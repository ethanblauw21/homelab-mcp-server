import { z } from "zod";
import type { SshTransport } from "../ssh/transport.js";
import { validatePath } from "../guardrails/pathValidation.js";
import type { Config } from "../config.js";

export const ReadFileInputSchema = z.object({
  path: z.string().min(1).describe("Absolute path on the Proxmox host"),
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

export type ReadFileInput = z.infer<typeof ReadFileInputSchema>;

export async function readFileHandler(
  input: ReadFileInput,
  transport: SshTransport,
  cfg: Config
): Promise<{ content: string; encoding: string; bytes: number; offset: number }> {
  const pathResult = validatePath(input.path, {
    allowlist: cfg.guardrails.pathAllowlist,
    denylist: cfg.guardrails.pathDenylist,
  });
  if (!pathResult.valid) {
    throw new Error(`Invalid path: ${pathResult.reason}`);
  }

  const cap = cfg.tools.readFileMaxBytes;
  const { size } = await transport.stat(input.path);
  const windowed = input.offset !== undefined || input.maxBytes !== undefined;

  let buf: Buffer;
  let offset: number;
  if (!windowed) {
    // Whole-file read: refuse anything over the cap (ADR-004 §4).
    if (size > cap) {
      throw new Error(
        `File is ${size} bytes, over the ${cap}-byte read_file cap. ` +
          `Read a window with offset/maxBytes, or use execute with head/tail/grep/wc.`
      );
    }
    buf = await transport.readFile(input.path);
    offset = 0;
  } else {
    offset = input.offset ?? 0;
    // Window length is bounded by the cap regardless of the requested maxBytes.
    const length = Math.min(input.maxBytes ?? cap, cap);
    buf = await transport.readFile(input.path, { start: offset, length });
  }

  return {
    content: buf.toString(input.encoding),
    encoding: input.encoding,
    bytes: buf.length,
    offset,
  };
}
