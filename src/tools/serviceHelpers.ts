/**
 * Pure command builders + parser for the systemd front door (ADR-020 §1).
 *
 * No I/O. The only caller-controlled string that reaches a shell is the unit
 * name, which is charset-validated (the same `validateUnitName` `tail_log` uses)
 * and single-quoted here; everything else is a fixed verb. `service_logs` reuses
 * `buildTailCommand` wholesale, so the only systemd-specific surface is the
 * `systemctl show` status read and the `systemctl restart` mutation.
 */
import { shSingleQuote } from "../ssh/command.js";
import { validateUnitName } from "./tailLog.js";

/** The `systemctl show` properties we parse — a fixed, key=value-friendly set. */
const SHOW_PROPS = "ActiveState,SubState,UnitFileState,ActiveEnterTimestamp,MainPID";

/**
 * Build `systemctl show -p <props> <unit>` (no pager; `show` is key=value, never
 * paged, but the explicit flag keeps it terminal-agnostic). Throws on a bad unit
 * name so no unvalidated string is ever interpolated.
 */
export function buildServiceStatusCommand(unit: string): string {
  if (!validateUnitName(unit)) {
    throw new Error(`Invalid unit name: ${JSON.stringify(unit)}`);
  }
  return `systemctl show -p ${SHOW_PROPS} --no-pager ${shSingleQuote(unit)}`;
}

/** Build `systemctl restart <unit>`. Same charset guard as the status read. */
export function buildServiceRestartCommand(unit: string): string {
  if (!validateUnitName(unit)) {
    throw new Error(`Invalid unit name: ${JSON.stringify(unit)}`);
  }
  return `systemctl restart ${shSingleQuote(unit)}`;
}

export interface ServiceStatus {
  /** ActiveState: active | inactive | failed | activating | … */
  active: string;
  /** SubState: running | dead | exited | … */
  sub: string;
  /** UnitFileState: enabled | disabled | static | masked | "" (transient). */
  enabled: string;
  /** ActiveEnterTimestamp, or undefined when the unit is not active. */
  since?: string;
  /** MainPID, or undefined when there is no main process (0 / inactive). */
  mainPid?: number;
}

/**
 * Parse `systemctl show` key=value output. Unknown/missing keys default to "" so
 * the shape is stable; `MainPID=0` (no process) and an empty timestamp collapse
 * to undefined rather than surfacing a meaningless 0 / blank.
 */
export function parseServiceShow(output: string): ServiceStatus {
  const map = new Map<string, string>();
  for (const line of output.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    map.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  const pid = parseInt(map.get("MainPID") ?? "", 10);
  const since = map.get("ActiveEnterTimestamp") ?? "";
  return {
    active: map.get("ActiveState") ?? "",
    sub: map.get("SubState") ?? "",
    enabled: map.get("UnitFileState") ?? "",
    ...(since ? { since } : {}),
    ...(Number.isFinite(pid) && pid > 0 ? { mainPid: pid } : {}),
  };
}
