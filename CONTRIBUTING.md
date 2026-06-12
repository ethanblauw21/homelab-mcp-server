# Contributing

## Setup

```bash
npm install
npm run build
npm run test:unit   # fast, no Docker required — the primary local feedback loop
```

Integration tests require Docker and are intended for Linux/CI:

```bash
npm run test:int
```

## The core invariant

Before writing code, understand the principle the entire test and safety strategy depends on: **guardrails, backup policy, eviction, audit record construction, tier registry, and trust decisions are pure functions with no I/O.** This is what keeps unit tests fast, deterministic, and mutation-testable.

If you are touching `guardrails/`, `backup/policy.ts`, `backup/eviction.ts`, `audit/record.ts`, `history/`, or `tiers/` — the code must stay pure. Tool handlers call these functions, then call injected interfaces to do the actual I/O. The dependency direction is one-way: handlers → interfaces → concrete implementations. Never import `ssh2Client.ts` or `apiClient.ts` from a tool handler.

Adding a tool means adding one row to `TOOL_MIN_TIER` in `tiers/registry.ts`. Nothing else is needed for registration.

## ADR-first process

Changes to the tool surface, transport, tier model, trust model, or backup/audit behavior require an ADR before implementation. The ADRs are the specification; the code implements the spec, not the other way around.

ADRs live in `docs/adr/` as `ADR-NNN-slug.md`. Write from a question the design needs to answer: document the options considered, state the decision, and explain the rationale. Look at the existing ADRs for format and depth. If you are unsure whether something warrants an ADR, it probably does.

## Testing requirements

| Layer | Requirement |
|-------|-------------|
| Pure functions (`guardrails/`, `backup/`, `audit/record.ts`, `history/`, `tiers/`) | Unit tests, ~90%+ line/branch coverage, mutation-tested |
| Tool handlers | Integration tests via Docker SSH harness or `ApiBackend` fixtures |
| New tools | Both: unit tests for any pure helpers, integration test for the handler wiring |

Coverage count is not enough — run `npx stryker run` to verify the tests actually catch mutations. The guardrail and backup modules have a mutation testing requirement; a green coverage report with a poor mutation score is not acceptable.

## What we would welcome

- New tools built against the existing `NodeOps` / `SshTransport` interfaces
- Bug fixes accompanied by a regression test
- Integration test coverage improvements
- Documentation improvements and ADR clarifications

Changes to the tier model, trust model, protected set, or root flag semantics are high-stakes design decisions. These require an ADR and careful review before any implementation.

## Pull requests

One logical change per PR. If the change touches the tool surface or architecture, reference or include the relevant ADR. Keep commit messages functional — what changed and why, not project philosophy.
