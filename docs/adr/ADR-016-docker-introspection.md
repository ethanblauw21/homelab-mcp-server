# ADR-016: Docker Introspection — Structured `docker_inspect` / `docker_stats` / `compose_discover` + Named-Volume Read Fast Path

**Status:** Accepted (implemented 2026-06-19)
**Date:** 2026-06-19
**Deciders:** Ethan
**Depends on:** ADR-002 (shared redaction module — env-value redaction), ADR-004 (read caps, path validation, denylist), ADR-008 (the Docker layer: `pct exec docker …` plumbing, `dockerHelpers.ts` pure builders/parsers, the `docker:<vmid>:<container>:<path>` descriptor, the bind-mount fast path)
**Required by:** ADR-020 (extends the "dedicated tool beats raw exec" doctrine + the audit-log evidence method to systemd, service probes, and content-addressed reads)
**Source:** Dogfooding run 2026-06-19 — the audit log showed **227 of 257 records were `pct_exec` running hand-rolled `docker inspect`/`docker stats`/`docker exec cat` loops**, because the Docker layer has tools for *listing, logs, and files* but none for *inspection*.

## Context

ADR-008 built the Docker layer — `docker_ps`, `docker_logs`, `docker_read_file`/`docker_write_file`, `docker_exec` — all riding the companion-tier `pct exec docker …` boundary. Six months of dogfooding exposes a gap it did not fill: **introspection has no first-class tool.** Every "what image is gluetun pinned to / what are its mounts / labels / env / restart policy / how much memory is each container using / where is the compose file" question forces a drop to `pct_exec` with a bespoke Go-template format string.

The cost is measurable and threefold:
1. **Token waste.** Each such call ships a 100–500-char `docker inspect --format '{{…}}'` string up and unstructured text back, which the model then re-parses. The audit log's 227 `pct_exec` records are mostly this.
2. **Quoting hazard.** Go-template braces inside a shell string inside `pct exec` inside the `timeout bash -c` wrapper is four nested quoting contexts; the dogfooding log shows escaped-quote gymnastics (`'\''`) that are error-prone.
3. **Latency.** Multi-container questions become `for c in …; do docker inspect …; done` loops — one SSH round-trip each, serially (see ADR-018 for the same round-trip pathology on the integrity side).

The Docker layer is the richest part of the toolkit and the least used through its own tools, *because its most common question has no tool*. This ADR closes that with three read-only introspection tools and one fast-path fix, all reusing the ADR-008 plumbing — no new transport, no new tier, no new mutation surface.

## Decision

Three new **read-only, companion-tier, not-audited** Docker tools (mirroring `docker_ps`'s posture) plus a fast-path improvement to the existing `docker_read_file`. All parsing lives in `dockerHelpers.ts` (pure, ADR-008's existing home), and container names keep the existing `[a-zA-Z0-9][a-zA-Z0-9_.-]*` charset guard before interpolation.

### 1. `docker_inspect(vmid, container, fields?)` — structured single-container view

Runs `pct exec <vmid> -- docker inspect <container>`, parses the JSON, and returns a structured, **secret-aware** projection: image + first `RepoDigest` (the pinned identity), `status`/`health`, `restartPolicy`, networks, mounts (`source:dest:mode`), published ports, and the compose labels (`com.docker.compose.project` + `…project.config_files`). The **env block keeps names but redacts values by default** — the dogfooding log repeatedly did `docker inspect … | grep -iE "WATCHTOWER|TZ"` to read config without leaking secrets; this bakes that instinct in via the ADR-002 redaction module rather than leaving it to a hand-rolled grep. `fields?` narrows the projection (e.g. `["image","mounts"]`) to cut tokens further.

### 2. `docker_stats(vmid)` — point-in-time resource snapshot

Runs `docker stats --no-stream` and parses it to `[{ name, cpuPct, memUsedBytes, memLimitBytes, memPct, netIO, blockIO }]`, sorted by memory descending. This is the structured form of the audit log's recurring `docker stats --no-stream --format … | sort | tail` pattern. Pairs with `health_check` for a guest-level resource view. (Considered and rejected: folding this into `docker_ps` as an opt-in `stats: true` — kept separate so `docker_ps` stays a cheap, always-safe roster and the heavier `--no-stream` sampling is opt-in by tool choice.)

### 3. `compose_discover(vmid)` — read-only compose project map

Enumerates compose projects in the LXC from the running containers' compose labels, returning `[{ project, configFile, services: [{ name, image, ports }] }]`. The dogfooding log shows repeated `cd /var/lib/docker/volumes/portainer_data/_data/compose/1 && grep … docker-compose.yml` just to **find the compose file** and read its image tags. `compose_redeploy` and `compose_preflight` (ADR-008, ADR-012) both already require the operator to *know* `composePath`; `compose_discover` is the tool that produces it. This makes the redeploy/preflight pair self-serviceable instead of depending on out-of-band knowledge.

### 4. `docker_read_file` — named-volume fast path

ADR-008's `docker_read_file` has a bind-mount fast path (resolve the host-visible source, read it directly over `pct pull`) and a `docker cp` slow path (the three-filesystem relay). Dogfooding showed the common case — a linuxserver `/config` **named volume** (qBittorrent, sonarr, …) — *missing* the fast path (`viaBindMount:false`) and falling to the slow relay, because the resolver only recognized bind mounts. Extend the resolver to also recognize **named-volume mountpoints** (`docker inspect` → `.Mounts[]` where `Type == "volume"`, whose `Source` is a host path under `/var/lib/docker/volumes/<name>/_data`). Most managed-app config lives in named volumes; resolving them turns the slow relay into a direct LXC read. The slow path stays as the fallback for genuinely non-host-visible paths (tmpfs, overlay-only).

## Scope boundaries

- **Read-only introspection only.** No new exec/mutation surface — `docker_exec`/`docker_write_file` already cover that at companion with the denylist+confirm gate. These three are siblings of `docker_ps`/`docker_logs` (read, not audited).
- **No streaming.** ADR-008 Option D deferred streaming/async-job output and this ADR does **not** change that — `docker_stats` is a single `--no-stream` sample, not a live feed. *This ADR does not realize the ADR-008 Option D deferral; that remains open.*
- **`docker_inspect` is single-container.** A fleet inspect (`docker inspect $(docker ps -q)`) is a plausible extension but is held out to keep the projection/redaction story simple; loop at the call site if needed, or use `compose_discover` for the project-wide image view.
- **No daemon-socket access.** Unchanged from ADR-008 — everything shells `docker …` inside the LXC via `pct exec`; `/var/run/docker.sock` is never spoken to directly.

## Consequences

**Positive.** The dominant real-usage pattern (227/257 audited ops) collapses from hand-rolled, quoting-fragile, unstructured `pct_exec` bash into three structured, token-cheap, charset-guarded tools. `compose_discover` makes `compose_redeploy`/`compose_preflight` self-serviceable. The named-volume fast path turns the most common Docker file read from a 3-FS relay into a direct read. Zero new transport, tier, or credential.

**Negative / cost.** Three new tools + parsers + `TOOL_MIN_TIER` rows (all companion, read-only) + the fast-path resolver change. `docker_stats --no-stream` is heavier than `docker ps` (it samples every container) — hence opt-in by tool choice, not folded into the roster.

**Honest limits.**
- **`docker_inspect` env redaction is best-effort, like all ADR-002 redaction** — it redacts values by default and matches the shared secret patterns; a secret in an *unusual* env-var name is still redacted (values go by default), but a secret embedded in a non-env field (a command line) follows the same redaction module and its known limits.
- **`compose_discover` sees only running containers' labels.** A compose project that is fully `down` exposes no labels to discover; it finds what is running, not every compose file on disk. Stated in the tool output.
- **Named-volume fast path assumes the default local driver.** A volume on a non-local driver (NFS/cluster) whose `Source` is not a host path under `/var/lib/docker/volumes` correctly falls back to the `docker cp` relay.

## Implementation notes

- **Pure core (`dockerHelpers.ts`):** add `parseDockerInspect`, `parseDockerStats`, `parseComposeProjects`, and the named-volume mountpoint resolver — all pure over command output, held to the guardrail-tier coverage bar.
- **Handlers (`tools/`):** `dockerInspect.ts`, `dockerStats.ts`, `composeDiscover.ts`, thin I/O over `pct exec`; `docker_read_file`'s resolver gains the volume branch.
- **Redaction:** `docker_inspect` routes env values through the ADR-002 redaction module (same module `tail_log`/`docker_logs` use).
- **Registry (`tiers/registry.ts`):** three new `TOOL_MIN_TIER` rows at `companion`. No tier-rule change.
- **CLAUDE.md:** add the three tools to the tool table and the Docker-layer section **once implemented** (not at proposal time).

## Implementation status (2026-06-19)

Implemented on branch `adr-016-docker-introspection`; +35 unit tests, full suite green (1169), typecheck + lint clean.

- **§1 `docker_inspect` (`dockerInspect.ts` + `parseContainerInspect`/`projectInspectFields`/`buildContainerInspectCommand`).** Naming: the existing ADR-008 `parseDockerInspect`/`DockerInspect` (id + mounts, for the bind resolver) was **left untouched**; the new richer projection is `parseContainerInspect`/`ContainerInspect` to avoid a collision. **Dimension-C directive honored:** env redaction runs on the **parsed** `{KEY:val}` map via `redactRecord(...)` (imported into the otherwise-pure helpers — `redactRecord` is itself pure), never on JSON-escaped text. Benign config (TZ/PUID) stays readable; secret-named/secret-valued entries are masked, with an `envRedactedCount` for transparency.
  - **Honest deviation from §1's "first `RepoDigest`":** container inspect does not expose `RepoDigests` (that lives on the *image* object, a second round trip). We surface `imageId` (`.Image`, the resolved `sha256:` content hash) as the container-level pin instead — equivalent identity, one round trip. Documented in the parser/handler doc-comments.
- **§2 `docker_stats` (`dockerStats.ts` + `parseDockerStats`/`parseDockerSize`).** `--no-stream` single sample, sorted by memory used descending; `parseDockerSize` handles both binary (MiB/GiB) and decimal (MB/GB) suffixes. No streaming (ADR-008 Option D stays deferred).
- **§3 `compose_discover` (`composeDiscover.ts` + `parseComposeProjects`/`parseDockerLabels`).** Built from `docker ps --format '{{json .}}'` Labels (reuses `buildDockerPsCommand` — one round trip), grouped by `com.docker.compose.project`, sorted + service-deduped. The honest "running-only" limit is surfaced as a `note` in the result.
- **§4 named-volume fast path.** `resolveBindMount` was **broadened** (not duplicated): a new pure `isHostVisibleMount` predicate matches binds (always) plus local-driver named volumes whose `Source` is under `/var/lib/docker/volumes/<name>/_data` (regex-anchored — a non-local/NFS volume or tmpfs stays on the `docker cp` relay). **Honest deviation:** the read/write result field stays named `viaBindMount` (now meaning "served by the host-visible fast path") to avoid churning the audit/response shape; the broadened meaning is documented at the resolver. Two pre-existing slow-path tests (read + write) used a `_data` volume fixture that now resolves fast — they were repointed to a non-local (NFS) volume source, and a new fast-path test proves the named-volume win.
- **Tier/registration:** three `companion` rows in `tiers/registry.ts`; registered in `index.ts`. No tier-rule change, no new mutation surface — all three are read-only and not audited.
- **Live smoke:** read-only `docker_inspect`/`docker_stats`/`compose_discover` against a real LXC on `proxlab` are available on request (not gated on merge, per the Safety rule).
