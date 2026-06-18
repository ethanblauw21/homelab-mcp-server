---
name: Bug report
about: Report something in the homelab MCP server that isn't working as expected
title: "[bug]: "
labels: bug
assignees: ''
---

## Summary

<!-- A clear, one- to two-sentence description of the bug. -->

## Tier and transport

<!-- The permission tier the server was running at, and the transport in play.
     See SECURITY.md / ADR-007 for tier definitions. -->

- **Tier:** <!-- observe | operate | companion | root -->
- **Transport:** <!-- API token | SSH | n/a -->
- **Tool(s) involved:** <!-- e.g. snapshot_create, pct_exec, describe_homelab -->

## Steps to reproduce

1.
2.
3.

## Expected behavior

<!-- What you expected to happen. -->

## Actual behavior

<!-- What actually happened. Include the exact error string if there was one. -->

## Evidence

<!-- Anything that helps pin it down:
     - audit record id(s) from query_audit
     - relevant stderr / log lines
     - the tool call arguments (redact secrets) -->

## Environment

- **Proxmox VE version:**
- **Server version / commit:**
- **Affected guest (VMID), if any:**

## Additional context

<!-- Hypothesis on root cause, related ADRs, anything else. -->
