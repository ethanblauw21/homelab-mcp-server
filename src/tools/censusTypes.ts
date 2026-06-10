import type {
  StorageInfo,
  NetworkIface,
  BridgeInfo,
  GuestConfig,
  TailscaleSummary,
  DockerContainer,
} from "./censusParsers.js";

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
  network?: NetworkSection;
  containers?: GuestEntry[];
  vms?: GuestEntry[];
  services?: ServiceEntry[];
  tailscale?: TailscaleSummary | null;
}

export interface CensusSnapshot {
  ts: string;
  host: string;
  depth: "summary" | "full";
  sections: CensusSections;
  errors: CensusError[];
  redactions: number;
  snapshotPath?: string;
  drift?: DriftReport;
}

export interface GuestDrift {
  added: number[];
  removed: number[];
  changed: Array<{ vmid: number; from: string; to: string }>;
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
}
