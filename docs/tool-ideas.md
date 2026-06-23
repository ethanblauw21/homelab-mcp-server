# Tool ideas — dogfooding backlog

Candidate new tools surfaced while *using* (not building) the server against the
live node (`proxlab` / `10.0.0.10`). Each entry: the friction that motivated it,
a sketch of the tool, and why it isn't just a flag on an existing tool. Not ADRs
yet — raw candidates to triage.

> **Status.** Items 1–7 below **shipped** — items 1–4 via ADR-016 (`docker_inspect`/
> `docker_stats`/`compose_discover`) + ADR-017 (`describe_guest`); items 5–7 via
> **ADR-020** (`service_status`/`service_logs`/`service_restart`, `tcp_ping`/
> `http_probe`, `search_file_regex`) — all kept here for the friction record.
> Items 8–10 remain the live backlog, each carrying an unresolved architectural
> question (session state / the write-path invariant / external subsystems) that
> kept it out of ADR-020.

---

## 1. `docker_inspect` — structured container introspection  ★ highest-value

**Friction.** The audit log is the smoking gun: **227 of 257 records are
`pct_exec` running hand-rolled `docker inspect … --format '{{…}}'` / `docker
stats` / `docker exec … cat` bash loops.** Every "what image is gluetun pinned
to / what are its mounts / labels / env / restart policy" question became a
bespoke Go-template string with shell-quoting hazards, run over a full SSH
round-trip, returning unstructured text the model then re-parses. The dedicated
`docker_*` tools (`ps`/`logs`/`read_file`) don't cover *inspection*, so the path
of least resistance is to drop to `pct_exec`.

**Sketch.** `docker_inspect(vmid, container, fields?)` →
`pct exec <vmid> -- docker inspect <container>` parsed into a structured,
**secret-aware** object: image + RepoDigest, status/health, restart policy,
networks, mounts (source:dest), ports, compose project/config-file labels, and
an **env block with values redacted by default** (names kept — the audit shows
repeated `grep -iE "WATCHTOWER|TZ"` over env). `fields` narrows the projection
to cut tokens. Companion tier, read-only, not audited (mirrors `docker_ps`).
Charset-validate the container name; reuse `dockerHelpers.ts` parsers.

**Why not a flag.** `docker_ps` is a fleet-level list; this is a single-container
deep view with a different parse shape and a redaction policy env vars demand.

## 2. `docker_stats` — point-in-time resource snapshot

**Friction.** Same audit pattern: `docker stats --no-stream --format … | sort |
tail` to find the memory hogs. Hand-rolled, unstructured.

**Sketch.** `docker_stats(vmid)` → `docker stats --no-stream` parsed to
`[{name, cpuPct, memUsedBytes, memLimitBytes, memPct, netIO, blockIO}]`, sorted
by mem desc. Pairs with `health_check` for a guest-level resource view. Could
also fold into `docker_ps` as an opt-in `stats: true` — decide at ADR time.

## 3. `compose_discover` — read-only compose project map

**Friction.** Repeated `cd /var/lib/docker/volumes/portainer_data/_data/compose/1
&& grep -iE … docker-compose.yml` to find image tags / a service's block. The
compose-file *location* itself had to be rediscovered each time. `compose_redeploy`
and `compose_preflight` both already need a `composePath` the operator must
already know.

**Sketch.** `compose_discover(vmid)` → enumerate compose projects in the LXC
(from `docker ps` compose labels: `com.docker.compose.project` +
`…project.config_files`), returning `[{project, configFile, services:[{name,
image, ports}]}]`. Turns the "where is the compose file and what's in it" dance
into one structured call, and feeds the `composePath` that `compose_redeploy` /
`compose_preflight` require. Read-only, companion.

## 4. `describe_guest(vmid)` — single-guest focused census

**Friction.** `describe_homelab depth:full` re-runs every probe across the whole
node (all guests, all sections) even when the operator is working one container.
The `full` payload is ~3.5 KB and most of it is irrelevant to "tell me about
101." (See token-reduction findings.)

**Sketch.** `describe_guest(vmid, sections?)` → the census probes scoped to one
guest: its redacted config, `snapshotCapable`, docker roster (if a Docker host),
failed units, and recent drift for *its* paths. A focused, token-cheap view that
reuses the census parsers. Read-only.

---

## 5. `service_restart` / `service_status` / `service_logs` — systemd front door  ★ highest-value (new batch) → ADR-020 §1 ✅ SHIPPED

**Friction.** systemd operations today go through raw `execute` (host) / `pct_exec`
(LXC): the model writes `systemctl restart nginx`, `systemctl is-active`,
`journalctl -u …` by hand. That's free-form command text in the audit log —
unstructured, un-queryable, and a denylist/quoting surface — for an operation
that is completely enumerable.

**Sketch.** A small dedicated trio that builds the `systemctl`/`journalctl`
invocation from validated params (`unit` charset-checked, `vmid?` to target an
LXC via the existing `pct exec` plumbing):
- `service_status(unit, vmid?)` → parsed `{active, sub, enabled, since, pid}`
  (`systemctl show -p …`). Read-only, not audited.
- `service_logs(unit, vmid?, lines?, since?)` → bounded, **always-redacted** tail
  — literally `tail_log` with a `unit`-only contract (reuse `buildTailCommand`).
- `service_restart(unit, vmid?)` → confirm-gated mutation, full audit row.

**Why not a flag.** The payoff is the **structured, predictable audit object**
(`{tool:"service_restart", unit:"nginx", vmid:105}`) — exactly the clean,
parse-free record the ADR-010 UI and ADR-015 metrics want, which a free-form
`execute` string can never be. This is the same "dedicated tool beats raw exec"
move that justified the whole `docker_*`/`guest_*` family; systemd is the obvious
remaining gap. Tier: host units ⇒ root (like `execute`), LXC units ⇒ companion
(like `pct_exec`); follow target kind à la `diff_config`/`revert_file`.

## 6. `http_probe` / `tcp_ping` — assert a service actually answers → ADR-020 §2 ✅ SHIPPED

**Friction.** After a `compose_redeploy` or `guest_restart` the model has no
structured way to confirm the thing came back — it hand-writes `curl -sS -o
/dev/null -w '%{http_code}'` or `nc -z` via `*_exec`. Free-form, quoting-prone,
and the "did my change work?" check is the single most common post-mutation step.

**Sketch.**
- `tcp_ping(host, port, timeoutMs?)` → `{reachable, latencyMs}` (one connect, no
  payload).
- `http_probe(url, expectStatus?, timeoutMs?, fromVmid?)` → `{status, ok,
  latencyMs, bodyBytes}`; `expectStatus` makes it an assertion (`ok:false` when
  it misses). `fromVmid?` runs the probe *inside* an LXC via `pct exec`
  (`curl`/`wget`) so it can reach container-network-only services; absent ⇒ probe
  from the Windows host directly (no node round-trip at all).

**Why not a flag.** This is the structured *outcome* check that pairs with every
lifecycle/deploy verb — `health_check` is fixed-probe and node-scoped; this is
operator-directed at one endpoint. Read-only, not audited (like the other
read tools). Honest limit: a host-side probe and an in-guest probe see different
network namespaces — surface which one ran in the result.

## 7. `search_file_regex` — the regex "balloon" scanner → ADR-020 §3 ✅ SHIPPED

**Friction.** Reading a config to find one stanza means either `read_file` (whole
file, or a guessed `offset`/`maxBytes` window) or dropping to `execute grep`.
Neither gives "the match **plus N lines of context** each side" without burning
context on the surrounding file — and the token economy (ADR-011 §1 / ADR-017
output budgeting) is the dominant real-use cost.

**Sketch.** `search_file_regex(path, pattern, context?, maxMatches?, vmid?,
container?)` → for each match, the matched line + `context` lines above/below
(a `grep -C` "balloon"), as `[{lineNo, matchLine, before:[…], after:[…]}]`,
capped at `maxMatches` with an overflow marker. Validated regex, path through
`validatePath`, reuses the host/LXC/Docker read plumbing the `*_read_file`
family already has.

**Why not a flag.** `read_file`'s `offset`/`maxBytes` is a *blind byte window* —
you must already know where to look. This is *content-addressed* windowing: find
first, then return just the neighborhood. It's the read-side analogue of
`edit_file`'s find-and-replace front door (ADR-011), and the surgical-read tool
ADR-017's budgeting doctrine implies but doesn't yet provide.

## 8. rollback circuit breaker — the "panicked agent" guard

**Friction.** An agent that hits an error, blindly `revert_file`/`snapshot_rollback`s,
re-runs the same faulty command, and rolls back again burns tokens in a loop and
churns the node — with no backstop today.

**Sketch.** A per-session strike counter on the rollback-family verbs
(`revert_file`, `snapshot_rollback`, `guest_backup_restore`): after K reverts
(default 3) the tool refuses with a structured "hand back to human" error
instead of executing, until explicitly reset. Lives at the guardrail layer,
audited as a refusal.

**Why not a flag.** It's a *cross-call* safety policy, not a parameter on any one
tool — closest kin is the ADR-004 denylist/confirm tripwires. **Open question:**
the stdio server keeps little per-session state today; "session" and "reset"
need defining (in-memory counter for the process lifetime? persisted?). Narrower
than 5–7 — one specific failure mode — but cheap and squarely in the
guardrail-doctrine wheelhouse.

## 9. `query_semantic_history` — the semantic time machine

**Friction.** The ADR-006 git mirror remembers everything but is only searchable
by exact text / path / `git log`. "When did we last change the Docker security
settings?" is a *concept* query the mirror can't answer without the model
hand-driving `git log -S` guesses.

**Sketch.** An embedded vector index (SQLite + vec extension, or Faiss) over the
mirror's commits: each commit stored as an **LLM-generated NL summary + metadata**
(tool, vmid, pre/post hash, paths) alongside the raw diff. `query_semantic_history(
question, k?)` → the top-k matching transactions. Turns archaeology from
"guess the grep" into "ask the question."

**Why not a flag.** High conceptual value, but a **real architectural tension to
resolve before this is an ADR**: ADR-006's load-bearing invariant is *git is
never on the write's critical path and never fails the write* — an
LLM-summarize-and-embed step on commit either violates that or must run fully
async/out-of-band (a separate indexer pass over `git log`, like `config_sweep`
is to mutations). Also adds an embedding dependency + a "who calls the LLM"
question the server has so far avoided. Worth it, but heavier than 5–8.

## 10. `index_path` — the indexer router

**What it does.** A unified `index_path(path)` that routes a file to a Python
codebase indexer (AST/semantic chunking for `.py`/`.yml`/`.tf`) or a Rust
filesystem indexer (fast metadata/structural tracking for raw logs/configs),
so the model just says "index this" and the system handles routing.

**Why it's ranked last / open questions.** Most speculative and the least
architectural fit: it depends on **two external indexer subsystems that don't
exist in this repo**, and codebase/AST indexing is arguably a *different product*
than node operation — this server's job is operating a Proxmox node, not
indexing source trees. Before it's a candidate it needs: what consumes the
index (the model? a future RAG tool?), where the indexers live and how they're
invoked (subprocess? service?), and how it relates to the existing read/forest
layers. Captured for completeness; not actionable as-is.

---

### Cross-cutting note (not a tool)
The dominant cost driver in real use is **multi-step diagnostics fanning out
into many `pct_exec` SSH round-trips**. Tools 1–3 each collapse a recurring bash
loop into one structured, quoting-safe, token-cheap call — that's the throughline.
The new batch extends it on two axes: **5–6** give *structured outcomes* (clean
audit rows, pass/fail probes) where today only free-form `execute` exists, and
**7** extends the token-economy doctrine to the read side. **8–10** are
higher-ambition / higher-cost and each carry an unresolved architectural
question (session state, the write-path invariant, external subsystems)
flagged inline.
