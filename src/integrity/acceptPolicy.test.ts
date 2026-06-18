import { describe, it, expect } from "vitest";
import { applyAcceptPolicy, isSensitivePath, type LeafDrift, type AcceptPolicyConfig } from "./acceptPolicy.js";

const CFG: AcceptPolicyConfig = {
  maxUnexplainedL3: 2,
  allowL2AutoAccept: false,
  sensitiveGlobs: ["/etc/pve", "**/secrets/**"],
};

const leaf = (over: Partial<LeafDrift>): LeafDrift => ({
  path: "host" + (over.nodePath ?? "/etc/x"),
  nodePath: "/etc/x",
  explained: false,
  l1: true,
  l2: false,
  l3: false,
  ...over,
});

const decisionFor = (drifts: LeafDrift[], cfg = CFG) =>
  Object.fromEntries(applyAcceptPolicy(drifts, cfg).map((o) => [o.path, `${o.decision}:${o.reason}`]));

describe("isSensitivePath", () => {
  it("matches the path itself and its subtree on a / boundary", () => {
    expect(isSensitivePath("/etc/pve", ["/etc/pve"])).toBe(true);
    expect(isSensitivePath("/etc/pve/storage.cfg", ["/etc/pve"])).toBe(true);
    expect(isSensitivePath("/etc/pvexyz", ["/etc/pve"])).toBe(false); // no false prefix match
  });
  it("honors glob entries", () => {
    expect(isSensitivePath("/srv/app/secrets/key.pem", ["**/secrets/**"])).toBe(true);
    expect(isSensitivePath("/srv/app/config.yml", ["**/secrets/**"])).toBe(false);
  });
});

describe("applyAcceptPolicy precedence", () => {
  it("explained always folds — even on a sensitive path, even L2", () => {
    const d = leaf({ path: "host/etc/pve/x", nodePath: "/etc/pve/x", explained: true, explainedBy: "aud-1", l2: true });
    const out = applyAcceptPolicy([d], CFG)[0];
    expect(out).toMatchObject({ decision: "fold", reason: "explained", explainedBy: "aud-1" });
  });

  it("sensitive unexplained never folds (beats L1-only free-fold)", () => {
    const d = leaf({ path: "host/etc/pve/x", nodePath: "/etc/pve/x", l1: true, l2: false, l3: false });
    expect(decisionFor([d])).toEqual({ "host/etc/pve/x": "flag:sensitive" });
  });

  it("L2 config drift flags by default, folds only when explicitly loosened", () => {
    const d = leaf({ path: "host/etc/app.yml", nodePath: "/etc/app.yml", l2: true, l3: true });
    expect(decisionFor([d])).toEqual({ "host/etc/app.yml": "flag:l2-config" });
    expect(decisionFor([d], { ...CFG, allowL2AutoAccept: true })).toEqual({ "host/etc/app.yml": "fold:l2-config" });
  });

  it("L1-only mtime drift folds freely", () => {
    const d = leaf({ path: "host/etc/x", nodePath: "/etc/x", l1: true, l2: false, l3: false });
    expect(decisionFor([d])).toEqual({ "host/etc/x": "fold:l1-only" });
  });
});

describe("applyAcceptPolicy L3 budget", () => {
  it("folds L3-only drift up to maxUnexplainedL3, flags the tail", () => {
    const drifts = ["a", "b", "c", "d"].map((p) =>
      leaf({ path: `host/var/${p}`, nodePath: `/var/${p}`, l1: true, l2: false, l3: true })
    );
    const out = applyAcceptPolicy(drifts, CFG); // budget = 2
    const folded = out.filter((o) => o.decision === "fold");
    const flagged = out.filter((o) => o.decision === "flag");
    expect(folded).toHaveLength(2);
    expect(folded.every((o) => o.reason === "l3-tail")).toBe(true);
    expect(flagged).toHaveLength(2);
    expect(flagged.every((o) => o.reason === "l3-over-threshold")).toBe(true);
  });

  it("explained L3 drift does not consume the unexplained budget", () => {
    const drifts = [
      leaf({ path: "host/var/x", nodePath: "/var/x", explained: true, explainedBy: "a1", l3: true }),
      leaf({ path: "host/var/y", nodePath: "/var/y", l3: true }),
      leaf({ path: "host/var/z", nodePath: "/var/z", l3: true }),
    ];
    const out = applyAcceptPolicy(drifts, { ...CFG, maxUnexplainedL3: 2 });
    // x explained-folds; y,z both fit the budget of 2.
    expect(out.map((o) => o.decision)).toEqual(["fold", "fold", "fold"]);
  });
});

describe("applyAcceptPolicy edge", () => {
  it("a leaf with no drift at any level is a flagged no-op (defensive)", () => {
    const d = leaf({ path: "host/etc/x", nodePath: "/etc/x", l1: false, l2: false, l3: false });
    expect(decisionFor([d])).toEqual({ "host/etc/x": "flag:no-drift" });
  });
});
