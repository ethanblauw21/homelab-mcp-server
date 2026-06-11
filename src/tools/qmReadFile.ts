import { z } from "zod";
import type { SshTransport } from "../ssh/transport.js";
import { validatePath } from "../guardrails/pathValidation.js";
import { assertAgentAvailable, resolveNodeName, readVmFile } from "./qmFiles.js";
import type { Config } from "../config.js";

export const QmReadFileInputSchema = z.object({
  vmid: z.number().int().positive().describe("VM ID (qm guest)"),
  path: z.string().min(1).describe("Absolute path of the file inside the VM"),
  encoding: z.enum(["utf8", "base64"]).default("utf8").describe("Return encoding"),
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

export type QmReadFileInput = z.infer<typeof QmReadFileInputSchema>;

/**
 * `qm_read_file` — read a file from inside a VM via the QEMU guest agent
 * (ADR-005 stretch). Mirrors `pct_read_file`: validated path, agent precheck,
 * ADR-004 read cap + offset/maxBytes window. The agent endpoint is text-oriented
 * and may itself truncate; that `truncated` flag is surfaced honestly rather
 * than hidden.
 */
export async function qmReadFileHandler(
  input: QmReadFileInput,
  transport: SshTransport,
  cfg: Config
): Promise<{ content: string; encoding: string; bytes: number; offset: number; truncated: boolean }> {
  const pathResult = validatePath(input.path, {
    allowlist: cfg.guardrails.pathAllowlist,
    denylist: cfg.guardrails.pathDenylist,
  });
  if (!pathResult.valid) {
    throw new Error(`Invalid path: ${pathResult.reason}`);
  }

  const timeoutMs = cfg.ssh.commandTimeoutMs;
  await assertAgentAvailable(transport, input.vmid, timeoutMs);
  const node = await resolveNodeName(transport, timeoutMs);

  const { content, truncated } = await readVmFile(transport, node, input.vmid, input.path, timeoutMs);
  if (content === null) {
    throw new Error(`File not found inside VM ${input.vmid}: ${input.path}`);
  }

  // ADR-004 §4 cap parity with read_file / pct_read_file. The agent already
  // returned the bytes, so the cap bounds the returned payload.
  const cap = cfg.tools.readFileMaxBytes;
  const windowed = input.offset !== undefined || input.maxBytes !== undefined;

  let buf: Buffer;
  let offset: number;
  if (!windowed) {
    if (content.length > cap) {
      throw new Error(
        `File is ${content.length} bytes, over the ${cap}-byte read cap. ` +
          `Read a window with offset/maxBytes, or use qm_exec with head/tail/grep/wc.`
      );
    }
    buf = content;
    offset = 0;
  } else {
    offset = input.offset ?? 0;
    const length = Math.min(input.maxBytes ?? cap, cap);
    buf = content.subarray(offset, offset + length);
  }

  return {
    content: buf.toString(input.encoding),
    encoding: input.encoding,
    bytes: buf.length,
    offset,
    truncated,
  };
}
