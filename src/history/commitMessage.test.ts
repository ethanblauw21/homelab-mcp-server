import { describe, it, expect } from "vitest";
import {
  mutationCommitMessage,
  sweepCommitMessage,
  sweepTargetsSummary,
  targetDescriptor,
} from "./commitMessage.js";

describe("targetDescriptor", () => {
  it("renders host/pct/qm descriptors", () => {
    expect(targetDescriptor({ kind: "host", remotePath: "/etc/hosts" })).toBe(
      "host:/etc/hosts"
    );
    expect(
      targetDescriptor({ kind: "pct", vmid: 104, remotePath: "/etc/wireguard/wg0.conf" })
    ).toBe("pct:104:/etc/wireguard/wg0.conf");
    expect(targetDescriptor({ kind: "qm", vmid: 200, remotePath: "/etc/x" })).toBe(
      "qm:200:/etc/x"
    );
  });
});

describe("mutationCommitMessage", () => {
  it("is the greppable, audit-joinable fixture shape", () => {
    const msg = mutationCommitMessage(
      "write_file",
      { kind: "pct", vmid: 104, remotePath: "/etc/wireguard/wg0.conf" },
      "abc-123"
    );
    expect(msg).toBe("write_file pct:104:/etc/wireguard/wg0.conf\n\naudit: abc-123");
  });
});

describe("sweepCommitMessage + summary", () => {
  it("summarizes targets for the subject line", () => {
    expect(sweepTargetsSummary(["host", { vmid: 104 }, { vmid: 107 }])).toBe(
      "host, pct:104, pct:107"
    );
    expect(sweepTargetsSummary([])).toBe("(no targets)");
  });

  it("builds the sweep commit message with the audit uuid", () => {
    expect(sweepCommitMessage("host, pct:104", "uuid-9")).toBe(
      "config_sweep host, pct:104\n\naudit: uuid-9"
    );
  });
});
