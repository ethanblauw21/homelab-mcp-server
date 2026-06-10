/**
 * Pure threshold evaluators + small parsers for `health_check` (ADR-005 Part 2).
 *
 * No I/O. Each evaluator maps a probed value onto a tri-state status against
 * config-driven thresholds. The handler runs the probes and decorates these with
 * a `section`; keeping the decision logic here makes every boundary unit-testable.
 */

export type HealthStatus = "ok" | "warn" | "crit";

/** One check's verdict, before the handler attaches its section. */
export interface CheckResult {
  check: string;
  status: HealthStatus;
  finding: string;
  detail?: string;
}

/** value ≥ crit ⇒ crit; value ≥ warn ⇒ warn; else ok. Thresholds: warn ≤ crit. */
export function statusFromThresholds(value: number, warn: number, crit: number): HealthStatus {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

export interface LoadThresholds {
  warnRatio: number;
  critRatio: number;
}

export function evaluateLoad(load1m: number, cores: number, t: LoadThresholds): CheckResult {
  const c = Math.max(1, cores);
  const ratio = load1m / c;
  return {
    check: "load",
    status: statusFromThresholds(ratio, t.warnRatio, t.critRatio),
    finding: `1m load ${load1m.toFixed(2)} on ${c} core(s)`,
    detail: `ratio ${ratio.toFixed(2)} (warn ≥ ${t.warnRatio}, crit ≥ ${t.critRatio})`,
  };
}

export interface PercentThresholds {
  warnPercent: number;
  critPercent: number;
}

export function evaluateMemory(
  usedBytes: number,
  totalBytes: number,
  t: PercentThresholds
): CheckResult {
  const pct = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0;
  return {
    check: "memory",
    status: statusFromThresholds(pct, t.warnPercent, t.critPercent),
    finding: `memory ${pct.toFixed(1)}% used`,
    detail: `${usedBytes}/${totalBytes} bytes`,
  };
}

export function evaluateUsage(
  label: string,
  usedBytes: number,
  sizeBytes: number,
  t: PercentThresholds
): CheckResult {
  const pct = sizeBytes > 0 ? (usedBytes / sizeBytes) * 100 : 0;
  return {
    check: label,
    status: statusFromThresholds(pct, t.warnPercent, t.critPercent),
    finding: `${label} ${pct.toFixed(1)}% used`,
    detail: `${usedBytes}/${sizeBytes} bytes`,
  };
}

export function evaluateZpool(zpool: { healthy: boolean; detail: string }): CheckResult {
  return zpool.healthy
    ? { check: "zfs", status: "ok", finding: "all pools healthy", detail: zpool.detail }
    : { check: "zfs", status: "crit", finding: "zpool not healthy", detail: zpool.detail };
}

export function evaluateFailedUnits(units: string[], critList: string[]): CheckResult {
  if (units.length === 0) {
    return { check: "failed-units", status: "ok", finding: "no failed units" };
  }
  const crit = units.filter((u) => critList.includes(u));
  return {
    check: "failed-units",
    status: crit.length > 0 ? "crit" : "warn",
    finding: `${units.length} failed unit(s)${crit.length ? ` (${crit.length} critical)` : ""}`,
    detail: units.join(", "),
  };
}

export interface OnbootGuest {
  vmid: number;
  name: string;
  onboot: boolean;
  status: string;
}

export function evaluateOnbootStopped(guests: OnbootGuest[]): CheckResult {
  const offenders = guests.filter((g) => g.onboot && g.status !== "running");
  if (offenders.length === 0) {
    return { check: "onboot-guests", status: "ok", finding: "all onboot guests are running" };
  }
  return {
    check: "onboot-guests",
    status: "warn",
    finding: `${offenders.length} onboot guest(s) not running`,
    detail: offenders.map((g) => `${g.vmid}:${g.name}`).join(", "),
  };
}

export function evaluatePendingUpdates(count: number, warnCount: number): CheckResult {
  return {
    check: "updates",
    status: count > warnCount ? "warn" : "ok",
    finding: `${count} pending update(s)`,
    detail: `informational; warn above ${warnCount}`,
  };
}

/** Worst-status rollup across all findings. */
export function rollupStatus(findings: { status: HealthStatus }[]): HealthStatus {
  if (findings.some((f) => f.status === "crit")) return "crit";
  if (findings.some((f) => f.status === "warn")) return "warn";
  return "ok";
}

/**
 * Parse `grep -H '^onboot:' /etc/pve/lxc/*.conf /etc/pve/qemu-server/*.conf`.
 * Lines look like `/etc/pve/lxc/101.conf:onboot: 1`. Returns vmid → onboot bool.
 * Tolerant: unmatched lines are skipped.
 */
export function parseOnbootConfig(output: string): Map<number, boolean> {
  const map = new Map<number, boolean>();
  for (const line of output.split("\n")) {
    const m = line.match(/\/(\d+)\.conf:\s*onboot:\s*(\d+)/);
    if (!m) continue;
    map.set(parseInt(m[1]!, 10), m[2] === "1");
  }
  return map;
}

/**
 * Count pending updates from `apt-get -s -o Debug::NoLocking=true upgrade` output
 * by counting lines beginning with "Inst". A5.1: this is a SIMULATION (`-s`); the
 * caller must never run `apt update` (no index refresh) — the count is "as of" the
 * last manual refresh.
 */
export function parseAptUpgradeCount(output: string): number {
  let count = 0;
  for (const line of output.split("\n")) {
    if (/^Inst\s/.test(line)) count++;
  }
  return count;
}
