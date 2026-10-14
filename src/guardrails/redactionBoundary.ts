/**
 * ADR-026 — the MCP-boundary redactor. `index.ts`'s `register` wraps EVERY tool
 * callback with `withRedaction`, so every result (success or `isError`) and every
 * thrown error message passes through the shared redactor before it reaches the
 * model. There is no bypass flag; a tool that forgets to redact is still covered.
 * `redactionBoundary.test.ts` pins that `index.ts` registers only through this.
 */
import { redactString, redactToolResult } from "./redaction.js";

export function withRedaction<A extends unknown[], R>(
  cb: (...args: A) => R | Promise<R>
): (...args: A) => Promise<R> {
  return async (...args: A): Promise<R> => {
    try {
      return redactToolResult(await cb(...args));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(redactString(msg).value);
    }
  };
}
