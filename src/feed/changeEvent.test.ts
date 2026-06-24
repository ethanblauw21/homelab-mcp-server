import { describe, it, expect } from "vitest";
import { buildChangeEvent } from "./changeEvent.js";
import type { AuditRecord } from "../audit/record.js";

function rec(over: Partial<AuditRecord>): AuditRecord {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    ts: "2026-06-24T12:00:00.000Z",
    tool: "write_file",
    ...over,
  } as AuditRecord;
}

describe("buildChangeEvent (ADR-022 §2 change-event projection)", () => {
  it("projects a write-family record + diff into the indexer's {uri,content,mime,meta} shape", () => {
    const ev = buildChangeEvent(
      rec({
        tool: "pct_write_file",
        vmid: 101,
        path: "/etc/app.conf",
        beforeHash: "be",
        afterHash: "af",
      }),
      "@@ -1 +1 @@\n- old\n+ new\n"
    );
    expect(ev).not.toBeNull();
    expect(ev!.uri).toBe("change://101/%2Fetc%2Fapp.conf@2026-06-24T12:00:00.000Z");
    expect(ev!.mime).toBe("text/plain");
    expect(ev!.content).toContain("+ new");
    expect(ev!.meta).toMatchObject({
      tool: "pct_write_file",
      source: "homelab-change",
      ts: "2026-06-24T12:00:00.000Z",
      vmid: 101,
      path: "/etc/app.conf",
      pre_hash: "be",
      post_hash: "af",
    });
  });

  it("namespaces a host write under change://host/…", () => {
    const ev = buildChangeEvent(rec({ tool: "write_file", path: "/etc/hosts" }), "+ x\n");
    expect(ev!.uri).toMatch(/^change:\/\/host\//);
    expect(ev!.meta.vmid).toBeUndefined();
  });

  it("redacts the diff before it leaves the server (ADR-022 §3)", () => {
    // A token-shaped secret in the diff must not survive into the change-event.
    const ev = buildChangeEvent(
      rec({ path: "/etc/app.conf" }),
      "+ PVE_API_TOKEN_SECRET=super-secret-value-1234567890\n"
    );
    expect(ev!.content).not.toContain("super-secret-value-1234567890");
  });

  it("falls back to the (already-redacted) cmd for an exec-family record with no diff", () => {
    const ev = buildChangeEvent(
      rec({ tool: "pct_exec", vmid: 105, cmd: "systemctl restart nginx", hashScope: "unknown" }),
      null
    );
    expect(ev!.content).toBe("systemctl restart nginx");
    // path absent ⇒ the URI uses hashScope as the addressable component.
    expect(ev!.uri).toBe("change://105/unknown@2026-06-24T12:00:00.000Z");
    expect(ev!.meta.path).toBeUndefined();
  });

  it("returns null when there is nothing to embed (no diff, no cmd)", () => {
    expect(buildChangeEvent(rec({ tool: "read_file", path: "/etc/app.conf" }), null)).toBeNull();
    expect(buildChangeEvent(rec({ tool: "write_file" }), "")).toBeNull();
  });
});
