import { redactString } from "../guardrails/redaction.js";

/**
 * Audit-log redaction. Thin wrapper over the shared, pure redaction module
 * (`guardrails/redaction.ts`) so the audit path and the census path use one
 * implementation with one test suite (ADR-002). Operates on free-text fields
 * (`cmd`, `note`) and returns the redacted string.
 */
export function redactSecrets(text: string): string {
  return redactString(text).value;
}
