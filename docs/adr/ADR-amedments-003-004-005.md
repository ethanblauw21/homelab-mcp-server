# ADR Amendments — 2026-06-09 (ADR-003 / ADR-004 / ADR-005)

**Status:** Approved deltas — apply to the canonical ADR copies in-repo and implement accordingly.
**Scope:** ADR-002 amendments were delivered separately and are already in flight; they are intentionally absent here.

---

## ADR-003 (Container File Safety + Snapshot Guard)

### A3.1 — Stopped containers: `pct pull`/`pct push` precondition (correctness, MUST)

`pct pull` and `pct push` require a **running** container. The current spec treats a failed pull during `pct_write_file` as "file does not exist ⇒ new file," which would misclassify a *stopped container* as a new-file write and proceed to push against a guest that can't receive it.

**Change:**
- Both `pct_read_file` and `pct_write_file` begin with a guest-state check (status from `pct list`/`pct status <vmid>`). If the container is not `running` ⇒ refuse with a structured error naming the state and the remedy ("start the container, or edit via the Proxmox UI").
- "New file" is only inferred when the container is confirmed running **and** the pull fails with a file-not-found error specifically; any other pull failure is surfaced as an error, never reinterpreted.
- Add to the testing table: stopped-container refusal (read and write paths) and pull-error classification (not-found vs other) as unit cases against the fake.
- New stretch action item: a `pct mount`-based read/write path for stopped containers (explicitly not v1).

### A3.2 — VM snapshots: `--vmstate` decision (spec gap, MUST document)

The spec never decided whether `qm snapshot` includes RAM state.

**Change:**
- Default: **no `--vmstate`** (RAM dumps are large; node disk is premium). Consequence: rolling back a VM snapshot is **disk-only** — the guest resumes as if from power loss, not as if resumed from the moment of the snapshot.
- This consequence MUST appear in the `snapshot_rollback` tool description and in the rollback audit note for VM targets.
- Config addition: `snapshotVmstate: boolean` (default `false`) for operators who want RAM-inclusive snapshots and accept the disk cost.
- Testing: command-construction unit test asserts the flag's presence/absence follows config.

---

## ADR-004 (Transport & Guardrail Hardening)

### A4.1 — Timeout wrapper shell: `bash -c`, not `sh -c` (bug, MUST)

On Debian, `sh` is dash. Today's `execute` passes commands raw over SSH exec, which runs them under root's login shell (bash). Wrapping in `sh -c` would silently change shell semantics and break every bashism that currently works (`[[ ]]`, `for ((;;))`, process substitution, etc.).

**Change:** the wrapper is
`timeout --signal=TERM --kill-after=5 <secs> bash -c '<escaped>'`
Same single-quote escaping helper; `pct_exec` composition note unchanged in structure but uses `bash -c` where the container provides bash, with a documented fallback: if a guest lacks bash, the inner wrapper degrades to `sh -c` and the result carries a `shell: "sh"` note (alpine-style containers). Testing: wrapper-construction tests assert `bash -c`; add a bashism round-trip integration case (`[[ -d /tmp ]] && echo ok`).

### A4.2 — Segment splitter: quote-awareness is required, not optional (spec firmed)

The spec hedged ("document the chosen fidelity level"). Hedge removed.

**Change:** the splitter MUST be quote-aware: separators inside single or double quotes do not split segments (`echo "a && b"` is one segment with `echo` in command position). Escaped quotes within double quotes are handled; everything beyond that (heredocs, arithmetic contexts) is explicitly out of scope and documented. Testing additions: quoted-separator fixtures, nested-quote fixtures, and the adversarial case `bash -c "reboot"` — the inner string is *argument* position for the splitter, which is acceptable: `bash`/`sh -c` evasion is already in the known-limits paragraph (tripwire, not sandbox), and MUST be listed there explicitly as an example.

### A4.3 — Implementation ordering: host-key pinning ships first, standalone (sequencing, SHOULD)

Census development (ADR-002, in flight) is running read-heavy operations against the live node while host-key verification does not exist.

**Change:** action item 2 (host-key verification: pin + TOFU store + fail-closed mismatch) is promoted to a standalone change set, implementable immediately and independently — it touches only `Ssh2Transport`, config, and setup docs, and does not depend on the `ExecResult` migration or any other ADR-004 item. The remaining ADR-004 items keep their original ordering.

---

## ADR-005 (VM Parity + Operator Toolkit)

### A5.1 — Pending-updates probe: staleness labeling (accuracy, SHOULD)

`apt-get -s upgrade` counts against the *last refreshed* package lists; without a recent `apt update` the count is stale. The probe must not run `apt update` itself (slow, lock-taking, mutating cache state inside a read-only tool).

**Change:** the probe additionally reads the package-list freshness (mtime of `/var/lib/apt/lists`, e.g. `stat -c %Y /var/lib/apt/lists 2>/dev/null`) and the finding is labeled `asOf: <timestamp>`. Evaluator behavior unchanged; the staleness is informational. Testing: evaluator fixture includes the `asOf` field; stale-list fixture renders a finding that names the refresh age.

---

## Cross-cutting note for implementation

A4.1 interacts with ADR-005's `qm_exec`: the inner agent command construction follows the same `bash -c`-preferred / `sh -c`-fallback rule, using the shared quoting helper. No other amendment alters a cross-ADR contract.