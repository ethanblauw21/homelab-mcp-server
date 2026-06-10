import { z } from "zod";
import type { SshTransport, FileEntry } from "../ssh/transport.js";
import { validatePath } from "../guardrails/pathValidation.js";
import type { Config } from "../config.js";

export const ListDirectoryInputSchema = z.object({
  path: z.string().min(1).describe("Absolute path to directory on the Proxmox host"),
});

export type ListDirectoryInput = z.infer<typeof ListDirectoryInputSchema>;

export async function listDirectoryHandler(
  input: ListDirectoryInput,
  transport: SshTransport,
  cfg: Config
): Promise<{ entries: FileEntry[] }> {
  const pathResult = validatePath(input.path, {
    allowlist: cfg.guardrails.pathAllowlist,
    denylist: cfg.guardrails.pathDenylist,
  });
  if (!pathResult.valid) {
    throw new Error(`Invalid path: ${pathResult.reason}`);
  }

  const entries = await transport.list(input.path);
  return { entries };
}
