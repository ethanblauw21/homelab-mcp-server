# ADR-025: Container Update Workflow — `docker_restart`, `image_updates` (Registry + Diun), `compose_update` with Automatic Re-Tag Rollback

**Status:** Proposed — implemented 2026-10-13 (unit-tested; awaiting live verification on CT101 before Accepted)
**Date:** 2026-10-13
**Deciders:** Ethan
**Depends on:** ADR-004 (confirm gate, honest `ExecResult`, charset validation), ADR-007 (tiers, registration filtering), ADR-008 (Docker layer — `pct exec docker …` plumbing, `compose_redeploy`, `dockerHelpers.ts`), ADR-012 (`parseCompose`/`netnsOwner`/`groupByNetns` — the netns-provider hazard model), ADR-016 (`docker_inspect` projection, `imageId` as the container-level pin, `compose_discover` producing `composePath`), ADR-020 (`service_restart` shape; `http_probe` `fromVmid` core), ADR-021 (rollback circuit breaker — a new key family), ADR-024 (allowlist gate covers the new tools)
**Required by:** — none yet —
**Source:** Operator feature request (2026-10-13), items 2–4: `compose_update`, `docker_restart`, and a read of pending updates (Diun or registry) so finding updates needs no shell. Decisions taken with the operator: rollback by **local re-tag** (no compose-file mutation); **Diun is in scope for v1** because its tag history helps choose a version. Revised the same day after a read-only live check of Diun/Watchtower on CT101 (§0).

## Context

Updating a container today is a free-form sequence the agent assembles by hand: `pct_exec docker inspect` to see what is running, `pct_exec docker compose pull`, `compose_redeploy` (which recreates the *whole stack*), then eyeballing `docker_logs`. There is no record of the previous image, no health gate, and no undo short of `guest_backup_restore`. Restarting one container needs `docker_exec`-class shell (`pct_exec docker restart x`), the exact "dedicated tool beats raw exec" gap ADR-016/020 closed elsewhere. Finding what *has* an update needs either a shell or a human looking at Diun's notifications.

### §0 What the lab actually runs (live check, 2026-10-13, CT101 dockerBoss, read-only)

These observations shaped §2–§3; the raw outputs become the parser fixtures.

| Observed | Consequence for this ADR |
|---|---|
| Diun **v4.33.0**, docker provider, `WATCHBYDEFAULT=true`, schedule `0 0 6 * * 1` (weekly, Mon 06:00); 22 images tracked across 33 containers (locally built `:local`/compose-built images absent, `spotify-history` opted out). | Diun data can be up to **a week stale** and carries no "last checked" time → Diun cannot be the authority for "is there an update *now*"; the registry check is (§2). |
| `diun image list --raw` → `{images:[{name, manifestsCount, latest:{tag, mimeType, digest, created, labels, platform}}]}`; `diun image inspect --image <name> --raw` → `{image:{name, manifests:[…same entry shape…]}}`. `manifestsCount` is a **string**; `latest` means *most recently seen manifest*, not the tag `latest`. | Shapes are now known, not guessed; parser pinned to these fixtures + the version string. |
| Names are **fully qualified** (`docker.io/amir20/dozzle`, `lscr.io/linuxserver/sonarr`); `inspect` on an unqualified/wrong name prints a `{"level":"fatal",…"not found in database"}` JSON log line. | Refs must be normalized (`docker.io/` + `library/` for official images) before lookup; the fatal-line form is parsed as "not tracked", independent of exit code. |
| Diun's `digest` is the **index/manifest-list digest** (`mimeType` `…image.index.v1+json` / `…manifest.list.v2+json`). | Directly comparable with the local `RepoDigests` entry — confirms §2's comparison rule. |
| **`manifestsCount` = 1 for every image** — `watch_repo` is off everywhere (no `diun.watch_repo` labels). | Diun knows **one tag per repo** today. A tag-candidate list is empty until watch_repo is enabled (§2 "version choice"). |
| Diun's manifest carries OCI labels: `org.opencontainers.image.version` (e.g. dozzle `v11.3.1`, jellyfin `12.2`) and linuxserver's `build_version`. Locally, sonarr runs `4.0.19.2979-ls322` (`RepoDigest …c19aa4…`) while Diun's `latest` is `4.0.20.3014-ls327` (`…dffc730…`). | The **version label is the real "which version would I get" signal** even with watch_repo off: `currentVersion → availableVersion` per container, from data already on hand. |
| **Watchtower** running: `LABEL_ENABLE=true`, `CLEANUP=true`, schedule Sat 03:00; label-enabled on `homepage`, `socket-proxy`, `gluetun-port-sync`, `dozzle`, `flaresolverr`. | Two updaters on one container fight: Watchtower would re-pull over a re-tag rollback, and `CLEANUP` deletes the old image a rollback needs. Handled in §3. |
| Docker **29.5.2, containerd image store** (`io.containerd.snapshotter.v1`); a container's `.Image` equals its index digest; one dangling image present (`portainer` runs from an untagged `sha256:` image after its tag moved). | Re-tag rollback must not rely on an untagged image surviving; §3 pins the old image under a **server-owned hold tag** first. |
| `buildx v0.34.0` present in the LXC. | The registry check's `imagetools inspect` is available without new installs. |
| The main stack is a **Portainer stack** (project `1`, file `/var/lib/docker/volumes/portainer_data/_data/compose/1/docker-compose.yml`, a sibling `.env`). | `compose_update` passes `-p <project label>` explicitly (don't rely on the directory name) and runs from the file's directory so the sibling `.env` is loaded, matching how Portainer deploys. |
| `docker_inspect` returned Diun's **Discord webhook URL unredacted** (`DIUN_NOTIF_DISCORD_WEBHOOKURL`, `envRedactedCount: 0`). | A pre-existing ADR-016 redaction gap, **to be fixed before this ADR ships** (webhook/URL-with-credential-path values must redact); `image_updates` reads Diun's env only for the schedule key. |

## Decision

Three tools, built in this order (each is useful alone and the later ones reuse the earlier ones' helpers). All **companion**, all over the existing `pct exec <vmid> -- docker …` boundary, all with pure builders/parsers in `dockerHelpers.ts` (or a new `dockerUpdate.ts`) and a thin I/O handler.

### §1 `docker_restart` — one named container

`docker_restart({ vmid, container, timeoutSec?, netnsDependents?, confirm })` → `pct exec <vmid> -- docker restart [-t N] <container>`.

- Container name charset-validated (the existing `[a-zA-Z0-9][a-zA-Z0-9_.-]*`); `timeoutSec` clamped.
- **Confirm-gated**, matching `service_restart` (a restart interrupts the service).
- **Netns-provider guard.** Before restarting, list running containers' `HostConfig.NetworkMode` (one batched `docker inspect`); containers with `container:<this>` (or compose `service:<this>`, resolved via labels) are **dependents** — restarting the provider tears down the namespace they live in. `netnsDependents: "refuse"` (default) refuses and names them; `"restart"` restarts the provider then each dependent; `"ignore"` proceeds and returns them in a `warnings` field. Detection reuses ADR-012's `netnsOwner` grammar.
- Audited: `tool: "docker_restart"`, `hashScope: "unknown"` (like `service_restart`), honest exit semantics. Result: `{ restarted: string[], exitCode, durationMs, warnings }`.
- Does **not** apply compose changes (that is `compose_redeploy`/`compose_update`); the tool description says so.

### §2 `image_updates` — read-only pending-update report, two sources

`image_updates({ vmid, container?, source?: "auto" | "registry" | "diun", candidates?: number })`. Read-only, **not audited** (like `docker_inspect`/`docker_stats`).

**Per-container identity (always).** One batched script in the LXC emits, per running container: name, compose project/service labels, configured ref (`.Config.Image`), local image id (`.Image`), and the image's `RepoDigests` (an `docker image inspect` on the ids — the second round trip ADR-016 §1 avoided, paid here once for the batch). The image half reads labels from `{{json .Config}}` and picks them apart in code, never `{{index .Config.Labels …}}` in the template: an image built with no labels has no `Labels` key, the CLI's raw-map template fallback then fails the *whole* batched call ("map has no entry for key Labels" — and `{{with .Config.Labels}}` doesn't help, the field lookup itself errors), which on CT101 blanked 30 of 31 verdicts (2026-10-14). The handler also degrades per image: stdout is parsed whatever the exit code, and only ids missing from it report `unknown` with the inspect error as the reason.

**Source A — registry check.** For each distinct ref, the remote digest via `docker buildx imagetools inspect <ref> --format '{{json .Manifest}}'` (run in the LXC, so it inherits the daemon's registry credentials). Compare to the local `RepoDigests` entry for that repo. Pure classifier `classifyImageUpdate` → `up-to-date | update-available | unknown` with a reason:
- the comparison uses the **index/manifest-list digest** (what `RepoDigests` records on pull), never a per-platform digest — comparing the wrong one reports a false update on every multi-arch image;
- ref already digest-pinned (`@sha256:`) ⇒ `pinned` (never "update-available");
- no `RepoDigests` (locally built / loaded image) ⇒ `unknown: local-image`;
- `buildx` absent, auth failure, network failure ⇒ `unknown` with the reason; the batch never aborts on one ref (per-ref error isolation, like the census).
Manifest HEAD/GET for digest resolution does not consume Docker Hub pull quota; refs are de-duplicated so a stack sharing an image costs one lookup.

**Source B — Diun (metadata + version labels; not the verdict).** Diun is a weekly-cadence notifier with no "last checked" time in its data (§0), so it **never decides** "update available" — the registry check does. What Diun adds is what a digest cannot say: **which version an update would install**, and (when enabled) **which other tags exist**. Access is Diun's own CLI against its local gRPC API, inside the Diun container: `diun image list --raw` once per call (one round trip for every image), `diun image inspect --image <name> --raw` only for repos with `manifestsCount > 1`.
- **Locating Diun:** `docker.diunContainer` config (`<vmid>:<name>`), else auto-detect a running container whose image repo is `crazymax/diun` in the target LXC. Absent ⇒ `diun: { available: false, reason }`, never an error. The schedule is read from that container's `DIUN_WATCH_SCHEDULE` env (name-only lookup) and reported as `diun.schedule` so the reader can judge staleness.
- **Join:** running container ref → normalized fully-qualified name (`normalizeImageName`: default registry `docker.io`, `library/` for single-segment official images, tag/digest stripped) → Diun entry. Untracked refs (local builds, opted-out containers, fatal "not found" line) get `diun: null` with a reason.
- **Version, the primary v1 payoff:** `currentVersion` from the *local* image's labels (`org.opencontainers.image.version`, else linuxserver `build_version`'s `version:- X` segment) and `availableVersion` from Diun's manifest labels, same precedence. Shown as e.g. sonarr `4.0.19.2979-ls322 → 4.0.20.3014-ls327`. Missing labels ⇒ `null`, never inferred from the tag. If the registry digest differs from Diun's digest for the same tag, Diun's `availableVersion` is **stale** and is reported with `diunStale: true` rather than presented as what a pull would fetch.
- **Tag candidates (only when watch_repo is on).** For repos where Diun tracks more than one manifest, `candidates` = Diun's tags, filtered by a pure `rankCandidateTags` that keeps tags of the **same shape** as the running tag (`1.2.3`-style keeps version-shaped tags with the same `v` prefix, ordered by version; a moving tag like `latest` gets the version-shaped tags — those are what you would pin to) newest-first, capped (`candidates`, default 10, max `docker.imageUpdatesMaxCandidates`), with the running digest marked `current`. **On this lab today every repo has `manifestsCount` = 1, so `candidates` is empty everywhere**; the result says so (`diun.watchRepo: false`) and the tool description names the Diun labels that turn it on (`diun.watch_repo=true` plus `diun.include_tags`/`diun.max_tags` to keep the list bounded). Enabling them is a compose-file edit the operator makes; this tool never writes Diun config.
- `source`: `"auto"` (default) = registry verdict + Diun metadata; `"registry"` = skip Diun; `"diun"` = Diun only (no registry traffic), every verdict labelled `verdictSource: "diun"` and qualified by `diun.schedule`.
- **Parser honesty:** written against the §0 fixtures (Diun v4.33.0, version recorded in the fixture header). Tolerant of extra fields; a missing `images`/`image.manifests` array or a non-numeric `manifestsCount` string yields `diun: { available: false, reason: "unrecognized output (diun vX)" }`, never a guess.

**Updater ownership.** Each container also reports `managedBy`: `"watchtower"` when a running Watchtower would update it (Watchtower with `LABEL_ENABLE=true` and the container labelled `com.centurylinklabs.watchtower.enable=true`, or Watchtower without `LABEL_ENABLE` and the container not labelled `false`), else `null`. The Watchtower schedule and `CLEANUP` setting are reported once at top level.

Result (per container): `{ name, project?, service?, ref, imageId, localDigest, remoteDigest?, status, reason?, verdictSource, currentVersion, availableVersion, diunStale?, candidates?, managedBy }`, plus top-level `{ sources: {registry, diun: {available, version, schedule, watchRepo}}, watchtower?: {schedule, labelEnable, cleanup}, checkedAt }`.

### §3 `compose_update` — one service, pull → recreate → health-check → re-tag rollback

`compose_update({ vmid, composePath, service, healthTimeoutSec?, stableSec?, probe?: {url, expectStatus?}, allowWatchtowerManaged?, confirm, overrideCircuitBreaker? })`.

**Preconditions (refuse before touching anything):**
- `confirm: true`; `composePath` through `validatePath`; `service` charset-validated.
- Read + `parseCompose` the file (ADR-012): the service exists, has `image:`, has **no `build:`**, and its ref is **not digest-pinned** (nothing to pull — a pinned ref is changed by editing the file, see §4).
- **Netns provider refusal:** if other services use `network_mode: service:<this>` (ADR-012 `groupByNetns`), refuse — an in-place recreate of a provider is ADR-012's deadlock. Point at `compose_redeploy` with a down/up.
- **Watchtower-managed refusal:** if the service's container is `managedBy: "watchtower"` (§2 rule), refuse unless `allowWatchtowerManaged: true`. Two updaters on one container fight: Watchtower re-pulls over a re-tag rollback at its next run, and its `CLEANUP` deletes images (§0: five containers on this lab are label-enabled). The refusal names the label to remove. With the override, the result carries a warning and the hold tag (below) is the only thing keeping the old image.
- **Breaker check** on key `compose/<vmid>/<service>` (§5).

**Compose invocation.** Every compose command runs as `cd <dir of composePath> && docker compose -p <project> -f <composePath> …`, where `<project>` is the running container's `com.docker.compose.project` label (charset-validated). Explicit `-p` avoids depending on the directory name, and running from the file's directory loads its sibling `.env` — matching how Portainer deploys its stacks (§0: project `1`, `.env` beside the file). If the label's `config_files` doesn't name `composePath`, refuse: the caller is pointing at a different file than the one that created the container.

**Steps:**
1. **Record.** Find the service's container by `com.docker.compose.project` + `.service` labels; capture `ref`, `oldImageId`, `oldRepoDigest`, `currentVersion` (§2 label rule). No running container ⇒ refuse (nothing to roll back to; use `compose_redeploy`).
2. **Hold.** `docker tag <oldImageId> <repo>:mcp-hold-<service>` — a **server-owned hold tag** (the `mcp-` ownership convention of ADR-003 snapshots / ADR-008 archives, applied to images). On the containerd image store (§0) an image that loses its last tag becomes dangling and is fair game for any prune or Watchtower cleanup; the hold tag keeps the rollback target referenced for exactly as long as the server needs it. Retention: one hold per service, for free — the tag name is fixed per service, so `docker tag` simply moves it and the previous held image loses that reference (human tags are never touched; a hold under an older repo name, if the service's repo changed, is left for the operator).
3. **Pull.** `docker compose … pull <service>`. Resolve the ref's new image id. Equal to `oldImageId` ⇒ return `outcome: "already-current"`, drop the just-created hold back to the previous one, no recreate, audited as a no-op.
4. **Recreate.** `docker compose … up -d --no-deps <service>` — `--no-deps` so dependencies are not recreated alongside it.
5. **Health gate** (server-side polling, each poll its own short `pct exec` under the normal command timeout; total bounded by `healthTimeoutSec`, default `docker.updateHealthTimeoutSec` = 120, clamped):
   - image defines a `HEALTHCHECK` ⇒ poll `.State.Health.Status` until `healthy` (pass) / `unhealthy` (fail) / deadline (fail);
   - otherwise ⇒ `running`, not `restarting`, and `RestartCount` unchanged for `stableSec` (default 20) consecutive seconds;
   - optional `probe` ⇒ additionally require the ADR-020 `http_probe` `fromVmid` core to meet `expectStatus` (default 2xx/3xx) at the end. The probe gates the **rollback** too: if the old image also fails it, the result is `rollback-failed` (the probe is likely wrong, and that is reported, not hidden).
6. **On failure — re-tag rollback.** `docker tag <repo>:mcp-hold-<service> <ref>` then `docker compose … up -d --no-deps --pull never <service>` (`--pull never` so compose cannot re-fetch the new image under the restored tag), then the same health gate (pass ⇒ `rolled-back`, fail ⇒ `rollback-failed`). If the hold tag is gone (removed out-of-band), `rollback-failed` with that reason — never a silent fall-through to whatever the tag now names.

**Why re-tag works and what it leaves behind.** Re-pointing the ref's tag at the held image makes the unmodified compose file resolve to the old bytes. The compose file is **never written**, so there is no backup/history/integrity event for a file that did not change. After a *successful* update the hold tag remains (one per service) — the manual undo is `compose_update`'s own rollback recipe, and `previousImageId` + the hold tag name are returned. Pruning holds is an operator action (`docker rmi <repo>:mcp-hold-<service>`); the tool never prunes beyond its one-per-service retention.

**Outcome and audit.** `outcome: "already-current" | "updated" | "rolled-back" | "rollback-failed" | "failed-needs-file-revert" | "pull-failed"` (`pull-failed`: nothing recreated; the hold tag is the only change), with `{ ref, oldImageId, newImageId, oldRepoDigest, newRepoDigest, currentVersion, newVersion, holdTag, health: {mode, status, elapsedMs, detail}, rollbackHealth?, steps: [...exit codes] }`. One audit record, `tool: "compose_update"`, `vmid`, `path: composePath`, `hashScope: "unknown"`, `isLargeChange: true`, and a `note` carrying outcome + both image ids (so `query_audit` with `textSearch` finds "which update rolled back, from what to what"). `rollback-failed` is reported as a failure (non-zero-equivalent result), never folded into "rolled back".

### §4 Choosing a different version (tag change) — via the existing write pipeline

`compose_update` v1 updates the ref **already named** in the compose file (a moving tag like `latest`, or the same version tag re-published). Moving to a *different* tag that `image_updates` suggested is a compose-file edit: `pct_edit_file`/`docker_edit_file` (backup + audit + history + `dryRun`), then `compose_update`. If the running ref differs from the file's ref, re-tag rollback cannot help (the old image is not under the new name, and re-tagging it would make the tag lie), so `compose_update` detects the mismatch and runs with **`rollback: "file"` semantics**: on health failure it returns `outcome: "failed-needs-file-revert"` with the exact `revert_file` + `compose_redeploy` (or `compose_update`) call to issue — it does not revert the file itself in v1. Folding the file revert into the tool is a noted follow-up once the re-tag path has dogfooded.

### §5 Breaker and tier

- `compose_update` joins the ADR-021 rollback family: an automatic rollback (`rolled-back`/`rollback-failed`) records a breaker timestamp under `rollbackTargetKey({kind: "compose", vmid, remotePath: service})` → `compose/<vmid>/<service>`. Three auto-rollbacks of the same service in the window refuse further `compose_update` calls on it until override — the "keep pulling the same broken image" loop is exactly the thrash pattern ADR-021 targets (re-tagging does not stop the *next* pull from fetching the bad image again).
- `TOOL_MIN_TIER`: `docker_restart`, `image_updates`, `compose_update` → `companion`, beside the rest of the Docker family. ADR-024's allowlist applies with no extra wiring.

## Scope boundaries

- No `docker image prune` / cleanup tool; beyond the one-per-service `mcp-hold-*` retention, old images accumulate until the operator prunes (stated in results).
- No scheduled/automatic updates. This is not Watchtower; every update is an explicit, confirm-gated call. Coexistence with Watchtower is by ownership, not cooperation: `image_updates` reports `managedBy`, and `compose_update` refuses Watchtower-managed containers by default (§3). Moving a container from Watchtower to this workflow is the operator removing its `com.centurylinklabs.watchtower.enable` label.
- No Diun configuration management (watch lists, `watch_repo`); the tool reads Diun, never writes it.
- Multi-service or whole-stack update is out of v1 (one service per call; stacks are updated by repeated calls).

## Consequences

**Positive.** Update-check, update and restart become structured, audited, single calls; every update has a recorded before/after image id and an automatic, file-free undo; "what version would this update install" becomes a field (Diun's OCI version labels) instead of a release-notes hunt, and Diun's tag history becomes queryable for version choice once watch_repo is enabled.

**Negative.** `compose_update` is the longest-running tool in the kit (pull + health window) and the most stateful handler (multi-step with a compensating path). The re-tag leaves a local tag that disagrees with the registry until the next deliberate update — correct, but surprising; results and the tool description state it.

**Honest limits.**
- The health gate is a heuristic: a container can be "healthy" and wrong. `probe` narrows that; it does not close it.
- Re-tag rollback depends on the held image surviving; the `mcp-hold-*` tag protects it from dangling-image prunes and Watchtower cleanup, not from an explicit `docker rmi -f`/`image prune -a` — that is reported as `rollback-failed` with the reason.
- Without watch_repo, version choice is limited to "the version the current tag now points to"; picking among tags needs the Diun labels in §2.
- Diun's `availableVersion` can be up to one schedule interval old; the registry digest is the freshness check, and a mismatch is flagged (`diunStale`), not hidden.
- Rollback restores the **image**, not data: a new version that migrated a volume's schema on start is not undone. That is what `guest_backup` before a risky update is for; the tool description says so.
- Diun parsing is fixture-pinned to observed v4.33.0 output, not a documented contract; an unrecognized shape degrades to `diun.available: false`.

## Implementation notes

- **Pure (unit-tested, no I/O):** batch identity script builder + parser; `classifyImageUpdate`; `normalizeImageName`; `extractImageVersion` (OCI label → linuxserver `build_version` → null); `watchtowerManages` (the §2 ownership rule); Diun list/inspect parsers (fixture-driven, incl. the fatal not-found line) + `rankCandidateTags`; hold-tag naming + retention planner (`mcp-hold-*` only); netns-dependent finder (`docker_restart`); `compose_update` precondition checker over `ComposeModel`; health evaluators (`evaluateHealthPoll` over a sequence of samples — so the timing logic is tested without sleeping); the outcome state machine as a pure step reducer.
- **I/O handlers:** `tools/dockerRestart.ts`, `tools/imageUpdates.ts`, `tools/composeUpdate.ts`; `now`/`sleep` injected into `composeUpdate` for tests.
- **Fake-transport tests** for every `compose_update` path: already-current, updated, health-fail → rolled-back, rollback-fail, hold-tag-missing, ref-mismatch (§4), Watchtower-managed refusal + override, `config_files` mismatch, each precondition refusal, breaker trip + override.
- **Integration check before accepting the hold-tag design:** on a throwaway container in a Docker 29 / containerd-store harness, confirm that tagging by image id, re-pointing a tag, and `up -d --pull never` behave as §3 assumes.
- **Config (`docker.*`):** `diunContainer` (`"<vmid>:<name>"`), `updateHealthTimeoutSec` (120, clamped to `updateHealthTimeoutMaxSec` 600), `updateStableSec` (20), `updatePollIntervalMs` (2000), `updatePullTimeoutMs` (600 000), `updateRecreateTimeoutMs` (180 000), `registryCheckTimeoutMs` (120 000), `imageUpdatesMaxCandidates` (25); env `DOCKER_DIUN_CONTAINER`, `DOCKER_UPDATE_HEALTH_TIMEOUT_SEC`, `DOCKER_UPDATE_STABLE_SEC`, `DOCKER_UPDATE_POLL_INTERVAL_MS`, `DOCKER_UPDATE_PULL_TIMEOUT_MS`, `DOCKER_UPDATE_RECREATE_TIMEOUT_MS`, `DOCKER_REGISTRY_CHECK_TIMEOUT_MS`, `DOCKER_IMAGE_UPDATES_MAX_CANDIDATES`.
- **As built:** pure core `tools/dockerUpdate.ts`; handlers `dockerRestart.ts` / `imageUpdates.ts` / `composeUpdate.ts`; tests `dockerUpdate.test.ts` (pure), `dockerUpdateHandlers.test.ts`, `composeUpdate.test.ts` over a scripted transport (`dockerUpdateTestkit.ts`). `compose_update` reads the service through `docker compose config --format json` (interpolation + `.env` applied, as compose sees it) and feeds it to ADR-012's `parseCompose`/`groupByNetns`. The breaker gained a non-recording `peek` so only actual auto-rollbacks consume window slots.
- **Unverified until the live check:** `buildx imagetools inspect --format '{{.Manifest.Digest}}'` output, `docker compose config --format json` on the Portainer stack, and the hold-tag / `--pull never` behaviour on Docker 29's containerd store (the integration item below).
- **Fixtures:** the §0 captures (`diun image list --raw`, `diun image inspect --image lscr.io/linuxserver/sonarr --raw`, the not-found fatal line, Diun v4.33.0) are checked in under `src/tools/__fixtures__/diun/`, trimmed of label noise; re-capture when Diun's major/minor changes.
- **Header back-links:** `Required by: ADR-025` added to ADR-004, ADR-008, ADR-012, ADR-016, ADR-020, ADR-021, ADR-024 in the same change (ADR-000 convention; ADR-007 exempt).
- `CLAUDE.md` tool table: three rows (ADR 025).
