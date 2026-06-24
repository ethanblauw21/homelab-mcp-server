# ADR-019: Opt-in Redaction for the File-Read Family

**Status:** Accepted (implemented 2026-06-19)
**Date:** 2026-06-19
**Deciders:** Ethan
**Depends on:** ADR-002 (the shared redaction module — the single secret-pattern matcher), ADR-004 (the read surface: `read_file` stat-gating + the deliberate "reads return fidelity, logs always redact" doctrine this ADR amends)
**Required by:** ADR-022 (the "redaction is best-effort, not a security control" caveat now guards a *feed/exfil* boundary — FTS makes a redaction miss in a stored diff *searchable* at rest, a strictly larger exposure the ADR pins)
**Source:** Dogfooding run 2026-06-19 — `docker_read_file` on a qBittorrent config returned the `WebUI\Password_PBKDF2` hash verbatim into the model's context. Correct by current design; worth a lever.

## Context

The system has a deliberate, doctrinally-stated split (ADR-002/004/005/008):

- The **log/journal tools** (`tail_log`, `docker_logs`) **always** pass output through the ADR-002 redaction module. Over-redaction is the accepted failure mode for logs — a redacted secret in a log line costs nothing.
- The **file-read tools** (`read_file`, `pct_read_file`, `qm_read_file`, `docker_read_file`) **never** redact. Fidelity is the point: you read a config file to see its exact bytes, and a redaction that mangled a value you were trying to inspect would defeat the tool. ADR-008 states this for `docker_read_file` explicitly ("Not redacted (fidelity is the point)").

This split is correct as a *default*. But dogfooding exposed its cost: the very common operation "let me look at this app's config to understand its shape" pours whatever secrets that config holds straight into the model's context. The qBittorrent read returned a `Password_PBKDF2` hash; a typical `.env` or `compose` read would return API keys, tokens, DB passwords. The operator frequently does **not** need the secret values — they need the config *structure* (which keys are set, what the non-secret values are). Today that need has no lever: it is full fidelity or nothing.

This is not a request to change the default (fidelity must stay the default — see Scope). It is a request for the **caller to opt into** the same redaction the log tools already apply, for the read where structure-not-secrets is what's wanted.

## Decision

Add an **opt-in `redact?: boolean` (default `false`)** to the four file-read tools — `read_file`, `pct_read_file`, `qm_read_file`, `docker_read_file`. When `true`, the returned bytes pass through the **same ADR-002 redaction module** the log tools use before return; when absent/`false`, behavior is byte-for-byte today's full-fidelity read. The flag is reflected in the result (`redacted: true`) and, when any redaction occurred, a `redactionCount` — so the caller is never misled into thinking they are looking at verbatim bytes.

The default is unchanged and the doctrine is preserved-but-refined: **reads return fidelity by default; the caller may request the log-tools' redaction when they want structure over secrets.** This unifies the redaction story — one module, now reachable from both the always-redact log surface and (opt-in) the fidelity read surface — rather than introducing a second, read-specific redactor.

## Scope boundaries

- **Default is unchanged: no redaction.** This is the load-bearing constraint. Every existing call, test, and `revert_file`/`diff_config` consumer that reads bytes keeps full fidelity unless it opts in. Redaction-by-default on reads would break the core use (inspecting/round-tripping exact config bytes) and is explicitly rejected.
- **Read-path only; never the write/backup path.** `redact` shapes only what is *returned to the caller*. The backup pipeline, the diff-on-write bytes, the integrity content-leaf hashes, and `revert_file`'s restore all operate on **true bytes** — redacting any of those would corrupt backups and break revert/verify. The flag lives strictly at the read tool's return boundary.
- **No new redaction logic.** It reuses the ADR-002 module verbatim; this ADR adds a *call site*, not a matcher. Improvements to redaction coverage remain ADR-002's domain.
- **Encoding interaction.** `redact: true` is meaningful for `utf8` reads; for `encoding: "base64"` (binary) redaction is a no-op (a binary blob has no text secrets to pattern-match) and the result says so rather than silently implying it scanned.

## Consequences

**Positive.** The common "show me the config shape" read gets a one-flag way to keep secrets out of context, using the exact redactor the log tools already trust. The fidelity default — required for config round-tripping, backups, and verify — is untouched. The redaction module gains a second, opt-in consumer surface without a second implementation.

**Negative / cost.** A small additive flag on four tools + the result fields (`redacted`, `redactionCount`). A minor doctrine note in ADR-004 (the "reads never redact" statement becomes "reads never redact *by default*").

**Honest limits.**
- **Redaction is best-effort (ADR-002's known limit, inherited).** `redact: true` reduces exposure; it does not guarantee zero secrets — a secret in an unrecognized format can slip through. It is a convenience for the structure-over-secrets case, **not** a security control you should rely on to safely export a file. When in doubt, do not read the file into context at all.
- **Over-redaction can hide the value you wanted.** The same trade-off the log tools accept: a redacted value is gone for that call. If you opted into `redact` and the masked value was the point, re-read without it. This is why the default stays fidelity.
- **It does not change what the node exposes.** The bytes still travel from node to host either way; `redact` masks them at the return boundary to the model, not on the wire. The trust boundary (companion SSH) is unchanged.

## Implementation notes

- **Handlers:** add `redact?: boolean` to the zod schema of `read_file`, `pct_read_file`, `qm_read_file`, `docker_read_file`; on `true` and `encoding === "utf8"`, pass the decoded text through the ADR-002 redaction module at the return boundary only; set `redacted`/`redactionCount` in the result.
- **Untouched paths (assert in tests):** backup bytes, diff-on-write bytes, integrity content-leaf hashes, and `revert_file` restore all bypass the flag and use true bytes — a regression test pins that `redact: true` on a read does not alter any persisted artifact.
- **Doctrine sync:** amend ADR-004's read-surface statement to "fidelity by default, opt-in redaction" (the reverse marker on the depended-on ADR), and update the CLAUDE.md read-tool descriptions **once implemented**.
- **Tier:** no change — each tool keeps its existing tier (`read_file` ⇒ root, the guest reads ⇒ companion). No new `TOOL_MIN_TIER` row (flag on existing tools).
