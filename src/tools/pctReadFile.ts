import { z } from "zod";
import type { SshTransport } from "../ssh/transport.js";
import { validatePath } from "../guardrails/pathValidation.js";
import { assertContainerRunning, pullContainerFile } from "./pctFiles.js";
import { applyReadRedaction } from "./readRedaction.js";
import type { Config } from "../config.js";

export const PctReadFileInputSchema = z.object({
  vmid: z.number().int().positive().describe("LXC container ID"),
  path: z.string().min(1).describe("Absolute path of the file inside the container"),
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

export type PctReadFileInput = z.infer<typeof PctReadFileInputSchema>;

export async function pctReadFileHandler(
  input: PctReadFileInput,
  transport: SshTransport,
  cfg: Config
): Promise<{
  content: string;
  encoding: string;
  bytes: number;
  offset: number;
  redacted?: boolean;
  redactionCount?: number;
}> {
  const pathResult = validatePath(input.path, {
    allowlist: cfg.guardrails.pathAllowlist,
    denylist: cfg.guardrails.pathDenylist,
  });
  if (!pathResult.valid) {
    throw new Error(`Invalid path: ${pathResult.reason}`);
  }

  // A3.1: a stopped container can't serve `pct pull`; refuse before trying.
  await assertContainerRunning(transport, input.vmid, cfg.ssh.commandTimeoutMs);

  const { content } = await pullContainerFile(
    transport,
    input.vmid,
    input.path,
    cfg.container.nodeTempDir,
    cfg.ssh.commandTimeoutMs
  );
  if (content === null) {
    throw new Error(`File not found inside container ${input.vmid}: ${input.path}`);
  }

  // ADR-004 §4 cap parity with read_file. NOTE: `pct pull` already copies the
  // whole file out of the guest, so the cap here bounds the payload returned to
  // the caller rather than avoiding the transfer (the host read_file stat-gates
  // before reading; a container file has no equally cheap pre-pull size probe).
  const cap = cfg.tools.readFileMaxBytes;
  const windowed = input.offset !== undefined || input.maxBytes !== undefined;

  let buf: Buffer;
  let offset: number;
  if (!windowed) {
    if (content.length > cap) {
      throw new Error(
        `File is ${content.length} bytes, over the ${cap}-byte read_file cap. ` +
          `Read a window with offset/maxBytes, or use pct_exec with head/tail/grep/wc.`
      );
    }
    buf = content;
    offset = 0;
  } else {
    offset = input.offset ?? 0;
    // Window length is bounded by the cap regardless of the requested maxBytes.
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
    ...(red.redacted !== undefined ? { redacted: red.redacted } : {}),
    ...(red.redactionCount !== undefined ? { redactionCount: red.redactionCount } : {}),
  };
}
