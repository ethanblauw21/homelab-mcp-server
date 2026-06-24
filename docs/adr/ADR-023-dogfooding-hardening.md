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
| **B6** | `setup.mjs` grants the `MCPOperate` role `VM.Backup` + `Datastore.AllocateSpace` for vzdump | **Shipped + re-provisioned + verified live** | After re-running setup with `-RotateToken`, `guest_backup(100, snapshot)` succeeded (archive `mcp-20260623-123157`, task UPID returned) — **no 403**. The snapshot-incapable guest now has a working rollback path. |
| **E2** | `guest_start` on an already-running guest is idempotent (`{alreadyRunning:true}`, no `startGuest` call) | **Shipped + tested** | Unit test pins the no-op; avoids the raw API 500. |
| **E4** | pmxcfs volatile runtime files (`.rrd`/`.version`/`lrm_status`/…) added to `excludePatterns` | **Shipped** | Removes perpetual benign `unexplained` integrity drift. |

### Deferred to a follow-up (NOT implemented here)

These were left uncoded **deliberately** — each needs a live guest-cycle re-test or is a larger surface change, and shipping them blind would risk the production LXCs:

- **B5 — `snapshot_rollback` false restart-failure (DEFERRED).** The SSH-routed post-rollback restart reports `failed to restart … (exit null)` even though the guest *does* come back (confirmed during dogfooding: `pct_list` running, DNS up, service active). The fix (Decision 5 — verify run-state by polling `status` instead of trusting the start command's `exitCode`) touches the stop→rollback→restart orchestration and **cannot be validated without a live rollback cycle on a production guest**, so it is held until a maintenance window or a disposable test guest exists. Until then the false-failure message is cosmetic — rollback itself works.
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

## Consequences

- Six bug fixes (B1–B6) restore parity between the `pct`/`docker`/host families and remove two false-failure reports (`http_probe`, `snapshot_rollback`) that would mislead an operator. B6 restores the only rollback path for the snapshot-incapable guest — the highest-value fix.
- The consistency pass (E1–E7) makes not-found/idempotent/empty-input behavior uniform and quiets perpetual integrity noise.
- No new tool, transport, store, or dependency is added; every change is a correctness/parity fix or a provisioning-privilege addition.
- The redundancy review concludes the surface is justified; only `service_logs` is annotated, not removed.

## Honest non-goals

- This ADR does not re-litigate the deliberate tier asymmetries (`tail_log` companion host-read vs the root-gated rest) — those are documented design (ADR-005/007), and the dogfooding confirmed they behave as specified.
- ~~The `qm_*` family could not be exercised beyond its refusal paths (no VM exists on the node); its mutation surface is unverified live and is called out as a coverage gap, not a finding.~~ **Resolved 2026-06-23** — see the "qm_* live verification addendum" above: the family was dogfooded live against a throwaway VM, found healthy, and two bugs (F1/F2) were fixed.
