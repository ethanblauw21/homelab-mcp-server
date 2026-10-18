import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { enforceKeyFileMode, loadOrCreateRedactionKey } from "./redactionKey.js";

const posix = process.platform !== "win32";
const tmpKey = (): string => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rkey-")), "redaction.key");
const mode = (p: string): number => fs.statSync(p).mode & 0o777;

describe("redaction.key file mode (ADR-027)", () => {
  it.runIf(posix)("creates a new key at mode 600", () => {
    const p = tmpKey();
    expect(loadOrCreateRedactionKey(p)).toHaveLength(32);
    expect(mode(p)).toBe(0o600);
  });

  it.runIf(posix)("tightens an existing group/world-readable key to 600 and still loads it", () => {
    const p = tmpKey();
    fs.writeFileSync(p, "ab".repeat(32) + "\n");
    fs.chmodSync(p, 0o644);
    const key = loadOrCreateRedactionKey(p);
    expect(key?.toString("hex")).toBe("ab".repeat(32));
    expect(mode(p)).toBe(0o600);
  });

  it.runIf(posix)("leaves an already-private key alone", () => {
    const p = tmpKey();
    fs.writeFileSync(p, "ab".repeat(32) + "\n", { mode: 0o400 });
    expect(enforceKeyFileMode(p)).toBe(false);
    expect(mode(p)).toBe(0o400);
  });

  it("is a no-op on Windows", () => {
    const p = tmpKey();
    fs.writeFileSync(p, "x");
    expect(enforceKeyFileMode(p, "win32")).toBe(false);
  });
});
