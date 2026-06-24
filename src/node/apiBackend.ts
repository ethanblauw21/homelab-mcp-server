/**
 * ApiBackend (ADR-007 §3) — NodeOps over the Proxmox REST API.
 *
 * Every operation is one stateless HTTPS request to `https://<host>:8006/api2/json`
 * authenticated with an API token (`Authorization: PVEAPIToken=<id>=<secret>`), so
 * this backend rides every tier and needs no text parsers. The actual transport is
 * injected as an `ApiHttp` function: production wires it to the pinned-TLS https
 * client (`apiClient.ts`); unit tests wire it to recorded fixtures.
 *
 * Error mapping is explicit and structured (401/403/5xx) so a permission failure
 * reads as "your token lacks privilege X", not a raw HTML blob.
 */
import type {
  NodeOps,
  Guest,
  GuestType,
  Snapshot,
  TaskRef,
  NodeStatusInfo,
  StorageStatusInfo,
  AptUpdateInfo,
  BackupArchive,
  BackupCreateOpts,
} from "./nodeOps.js";
import { parseArchiveContent } from "../tools/backups.js";

export interface ApiResponse {
  status: number;
  /** Parsed JSON body (PVE wraps payloads in `{ data: ... }`). */
  json: unknown;
}

export type ApiHttp = (req: {
  method: "GET" | "POST" | "DELETE" | "PUT";
  path: string;
  body?: Record<string, unknown>;
}) => Promise<ApiResponse>;

/** `Authorization` header value for a Proxmox API token. Pure. */
export function buildTokenHeader(tokenId: string, tokenSecret: string): string {
  return `PVEAPIToken=${tokenId}=${tokenSecret}`;
}

/**
 * Map a non-2xx API response to a structured Error. Pure.
 *  - 401 ⇒ token id/secret rejected (auth).
 *  - 403 ⇒ authenticated but the token's role lacks the required privilege —
 *    the expected, informative failure when a lower tier reaches above itself.
 *  - 5xx ⇒ node-side error; surface the PVE message.
 */
export function mapApiError(status: number, json: unknown, context: string): Error {
  const msg = extractApiMessage(json);
  if (status === 401) {
    return new Error(
      `API auth failed (401) on ${context}: token id/secret rejected. ` +
        `Check PVE_API_TOKEN_ID / PVE_API_TOKEN_SECRET.${msg ? ` — ${msg}` : ""}`
    );
  }
  if (status === 403) {
    return new Error(
      `API permission denied (403) on ${context}: the token's role lacks the required ` +
        `privilege for this operation (this is Proxmox RBAC enforcing your tier).${msg ? ` — ${msg}` : ""}`
    );
  }
  if (status >= 500) {
    return new Error(`API node error (${status}) on ${context}.${msg ? ` — ${msg}` : ""}`);
  }
  return new Error(`API request failed (${status}) on ${context}.${msg ? ` — ${msg}` : ""}`);
}

function extractApiMessage(json: unknown): string | undefined {
  if (json && typeof json === "object") {
    const o = json as Record<string, unknown>;
    if (typeof o["message"] === "string") return (o["message"] as string).trim();
    if (typeof o["errors"] === "object" && o["errors"]) {
      return JSON.stringify(o["errors"]);
    }
  }
  if (typeof json === "string" && json.trim() !== "") return json.trim().slice(0, 300);
  return undefined;
}

function typeSeg(type: GuestType): string {
  return type === "lxc" ? "lxc" : "qemu";
}

export interface ApiBackendOptions {
  /** PVE node name used in `/nodes/<node>/...` paths. */
  node: string;
}

export class ApiBackend implements NodeOps {
  readonly kind = "api" as const;

  constructor(
    private readonly http: ApiHttp,
    private readonly opts: ApiBackendOptions
  ) {}

  private async unwrap(
    method: "GET" | "POST" | "DELETE" | "PUT",
    path: string,
    context: string,
    body?: Record<string, unknown>
  ): Promise<unknown> {
    const res = await this.http({ method, path, body });
    if (res.status < 200 || res.status >= 300) {
      throw mapApiError(res.status, res.json, context);
    }
    if (res.json && typeof res.json === "object" && "data" in (res.json as object)) {
      return (res.json as { data: unknown }).data;
    }
    return res.json;
  }

  private base(): string {
    return `/nodes/${this.opts.node}`;
  }

  async listGuests(): Promise<Guest[]> {
    const out: Guest[] = [];
    for (const type of ["qemu", "lxc"] as GuestType[]) {
      const data = (await this.unwrap("GET", `${this.base()}/${typeSeg(type)}`, `list ${type}`)) as
        | Array<Record<string, unknown>>
        | undefined;
      for (const g of data ?? []) {
        out.push({
          vmid: Number(g["vmid"]),
          name: String(g["name"] ?? ""),
          type,
          status: String(g["status"] ?? "unknown"),
        });
      }
    }
    return out.sort((a, b) => a.vmid - b.vmid);
  }

  async guestStatus(vmid: number, type: GuestType): Promise<{ status: string }> {
    const data = (await this.unwrap(
      "GET",
      `${this.base()}/${typeSeg(type)}/${vmid}/status/current`,
      `status ${type} ${vmid}`
    )) as Record<string, unknown>;
    return { status: String(data?.["status"] ?? "unknown") };
  }

  private async lifecycle(vmid: number, type: GuestType, action: "start" | "stop" | "reboot"): Promise<TaskRef> {
    const data = await this.unwrap(
      "POST",
      `${this.base()}/${typeSeg(type)}/${vmid}/status/${action}`,
      `${action} ${type} ${vmid}`
    );
    return { upid: typeof data === "string" ? data : String(data ?? "") };
  }

  startGuest(vmid: number, type: GuestType): Promise<TaskRef> {
    return this.lifecycle(vmid, type, "start");
  }
  stopGuest(vmid: number, type: GuestType): Promise<TaskRef> {
    return this.lifecycle(vmid, type, "stop");
  }
  rebootGuest(vmid: number, type: GuestType): Promise<TaskRef> {
    return this.lifecycle(vmid, type, "reboot");
  }

  async listSnapshots(vmid: number, type: GuestType): Promise<Snapshot[]> {
    const data = (await this.unwrap(
      "GET",
      `${this.base()}/${typeSeg(type)}/${vmid}/snapshot`,
      `list snapshots ${type} ${vmid}`
    )) as Array<Record<string, unknown>> | undefined;
    return (data ?? [])
      .filter((s) => s["name"] !== "current")
      .map((s) => ({
        name: String(s["name"]),
        description: typeof s["description"] === "string" ? (s["description"] as string) : undefined,
        snaptime: typeof s["snaptime"] === "number" ? (s["snaptime"] as number) : undefined,
        parent: typeof s["parent"] === "string" ? (s["parent"] as string) : undefined,
      }));
  }

  createSnapshot(
    vmid: number,
    type: GuestType,
    name: string,
    opts?: { description?: string; vmstate?: boolean }
  ): Promise<TaskRef> {
    const body: Record<string, unknown> = { snapname: name };
    if (opts?.description) body["description"] = opts.description;
    if (opts?.vmstate && type === "qemu") body["vmstate"] = 1;
    return this.unwrap(
      "POST",
      `${this.base()}/${typeSeg(type)}/${vmid}/snapshot`,
      `create snapshot ${name} on ${type} ${vmid}`,
      body
    ).then((d) => ({ upid: typeof d === "string" ? d : String(d ?? "") }));
  }

  rollbackSnapshot(vmid: number, type: GuestType, name: string): Promise<TaskRef> {
    return this.unwrap(
      "POST",
      `${this.base()}/${typeSeg(type)}/${vmid}/snapshot/${name}/rollback`,
      `rollback ${type} ${vmid} to ${name}`
    ).then((d) => ({ upid: typeof d === "string" ? d : String(d ?? "") }));
  }

  deleteSnapshot(vmid: number, type: GuestType, name: string): Promise<TaskRef> {
    return this.unwrap(
      "DELETE",
      `${this.base()}/${typeSeg(type)}/${vmid}/snapshot/${name}`,
      `delete snapshot ${name} on ${type} ${vmid}`
    ).then((d) => ({ upid: typeof d === "string" ? d : String(d ?? "") }));
  }

  async nodeStatus(): Promise<NodeStatusInfo> {
    const data = (await this.unwrap("GET", `${this.base()}/status`, "node status")) as Record<string, unknown>;
    const mem = data?.["memory"] as Record<string, unknown> | undefined;
    const cpuinfo = data?.["cpuinfo"] as Record<string, unknown> | undefined;
    return {
      loadavg: Array.isArray(data?.["loadavg"]) ? (data["loadavg"] as unknown[]).map(Number) : undefined,
      memoryTotal: mem && typeof mem["total"] === "number" ? (mem["total"] as number) : undefined,
      memoryUsed: mem && typeof mem["used"] === "number" ? (mem["used"] as number) : undefined,
      uptimeSecs: typeof data?.["uptime"] === "number" ? (data["uptime"] as number) : undefined,
      version: typeof data?.["pveversion"] === "string" ? (data["pveversion"] as string) : undefined,
      cpuCount: cpuinfo && typeof cpuinfo["cpus"] === "number" ? (cpuinfo["cpus"] as number) : undefined,
    };
  }

  async storageStatus(): Promise<StorageStatusInfo[]> {
    const data = (await this.unwrap("GET", `${this.base()}/storage`, "storage status")) as
      | Array<Record<string, unknown>>
      | undefined;
    return (data ?? []).map((s) => ({
      storage: String(s["storage"] ?? ""),
      type: String(s["type"] ?? ""),
      enabled: s["enabled"] === 1 || s["enabled"] === true,
      active: s["active"] === 1 || s["active"] === true,
      totalBytes: Number(s["total"] ?? 0),
      usedBytes: Number(s["used"] ?? 0),
      availBytes: Number(s["avail"] ?? 0),
    }));
  }

  async aptUpdates(): Promise<AptUpdateInfo[]> {
    const data = (await this.unwrap("GET", `${this.base()}/apt/update`, "apt updates")) as
      | Array<Record<string, unknown>>
      | undefined;
    return (data ?? []).map((p) => ({
      package: String(p["Package"] ?? p["package"] ?? ""),
      version: String(p["Version"] ?? p["version"] ?? ""),
    }));
  }

  // ADR-008 §6 — vzdump archive lifecycle over the REST API.

  createBackup(vmid: number, _type: GuestType, opts: BackupCreateOpts): Promise<TaskRef> {
    const body: Record<string, unknown> = {
      vmid,
      storage: opts.storage,
      mode: opts.mode,
      compress: opts.compress ?? "zstd",
      "notes-template": opts.notes,
      remove: 0, // server-side rotation is OUR job (mcp- retention), not vzdump's
    };
    return this.unwrap("POST", `${this.base()}/vzdump`, `vzdump ${vmid}`, body).then((d) => ({
      upid: typeof d === "string" ? d : String(d ?? ""),
    }));
  }

  // ADR-023 #9 — poll a task's terminal status. `createBackup` (and the other
  // lifecycle calls) return a UPID before the task finishes; without this a vzdump
  // that fails async (e.g. the target storage lacks `backup` content) would read
  // as success. The UPID contains colons, so it is URL-encoded for the path.
  async taskStatus(upid: string): Promise<{ status: string; exitstatus?: string }> {
    const data = (await this.unwrap(
      "GET",
      `${this.base()}/tasks/${encodeURIComponent(upid)}/status`,
      `task status ${upid}`
    )) as Record<string, unknown> | null;
    const exit = data?.["exitstatus"];
    return {
      status: String(data?.["status"] ?? "unknown"),
      exitstatus: typeof exit === "string" ? exit : undefined,
    };
  }

  async listBackupArchives(storage: string, vmid?: number): Promise<BackupArchive[]> {
    const data = await this.unwrap(
      "GET",
      `${this.base()}/storage/${storage}/content?content=backup`,
      `list backups on ${storage}`
    );
    const all = parseArchiveContent(data).map((a) => ({
      volid: a.volid,
      vmid: a.vmid,
      ctime: a.ctime,
      sizeBytes: a.sizeBytes,
      notes: a.notes,
      format: a.format,
    }));
    return vmid === undefined ? all : all.filter((a) => a.vmid === vmid);
  }

  restoreBackup(vmid: number, type: GuestType, volid: string): Promise<TaskRef> {
    // LXC restore is POST /lxc with ostemplate=<volid>+restore=1; QEMU is POST
    // /qemu with archive=<volid>. Both force-overwrite the existing guest.
    const seg = typeSeg(type);
    const body: Record<string, unknown> =
      type === "lxc"
        ? { vmid, ostemplate: volid, restore: 1, force: 1 }
        : { vmid, archive: volid, force: 1 };
    return this.unwrap(
      "POST",
      `${this.base()}/${seg}`,
      `restore ${type} ${vmid} from ${volid}`,
      body
    ).then((d) => ({ upid: typeof d === "string" ? d : String(d ?? "") }));
  }

  deleteBackupArchive(storage: string, volid: string): Promise<TaskRef> {
    return this.unwrap(
      "DELETE",
      `${this.base()}/storage/${storage}/content/${encodeURIComponent(volid)}`,
      `delete archive ${volid}`
    ).then((d) => ({ upid: typeof d === "string" ? d : String(d ?? "") }));
  }
}
