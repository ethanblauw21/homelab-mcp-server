import type {
  StorageInfo,
  NetworkIface,
  BridgeInfo,
  GuestConfig,
  TailscaleSummary,
  TailscaleAbsent,
  DockerContainer,
  SnapshotCapability,
} from "./censusParsers.js";
import type { Tier } from "../tiers/registry.js";

/**
 * ADR-007 §6 — a section that cannot be served at the active tier because it
 * needs in-guest/host exec (companion+) the API token does not grant. This is a
 * **structured status, never an error**: the census ran fine, the section is
 * simply "not observed at this tier". The drift differ (`observed()` below)
 * treats it as not-observed — never as "removed".
 */
export interface Unavailable {
  unavailableAtTier: Tier;
}

export function isUnavailable(v: unknown): v is Unavailable {
  return typeof v === "object" && v !== null && "unavailableAtTier" in v;
}

/** Collapse an `Unavailable` marker (or undefined) to undefined for the differ. */
export function observed<T>(v: T | Unavailable | undefined): T | undefined {
  return v === undefined || isUnavailable(v) ? undefined : (v as T);
}

export type CensusSection =
  | "node"
  | "storage"
  | "network"
  | "containers"
  | "vms"
  | "services"
  | "tailscale";

export const ALL_SECTIONS: CensusSection[] = [
  "node",
  "storage",
  "network",
  "containers",
  "vms",
  "services",
  "tailscale",
];

/**
 * R3 — snapshot schema version. Bumped only on a breaking shape change. The
 * drift differ refuses-or-degrades when two snapshots disagree (see
 * `censusDrift.ts`), so cross-version diffs never produce garbage.
 */
export const CENSUS_SCHEMA_VERSION = 1;

/**
 * R3 — the single annotation of volatile (cosmetic, always-changing) fields.
 * Both the differ and any future renderer consult THIS rather than carrying
 * their own ad-hoc ignore-lists. The node section is omitted from drift in its
 * entirety precisely because every field listed here lives on it (plus `ts` on
 * the envelope).
 */
export const VOLATILE_FIELDS = {
  snapshot: ["ts"],
  node: ["uptime", "load", "memUsedBytes"],
} as const;

export interface NodeSection {
  version: string;
  uptime: string;
  cpu: number;
  memBytes: number;
  memUsedBytes: number;
  load: number[];
  zpool?: { healthy: boolean; detail: string };
}

export interface NetworkSection {
  ifaces: NetworkIface[];
  bridges: BridgeInfo[];
}

export interface GuestEntry {
  vmid: number;
  name: string;
  status: string;
  lock?: string;
  /** Present only at depth "full"; redacted. */
  config?: GuestConfig;
  /**
   * R6 — forward-slot for ADR-005's qemu-guest-agent status. Defined now so
   * ADR-005 only populates data and never bumps `schemaVersion` for one field.
   * Meaningful for `vms` entries; left undefined for containers.
   */
  agent?: { enabled: boolean; running?: boolean };
  /**
   * ADR-008 §5 — best-effort snapshot capability, computed from the redacted
   * per-guest config (+ storage types when available). Present only at depth
   * "full" (the heuristic needs the config). Drift treats a change here as real.
   */
  snapshotCapable?: SnapshotCapability;
}

export interface ServiceEntry {
  vmid: number;
  failedUnits: string[];
  docker: DockerContainer[];
}

export interface CensusError {
  section: CensusSection;
  probe: string;
  error: string;
}

export interface CensusSections {
  node?: NodeSection;
  storage?: StorageInfo[];
  // ADR-007 §6 — exec-bound sections may carry an `Unavailable` marker below
  // companion (the API token cannot run in-guest/host commands). Metadata
  // sections (node/storage/containers/vms) are API-complete at observe.
  network?: NetworkSection | Unavailable;
  containers?: GuestEntry[];
  vms?: GuestEntry[];
  services?: ServiceEntry[] | Unavailable;
  // #22 — host-first/container-fallback probe. TailscaleAbsent ({ scope: "none" })
  // replaces a bare null so "not present" is distinguishable from "down"; null is
  // retained for back-compat with snapshots stored before ADR-013.
  tailscale?: TailscaleSummary | TailscaleAbsent | null | Unavailable;
}

/**
 * R5 — every dropped item is explicit. A `section` of `"_response"` means the
 * whole-response byte budget forced per-guest configs to be dropped (vs a
 * per-section item cap).
 */
export interface Truncation {
  section: CensusSection | "_response";
  reason: string;
  omitted: number;
}

export interface CensusSnapshot {
  /** R3 — schema version of this envelope. See CENSUS_SCHEMA_VERSION. */
  schemaVersion: number;
  ts: string;
  host: string;
  depth: "summary" | "full";
  sections: CensusSections;
  errors: CensusError[];
  redactions: number;
  /** R5 — true when any section or the response budget dropped data. */
  truncated?: boolean;
  /** R5 — one entry per truncation; never silent. */
  truncations?: Truncation[];
  snapshotPath?: string;
  drift?: DriftReport;
}

export interface GuestDrift {
  added: number[];
  removed: number[];
  /**
   * Per-guest changes. `field` names what changed (`status` by default for
   * back-compat; `snapshotCapable` for an ADR-008 §5 capability transition —
   * treated as real drift, not noise).
   */
  changed: Array<{ vmid: number; from: string; to: string; field?: "status" | "snapshotCapable" }>;
}

export interface StorageDrift {
  added: string[];
  removed: string[];
  changed: Array<{ name: string; reason: string }>;
}

export interface NetworkDrift {
  added: string[];
  removed: string[];
  changed: Array<{ iface: string; reason: string }>;
}

export interface DriftReport {
  containers: GuestDrift;
  vms: GuestDrift;
  storage: StorageDrift;
  network: NetworkDrift;
  tailscale?: { from: number; to: number };
  comparedTo: string; // ts of the previous snapshot
  /**
   * R3 — set when the two snapshots' `schemaVersion`s disagree. Detailed
   * diffing is skipped (all sub-diffs empty) rather than producing garbage.
   */
  schemaMismatch?: boolean;
}
