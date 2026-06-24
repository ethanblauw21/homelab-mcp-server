import { describe, it, expect } from "vitest";
import {
  evaluateRollbackBreaker,
  rollbackTargetKey,
  breakerRefusal,
  RollbackBreaker,
} from "./rollbackBreaker.js";

const WINDOW = 600_000; // 10 min
const LIMIT = 3;

describe("evaluateRollbackBreaker (pure sliding window)", () => {
  it("does not trip below the limit", () => {
    const now = 1_000_000;
    expect(evaluateRollbackBreaker([now - 1, now], now, WINDOW, LIMIT)).toEqual({
      tripped: false,
      recentCount: 2,
    });
  });

  it("trips at exactly the limit", () => {
    const now = 1_000_000;
    const r = evaluateRollbackBreaker([now - 2, now - 1, now], now, WINDOW, LIMIT);
    expect(r).toEqual({ tripped: true, recentCount: 3 });
  });

  it("ignores timestamps older than the window (the cutoff is forgiving)", () => {
    const now = 1_000_000;
    // two are stale (outside the window), one fresh ⇒ recentCount 1, not tripped.
    const history = [now - WINDOW - 1, now - WINDOW - 100, now];
    expect(evaluateRollbackBreaker(history, now, WINDOW, LIMIT)).toEqual({
      tripped: false,
      recentCount: 1,
    });
  });

  it("counts a timestamp exactly at the cutoff boundary as in-window (inclusive)", () => {
    const now = 1_000_000;
    const atCutoff = now - WINDOW; // boundary
    const r = evaluateRollbackBreaker([atCutoff, now - 1, now], now, WINDOW, LIMIT);
    expect(r.recentCount).toBe(3);
    expect(r.tripped).toBe(true);
  });
});

describe("rollbackTargetKey (descriptor grammar)", () => {
  it("builds host / pct / qm / docker / guest keys", () => {
    expect(rollbackTargetKey({ kind: "host", remotePath: "/etc/hosts" })).toBe("host//etc/hosts");
    expect(rollbackTargetKey({ kind: "pct", vmid: 101, remotePath: "/etc/x" })).toBe("pct/101//etc/x");
    expect(rollbackTargetKey({ kind: "qm", vmid: 100, remotePath: "/etc/y" })).toBe("qm:100:/etc/y");
    expect(
      rollbackTargetKey({ kind: "docker", vmid: 101, container: "web", remotePath: "/app.conf" })
    ).toBe("docker:101:web:/app.conf");
    expect(rollbackTargetKey({ kind: "guest", vmid: 105 })).toBe("guest/105");
  });

  it("falls back gracefully for an unknown kind", () => {
    expect(rollbackTargetKey({ kind: "weird", remotePath: "/p" })).toBe("weird//p");
    expect(rollbackTargetKey({ kind: "weird", vmid: 9 })).toBe("weird/9");
  });

  it("keys file reverts and whole-guest verbs into disjoint namespaces", () => {
    // A pct file revert and a snapshot rollback of the same vmid must not collide.
    expect(rollbackTargetKey({ kind: "pct", vmid: 105, remotePath: "/etc/x" })).not.toBe(
      rollbackTargetKey({ kind: "guest", vmid: 105 })
    );
  });
});

describe("breakerRefusal (message + audit sub-object)", () => {
  it("names the key, count, window-in-minutes, limit, and the three recoveries", () => {
    const { message, circuitBreaker } = breakerRefusal("guest/105", {
      tripped: true,
      recentCount: 3,
      limit: 3,
      windowMs: 600_000,
    });
    expect(message).toContain("guest/105");
    expect(message).toContain("3 rollbacks");
    expect(message).toContain("10 min");
    expect(message).toContain("limit 3");
    expect(message).toMatch(/hand back to a human/i);
    expect(message).toMatch(/overrideCircuitBreaker: true/);
    expect(circuitBreaker).toEqual({ recentCount: 3, limit: 3, windowMs: 600_000 });
  });

  it("never reports a sub-minute window as 0 min (floors at 1)", () => {
    const { message } = breakerRefusal("host//x", {
      tripped: true,
      recentCount: 2,
      limit: 2,
      windowMs: 20_000, // 0.33 min
    });
    expect(message).toContain("1 min");
    expect(message).not.toContain("0 min");
  });
});

describe("RollbackBreaker (stateful shell, injected now)", () => {
  const cfg = { enabled: true, limit: 3, windowMs: WINDOW };

  it("trips on the Nth call against one key inside the window", () => {
    const b = new RollbackBreaker(cfg);
    expect(b.check("guest/105", 1000).tripped).toBe(false); // 1
    expect(b.check("guest/105", 2000).tripped).toBe(false); // 2
    const third = b.check("guest/105", 3000); // 3 ⇒ trip
    expect(third.tripped).toBe(true);
    expect(third.recentCount).toBe(3);
    expect(third).toMatchObject({ limit: 3, windowMs: WINDOW });
  });

  it("counts each key independently (a loop on A never trips B)", () => {
    const b = new RollbackBreaker(cfg);
    b.check("host//a", 1000);
    b.check("host//a", 2000);
    b.check("host//a", 3000); // A trips here
    // B is pristine.
    expect(b.check("host//b", 3100).tripped).toBe(false);
    expect(b.check("host//b", 3200).tripped).toBe(false);
  });

  it("self-heals: stale timestamps fall out of the window so the count recovers", () => {
    const b = new RollbackBreaker(cfg);
    b.check("guest/105", 1000);
    b.check("guest/105", 2000);
    // Far in the future — the two early calls are now stale, only this one is fresh.
    const later = b.check("guest/105", 1000 + WINDOW + 5000);
    expect(later.tripped).toBe(false);
    expect(later.recentCount).toBe(1);
  });

  it("keeps tripping while the window stays hot (the override is the only way past)", () => {
    const b = new RollbackBreaker(cfg);
    b.check("guest/105", 1000);
    b.check("guest/105", 2000);
    expect(b.check("guest/105", 3000).tripped).toBe(true);
    expect(b.check("guest/105", 4000).tripped).toBe(true); // 4th in-window ⇒ still tripped
  });

  it("disabled is a true no-op: never trips and records nothing", () => {
    const b = new RollbackBreaker({ enabled: false, limit: 1, windowMs: WINDOW });
    for (let i = 0; i < 10; i++) {
      const v = b.check("guest/105", 1000 + i);
      expect(v.tripped).toBe(false);
      expect(v.recentCount).toBe(0);
    }
  });
});
