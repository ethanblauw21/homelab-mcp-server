/**
 * NodeOps — the domain-level interface for guest/node operations (ADR-007 §3).
 *
 * "The transport follows the tool, not the tier." Tools that express a structured
 * node operation (list guests, lifecycle, snapshots, node/storage status) depend on
 * this interface, not on a concrete transport. Two backends implement it:
 *
 *   - ApiBackend  — Proxmox REST API over a pinned-TLS https client + API token.
 *                   Rides EVERY tier (observe..root); no text parsers needed.
 *   - SshBackend  — wraps the existing exec + parsers (companion+ only); used for
 *                   anything API-less and as a fallback.
 *
 * Exec, arbitrary host/guest files, and in-guest agent probes are NOT here — those
 * are SSH-only (or guest-agent-only) and keep depending on SshTransport directly.
 */

export type GuestType = "qemu" | "lxc";

export interface Guest {
  vmid: number;
  name: string;
  type: GuestType;
  /** "running" | "stopped" | ... as Proxmox reports it. */
  status: string;
}

export interface Snapshot {
  name: string;
  description?: string;
  /** Unix seconds, when Proxmox reports it (the synthetic `current` node has none). */
  snaptime?: number;
  parent?: string;
}

/**
 * Proxmox lifecycle/snapshot calls are asynchronous: the API returns a UPID task
 * reference. The SSH backend returns a synthetic ref (the CLI blocks to completion).
 */
export interface TaskRef {
  /** Proxmox UPID, or a synthetic marker on the SSH path. */
  upid: string;
}

export interface NodeStatusInfo {
  loadavg?: number[];
  /** Total/used memory in bytes when available. */
  memoryTotal?: number;
  memoryUsed?: number;
  uptimeSecs?: number;
  /** PVE version string (e.g. "pve-manager/8.x"), when the backend reports it. */
  version?: string;
  /** Logical CPU count, when the backend reports it. */
  cpuCount?: number;
}

export interface StorageStatusInfo {
  storage: string;
  type: string;
  enabled: boolean;
  active: boolean;
  totalBytes: number;
  usedBytes: number;
  availBytes: number;
}

export interface AptUpdateInfo {
  package: string;
  version: string;
}

/**
 * ADR-008 §6 — a vzdump archive on a node backup storage. The `notes` field
 * carries the server's `mcp-` ownership tag (see tools/backups.ts); identity is
 * the `volid`.
 */
export interface BackupArchive {
  volid: string;
  vmid: number;
  ctime?: number;
  sizeBytes?: number;
  notes?: string;
  format?: string;
}

export interface BackupCreateOpts {
  mode: "snapshot" | "suspend" | "stop";
  storage: string;
  /** Goes into the archive notes; carries the `mcp-` ownership tag. */
  notes: string;
  compress?: string;
}

export interface NodeOps {
  listGuests(): Promise<Guest[]>;
  guestStatus(vmid: number, type: GuestType): Promise<{ status: string }>;

  startGuest(vmid: number, type: GuestType): Promise<TaskRef>;
  stopGuest(vmid: number, type: GuestType): Promise<TaskRef>;
  /** Graceful reboot (shutdown+start) of a running guest. */
  rebootGuest(vmid: number, type: GuestType): Promise<TaskRef>;

  listSnapshots(vmid: number, type: GuestType): Promise<Snapshot[]>;
  createSnapshot(vmid: number, type: GuestType, name: string, opts?: { description?: string; vmstate?: boolean }): Promise<TaskRef>;
  rollbackSnapshot(vmid: number, type: GuestType, name: string): Promise<TaskRef>;
  deleteSnapshot(vmid: number, type: GuestType, name: string): Promise<TaskRef>;

  nodeStatus(): Promise<NodeStatusInfo>;
  storageStatus(): Promise<StorageStatusInfo[]>;
  /** apt updates available (simulate-only; never runs `apt update`). */
  aptUpdates(): Promise<AptUpdateInfo[]>;

  // ADR-008 §6 — vzdump archive lifecycle (the snapshot-incapable rollback path).
  /** Create a vzdump archive of a guest. `opts.notes` carries the `mcp-` tag. */
  createBackup(vmid: number, type: GuestType, opts: BackupCreateOpts): Promise<TaskRef>;
  /** List backup archives on a storage, optionally filtered to one vmid. */
  listBackupArchives(storage: string, vmid?: number): Promise<BackupArchive[]>;
  /** Restore a guest from an archive volid (destructive whole-guest overwrite). */
  restoreBackup(vmid: number, type: GuestType, volid: string): Promise<TaskRef>;
  /** Delete one archive volume by volid. */
  deleteBackupArchive(storage: string, volid: string): Promise<TaskRef>;

  /** Which backend answered — for audit notes / diagnostics. */
  readonly kind: "api" | "ssh";
}
