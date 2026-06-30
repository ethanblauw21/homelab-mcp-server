# ADR-023: Dogfooding Hardening — Bug Fixes & Consistency Pass from a Live-Node Stress Test

**Status:** Accepted
**Date:** 2026-06-23
**Deciders:** Ethan
**Depends on:** ADR-004 (transport/guardrail/exit semantics), ADR-005 (`tail_log`/probes patterns), ADR-007 (tiers + MCPOperate role), ADR-008 (`guest_backup` vzdump fallback), ADR-009 (integrity watched set), ADR-011 (edit-tools over write-tools), ADR-020 (probes/regex/systemd front door)
**Required by:** — none yet —
**Source:** A full live-node dogfooding session against `proxlab` (companion tier, CT100 adguard-dns + CT101 dockerBoss) — every registered tool was exercised ~5× with a mutation/adversarial mindset. This ADR records the defects and rough edges that surfaced and the changes needed to close them.

## Context

The dogfooding run confirmed the guardrail layer is solid: the two-tier denylist (DENY + CONFIRM), charset validation (units, hosts, container names, paths), tier refusals (host targets → root), confirm gates (restart/stop/rollback/backup/redeploy), honest exit semantics (signal-kill → `exitCode: null`, never coerced), ADR-019 read redaction, ADR-022 audit.db FTS-with-redaction (a secret written into a file was **not** searchable while its path was), and the `mcp-` snapshot/archive ownership boundary. Those need no change.

It also surfaced a cluster of **real bugs** and **consistency rough edges**, several sharing a single root cause. This ADR is the batch fix.

## Decision 1 — Fix the `pct` "missing file reads as empty" root cause (B1)

**The bug.** `pct_read_file` / the underlying `pct pull` of a **nonexistent** path silently returns **empty content with no error**, where `docker_read_file` correctly raises "File not found". This single defect cascades into four observed symptoms, each of which the `docker_*` equivalent gets right:

| Symptom | `pct_*` (buggy) | `docker_*` (correct) |
|---|---|---|
| read missing file | empty output, no error | clean "File not found" |
| write a **new** file → `newFile` flag | `false` | `true` |
| write a new file → backup content | a backup of the **empty string** (`e3b0c442…`) ⇒ a later revert *empties* the file | new-file marker, self-contained |
| write a new file → `isLargeChange` | `false` (new-file reason missed) | `true` ("new file creation") |
| edit a **missing** file | "oldString was not found in the file" (implies it exists) | n/a |

**Root cause.** The `pct` "read previous content" path treats a failed/empty `pct pull` as `prevContent = ""` instead of `prevContent = null` (missing). New-file detection, large-change detection, the backup base, and the edit-precondition all then misbehave.

**Fix.** In the `pct` prev-read (mirror of `readHostPrev`/the docker resolver), distinguish *file absent* (return `null`/throw a typed not-found) from *file present but empty* (`""`). Then:
- `pct_read_file` raises a "File not found" error for a missing path (parity with `docker_read_file`).
- `pct_write_file` reports `newFile: true`, skips the empty-base backup (new file ⇒ revert deletes, not empties), and flags `isLargeChange` for new-file creation.
- `pct_edit_file` reports "file does not exist" for a missing target.

## Decision 2 — `http_probe` must return a structured unreachable result, not throw an SSH error (B2)

**The bug.** `http_probe http://host:closedport/` throws `connect ECONNREFUSED … — SSH connection refused. Verify SSH_HOST … npm run doctor`. The host-side probe uses Node `http`, not SSH at all. Two defects: (a) a closed/unreachable target **throws** instead of returning a structured negative like `tcp_ping` does; (b) the error is decorated with an **SSH** diagnostic — a global `ECONNREFUSED → SSH` mapper is catching a non-SSH failure.

**Fix.** In `httpRequest` (probes.ts), catch connection-class errors (`ECONNREFUSED`/`ENOTFOUND`/`ETIMEDOUT`/timeout) and resolve to `{ status: 0, ok: false, bodyBytes: 0, latencyMs, from }` (the reachability check's honest "no"), mirroring `tcp_ping`. Ensure the SSH-error decorator never wraps a host-side probe failure (scope it to the SSH transport).

## Decision 3 — `search_file_regex` must honor `context: 0` (B3)

**The bug.** The schema declares `context` `minimum: 0`, but the handler's `clamp()` does `Math.max(1, …)`, so `context: 0` silently returns **1** context line. Schema and implementation disagree.

**Fix.** Allow `0` for the context clamp (`Math.max(0, Math.min(req, max))`); keep `maxMatches` floored at 1. A pure-unit test pins `context: 0 ⇒ before: [], after: []`.

## Decision 4 — `docker_read_file` relay must handle symlinks (B4)

**The bug.** The `docker cp` slow-path relay fails on a symlinked file (`/etc/os-release → ../usr/lib/os-release`) with `invalid symlink`. Symlinked files are unreadable via the relay.

**Fix.** Use `docker cp -L` (follow symlinks) on the relay, or fall back to `docker exec cat` for a path that `docker cp` reports as a symlink. Add a note in the result when the symlink was dereferenced.

## Decision 5 — `snapshot_rollback` must not report a false restart failure (B5)

**The bug.** The real rollback (stop → rollback → restart) returned `Rolled back, but failed to restart guest 100 (exit null)` even though the guest **did** restart (`pct_list` = running, DNS up, service active). The SSH-routed restart's wait returns `exitCode: null` (timeout/signal) and the orchestrator treats `null` as failure. The API-native `guest_restart` path, by contrast, returns a clean task UPID.

**Fix.** After issuing the post-rollback start, **verify run-state** (poll `status` until running or a bounded deadline) rather than trusting the start command's exit code; only report failure if the guest is still stopped. Reuse the `NodeOps` start+status path where available.

## Decision 6 — `guest_backup` must actually work at companion (B6) — highest operational impact

**The bug.** `guest_backup` → `403 … Datastore.AllocateSpace` on `/storage/local`. The `MCPOperate` role (`VM.Audit VM.PowerMgmt VM.Snapshot VM.Snapshot.Rollback VM.Config.Options Sys.Audit Datastore.Audit`) lacks the privilege vzdump needs to allocate an archive, and `guest_backup` routes via the API. **Consequence:** the guest that most needs the vzdump fallback — CT101/dockerBoss, which is snapshot-incapable (GPU passthrough + bind mount) — can neither snapshot **nor** back up. It has no working rollback path at companion. ADR-008 §6 designed `guest_backup` precisely for this guest; the privilege gap defeats it.

**Fix (both halves):**
1. **Provisioning:** add `Datastore.AllocateSpace` (and `Datastore.AllocateTemplate` if restore needs it) to the `MCPOperate` role in `scripts/setup.mjs`. Re-running setup updates the role.
2. **Routing:** since `guest_backup`/`guest_backup_restore` are MCP-enforced **companion** tools and SSH is available at companion, prefer the **SSH (`vzdump`) route** at companion instead of the RBAC-limited API token — matching the "API where it can, SSH otherwise" contract but choosing SSH when the API token provably can't allocate. Document the precedence in `tools/backupTools.ts`.

## Decision 7 — Uniform "guest not found" handling (E1)

`guest_*` / `describe_guest` / `config_sweep` return clean not-found / not-running messages; `snapshot_list`, `docker_ps`, `docker_stats`, `docker_logs`, `compose_discover`, `compose_preflight` leak the raw `Configuration file 'nodes/proxlab/{lxc,qemu-server}/<vmid>.conf' does not exist`. **Fix:** a shared guest-existence precheck (reuse `pct_list`/`qm_list` membership) that yields one uniform `Guest <vmid> not found` before the tool-specific command runs.

## Decision 8 — Minor rough edges (E2–E7)

- **E2** `guest_start` on an already-running guest leaks a raw API `500 … already running`. Return a clean idempotent result (`{ alreadyRunning: true }`) instead.
- **E3** `describe_homelab` `sections: []` (empty array) returns nothing; the documented default ("all") only applies when omitted. Either treat `[]` as "all" or document the empty-array semantics in the field description.
- **E4** The integrity watched set folds `/etc/pve` **volatile runtime files** (`.rrd`, `.version`, `nodes/*/lrm_status`, and other pmxcfs-generated state) that change every few seconds, producing perpetual benign `unexplained` drift. Add them to `integrity`/`history` `excludePatterns` so drift reports surface only real config changes.
- **E5** There is no `guest_backup_delete`; archives are only auto-evicted by per-guest retention. Consider a delete verb (mcp-only, confirm-gated) so a test/one-off archive can be removed without waiting for the next backup.
- **E6** `compose_preflight` of a **currently-running** stack flags the running services' own ports as "bound elsewhere (holder unknown)". The detail text hedges honestly, but the check could skip ports whose binder is a member of the analyzed stack.
- **E7** `describe_homelab` `compareToPrevious: true` returned no `drift` field when combined with a `sections` filter — confirm whether drift is intentionally suppressed for a narrowed census or is a gap.

## Decision 9 — Consolidation: fold `service_logs` semantics toward `tail_log` (redundancy)

The dogfooding brief asked for redundancy in the tool count. The surface is mostly justified by a (transport × operation × tier) matrix, with one clear candidate: **`service_logs` is "`tail_log` with a unit-only contract"** that already delegates to `buildTailCommand`. The only real difference is **tier** (`service_logs` follows the target kind → a host unit is root-gated; `tail_log` is the companion host-journal escape hatch). Two honest options:

- **(a) Keep both**, but document that `service_logs` exists solely to impose the stricter target-kind tier on the journal read — i.e. it is a *policy alias*, not new function.
- **(b) Merge** into one `tail_log` with an explicit `tierPolicy: "follow-target" | "escape-hatch"` flag, removing a registered tool.

A lighter view-overlap also exists in the docker-roster trio (`describe_guest[docker]` ⊂ `docker_ps` ⊂ `compose_discover`) — three structurings of the running-container set — but each answers a distinct operator question (inventory / ops / deploy-target), so no merge is proposed there.

**Recommendation:** (a) — keep `service_logs` but annotate it as a tier-policy alias; the tier asymmetry is load-bearing and a flag would bury it. Revisit if the tool count becomes a maintenance burden.

## Implementation status (2026-06-23)

Shipped in this branch and verified; full unit suite green (1265 tests / 97 files), build + lint clean.

| ID | Change | State | Verification |
|---|---|---|---|
| **B1** | `pullContainerFile` decides existence with an explicit `test -e`, not `pct pull`'s unreliable exit code; missing → `null` | **Shipped + tested** | Live: `pct_read_file(100, /nonexistent)` → "File not found inside container 100" (was empty). Regression tests in `pctFiles.test.ts`. |
| **B2** | `http_probe` connection-class failure resolves to `{status:0, ok:false}` instead of throwing an SSH-misattributed error | **Shipped** | Live: `http_probe(:9999)` → `{status:0, ok:false, from:"host"}` (was an SSH error throw). |
| **B3** | `search_file_regex` `clamp` floors `context` at 0 so `context:0` is honored | **Shipped + tested** | Live: `search_file_regex(..., context:0)` → `after:[]` (was 1 line). |
| **B4** | `docker_read_file` relay uses `docker cp -L` to follow symlinks | **Shipped + tested** | Live: `docker_read_file(101, qbittorrent, /etc/os-release)` → reads bytes (was "invalid symlink"). |
| **B5** | `snapshot_rollback` verifies the post-rollback restart by POLLING run-state (`pct/qm status`) until running or a bounded deadline, instead of trusting the start command's `exitCode` | **Shipped + unit-tested + LIVE-VALIDATED (2026-06-23/24, follow-up branch)** | New `waitForGuestRunning` poll (bounded by `snapshot.restartPollIntervalMs`/`restartTimeoutMs`, injectable sleep). Unit tests pin both the false-failure regression (start `exitCode:null` + running ⇒ success) and the genuine failure (stays non-running past the deadline ⇒ throw). **Live-validated** against a throwaway LXC (vmid 9001, debian-13 on snapshot-capable `local-lvm`, provisioned + destroyed via the companion SSH credential — production CT100/CT101 untouched): the fixed handler ran the full stop→rollback→restart cycle, returned `restarted: true` with the guest genuinely `running` and the post-snapshot change correctly discarded; and the exact bug trigger was reproduced raw (`timeout 1 pct start 9001` → **exit 124** while `pct status` → **running**), the condition the old `exitCode !== 0` check mis-read as a restart failure. |
| **B6** | `setup.mjs` grants the `MCPOperate` role `VM.Backup` + `Datastore.AllocateSpace` for vzdump | **Shipped + re-provisioned + verified live** | After re-running setup with `-RotateToken`, `guest_backup(100, snapshot)` succeeded (archive `mcp-20260623-123157`, task UPID returned) — **no 403**. The snapshot-incapable guest now has a working rollback path. |
| **E2** | `guest_start` on an already-running guest is idempotent (`{alreadyRunning:true}`, no `startGuest` call) | **Shipped + tested** | Unit test pins the no-op; avoids the raw API 500. |
| **E4** | pmxcfs volatile runtime files (`.rrd`/`.version`/`lrm_status`/…) added to `excludePatterns` | **Shipped** | Removes perpetual benign `unexplained` integrity drift. |

### Deferred to a follow-up (NOT implemented here)

These were left uncoded **deliberately** — each needs a live guest-cycle re-test or is a larger surface change, and shipping them blind would risk the production LXCs:

- **B5 — `snapshot_rollback` false restart-failure (~~DEFERRED~~ RESOLVED 2026-06-23, follow-up branch).** The SSH-routed post-rollback restart reported `failed to restart … (exit null)` even though the guest *does* come back (confirmed during dogfooding: `pct_list` running, DNS up, service active). **Fixed** per Decision 5: the handler now issues the start and then **polls run-state** (`waitForGuestRunning`, bounded by the new `snapshot.restartPollIntervalMs`/`restartTimeoutMs` config + `SNAPSHOT_RESTART_*` env) until the guest is running or the deadline, failing only if it is genuinely still not running — the start command's `exitCode` is no longer trusted. Unit tests pin both the false-failure regression and the real-failure path. The deferral concern (can't validate without a live rollback cycle) is now **resolved with a live test** (2026-06-24): a throwaway debian-13 LXC (vmid 9001) was provisioned on snapshot-capable `local-lvm` and destroyed afterward via the companion SSH credential (no persistent root-tier re-enable; production CT100/CT101 untouched), the **fixed handler imported from the freshly built `dist`** drove a real stop→rollback→restart returning `restarted: true` with the guest `running` and the post-snapshot marker discarded, and the precise bug trigger was reproduced raw — `timeout 1 pct start 9001` exits **124** while the guest reaches **running**, exactly the non-zero-start-but-came-up case the old code mis-reported. The change is conservative (it can only *suppress* a false failure or *report a real* one).
- **E1** uniform "guest not found" across `snapshot_list`/`docker_*`/`compose_*` (shared precheck).
- **E3 / E5 / E6 / E7** — empty-`sections` semantics, a `guest_backup_delete` verb, `compose_preflight` own-port noise, and `describe_homelab` `compareToPrevious`-with-`sections` drift.
- **Decision 9 (redundancy)** — recommendation (a): keep `service_logs` as an annotated tier-policy alias; no removal.

## qm_* live verification addendum (2026-06-23)

The original run could not exercise `qm_*` beyond refusal paths (no VM existed). That **coverage gap is now closed**: a temporary root window provisioned a throwaway Debian 12 cloud VM (vmid 9000, `qemu-guest-agent` via a cloud-init snippet), the full `qm_*` family was dogfooded ~5×+ each with a mutation mindset, and the VM + all host changes were torn down (window closed back to companion). The family is **healthy** — every guardrail held and the honest-exit/parity behaviors the `pct`/`docker` siblings have are present here too:

- `qm_read_file`: missing file → clean "File not found inside VM" (**no B1 analog** — the agent file-read path correctly distinguishes absent from empty); windowed read, base64, directory→error, past-EOF→empty, and `redact:true` (password/api_token → `[REDACTED]`, true pre-redaction `bytes`) all correct.
- `qm_write_file`/`qm_edit_file`: `dryRun` new-file detection (`isNewFile:true`), real write + backup/audit, overwrite-of-existing, write→read roundtrip fidelity, and every edit guardrail (unique match, ambiguous-without-`replaceAll` refusal, no-op refusal, missing-file refusal, `replaceAll`) all correct.
- `qm_exec`: DENY (`rm -rf /`), CONFIRM-gate refusal (`reboot`), honest `exitCode` propagation (`exit 7`), stderr capture all correct.

Two **real bugs** surfaced and are fixed in this branch (tests pin both):

- **F1 — `qm_list`/census `bootDiskGB` inflated ~100×.** The shared `parseQmList` (`censusParsers.ts`) ran the `BOOTDISK(GB)` column — which `qm list` always formats as a float (`3.00`, `8.50`) — through the integer parser `toInt`, whose `replace(/[^\d-]/g,"")` **strips the decimal point**, so `3.00 → "300" → 300`. Affected `qm_list` **and** `describe_homelab`/`describe_guest` (same parser). Fix: a decimal-preserving `toNum` for that one float column. The pre-existing parser test used `32.00`/`64.00` inputs but **never asserted `bootDiskGB`**, which is why it slipped — the regression test now asserts the value.
- **F2 — `qm_exec` timeout surfaced a cryptic `exit 124` instead of the documented `timedOut:true`/`exitCode:null`/guest-pid.** The handler passed the *same* `timeoutMs` as both the agent `--timeout` (seconds) **and** the SSH transport's node-side `timeout` wrapper, so the wrapper killed `qm guest exec` at the same instant the agent timeout would have returned its honest `exited:false` blob. The documented honest-timeout path was effectively unreachable. Fix: give the transport wrapper `commandTimeoutGraceMs` of headroom over the agent `--timeout`, so the agent returns first and `parseAgentExec` reports the real timeout semantics.

Two observations folded into already-deferred items (not separately fixed here):

- **E1 confirmed to span `qm_*`.** `qm_agent_ping`/`qm_exec`/`qm_read_file`/`qm_write_file` on a non-VM or absent vmid leak the raw `Configuration file 'nodes/<node>/qemu-server/<vmid>.conf' does not exist` instead of a uniform "VM `<vmid>` not found." Same E1 root cause; the shared guest-existence precheck (Decision 7) should cover the `qm_*` family when implemented.
- **Denylist newline-normalization false-positive (tripwire limit).** A multi-line `execute` whose `rm` targeted `/var/lib/vz/...` and which *separately* read `/etc/pve/storage.cfg` was refused by the protected-set guard: whitespace normalization collapsed the two unrelated commands onto one line, so `rm … /etc/pve` matched across them. This is the documented "tripwire, not a sandbox" behavior (ADR-004) failing **safe** (a false deny, never a false allow), so it is recorded, not fixed — splitting the commands is the workaround.

## Second dogfooding pass (2026-06-24) — four more findings (G1–G4)

A second full live run against `proxlab` (companion token + an in-session root window), now with B6's `Datastore.AllocateSpace` grant in place, surfaced four more issues. G2 is the same defect as **B5** (already shipped here) — the live run only re-exhibited it because the running `dist/` had been rebuilt from `master`, which predates this branch's B5 fix; no code change was needed, only a rebuild/merge. G1, G3, G4 are new.

### Decision 10 — `guest_backup` must not report an async vzdump failure as success (G1, headline)

**The bug.** Two compounding defects beyond B6's RBAC fix:
1. **Silent async failure.** The API path (`ApiBackend.createBackup`) returns the vzdump **UPID immediately**; `unwrap()` only checks the task *creation* HTTP 200, never the task's eventual `exitstatus`. A vzdump that fails **after** submission was reported as **success** (UPID + `evicted:[]`). Live, the task's real `exitstatus` was `could not get storage information for 'local': can't use storage 'local' for backups - wrong content type` — yet the tool returned success.
2. **Wrong-content-type footgun.** `cfg.backup.nodeBackupStorage` defaults to `"local"`, which on a default PVE install carries `import,vztmpl,iso` — **not** `backup`. There was no per-call `storage` override. (The SSH path is unaffected: `SshBackend.exec` throws on a non-zero exit, so a failed `vzdump` is already loud there.)

**Fix.**
- Add optional `taskStatus(upid)` to `NodeOps` (`ApiBackend` implements it via `GET /nodes/<node>/tasks/<upid>/status`; the SSH backend may omit it — it is already synchronous-loud). `guestBackupHandler` now **polls the task to completion** on the API path (bounded by new `backup.taskPollIntervalMs`/`taskTimeoutMs` config + `BACKUP_TASK_*` env, injectable sleep) and **throws + audits a failure** (`isLargeChange:false`, note `…FAILED:<exitstatus>`) instead of returning false success.
- Add an optional **`storage`** param to `guest_backup` (charset-validated via `assertStorageName`) that overrides `NODE_BACKUP_STORAGE`; the failure message names the `backup`-content-type requirement. **Operator remediation** for this node: `NODE_BACKUP_STORAGE=media-backup` (the dir store that carries `backup,images,rootdir`).

### Decision 11 — `snapshot_rollback` false restart-failure was already fixed (G2 = B5)

No change. The live re-occurrence was the stale `dist/` (built from `master`); the branch source already polls run-state per B5 and its unit tests pin both the false-failure and genuine-failure cases. Rebuild/merge deploys it.

### Decision 12 — `docker_exec` must not 127 on minimal images (G3)

**The bug.** `buildDockerExecCommand` unconditionally wrapped the inner command with coreutils `timeout` **inside the container**, so distroless/scratch images (e.g. portainer) that lack the `timeout` binary failed `exit 127: exec: "timeout": not found`. Full distros (jellyfin/uptime-kuma) worked. The host-side `pct exec` `timeout` already bounds how long the server waits, so the in-container layer is redundant for the *wait*, only adding reliable in-guest *termination*.

**Fix.** The in-container timeout is now **best-effort**: the wrapper probes `command -v timeout` at run time and falls back to a bare shell when it is absent (`if command -v timeout …; then exec timeout … ${shell} -c '<cmd>'; else exec ${shell} -c '<cmd>'; fi` — `exec` avoids the `&&`/`||` short-circuit trap). Reliable in-guest termination is kept where `timeout` exists; the host wrapper still bounds the wait everywhere.

### Decision 13 — `diff_config` must accept Docker targets (G4)

**The bug.** `diff_config` only built `host` or `{kind:"pct",vmid}` targets — a passed `container` was stripped (zod `.strip()`), so a Docker file resolved as a bare host path and returned "No backups found", even though `list_backups` **and** `revert_file` (via blob meta) handle Docker. `readCurrentForTarget` already supported `kind:"docker"`; the gap was purely in the handler's target resolution. (This also reconciles the CLAUDE.md claim that "`list_backups`/`diff_config` accept a `container` param," which was previously true only of `list_backups`.)

**Fix.** Add a `container` field to the schema and a shared `targetFromInput(path, vmid, container)` resolver (docker > pct > host; `container` requires `vmid`), used by both the `backupPath`-fallback and `path`-only branches.

| ID | Change | State | Verification |
|---|---|---|---|
| **G1** | `guest_backup` polls the vzdump task (`NodeOps.taskStatus`) on the API path and throws+audits a real failure; adds a `storage` override + `backup.task*` config | **Shipped + tested** | Unit tests pin verified-success, the live `wrong content type` async failure → loud throw + `isLargeChange:false` audit, the timeout path, the `storage` override, and an illegal-storage refusal. `apiBackend.test.ts` pins the url-encoded task-status GET. |
| **G2** | (= B5) no code change; stale `dist` re-exhibited it | **Already shipped** | B5 source + unit tests; rebuild/merge deploys. |
| **G3** | `docker_exec` in-container timeout is best-effort (`command -v timeout` fallback) | **Shipped + tested** | `dockerHelpers.test.ts` pins the probe/fallback shape for `sh` and `bash`; the bare-`timeout` 127 path is gone. |
| **G4** | `diff_config` resolves Docker targets from `path+vmid+container` | **Shipped + tested** | `diffConfig.test.ts` pins the docker target resolution (asserts `seenTarget` + a real diff) and the `container`-without-`vmid` refusal. |

### Decision 14 — Consistency backlog (G5–G7)

The remaining "consider/confirm" rough edges from the dogfooding notes, resolved.

**G5 (#3/#7) — unknown params are silently stripped (systemic, false success).** Zod's default object behavior is `.strip()`: a hallucinated/mis-remembered param name is **dropped with no error** and the handler runs with a default, reporting success. Hit twice live — `docker_logs` `lines:8` (the model used the sibling `tail_log`'s param name and this tool's own *output* field name) was dropped → clamped to the 100-line cap → dumped a huge log; `snapshot_create` `name`/`description` were dropped → auto-named "no-description" snapshot.
- **Fix (central):** `strictifyInputSchema` (`util/strictSchema.ts`, pure) applies `.strict()` to every tool's `inputSchema` at the `register` boundary in `index.ts`, so an unknown top-level key becomes a loud MCP `Input validation error`. Verified safe against the SDK contract: `@modelcontextprotocol/sdk` (`zod-compat.js`) passes a ZodObject through to `safeParseAsync` **unchanged**, so the strict setting takes effect. Non-object schemas (unions/effects/raw shapes) and `.passthrough()` objects are returned untouched, so it is safe to apply blanket-style. Handlers are unit-tested directly (bypassing SDK validation), so no existing test regresses.
- **Fix (root cause of #3):** `docker_logs` now names its line-count param **`lines`** (matching the sibling `tail_log` and its own `lines` output field), with `tail` kept as a back-compat alias (`lines` wins if both are given) — the cross-tool naming inconsistency that triggered the silent strip is gone, and strict catches any third name.

**G6 (#6) — `revert_file` latest-resolution.** `revert_file` required an explicit `backupPath`, while `diff_config`/`list_backups` auto-resolve the latest for a target — an asymmetry for the common "undo my last change to this file" case. **Fix (opt-in, non-breaking):** when `backupPath` is omitted, `revert_file` resolves the **newest revertible** backup for the target named by `path` (+`vmid`/`container`), via the now-shared `targetFromInput` (`backup/store.ts`, also used by `diff_config`). The explicit-`backupPath` form is unchanged; the rollback circuit breaker still applies.

**G7 (#1) — `describe_homelab` depth monotonicity.** `depth` was non-monotonic: `summary` and `full` included the `services[].docker` roster but `status` (between them) dropped it — a mid-depth that lost data a lower depth showed. **Decision:** keep the roster at **all** depths (`summary ⊆ status ⊆ full`); `status` stays leaner than `full` by dropping only the bulky per-guest **config** blob, making it the "roster without config" tier. (Chosen over the alternative of dropping the roster from `summary` too — keeping the roster everywhere preserves the most-useful at-a-glance default and adds a config-free roster tier.)

| ID | Change | State | Verification |
|---|---|---|---|
| **G5** | central `.strict()` on tool input schemas (`strictifyInputSchema`); `docker_logs` param renamed `tail`→`lines` (alias kept) | **Shipped + tested** | `strictSchema.test.ts` pins reject-unknown / keep-declared / passthrough / non-object passthrough; `dockerLogs.test.ts` covers the `lines`/`tail` alias. SDK contract read to confirm strict survives normalization. |
| **G6** | `revert_file` resolves the newest revertible backup when `backupPath` is omitted (shared `targetFromInput`) | **Shipped + tested** | `revertFile.test.ts` pins host latest-resolution (newest-revertible wins over a newer metadata-only), docker target resolution, the no-target and no-revertible-version refusals, and `container`-without-`vmid`. |
| **G7** | `describe_homelab` keeps the docker roster at every depth (monotonic ladder) | **Shipped + tested** | `describeHomelab.test.ts` status-depth case now asserts the roster is present + config blob withheld. |

## Consequences

- Six bug fixes (B1–B6) restore parity between the `pct`/`docker`/host families and remove two false-failure reports (`http_probe`, `snapshot_rollback`) that would mislead an operator. B6 restores the only rollback path for the snapshot-incapable guest — the highest-value fix.
- The consistency pass (E1–E7) makes not-found/idempotent/empty-input behavior uniform and quiets perpetual integrity noise.
- No new tool, transport, store, or dependency is added; every change is a correctness/parity fix or a provisioning-privilege addition.
- The redundancy review concludes the surface is justified; only `service_logs` is annotated, not removed.

## Honest non-goals

- This ADR does not re-litigate the deliberate tier asymmetries (`tail_log` companion host-read vs the root-gated rest) — those are documented design (ADR-005/007), and the dogfooding confirmed they behave as specified.
- ~~The `qm_*` family could not be exercised beyond its refusal paths (no VM exists on the node); its mutation surface is unverified live and is called out as a coverage gap, not a finding.~~ **Resolved 2026-06-23** — see the "qm_* live verification addendum" above: the family was dogfooded live against a throwaway VM, found healthy, and two bugs (F1/F2) were fixed.

---

## Third dogfooding pass (2026-06-30)

A third full live pass on **proxlab/10.0.0.10** at **companion tier** (root flag unset → the host tools `execute`/`read_file`/`write_file`/`edit_file`/`list_directory` were *unregistered* and could not be exercised — clean ADR-007 behavior, not a finding; `qm_*` stayed ⚪ N/A, no VMs). ~60 tools exercised; full per-call log in `docs/dogfooding/SESSION-2026-06-24b.md`. The prior-pass fixes (B5/#8, #9/G1 write-side, G4 `diff_config` docker, G6 `revert_file` auto-latest, G7 monotonic depth) all **confirmed deployed**.

Findings are relabeled **H1–H9** here to avoid colliding with the qm-addendum's F1/F2 above. This decision lands the three **🔴 critical** one-liners (H1/H2/H3); the 🟡 backlog (H4–H9) is recorded below for follow-up passes.

### Decision 15 — the three critical portability bugs (H1/H2/H3)

**Theme.** All three are the *same class*: a shared helper reused across an **environment boundary** without adapting the env-specific detail — a GNU-vs-BusyBox flag dialect, a journalctl-vs-docker time grammar, and a write-vs-read storage name. Each had passed unit tests that pinned the *wrong* (un-adapted) output, so each fix also re-points its test.

**H1 (F1) — `docker_exec` hard-fails on BusyBox images.** The ADR-023 G3 fix made the in-container `timeout` *probe* for the binary, but still emitted GNU long options `timeout --signal=TERM --kill-after=5`. BusyBox `timeout` (Alpine — gluetun and most VPN/networking sidecars) **has** the binary, so the probe passed, but rejects `--signal=` with `unrecognized option (BusyBox v1.37.0)` and exits 1 **before the inner command runs**. G3 fixed "timeout absent," not "timeout is BusyBox."
- **Fix.** `buildInContainerTimeout` emits the **portable short forms `timeout -s TERM -k 5 <secs>`**, accepted by both GNU coreutils and BusyBox. One-line dialect change inside the existing probe/fallback wrapper.

**H2 (F5) — `docker_logs since` is broken for every relative value.** `buildDockerLogsCommand` forwarded the validated `tail_log` grammar straight to `docker logs --since`. journalctl groks `"30 min ago"`; `docker logs --since` does **not** — it takes only a Go duration (which has **no day unit**) or an RFC3339/date timestamp. So `"2h"` was rejected by the server's `validateSince`, and `"30 min ago"` was rejected by docker (`failed to parse value as time or duration`) — there was no value that worked.
- **Fix.** A pure `translateSinceForDocker` adapter: relative `min`→`Nm`, `hour`→`Nh`, `day`→`(N*24)h` (no Go `d` unit); a space-separated ISO datetime is normalized to docker's `T` separator; a bare date / already-`T` ISO passes through. The handler still validates against the one shared grammar; only the docker-bound emission is adapted.

**H3 (F8) — `guest_backup_restore` searches the wrong storage.** The restore handler hardcoded `storage = cfg.backup.nodeBackupStorage` (default `"local"`). But an archive `guest_backup` wrote **must** live on a backup-content store (e.g. `media-backup`; `local` lacks the `backup` content type), and the archive volid the caller passes (`<storage>:backup/<file>`) already names that store. Result: a correct, server-made archive was reported **"not found on local"** and was un-restorable — the read-side twin of the #9/G1 write-side bug.
- **Fix.** Derive the storage from the volid: `const storage = volidStorage(input.archive)` (new pure helper in `backups.ts`, asserts the `<storage>:backup/<file>` shape first). A malformed volid now throws `Invalid backup volid` *before* any node call, rather than silently searching `local`.

| ID | Change | State | Verification |
|---|---|---|---|
| **H1** | `docker_exec` in-container `timeout` uses portable `-s TERM -k 5`, not GNU `--signal=/--kill-after=` (BusyBox-safe) | **Shipped + tested** | `dockerHelpers.test.ts` re-pins the probe/fallback shape for `sh`+`bash` to the short flags and asserts no `--signal`/`--kill-after` long option survives. |
| **H2** | `docker_logs since` translated to a docker Go duration / RFC3339 via `translateSinceForDocker` | **Shipped + tested** | `dockerHelpers.test.ts` pins min/hour/day→duration, day→hours, ISO space→`T`, and bare-date passthrough; the logs builder now emits `--since '30m'`. |
| **H3** | `guest_backup_restore` derives storage from the archive volid (`volidStorage`), not the config default | **Shipped + tested** | `backupTools.test.ts` asserts a `media-backup:` volid is searched on `media-backup` (not `local`) and a storage-less volid is refused; `backups.test.ts` pins `volidStorage`. |

### Decision 16 — the 🟡 papercuts (H4–H9)

The remaining third-pass findings, all landed. None blocked an operator the way H1–H3 did, but each was a real rough edge surfaced live; together with Decision 15 they close the third pass.

**H4 (F2) — `docker_exec` dead-ends silently on a shell-less image.** A distroless/scratch image (portainer) has no `/bin/sh`, so `docker exec … sh -c …` fails to start the process and Docker returns a bare exit **127** with an OCI `executable file not found` message — indistinguishable to the model from a mistyped command. **Fix.** A pure `detectNoShell(result, shell)` recognizes the OCI/`exec: "sh"` signature at exit 126/127; `dockerExecHandler` audits the run (the 127 is real) and then throws a **typed** "this image has no shell — use docker_inspect/logs/read_file or a sibling container" dead-end. An ordinary command-not-found inside a working shell is deliberately NOT matched.

**H5 (F3) — repeated auto-latest `revert_file` hit a delta-base mismatch.** A revert never created a backup, so after one revert the newest backup was still the delta whose base = the *pre-revert* content; a second auto-latest revert re-selected it, the live file no longer matched the base, and it failed with a confusing "the current file has changed since this backup" — while the guidance ("try a more recent backup") was nonsense in the auto-latest case (there IS none newer). **Fix.** `revert_file` now **re-snapshots the current (pre-revert) content as a self-contained backup** (after the restore bytes are in hand, so it can't race the blob being read; best-effort, never blocks the revert). The newest backup for a target is therefore always self-contained, so a repeated auto-latest revert resolves to *it* and applies cleanly (deterministic undo/redo) instead of looping on a stale delta. The mismatch message is rewritten to point at the auto-latest revert (`revert_file` with just `path`).

**H6 (F4) — a failed revert left no audit row.** A revert that got past the circuit breaker (consuming a window slot) but then threw (stale delta, write error, metadata-only) appended nothing, so `recentCount` could not be reconciled against the trail and a thrash loop of *failing* reverts was invisible. **Fix.** A new `failed?: boolean` audit field; `revertFileHandler` wraps everything after the breaker check in a try/catch that appends a `failed: true` record (with the error in `note`, the override flag preserved) before rethrowing. Distinct from `refused` (the breaker itself blocking the call).

**H7 (F6) — LVM metadata-backup churn.** ADR-023 §E4 already excluded the pmxcfs dotfiles, but LVM rewrites a fresh `/etc/lvm/archive/pve_NNNNN.vg` + `backup/` copy on every `lvcreate`/`lvextend`/thin-pool autoextend, so those stayed as perpetual unexplained drift / sweep churn. **Fix.** Add `/etc/lvm/archive/*` and `/etc/lvm/backup/*` (siblings of the already-excluded `cache/*`) to the default `excludePatterns`. The single-segment `*` keeps `lvm.conf` and nested dirs.

**H8 (F7) — `config_sweep` timed out on a busy `/etc`.** Enumerate + hash of CT101's `/etc` (19-container stack) exceeded the 30 s `ssh.commandTimeoutMs` and dropped the connection mid-sweep, so that target never mirrored (error-isolation worked — other targets still committed). **Fix.** Two new config knobs: `history.sweepCommandTimeoutMs` (default 180 s — sweeps get their own larger node-side timeout) and `history.sweepHashBatchSize` (default 400 — a pure `chunk()` splits the candidate set so each `sha256sum`/`stat` command reads a bounded slice rather than the whole tree at once).

**H9 (F9) — vzdump archive lifecycle was unmanageable.** `guest_backup` returned a UPID + UTC note but **not the volid**, and vzdump names the file in the node's *local* time, so the volid couldn't be reconstructed from the note to feed `guest_backup_restore`; there was also no list verb. **Fix.** `guest_backup` re-lists the storage after the task completes and resolves the created archive's **volid by exact-note match** (returned in the result + audit note). A new read-only **`guest_backup_list`** (companion, not audited) inventories a storage's archives (optionally per-guest), newest-first, flagging `mcpManaged`; `includeForeign` shows human archives too (restore still refuses them). The note was already UTC.

| ID | Change | State | Verification |
|---|---|---|---|
| **H4** | `docker_exec` typed no-shell dead-end (`detectNoShell`) | **Shipped + tested** | `dockerHelpers.test.ts` pins the OCI signature at 126/127 and the non-match of an ordinary 127; `dockerExec.test.ts` asserts the typed throw (after auditing) + that a working-shell 127 returns normally. |
| **H5** | `revert_file` re-snapshots pre-revert content; honest delta-mismatch guidance | **Shipped + tested** | `revertFile.test.ts` proves a self-contained snapshot of pre-revert content becomes the newest version and a second auto-latest revert applies it cleanly; `policy.test.ts` pins the new message. |
| **H6** | `failed: true` audit row for a thrown revert | **Shipped + tested** | `revertFile.test.ts` asserts a failed (metadata-only) revert under a breaker leaves a `failed:true` record reconciling the consumed slot. |
| **H7** | exclude `/etc/lvm/archive/*` + `/etc/lvm/backup/*` | **Shipped + tested** | `sweepPlanner.test.ts` pins the globs match the churn but not `lvm.conf`/nested dirs. |
| **H8** | dedicated sweep timeout + batched hashing/stat (`chunk`) | **Shipped + tested** | `configSweep.test.ts` pins `chunk` (incl. size-0 clamp) and a batch-size-1 sweep issuing per-file `sha256sum`, never the combined command. |
| **H9** | `guest_backup` returns the volid; new `guest_backup_list` | **Shipped + tested** | `backupTools.test.ts` pins note-match volid resolution (+ null best-effort) and `guest_backup_list` ordering / foreign-filter / storage default + validation; registry + humanTools tests still green. |
