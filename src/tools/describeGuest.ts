import { z } from "zod";
import type { SshTransport } from "../ssh/transport.js";
import type { Config } from "../config.js";
import { buildPctExecCommand, parsePctList } from "./pctHelpers.js";
import {
  parseQmList,
  parseGuestConfig,
  parsePvesmStatus,
  parseDockerPs,
  parseFailedUnits,
  evaluateSnapshotCapable,
  type GuestConfig,
  type SnapshotCapability,
  type DockerContainer,
} from "./censusParsers.js";
import { redactRecord } from "../guardrails/redaction.js";

/**
 * ADR-017 §4 — the per-guest census section names. `config` carries the
 * redacted guest config + snapshotCapable; `docker`/`units` are LXC-only
 * (a QEMU guest exposes neither over `pct exec`).
 */
export const GUEST_SECTIONS = ["config", "docker", "units"] as const;
export type GuestSection = (typeof GUEST_SECTIONS)[number];

export const DescribeGuestInputSchema = z.object({
  vmid: z.number().int().positive().describe("Guest VMID (LXC or QEMU)"),
  sections: z
    .array(z.enum(GUEST_SECTIONS))
    .optional()
    .describe("Sub-sections to include; defaults to all (config, docker, units)"),
});

export type DescribeGuestInput = z.infer<typeof DescribeGuestInputSchema>;

export interface DescribeGuestResult {
  vmid: number;
  kind: "lxc" | "qemu";
  name: string;
  status: string;
  /** From the config probe; absent if config was excluded or unreadable. */
  snapshotCapable?: SnapshotCapability;
  /** Redacted guest config (config section). */
  config?: GuestConfig;
  /** Docker roster inside the LXC (docker section; LXC only). */
  docker?: DockerContainer[];
  /** Failed systemd units inside the LXC (units section; LXC only). */
  failedUnits?: string[];
  /** Total secret spans masked across the returned config. */
  redactions: number;
  /** Per-probe soft failures — a failed probe is recorded, never fatal. */
  errors: Array<{ probe: string; error: string }>;
}

export interface ResolvedGuest {
  kind: "lxc" | "qemu";
  name: string;
  status: string;
}

/**
 * Pure — resolve a vmid to its kind/name/status from the parsed `pct list` and
 * `qm list` rows. LXC is checked first (vmids are unique across both on a PVE
 * node, but the deterministic order keeps the resolution stable). Returns null
 * when the vmid is in neither list.
 */
export function resolveGuestKind(
  pctRows: ReturnType<typeof parsePctList>,
  qmRows: ReturnType<typeof parseQmList>,
  vmid: number
): ResolvedGuest | null {
  const ct = pctRows.find((c) => c.vmid === vmid);
  if (ct) return { kind: "lxc", name: ct.name, status: ct.status };
  const vm = qmRows.find((v) => v.vmid === vmid);
  if (vm) return { kind: "qemu", name: vm.name, status: vm.status };
  return null;
}

/**
 * `describe_guest` (ADR-017 §4) — a single-guest census. **No new node access:**
 * it reuses the ADR-002 parsers + redaction the whole-node census already uses,
 * scoped to one vmid so an operator working a single container pays for that
 * guest's payload, not the whole forest. Companion-tier, read-only, **not
 * audited** (like `describe_homelab`). Everything it returns is reachable via
 * `describe_homelab` + `sections`; this trades one focused call for the
 * whole-node payload.
 */
export async function describeGuestHandler(
  input: DescribeGuestInput,
  transport: SshTransport,
  cfg: Config
): Promise<DescribeGuestResult> {
  const timeoutMs = cfg.ssh.commandTimeoutMs;
  const errors: DescribeGuestResult["errors"] = [];

  async function softExec(cmd: string, probe: string): Promise<string | null> {
    const r = await transport.exec(cmd, timeoutMs);
    if (r.exitCode === 0) return r.stdout;
    errors.push({ probe, error: r.stderr.trim() || `exit ${r.exitCode ?? "signal"}` });
    return null;
  }

  // Resolve identity from both guest lists. A list failure is fatal — without it
  // we cannot tell what (or whether) the vmid is.
  const pctRows = parsePctList((await transport.exec("pct list", timeoutMs)).stdout);
  const qmRows = parseQmList((await transport.exec("qm list", timeoutMs)).stdout);
  const resolved = resolveGuestKind(pctRows, qmRows, input.vmid);
  if (resolved === null) {
    throw new Error(`Guest ${input.vmid} not found in pct list or qm list`);
  }

  const want = new Set<GuestSection>(input.sections ?? GUEST_SECTIONS);
  const result: DescribeGuestResult = {
    vmid: input.vmid,
    kind: resolved.kind,
    name: resolved.name,
    status: resolved.status,
    redactions: 0,
    errors,
  };

  if (want.has("config")) {
    const configCmd = resolved.kind === "lxc" ? `pct config ${input.vmid}` : `qm config ${input.vmid}`;
    const cfgText = await softExec(configCmd, configCmd);
    if (cfgText !== null) {
      const parsed = parseGuestConfig(cfgText);
      // snapshotCapable from RAW config; redact only what we hand back.
      const storeText = await softExec("pvesm status", "pvesm status");
      const storageTypeByName =
        storeText !== null ? new Map(parsePvesmStatus(storeText).map((s) => [s.name, s.type])) : undefined;
      result.snapshotCapable = evaluateSnapshotCapable(parsed, storageTypeByName);
      const red = redactRecord(parsed, cfg.census.redactionExtraKeys);
      result.config = red.value;
      result.redactions += red.redactedCount;
    }
  }

  // docker/units are LXC-only — a QEMU guest exposes neither over `pct exec`.
  if (resolved.kind === "lxc") {
    if (want.has("docker") && resolved.status === "running") {
      const out = await softExec(
        buildPctExecCommand(
          input.vmid,
          'command -v docker >/dev/null 2>&1 && docker ps --format "{{.Names}}\\t{{.Image}}\\t{{.Status}}" || true'
        ),
        "docker ps"
      );
      result.docker = out !== null ? parseDockerPs(out) : [];
    }
    if (want.has("units") && resolved.status === "running") {
      const out = await softExec(
        buildPctExecCommand(input.vmid, "systemctl list-units --failed --no-legend --plain"),
        "systemctl --failed"
      );
      result.failedUnits = out !== null ? parseFailedUnits(out) : [];
    }
  }

  return result;
}
