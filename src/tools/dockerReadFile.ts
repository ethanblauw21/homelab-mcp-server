import { z } from "zod";
import type { SshTransport } from "../ssh/transport.js";
import { validatePath } from "../guardrails/pathValidation.js";
import { assertContainerRunning } from "./pctFiles.js";
import { assertDockerName } from "./dockerHelpers.js";
import { resolveDockerContainer, readDockerFile } from "./dockerFiles.js";
import { applyReadRedaction } from "./readRedaction.js";
import type { Config } from "../config.js";

export const DockerReadFileInputSchema = z.object({
  vmid: z.number().int().positive().describe("LXC container ID hosting the Docker daemon"),
  container: z.string().min(1).describe("Docker container name"),
  path: z.string().min(1).describe("Absolute path of the file inside the Docker container"),
  encoding: z.enum(["utf8", "base64"]).default("utf8").describe("Return encoding"),
  redact: z
    .boolean()
    .optional()
    .describe(
      "ADR-019: opt into the log tools' secret redaction for this read (utf8 only). " +
        "Default false = full fidelity. Best-effort, not a security control."
    ),
  offset: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Byte offset to start reading from (for windowed reads of large files)"),
  maxBytes: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum bytes to read in this window (bounded by the server's read cap)"),
});

export type DockerReadFileInput = z.infer<typeof DockerReadFileInputSchema>;

export interface DockerReadFileResult {
  content: string;
  encoding: string;
  bytes: number;
  offset: number;
  vmid: number;
  container: string;
  /** True when the bind-mount fast path served the read. */
  viaBindMount: boolean;
  /** ADR-019: present only when `redact` was requested (true ⇒ scanned, false ⇒ base64 no-op). */
  redacted?: boolean;
  /** ADR-019: present only when redaction actually ran; count of masked spans. */
  redactionCount?: number;
}

/**
 * `docker_read_file` (ADR-008 §2). Returns **fidelity by default** — reading a
 * config to use its API key is the operator's legitimate choice, consistent with
 * `pct_read_file`/`read_file`. ADR-019 adds an opt-in `redact` flag that routes the
 * returned text through the same ADR-002 module the log tools use, for the
 * structure-over-secrets read; the default (no flag) is byte-for-byte unchanged. The
 * read cap bounds the returned payload (`docker cp`/`pct pull` copy the whole file first).
 */
export async function dockerReadFileHandler(
  input: DockerReadFileInput,
  transport: SshTransport,
  cfg: Config
): Promise<DockerReadFileResult> {
  assertDockerName(input.container);
  const pathResult = validatePath(input.path, {
    allowlist: cfg.guardrails.pathAllowlist,
    denylist: cfg.guardrails.pathDenylist,
  });
  if (!pathResult.valid) {
    throw new Error(`Invalid path: ${pathResult.reason}`);
  }

  const timeoutMs = cfg.ssh.commandTimeoutMs;
  // The LXC must be running for `pct exec`/`pct pull` to function.
  await assertContainerRunning(transport, input.vmid, timeoutMs);

  const inspect = await resolveDockerContainer(transport, input.vmid, input.container, timeoutMs);
  const { content, viaBindMount } = await readDockerFile(
    transport,
    input.vmid,
    input.container,
    input.path,
    inspect,
    cfg.container.nodeTempDir,
    timeoutMs
  );
  if (content === null) {
    throw new Error(
      `File not found inside Docker container ${input.container} (CT${input.vmid}): ${input.path}`
    );
  }

  const cap = cfg.tools.readFileMaxBytes;
  const windowed = input.offset !== undefined || input.maxBytes !== undefined;

  let buf: Buffer;
  let offset: number;
  if (!windowed) {
    if (content.length > cap) {
      throw new Error(
        `File is ${content.length} bytes, over the ${cap}-byte read_file cap. ` +
          `Read a window with offset/maxBytes, or use docker_exec with head/tail/grep/wc.`
      );
    }
    buf = content;
    offset = 0;
  } else {
    offset = input.offset ?? 0;
    const length = Math.min(input.maxBytes ?? cap, cap);
    buf = content.subarray(offset, offset + length);
  }

  const red = applyReadRedaction(
    buf.toString(input.encoding),
    input.encoding,
    input.redact,
    input.redact ? cfg.census.redactionExtraKeys : []
  );
  return {
    content: red.content,
    encoding: input.encoding,
    bytes: buf.length,
    offset,
    vmid: input.vmid,
    container: input.container,
    viaBindMount,
    ...(red.redacted !== undefined ? { redacted: red.redacted } : {}),
    ...(red.redactionCount !== undefined ? { redactionCount: red.redactionCount } : {}),
  };
}
