import { z } from "zod";
import type { SshTransport } from "../ssh/transport.js";
import { validatePath } from "../guardrails/pathValidation.js";
import type { Config } from "../config.js";

export const ReadFileInputSchema = z.object({
  path: z.string().min(1).describe("Absolute path on the Proxmox host"),
  encoding: z.enum(["utf8", "base64"]).default("utf8").describe("Return encoding"),
});

export type ReadFileInput = z.infer<typeof ReadFileInputSchema>;

export async function readFileHandler(
  input: ReadFileInput,
  transport: SshTransport,
  cfg: Config
): Promise<{ content: string; encoding: string }> {
  const pathResult = validatePath(input.path, {
    allowlist: cfg.guardrails.pathAllowlist,
    denylist: cfg.guardrails.pathDenylist,
  });
  if (!pathResult.valid) {
    throw new Error(`Invalid path: ${pathResult.reason}`);
  }

  const buf = await transport.readFile(input.path);
  return {
    content: buf.toString(input.encoding),
    encoding: input.encoding,
  };
}
