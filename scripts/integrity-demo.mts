/**
 * ADR-009 Merkle integrity forest — live demonstration (throwaway script).
 *
 * Drives the REAL IntegrityEngine + MemoryNodeStore + AuditLog against an
 * in-memory node filesystem (host + one LXC), walking a tamper-detection story:
 *
 *   1. Build the baseline Merkle forest        (compute_tree)
 *   2. Verify with no changes                  → clean
 *   3. Out-of-band edit (human/attacker)       → UNEXPLAINED drift
 *   4. A server write that stamps an audit hash → EXPLAINED drift (attributed)
 *   5. accept_truth folds reality into baseline → clean again
 *   6. mtime-only touch under smart escalation  → folded as L1-only, zero content read
 *
 * Run:  npx tsx scripts/integrity-demo.mts
 */
import crypto from "crypto";
import path from "path";
import os from "os";
import { IntegrityEngine } from "../src/integrity/integrityEngine.js";
import { MemoryNodeStore } from "../src/integrity/nodeStore.js";
import { AuditLog } from "../src/audit/log.js";
import { buildAuditRecord } from "../src/audit/record.js";
import { config as baseConfig, type Config } from "../src/config.js";
import type { ExecResult, SshTransport } from "../src/ssh/transport.js";

interface FsEntry { kind: "file" | "dir"; mtime: number; content?: string; }

/** In-memory node FS that answers the exact commands forest.ts issues. */
class NodeFsTransport implements SshTransport {
  host = new Map<string, FsEntry>();
  containers = new Map<number, Map<string, FsEntry>>();
  runningVmids = new Set<number>();
  shaReads = 0; // count content hashings, to prove smart escalation reads zero when clean

  async exec(command: string): Promise<ExecResult> {
    if (command === "pct list") {
      const lines = ["VMID       Status     Lock         Name"];
      for (const vmid of this.containers.keys())
        lines.push(`${vmid}        ${this.runningVmids.has(vmid) ? "running" : "stopped"}              ct${vmid}`);
      return ok(lines.join("\n") + "\n");
    }
    const statusMatch = /^pct status (\d+)$/.exec(command);
    if (statusMatch) {
      const vmid = Number(statusMatch[1]);
      return ok(`status: ${this.runningVmids.has(vmid) ? "running" : "stopped"}\n`);
    }
    const vmidExec = /pct exec (\d+) -- sh -c/.exec(command);
    const fs = vmidExec ? this.containers.get(Number(vmidExec[1])) ?? new Map() : this.host;
    if (command.includes("-printf '%y")) {
      const lines: string[] = [];
      for (const [p, e] of fs) lines.push(`${e.kind === "dir" ? "d" : "f"}\t${e.mtime}\t${p}`);
      return ok(lines.join("\n") + "\n");
    }
    if (command.includes("sha256sum")) {
      const lines: string[] = [];
      for (const [p, e] of fs) {
        if (e.kind === "file" && command.includes(`'${p}'`)) {
          this.shaReads++;
          lines.push(`${crypto.createHash("sha256").update(e.content ?? "").digest("hex")}  ${p}`);
        }
      }
      return ok(lines.join("\n") + "\n");
    }
    return ok("");
  }
  async stat() { return { size: 0 }; }
  async readFile() { return Buffer.alloc(0); }
  async writeFile() {}
  async list() { return []; }
  async close() {}
}
const ok = (stdout: string): ExecResult => ({ stdout, stderr: "", exitCode: 0 });

function cfg(): Config {
  return {
    ...baseConfig,
    ssh: { ...baseConfig.ssh, host: "demo-node", commandTimeoutMs: 1000 },
    history: { ...baseConfig.history, hostWatchPaths: ["/etc"], containerWatchPaths: ["/etc"], excludePatterns: [] },
    integrity: { ...baseConfig.integrity },
  };
}

const short = (h?: string | null) => (h ? h.slice(0, 16) + "…" : "(none)");
function banner(n: number, title: string) { console.log(`\n${"═".repeat(64)}\n  STEP ${n} — ${title}\n${"═".repeat(64)}`); }
function showDrift(report: { drift: any[] }) {
  if (report.drift.length === 0) { console.log("   drift: none ✓"); return; }
  for (const d of report.drift) {
    const tag = d.status === "explained" ? "EXPLAINED  " : "UNEXPLAINED";
    const by = d.explainedBy ? `  ← ${d.explainedBy.tool} @ ${d.explainedBy.auditId.slice(0, 8)}` : "";
    console.log(`   [${tag}] ${d.nodePath}`);
    console.log(`              ${short(d.oldHash)} → ${short(d.newHash)}  (L1:${d.l1} L2:${d.l2} L3:${d.l3})${by}`);
  }
}

async function main() {
  const transport = new NodeFsTransport();
  // Host /etc
  transport.host.set("/etc", { kind: "dir", mtime: 50 });
  transport.host.set("/etc/hosts", { kind: "file", mtime: 100, content: "127.0.0.1 localhost\n10.0.0.10 node\n" });
  transport.host.set("/etc/app.conf", { kind: "file", mtime: 100, content: "loglevel=info\nport=8080\n" });
  transport.host.set("/etc/ssh", { kind: "dir", mtime: 50 });
  transport.host.set("/etc/ssh/sshd_config", { kind: "file", mtime: 100, content: "PermitRootLogin yes\n" });
  // One running LXC (vmid 101) with its own /etc
  const ct = new Map<string, FsEntry>();
  ct.set("/etc", { kind: "dir", mtime: 50 });
  ct.set("/etc/app.conf", { kind: "file", mtime: 100, content: "service=dockerBoss\n" });
  transport.containers.set(101, ct);
  transport.runningVmids.add(101);

  const store = new MemoryNodeStore();
  const auditPath = path.join(os.tmpdir(), `integrity-demo-${crypto.randomUUID()}.jsonl`);
  const audit = new AuditLog(auditPath);
  const engine = new IntegrityEngine(store, transport, cfg(), audit);

  // STEP 1 — build the baseline forest at L3 (full content)
  banner(1, "compute_tree — build the baseline Merkle forest (L3, full content)");
  const built = await engine.computeTree("l3", "baseline");
  console.log(`   super-root hash: ${short(built.rootHash)}`);
  console.log(`   forest nodes:    ${built.nodeCount}  (host /etc subtree + pct/101 /etc subtree, namespaced under one super-root)`);

  // STEP 2 — verify, nothing changed
  banner(2, "verify_integrity (L3) — no changes since baseline");
  showDrift(await engine.verify("l3"));

  // STEP 3 — out-of-band edit: someone edits sshd_config directly on the node
  banner(3, "Out-of-band edit on the node (no MCP tool involved) → expect UNEXPLAINED");
  console.log('   simulating: a human runs `vi /etc/ssh/sshd_config` and sets PermitRootLogin without keys');
  transport.host.set("/etc/ssh/sshd_config", { kind: "file", mtime: 555, content: "PermitRootLogin without-password\n" });
  const r3 = await engine.verify("l3");
  showDrift(r3);
  console.log(`   super-root moved: ${short(built.rootHash)} → ${short(r3.rootHash)}  (any change ripples to the root)`);

  // STEP 4 — a server-mediated write: stamp an audit afterHash that matches the new bytes
  banner(4, "A server write_file that stamps a hash-anchored audit record → expect EXPLAINED");
  console.log('   simulating: write_file edits /etc/app.conf AND records its afterHash (ADR-009 anchor)');
  transport.host.set("/etc/app.conf", { kind: "file", mtime: 600, content: "loglevel=debug\nport=8080\n" });
  // Probe what the new forest leaf hash will be, then plant the matching audit record.
  const probe = await engine.verify("l3");
  const newHash = probe.drift.find((d) => d.nodePath === "/etc/app.conf")!.newHash!;
  await audit.append(buildAuditRecord({ tool: "write_file", host: "demo-node", path: "/etc/app.conf", afterHash: newHash }));
  console.log(`   planted audit afterHash = ${short(newHash)} (tool=write_file)`);
  const r4 = await engine.verify("l3");
  showDrift(r4);
  console.log("   → the sshd_config edit is still UNEXPLAINED; the app.conf edit is now EXPLAINED. The join is by hash, not by guesswork.");

  // STEP 5 — accept_truth: human blesses current reality
  banner(5, "accept_truth — fold current state into all three baselines (audited)");
  const accepted = await engine.acceptTruth();
  console.log(`   audit id: ${accepted.auditId.slice(0, 8)}   new baseline super-root: ${short(accepted.rootHash)}`);
  console.log("   re-verify after accept:");
  showDrift(await engine.verify("l3"));

  // STEP 6 — smart escalation: an mtime-only touch reads ZERO content
  banner(6, "verify(smart) — an mtime-only touch (L1) escalates cheaply / folds as l1-only");
  const before = transport.shaReads;
  await engine.verify("smart"); // clean baseline, should read no content
  console.log(`   clean smart verify content-hash reads: ${transport.shaReads - before}  (expect 0 — L1 gate stops escalation)`);
  const beforeTouch = transport.shaReads;
  transport.host.set("/etc/hosts", { kind: "file", mtime: 9999, content: "127.0.0.1 localhost\n10.0.0.10 node\n" }); // mtime only, same bytes
  const auto = await engine.autoAccept("smart");
  console.log(`   touched /etc/hosts mtime only (content identical).`);
  console.log(`   auto-accept folded: ${auto.folded.map((o) => `${o.path}[${o.reason}]`).join(", ") || "(none)"}`);
  console.log(`   auto-accept flagged: ${auto.flagged.map((o) => `${o.path}[${o.reason}]`).join(", ") || "(none)"}`);
  console.log(`   content-hash reads during the L1 touch path: ${transport.shaReads - beforeTouch} (L2/L3 only where L1 flagged)`);

  // Audit trail summary
  banner(7, "Audit trail (every fold is recorded)");
  for (const rec of audit.readAll())
    console.log(`   ${rec.tool.padEnd(13)} ${rec.id.slice(0, 8)}  scope=${(rec as any).hashScope ?? rec.path ?? "-"}  ${rec.note ?? ""}`);

  console.log("\n✓ demo complete — real IntegrityEngine drove every step.\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
