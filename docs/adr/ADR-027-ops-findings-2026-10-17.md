# ADR-027: Backup retention order, honest timeouts, compose env files and probe sanity

**Status:** Accepted (2026-10-17)
**Date:** 2026-10-17
**Deciders:** Ethan
**Depends on:** ADR-008 §6 (guest_backup, compose_redeploy), ADR-003 (snapshot retention), ADR-012 (compose_preflight), ADR-021 (rollback circuit breaker), ADR-023 #9 (vzdump task polling), ADR-025 (compose_update), ADR-026 (redaction key, boundary redactor)
**Amends:** ADR-008 §6 ("retention before create" is now "retention after a confirmed create"), ADR-023 #9 (a poll timeout is pending, not failed)
**Required by:** — none yet —
**Source:** ops session 2026-10-17, first full-stack update against proxlab / CT 101 (ops CHANGELOG.md, phases 0–2)

## Context

The first full-stack update run with homelab-mcp at companion tier worked, but it turned up five problems in the tools and two leftovers from ADR-026.

1. `guest_backup` deleted the previous `mcp-` archive of CT 101 before vzdump started. vzdump then ran for about 14 minutes. If it had failed, CT 101 would have had no `mcp-` archive at all. `snapshot_create` had the same order.
2. CT 101 (87 GB) takes about 14 minutes to back up and `taskTimeoutMs` was 10 minutes. Every backup threw "failed: still running after 600000ms", added the storage content-type hint, and wrote an audit record saying FAILED. The backup finished fine each time. The ops CLAUDE.md carried a "do not believe this error" note because of it.
3. `compose_update` ran `docker compose config` with only the compose file. segmem was started with `--env-file /data/segmem/.env` and has no sibling `.env`, so config failed with "required variable TS_AUTHKEY is missing a value". It refused safely. `compose_redeploy` has the same gap.
4. A `compose_update` of searxng was given a probe on `127.0.0.1:8888`, but searxng publishes 8888 on `10.0.0.52` only. Both the new and the old image failed the probe, so the outcome was `rollback-failed` even though the old image was healthy and serving.
5. `compose_preflight` reported `port-bound-elsewhere` for every port tailscale publishes on stack 1. The holder was the running copy of the same stack.

Also open: `audit.db` rows written before ADR-026 keep what the old rules missed, and `redaction.key` should be mode 600.

## Decision

### 1. Retention runs after a confirmed create

`guest_backup` now creates the archive first. It waits for success (API: task poll; SSH: vzdump exits 0), then re-lists the storage and resolves the new volid by its unique note. Only then does it evict old `mcp-` archives down to the cap. The new volid is taken out of the candidate set, so it cannot be evicted even with a cap of 0 (`planPostCreateEviction` treats a cap below 1 as 1).

Nothing is evicted when the create fails, when the wait times out, or when the new volid cannot be resolved. An eviction that fails after a successful backup is reported in `evictionErrors` and the audit note, not thrown. The backup is real, and the extra archive is retired on the next successful run.

Holding cap+1 archives for the length of a vzdump needs space. Before creating, when retention would evict something, the handler compares the storage's free space with the size of the newest existing archive of the same guest plus 10% (`checkBackupHeadroom`). If it clearly does not fit, the call is refused before anything is deleted or created, and the message gives both numbers. If either number is unknown, it proceeds with a warning. `evictBeforeCreate: true` restores the old order on purpose, for a storage that cannot hold one extra archive.

`snapshot_create` follows the same order: create, then evict from the pre-create listing (which cannot contain the new snapshot). An eviction failure there is now reported in `evictionErrors` instead of thrown.

### 2. A timeout is pending, not failed

On the API path, `waitForBackupTask` returns one of three states: `ok`, `failed` (the task stopped with a non-OK exit status), or `pending` (the wait ran out while the task was still running). A poll that throws is retried until the deadline.

`pending` does not throw. The result has `status: "pending"`, the UPID, `volid: null`, no eviction, the eviction that was held back (`pendingEviction`), and `nextSteps` pointing at `guest_backup_list` (look for the note), the `lock: backup` on the guest, and a larger `timeoutMs`. The audit record carries a new `pending: true` field, distinct from `failed` and `timedOut`, and its note says PENDING.

The content-type hint is attached only when the exit status mentions content type or storage (`backupFailureHint`).

`guest_backup` takes a per-call `timeoutMs` (1 minute to 6 hours). The default `backup.taskTimeoutMs` is raised from 10 to 30 minutes.

The SSH backend ran vzdump and `pct restore`/`qmrestore` under the ordinary 30 second command timeout. On SSH the node-side `timeout` is a kill, so any real backup or restore over SSH would have been killed. `SshBackend` now takes a long-task timeout (`backup.taskTimeoutMs`, or the per-call `timeoutMs` for vzdump) for those two commands. On SSH a timeout is still a real failure, because the process really is stopped.

### 3. Compose commands pass the project's env files

compose records the `--env-file` paths a project was started with in the `com.docker.compose.project.environment_file` label (comma-separated). The container identity scan now reads that label, and `compose_update` passes each path as `--env-file` on every compose call (config, pull, up, rollback up). `compose_redeploy` reads the same label from the project's containers, running or stopped, and takes an explicit `envFiles` override (`[]` means none). If the containers disagree, it uses none and warns. `compose_discover` reports `envFiles` per project.

Only absolute paths without control characters or `..` segments are accepted (`parseEnvFileLabel`). Anything else is skipped with a warning. The server passes paths only. It never reads, prints or logs the files. compose reads them on the node, and `docker compose config` error output still goes through the ADR-026 boundary redactor.

`docker ps` joins labels with commas and does not escape a comma inside a value, so `parseDockerLabels` lost everything after the first file of a multi-file label. A segment with no `=` now continues the previous value. This also fixes multi-file `config_files`.

`compose_preflight` parses the compose file itself and does not run `docker compose config`, so it does not interpolate and does not need the env files.

### 4. Probe sanity in compose_update

With a probe, `compose_update` now curls it once against the running image before anything changes. If it already fails there, the probe cannot tell a bad update from a bad URL, so the call is refused with "Nothing was changed".

The same check compares the probe's host:port with the container's published bindings (`.NetworkSettings.Ports`, or the netns provider's for a `container:` network mode) and explains a likely mismatch (`probeBindingWarning`). In the searxng case that reads "publishes port 8888 only on 10.0.0.52". It does not judge hostnames or `host` networking. When the probe passes but the binding check still has doubts, the warning is returned and the update goes ahead.

The health gate now marks a result where the container gate passed and only the probe failed (`probeOnly`). If both images end up that way, the outcome is `rollback-ok-probe-failed`, with a warning that the probe URL may be wrong and that the new image may have been fine. That outcome is not audited as failed, and it does not count toward the rollback circuit breaker. A probe that cannot tell images apart says nothing about a thrash loop. Every other failure path still counts.

### 5. compose_preflight attributes bound ports

The bound-port probe used to run `ss -tlnp` inside the provider container. Dependents share that network namespace but not its PID namespace, so their listeners had no holder and came back as a warning each.

It now runs from the LXC. It `nsenter`s into the provider's netns (or uses the LXC's own when there is no shared provider), lists listeners with LXC-level pids, and maps each pid to a Docker container id through `/proc/<pid>/cgroup` (`buildAttributedListenerProbe`, `parseAttributedListeners`). The container gives the compose project. A port held by a container of the project being analysed (any project whose containers' `config_files` name this file) becomes an `info` hazard: it is the running instance a redeploy replaces. A port held by another project's container stays an `error`.

If `nsenter` or `ss` is missing on the LXC, the old in-container probe runs. In that case, if every running container in the provider's netns belongs to the analysed project, unattributed holders are `info` too. Otherwise the old warning stands.

### 6. audit.db re-redaction (one time, dry run first)

`node dist/cli/rescrubAuditDb.js` applies the current `redactString` to `cmd`, `note`, `diff` and the `raw` record copy of every `audit.db` row, and changes only rows whose text changes. It is a dry run by default and opens the DB read-only. It prints counts by column and tool, never row text. `--list` adds ids and timestamps.

`--apply` copies `audit.db` to `audit.db.pre-rescrub-<ts>` (mode 600) first, then updates in one transaction under `secure_delete`, rebuilds and optimizes the FTS index, checkpoints the WAL and runs VACUUM. That backup still holds the old text and has to be deleted by hand once the result checks out. `--no-backup` skips it. The new markers use the install's `redaction.key`, which is read and never created.

The JSONL log is not rewritten. It is the append-only system of record (ADR-004), and `query_audit` already re-redacts it on the way out.

### 7. redaction.key mode

New keys were already created at 600. An existing key is now tightened to 600 on load when group or other bits are set, with one stderr line (POSIX only).

### 8. Addendum (same day): compose_update holds only when it will recreate

The `hold` step ran before the pull, so a run that turned out already-current re-pointed `mcp-hold-<service>` at the current image. On 2026-10-17 the verification run did this to searxng, leaving the real rollback image (held by the earlier update) with no tag, where a prune would delete it. The same run created a redundant `mcp-hold-ollama` on the current image. The ops session restored both by hand.

The order is now pull, resolve, then hold only when the pulled image differs from the running one (or the file's ref changed). Pulling first is safe because the running container keeps the old image referenced until the hold tags it. An already-current run issues no `docker tag` at all, and reports the image the existing hold points at as `existingHoldImageId` (null when there is none). If the hold fails, nothing is recreated and the ref is tagged back onto the running image.

The rollback path (re-tag the hold, `up -d --pull never`) only runs after a recreate, and a recreate is now always preceded by a hold in the same run, so it never relies on a hold from an earlier run.

No tool lists or removes images by `dangling=true`. On Docker 29 with the containerd image store that filter includes still-tagged images, so anything added later must not treat "dangling" as "safe to remove".

## Scope boundaries

- `guest_backup_restore` on the API path still does not poll its task. That has not come up in practice and is left alone here.
- A pending backup's eviction is deferred to the next successful backup of that guest. There is no separate "apply retention" verb.
- The probe binding check is a hint. It cannot see NAT, a reverse proxy, or a hostname's resolution.
- The android MCP's `apt-get` confirm gate mentioned in the ops report is a different server and is out of scope.

## Consequences

Positive:
- A failed or slow vzdump can no longer leave a guest with no `mcp-` archive.
- CT 101's normal 14 minute backup completes inside the default wait, and a slower one reads as pending, not failed.
- Projects started with an out-of-tree env file can be updated and redeployed.
- A wrong probe is caught before anything changes, instead of rolling back a healthy service.

Negative:
- A backup needs room for one extra archive. A storage near full is refused unless `evictBeforeCreate` is passed.
- `compose_update` with a probe makes one extra curl. Preflight makes one extra identity scan.

Honest limits:
- The headroom estimate uses the last archive's size. A guest that grew a lot since then can still fill the storage mid-vzdump. vzdump then fails, and nothing is evicted.
- `pending` means unknown. The backup can still fail after the server stops waiting.
- The attributed preflight probe needs `nsenter` and `ss` in the LXC. Without them it falls back as described above.

## Implementation notes

- `tools/backupTools.ts`, `tools/backups.ts` (`planPostCreateEviction`, `checkBackupHeadroom`, `backupFailureHint`, `formatBytes`), `node/sshBackend.ts`, `node/nodeOps.ts` (`BackupCreateOpts.timeoutMs`), `audit/record.ts` (`pending`), `config.ts`.
- `tools/snapshotTools.ts`.
- `tools/dockerUpdate.ts` (identity fields `composeEnvFiles`/`publishedPorts`, `buildComposeCommand` env files, `envFilesFor`, `probeBindingWarning`), `tools/dockerHelpers.ts` (`parseEnvFileLabel`, `parseDockerLabels`, `buildComposeUpCommand`, `parsePortMap` exported), `tools/composeUpdate.ts`, `tools/composeRedeploy.ts`.
- `tools/composePreflight.ts`, `tools/composePreflightHandler.ts`.
- `audit/auditDbRescrub.ts`, `cli/rescrubAuditDb.ts`.
- `guardrails/redactionKey.ts` (`enforceKeyFileMode`).
