import { z } from "zod";
import type { SshTransport } from "../ssh/transport.js";
import { validatePath } from "../guardrails/pathValidation.js";
import { assertContainerRunning, pullContainerFile } from "./pctFiles.js";
import type { Config } from "../config.js";

export const PctReadFileInputSchema = z.object({
  vmid: z.number().int().positive().describe("LXC container ID"),
  path: z.string().min(1).describe("Absolute path of the file inside the container"),
  encoding: z.enum(["utf8", "base64"]).default("utf8").describe("Return encoding"),
});

export type PctReadFileInput = z.infer<typeof PctReadFileInputSchema>;

export async function pctReadFileHandler(
  input: PctReadFileInput,
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

  return {
    content: content.toString(input.encoding),
    encoding: input.encoding,
  };
}
