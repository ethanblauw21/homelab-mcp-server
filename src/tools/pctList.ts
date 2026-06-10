import { z } from "zod";
import type { SshTransport } from "../ssh/transport.js";
import { parsePctList } from "./pctHelpers.js";
import type { PctContainer } from "./pctHelpers.js";

export const PctListInputSchema = z.object({});

export async function pctListHandler(
  _input: z.infer<typeof PctListInputSchema>,
  transport: SshTransport
): Promise<{ containers: PctContainer[] }> {
  const result = await transport.exec("pct list");
  if (result.exitCode !== 0) {
    throw new Error(`pct list failed (exit ${result.exitCode}): ${result.stderr}`);
  }
  return { containers: parsePctList(result.stdout) };
}
