# ADR-026: Secret redaction at the MCP boundary

**Status:** Accepted (2026-10-14)
**Amends:** ADR-002 (redaction module), ADR-019 (reads: "never redact by default" → "always redacted at the boundary"), ADR-022 (`audit.redactDiffs` no longer disables redaction)

## Context

The docs called several tools "secret-redacted", but in practice the redactor only caught a short key list (`password`, `token`, `secret`, …), `user:pass@` URLs, `Authorization:` headers, JWTs, PEM blocks and `AKIA…`. In another session, `docker_inspect` on the Diun container returned a full Discord webhook URL from `DIUN_NOTIF_DISCORD_WEBHOOKURL`: the key name contains no listed word, and there was no webhook-shape rule. (That webhook has since been rotated.) Redaction was also applied per tool, so a tool that didn't call the redactor (e.g. `*_exec`, plain reads) returned raw output.

The agents using this server operate under a rule never to print secret values, even partly. Before this change, the server's tools made that rule impossible to keep.

## Decision

### 1. One redactor, applied at the registration boundary

`register` in `index.ts` wraps every tool callback in `withRedaction` (`guardrails/redactionBoundary.ts`). Every text block of every result, error results, structured content and thrown error messages all pass through `redactToolResult` (`guardrails/redaction.ts`) before reaching the model. Compact JSON results are parsed and deep-redacted, so key context survives. Raw text (file content, stdout) is redacted as text with its layout preserved. The existing per-tool redaction (census, `docker_inspect` env, log tools) still runs. It is idempotent with the boundary.

**There is no bypass flag.** The read tools' `redact` flag (ADR-019) now only adds `redacted`/`redactionCount` fields. The content is redacted either way.

### 2. Key-name rules (value replaced, key kept)

Case-insensitive key pattern: `WEBHOOK|TOKEN|SECRET|PASS(WORD|WD)?|API[_-]?KEY|(^|[._-])KEY$|^KEY$|AUTH|COOKIE|CREDENTIAL|PRIVATE|SESSION|SIGNATURE|SALT|DSN|CONN(ECTION)?[_-]?STRING`, plus the earlier `ACCESS_KEY`, `PSK`, `WIREGUARD…KEY` and any `REDACTION_EXTRA_KEYS`.

The pattern is applied in these contexts:
- env `NAME=value`
- `key: value` / `key = value` lines (YAML, INI, `.env`, `export K=v`). The value runs to end of line, and YAML block scalars (`key: |`) redact the more-indented lines that follow.
- JSON `"key": value`
- XML `<ApiKey>…</ApiKey>`
- CLI `--token=x` and `--password x`
- secret-named URL query parameters
- parsed records and objects (env maps, labels, census config, tool result objects)

Exempt values: empty strings, booleans (`true`/`false`/`yes`/`no`/`on`/`off`), and interpolation references (`${VAR}`, `$VAR`, `${VAR:?msg}`). A reference with a default, `${VAR:-default}`, is **not** exempt, because the default can be the secret.

### 3. Shape rules (anywhere in text)

- Webhook URLs (Discord, Slack, Teams, generic `/webhook(s)/` and `/hooks/`) keep the scheme, host and path prefix. Notification URLs (shoutrrr/Apprise schemes such as `discord://`, `telegram://`) keep only the scheme.
- URL userinfo (`user:pass@`).
- Secret query parameters (`token`, `key`, `apikey`, `api_key`, `access_token`, `secret`, `sig`, `signature`, `password`, `auth`, …).
- `Authorization:` keeps the scheme word, e.g. `Bearer <redacted…>`.
- `X-Api-Key`, `X-Auth-Token`, `Cookie`/`Set-Cookie` and similar headers.
- `PVEAPIToken=user@realm!name=<uuid>` and any `!name=<uuid>` keep the token ID and redact the UUID secret.
- JWTs.
- PEM **private-key** blocks keep the BEGIN/END lines. Certificates are public and are no longer redacted.
- Known prefixes, kept: `ghp_`/`gho_`/…, `github_pat_`, `glpat-`, `xox[abposr]-`, `sk-`, `sk_live_`, `AKIA`/`ASIA`, `tskey-`.
- **Entropy fallback:** hex runs of 32+ characters, and base64/base64url runs of 32+ characters that contain upper, lower and digit characters and have ≥ 4.2 bits/char of entropy.
  - Allow-listed: anything after `sha256:`/`sha512:`/`md5:` (and `sha256-` SRI forms), lowercase hex of exactly 40/64/128 characters (git SHAs, container and image IDs, sha256/sha512 sums), SSH public-key bodies, `SHA256:` fingerprints, `PublicKey =` values, Tailscale `nodekey:`, and paths/URLs (runs starting with `/` or containing `//`).

### 4. Marker and fingerprint

A redacted value becomes `<redacted len=N>`, or `<redacted len=N fp=xxxxxxxx>` once the per-install key is loaded. The fingerprint is the first 8 hex characters of HMAC-SHA256 over the value, keyed with 32 random bytes stored in `redaction.key` beside the audit log (mode 0600, created on first start; override with `REDACTION_KEY_PATH`). The same value gives the same fp on one install, so a rotation can be confirmed without seeing the value. It is never a plain hash, which a short password couldn't survive. Redaction is idempotent: a value that already holds a marker is left alone.

### 5. Write guard

Tool output is now redacted, so writing it back would replace real secrets with markers. The four write cores (`writeResolvedHost/Pct/Qm/Docker`, which also serve every `*_edit_file` tool and `revert_file`) refuse new content that contains **more** markers than the current file. This applies to `dryRun` and real writes alike. The refusal points at `*_edit_file`, which leaves untouched secrets alone, or asks the caller to supply the real value. Comparing counts lets a revert, or an edit to a file that already contains marker-like text, go through.

### 6. Audit

The JSONL stores no file contents or tool arguments beyond `cmd`/`note`, which have always been redacted at write and now use the stronger rules. The `audit.db` diff projection now redacts **unconditionally**. `audit.redactDiffs` is kept for config compatibility but ignored. `query_audit` output also passes the boundary, so older records written under the weaker rules are re-redacted on the way out.

## Consequences and honest limits

- **Best-effort, not a security control.** Name-plus-shape matching misses some secrets:
  - a bare secret with no secret-ish key and no recognisable shape (e.g. `warn: hunter2`);
  - a 40/64/128-character lowercase-hex secret, which is indistinguishable from a digest;
  - a base64 secret under 32 characters, or one with low entropy;
  - a secret inside a YAML flow mapping (`{password: x}`) or in a mid-line `key: value` that isn't at the start of a line.
- **It over-redacts.** Examples: `SESSION_TIMEOUT=3600`, `--auth-type basic`, md5 sums, base64-encoded binary reads (the whole blob becomes one marker, so binary content can't be read through the tools), and API token IDs under `*TOKEN*` keys.
- **The length is disclosed** (`len=`) by design.
- **Data at rest is not rewritten.** Audit `cmd`/`note` and `audit.db` diffs written before this ADR keep whatever the old rules missed. The boundary redacts them on read through `query_audit`, but the files on disk and the ADR-010 UI's audit panel (which reads the JSONL directly, not through MCP) still hold them. The ADR-006 git mirror and the backup store hold real content by design.
- **Content hashes.** `beforeHash`/`afterHash` in audit records and the integrity forest are unkeyed SHA-256 of file content. For a file whose entire content is one short secret, the hash is brute-forceable. This is not changed here, because those hashes are the ADR-009 explained/unexplained join key.

## Enforcement (tests)

- `guardrails/redaction.test.ts` runs every fixture in `redactionFixtures.ts`, all fake, in both directions: what must be redacted and what must survive (digests, container IDs, git SHAs, UUIDs, ports, paths, normal URLs, `${VAR}`). It also covers the marker/fp, idempotency, the Diun env regression, the deep walk and the write guard.
- `guardrails/redactionBoundary.test.ts` covers three things:
  - it pins that `index.ts` registers only through the `withRedaction`-wrapped `register`;
  - it requires every tool in `TOOL_MIN_TIER` to be either run against a leaky fake backend or listed with a reason, so an unclassified new tool fails CI;
  - it runs the dump tools' handlers against a transport whose every exec and read returns secrets, and asserts that nothing survives the wrapper.
- `writeFile.dryRun.test.ts` checks that the write guard refuses markers on both the dryRun and real paths.
