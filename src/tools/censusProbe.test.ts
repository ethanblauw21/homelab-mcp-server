import { describe, it, expect } from "vitest";
import { FakeTransport } from "../ssh/fakeTransport.js";
import { expectSuccess, ProbeRunner, runProbe, BudgetExceeded } from "./censusProbe.js";
import type { CensusError } from "./censusTypes.js";

describe("expectSuccess", () => {
  it("returns stdout on exit 0", () => {
    expect(expectSuccess({ stdout: "ok\n", stderr: "", exitCode: 0 })).toBe("ok\n");
  });

  it("throws with exit code and stderr on non-zero exit", () => {
    expect(() => expectSuccess({ stdout: "", stderr: "boom", exitCode: 2 })).toThrow(/exit 2: boom/);
  });

  it("falls back to (no stderr) when stderr is empty", () => {
    expect(() => expectSuccess({ stdout: "", stderr: "", exitCode: 1 })).toThrow(/\(no stderr\)/);
  });
});

describe("ProbeRunner", () => {
  it("hard() returns stdout for a successful probe", async () => {
    const t = new FakeTransport();
    t.setExecResult("nproc", { stdout: "8\n", stderr: "", exitCode: 0 });
    const r = new ProbeRunner(t, 1000, 1000, () => 0);
    expect(await r.hard("nproc")).toBe("8\n");
  });

  it("hard() throws on non-zero exit", async () => {
    const t = new FakeTransport();
    t.setExecResult("bad", { stdout: "", stderr: "nope", exitCode: 1 });
    const r = new ProbeRunner(t, 1000, 1000, () => 0);
    await expect(r.hard("bad")).rejects.toThrow(/exit 1/);
  });

  it("soft() swallows a non-zero exit into null", async () => {
    const t = new FakeTransport();
    t.setExecResult("maybe", { stdout: "", stderr: "x", exitCode: 1 });
    const r = new ProbeRunner(t, 1000, 1000, () => 0);
    expect(await r.soft("maybe")).toBeNull();
  });

  it("throws BudgetExceeded once the deadline passes (soft does not swallow it)", async () => {
    const t = new FakeTransport();
    let tick = 0;
    const r = new ProbeRunner(t, 1000, 0, () => tick++); // deadline = 0
    await expect(r.hard("anything")).rejects.toBeInstanceOf(BudgetExceeded);
  });
});

describe("runProbe", () => {
  it("parses stdout on success", async () => {
    const t = new FakeTransport();
    t.setExecResult("nproc", { stdout: "8", stderr: "", exitCode: 0 });
    const errors: CensusError[] = [];
    const r = new ProbeRunner(t, 1000, 1000, () => 0);
    const n = await runProbe(
      r,
      { section: "node", key: "nproc", command: "nproc", parser: (s) => parseInt(s, 10) },
      0,
      errors
    );
    expect(n).toBe(8);
    expect(errors).toEqual([]);
  });

  it("records a section error and returns the fallback on failure", async () => {
    const t = new FakeTransport();
    t.setExecResult("qm list", { stdout: "", stderr: "qm failed", exitCode: 2 });
    const errors: CensusError[] = [];
    const r = new ProbeRunner(t, 1000, 1000, () => 0);
    const rows = await runProbe(
      r,
      { section: "vms", key: "qm list", command: "qm list", parser: () => [1, 2, 3] },
      [],
      errors
    );
    expect(rows).toEqual([]);
    expect(errors).toEqual([{ section: "vms", probe: "qm list", error: "exit 2: qm failed" }]);
  });

  it("lets BudgetExceeded propagate instead of recording it as a section error", async () => {
    const t = new FakeTransport();
    let tick = 0;
    const r = new ProbeRunner(t, 1000, 0, () => tick++);
    const errors: CensusError[] = [];
    await expect(
      runProbe(r, { section: "node", key: "x", command: "x", parser: (s) => s }, "", errors)
    ).rejects.toBeInstanceOf(BudgetExceeded);
    expect(errors).toEqual([]);
  });
});
