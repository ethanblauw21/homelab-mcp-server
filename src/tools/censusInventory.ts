/**
 * R2 — redaction enforced by the type system (ADR-002 refinement).
 *
 * The failure mode we design against is not the redactor missing a pattern — it
 * is a future probe whose output never reaches the redactor. So there is
 * exactly ONE function, `finalizeInventory`, that turns a raw inventory into the
 * branded `RedactedCensusSnapshot`, and snapshot persistence + the MCP response
 * accept ONLY that branded type. The brand is a module-private symbol: no other
 * module can mint a `RedactedCensusSnapshot`, so "add a probe, forget
 * redaction" is a compile error at the persist/return boundary, not a leak.
 *
 * `finalizeInventory` is also the single home for the other two wire-shaping
 * guarantees: deterministic ordering (R3) and the explicit truncation contract
 * (R5).
 */
import { redactRecord } from "../guardrails/redaction.js";
import type { CensusSnapshot, CensusSections, GuestEntry, Truncation } from "./censusTypes.js";
import { isUnavailable } from "./censusTypes.js";
import type { GuestConfig } from "./censusParsers.js";

declare const REDACTED_BRAND: unique symbol;

/**
 * A census snapshot that has provably been through `finalizeInventory`. The
 * brand cannot be produced outside this module, so it can only be obtained by
 * redacting.
 */
export type RedactedCensusSnapshot = CensusSnapshot & { readonly [REDACTED_BRAND]: "redacted" };

/** A snapshot as assembled by the handler, before redaction/ordering/truncation. */
export type RawCensusSnapshot = CensusSnapshot;

export interface FinalizeOptions {
  extraKeys: string[];
  maxItemsPerSection: number;
  maxResponseBytes: number;
}

function sortRecordKeys(rec: GuestConfig): GuestConfig {
  const out: GuestConfig = {};
  for (const k of Object.keys(rec).sort()) out[k] = rec[k]!;
  return out;
}

/** Deterministic ordering (R3): guests by vmid, storage/network/bridges by name. */
function orderSections(src: CensusSections): CensusSections {
  const out: CensusSections = { ...src };
  if (src.containers) out.containers = [...src.containers].map((g) => ({ ...g })).sort(byVmid);
  if (src.vms) out.vms = [...src.vms].map((g) => ({ ...g })).sort(byVmid);
  if (src.storage)
    out.storage = [...src.storage].map((s) => ({ ...s })).sort((a, b) => a.name.localeCompare(b.name));
  // ADR-007 §6 — leave an `Unavailable` marker untouched (it is not a list).
  if (src.services && !isUnavailable(src.services))
    out.services = [...src.services].map((s) => ({ ...s })).sort(byVmid);
  if (src.network && !isUnavailable(src.network)) {
    out.network = {
      ifaces: [...src.network.ifaces].sort((a, b) => a.iface.localeCompare(b.iface)),
      bridges: [...src.network.bridges].sort((a, b) => a.name.localeCompare(b.name)),
    };
  }
  return out;
}

function byVmid(a: { vmid: number }, b: { vmid: number }): number {
  return a.vmid - b.vmid;
}

/** Per-section item caps (R5). Records an explicit truncation for each cut. */
function capSections(sections: CensusSections, cap: number, truncations: Truncation[]): void {
  // Only list-valued sections are capped; `services` may hold an Unavailable
  // marker (ADR-007 §6), which the Array.isArray guard below skips.
  const names: Array<keyof CensusSections> = ["containers", "vms", "storage", "services"];
  for (const name of names) {
    const arr = sections[name] as unknown[] | undefined;
    if (Array.isArray(arr) && arr.length > cap) {
      const omitted = arr.length - cap;
      arr.length = cap;
      truncations.push({
        section: name as Truncation["section"],
        reason: `more than ${cap} items; kept first ${cap}`,
        omitted,
      });
    }
  }
}

function redactGuest(g: GuestEntry, extraKeys: string[]): number {
  if (!g.config) return 0;
  const red = redactRecord(g.config, extraKeys);
  g.config = sortRecordKeys(red.value);
  return red.redactedCount;
}

/**
 * Response-byte budget (R5). If the serialized snapshot is over budget, drop
 * the heaviest payload first — per-guest configs (only present at depth "full")
 * — and record an explicit `_response` truncation.
 */
function applyResponseBudget(snap: CensusSnapshot, maxBytes: number): void {
  if (Buffer.byteLength(JSON.stringify(snap), "utf8") <= maxBytes) return;
  const guests = [...(snap.sections.containers ?? []), ...(snap.sections.vms ?? [])];
  let dropped = 0;
  for (const g of guests) {
    if (g.config) {
      delete g.config;
      dropped++;
    }
  }
  if (dropped > 0) {
    (snap.truncations ??= []).push({
      section: "_response",
      reason: `response exceeded ${maxBytes} bytes; dropped ${dropped} guest config(s)`,
      omitted: dropped,
    });
    snap.truncated = true;
  }
}

/**
 * THE redaction chokepoint. Orders deterministically, applies item caps,
 * redacts every guest config, then enforces the response byte budget — and
 * returns the only branded snapshot type the store and MCP response will accept.
 */
export function finalizeInventory(
  raw: RawCensusSnapshot,
  opts: FinalizeOptions
): RedactedCensusSnapshot {
  const truncations: Truncation[] = [...(raw.truncations ?? [])];
  const sections = orderSections(raw.sections);
  capSections(sections, opts.maxItemsPerSection, truncations);

  let redactions = 0;
  for (const g of sections.containers ?? []) redactions += redactGuest(g, opts.extraKeys);
  for (const g of sections.vms ?? []) redactions += redactGuest(g, opts.extraKeys);

  const out: CensusSnapshot = { ...raw, sections, redactions };
  if (truncations.length > 0) {
    out.truncated = true;
    out.truncations = truncations;
  }

  applyResponseBudget(out, opts.maxResponseBytes);

  return out as RedactedCensusSnapshot;
}
