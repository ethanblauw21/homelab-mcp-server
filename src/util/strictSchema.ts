import { z } from "zod";

/**
 * ADR-023 #3/#7 — reject unknown tool parameters instead of silently dropping them.
 *
 * Zod's default object behavior is `.strip()`: an unknown key (a hallucinated or
 * mis-remembered param name — `lines` for `tail`, `name`/`description` for `note`)
 * is **dropped with no error**, so the handler runs with a defaulted value and
 * reports success. The model never learns it sent the wrong field. The live
 * dogfooding run hit this twice (`docker_logs` `lines`→clamped to the 100-line cap
 * and dumped a huge log; `snapshot_create` `name`/`description`→auto-named,
 * "no-description" snapshot).
 *
 * Applying `.strict()` at the registration boundary turns an unknown key into a
 * loud `Input validation error`, which the MCP SDK surfaces to the caller so it can
 * correct the name. This is the right default for an agent-facing surface: a typo'd
 * param is a bug, not something to swallow.
 *
 * Pure + total: only a ZodObject is strictened (it is the only type with `.strict()`
 * and the only shape where "unknown top-level key" is meaningful). Anything else —
 * a union/intersection/effect input schema, a raw shape, or a non-schema — is
 * returned unchanged, so this is safe to apply blanket-style in `index.ts`.
 */
export function strictifyInputSchema<T>(schema: T): T {
  if (
    schema instanceof z.ZodObject &&
    // ZodObject already in strict/passthrough mode keeps its setting; re-applying
    // strict is harmless but we avoid clobbering an explicit `.passthrough()`.
    (schema._def.unknownKeys ?? "strip") === "strip"
  ) {
    return schema.strict() as unknown as T;
  }
  return schema;
}
