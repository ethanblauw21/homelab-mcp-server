---
name: Feature request
about: Propose a new tool, capability, or enhancement to an existing one
title: "[feature]: "
labels: enhancement
assignees: ''
---

## Problem / motivation

<!-- What can't you do today, or what's painful? Ground it in a real usage scenario
     rather than a hypothetical. -->

## Proposed solution

<!-- The tool or change you'd like. If it's a new tool, sketch its inputs/outputs and
     what it operates on (host vs guest, API vs SSH). -->

## Tier placement

<!-- Which permission tier should this live at? New tools add one row to
     TOOL_MIN_TIER in tiers/registry.ts. See SECURITY.md / ADR-007. -->

- **Proposed minimum tier:** <!-- observe | operate | companion | root -->

## Does this need an ADR?

<!-- Per CONTRIBUTING.md, changes to the tool surface, transport, tier model, trust
     model, or backup/audit behavior require an ADR before implementation.
     Check the box if any apply. -->

- [ ] Touches the tool surface (new/changed tool)
- [ ] Touches transport, tier, or trust model
- [ ] Touches backup or audit behavior
- [ ] None of the above (pure internal/ergonomic change)

## Alternatives considered

<!-- Other approaches, workarounds you're using today, or why existing tools don't cover it. -->

## Additional context

<!-- Related ADRs, roadmap items, screenshots, or examples. -->
