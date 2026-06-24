import { describe, it, expect } from "vitest";
import { z } from "zod";
import { strictifyInputSchema } from "./strictSchema.js";

describe("strictifyInputSchema", () => {
  it("rejects an unknown key on a plain object schema (the silent-strip bug, ADR-023 #3/#7)", () => {
    const schema = strictifyInputSchema(z.object({ tail: z.number().optional() }));
    // The dogfooding case: the model sends `lines` instead of `tail`.
    const res = schema.safeParse({ lines: 8 });
    expect(res.success).toBe(false);
    if (!res.success) expect(JSON.stringify(res.error.issues)).toMatch(/unrecognized|lines/i);
  });

  it("still accepts declared keys and applies defaults (strict rejects only EXTRA keys)", () => {
    const schema = strictifyInputSchema(
      z.object({ a: z.number(), b: z.string().default("x") })
    );
    expect(schema.parse({ a: 1 })).toEqual({ a: 1, b: "x" });
  });

  it("preserves a schema's .describe() chain (still a ZodObject)", () => {
    const schema = strictifyInputSchema(z.object({ a: z.number() }).describe("desc"));
    expect(schema.safeParse({ a: 1, extra: true }).success).toBe(false);
  });

  it("leaves an explicit .passthrough() object untouched", () => {
    const schema = strictifyInputSchema(z.object({ a: z.number() }).passthrough());
    const res = schema.safeParse({ a: 1, extra: true });
    expect(res.success).toBe(true);
    if (res.success) expect((res.data as { extra?: boolean }).extra).toBe(true);
  });

  it("returns a non-object schema (union) unchanged", () => {
    const union = z.union([z.string(), z.number()]);
    expect(strictifyInputSchema(union)).toBe(union);
    expect(union.safeParse("ok").success).toBe(true);
  });

  it("returns a non-schema value unchanged (defensive)", () => {
    const raw = { not: "a schema" };
    expect(strictifyInputSchema(raw)).toBe(raw);
  });
});
