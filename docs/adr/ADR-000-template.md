# ADR-000: Template & Conventions (not a decision — the shape every ADR follows)

**Status:** Living
**Date:** 2026-06-19
**Deciders:** Ethan

This file is the canonical shape for an ADR in this repo and the home of the
**bidirectional reliance-marker** convention. It is not itself a decision record;
copy the skeleton below, fill it in, and delete the guidance.

---

## Header block

Every ADR opens with this block (the lines in **bold** are required):

```
# ADR-NNN: <Title>

**Status:** Proposed | Accepted | Superseded by ADR-MMM
**Date:** YYYY-MM-DD
**Deciders:** <names>
**Depends on:** ADR-X (what is reused), ADR-Y (what is reused), …
**Required by:** ADR-Z (what it added) — or "— none yet —"
**Realizes deferral:** ADR-X §N "<deferred item>" — omit the line if none
**Source:** <optional — dogfooding report, incident, etc.>
```

Then the prose sections: **Context** → **Decision** → **Scope boundaries** →
**Consequences** (Positive / Negative / Honest limits) → **Implementation notes**.
Match the house voice: dense, decision-first, name the honest limit out loud.

---

## The bidirectional reliance markers

The dependency graph between ADRs must be navigable **in both directions**. Two
header lines and one deferral pairing keep it consistent.

### 1. `Depends on:` ⇄ `Required by:` (the forward/back pair)

- **`Depends on:`** — every prior ADR this one builds on, each with a parenthetical
  saying *what* is reused. This is the forward edge; a subsequent ADR that requires
  a previous one **must** state it here.
- **`Required by:`** — the reverse edge, written **on the depended-on ADR**. The
  rule is mechanical: **whenever you add `Depends on: ADR-X` to a new ADR, you add
  a matching `Required by: <new ADR> (<what it added>)` line to ADR-X's header.**
  A reader on either ADR can then walk the lineage without grepping.

  > **Foundational-ADR exemption.** ADR-001 (the SSH MCP server) and ADR-007
  > (permission tiers), plus `TESTING-STRATEGY-*.md`, are depended on so nearly
  > universally that a `Required by:` list on them would be every ADR and carry no
  > signal. They are **exempt** from back-link tracking — still cite them in
  > `Depends on:`, but do not maintain their reverse list. Track the *substantive*
  > lineage, not the foundation.

### 2. `Realizes deferral:` ⇄ the updated deferral note (the deferral pair)

ADRs routinely defer work ("held out of v1", "noted future", "deferred per §N").
When a later ADR **builds the deferred thing**, both ends get updated:

- The realizing ADR adds **`Realizes deferral: ADR-X §N "<item>"`** to its header.
- The original ADR's deferral sentence is amended in place with a forward pointer:
  **`— Realized by ADR-MMM.`** (and, if the deferral was a checklist item or a
  status caveat, that line is ticked/updated too). The deferral is never silently
  left looking open once it has been satisfied.

This is the "vice versa" rule: a deferral is a promise, and the promise is closed
out *at the place it was made*, not only in the ADR that fulfilled it.

---

## Worked example (the ADR-016..019 batch that introduced this convention)

- ADR-017 (output budgeting) declared `Depends on: ADR-011 (token-economy doctrine)`
  → ADR-011 gained `Required by: ADR-017 (output-side levers)` **and** its §1
  roadmap sentence gained `— output-side levers realized by ADR-017.`
- ADR-016/018/019 each added a `Required by:` line to their primary parent
  (ADR-008 / ADR-009 / ADR-002+004 respectively).

If you change a `Depends on:` while editing, fix the matching `Required by:` in the
same commit — the two are one fact written twice, on purpose.
