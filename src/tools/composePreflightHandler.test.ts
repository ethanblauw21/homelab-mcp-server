import { describe, it, expect } from "vitest";
import { composePreflightHandler } from "./composePreflightHandler.js";
import type { ExecResult, ReadFileOptions, SshTransport, FileEntry, FileStat } from "../ssh/transport.js";

const cfg = {
  ssh: { host: "node.lan", commandTimeoutMs: 5000 },
  guardrails: { pathAllowlist: undefined, pathDenylist: ["/etc/pve"] },
  container: { nodeTempDir: "/tmp" },
} as unknown as import("../config.js").Config;

/**
 * A substring-matching transport: real `pct pull`/`mktemp` command strings carry a
 * server-generated temp path we cannot predict, so we match on intent, not exact
 * bytes. `onPull` maps a remotePath → its on-disk bytes (null ⇒ file-not-found).
 */
class PreflightFake implements SshTransport {
  commands: string[] = [];
  private staged = new Map<string, Buffer>();
  constructor(
    private opts: {
      running?: boolean;
      onPull?: Record<string, string | null>;
      probeStdout?: string;
      probeExit?: number;
    } = {}
  ) {}

  async exec(command: string): Promise<ExecResult> {
    this.commands.push(command);
    if (command.startsWith("pct status")) {
      return { stdout: this.opts.running === false ? "status: stopped" : "status: running", stderr: "", exitCode: 0 };
    }
    if (command.startsWith("mktemp")) {
      return { stdout: "/tmp/preflight-tmp", stderr: "", exitCode: 0 };
    }
    if (command.startsWith("pct pull")) {
      // pct pull <vmid> '<remotePath>' '<tmp>'
      const m = command.match(/pct pull \d+ '([^']+)' '([^']+)'/);
      const remotePath = m?.[1] ?? "";
      const tmp = m?.[2] ?? "";
      const content = this.opts.onPull?.[remotePath];
      if (content === undefined || content === null) {
        return { stdout: "", stderr: "no such file or directory", exitCode: 1 };
      }
      this.staged.set(tmp, Buffer.from(content));
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    if (command.includes("ss -tlnp")) {
      return { stdout: this.opts.probeStdout ?? "", stderr: "", exitCode: this.opts.probeExit ?? 0 };
    }
    if (command.startsWith("rm -f")) return { stdout: "", stderr: "", exitCode: 0 };
    return { stdout: "", stderr: "", exitCode: 0 };
  }
  async readFile(remotePath: string, _o?: ReadFileOptions): Promise<Buffer> {
    const b = this.staged.get(remotePath);
    if (!b) throw new Error(`no staged file ${remotePath}`);
    return b;
  }
  async stat(): Promise<FileStat> { throw new Error("unused"); }
  async writeFile(): Promise<void> { /* unused */ }
  async list(): Promise<FileEntry[]> { return []; }
  async close(): Promise<void> { /* unused */ }
}

const CLEAN = `
services:
  tailscale:
    image: tailscale/tailscale:latest
    ports: ["8080:8080"]
  dozzle:
    network_mode: service:tailscale
    environment: { PORT: 9090 }
`;
const COLLIDING = `
services:
  tailscale:
    image: tailscale/tailscale:latest
  qbittorrent:
    network_mode: service:tailscale
    expose: ["8080"]
  dozzle:
    network_mode: service:tailscale
    expose: ["8080"]
`;

describe("composePreflightHandler", () => {
  it("rejects a non-absolute / denylisted path before any I/O", async () => {
    const ft = new PreflightFake();
    await expect(
      composePreflightHandler({ vmid: 101, composePath: "relative.yml", checkBoundPorts: false }, ft, cfg)
    ).rejects.toThrow(/Invalid compose file path/);
    await expect(
      composePreflightHandler({ vmid: 101, composePath: "/etc/pve/x.yml", checkBoundPorts: false }, ft, cfg)
    ).rejects.toThrow(/Invalid compose file path/);
    expect(ft.commands).toEqual([]);
  });

  it("refuses when the container is not running", async () => {
    const ft = new PreflightFake({ running: false });
    await expect(
      composePreflightHandler({ vmid: 101, composePath: "/opt/s/c.yml", checkBoundPorts: false }, ft, cfg)
    ).rejects.toThrow(/not running/);
  });

  it("analyzes composeContent (proposed) and detects a collision; no on-disk prev", async () => {
    const ft = new PreflightFake({ onPull: { "/opt/s/c.yml": null } });
    const r = await composePreflightHandler(
      { vmid: 101, composePath: "/opt/s/c.yml", composeContent: COLLIDING, checkBoundPorts: false },
      ft,
      cfg
    );
    expect(r.ok).toBe(false);
    expect(r.boundPortsChecked).toBe(false);
    expect(r.hazards.some((h) => h.kind === "port-collision")).toBe(true);
    expect(r.stack.provider).toBe("tailscale");
  });

  it("uses on-disk content as prev so the recreate check is precise", async () => {
    // on-disk tailscale has one port; proposed adds a second → provider change → recreate error
    const onDisk = `
services:
  tailscale: { image: tailscale/tailscale:latest, ports: ["8080:8080"] }
  dozzle: { network_mode: service:tailscale }
`;
    const proposed = `
services:
  tailscale: { image: tailscale/tailscale:latest, ports: ["8080:8080", "9090:9090"] }
  dozzle: { network_mode: service:tailscale }
`;
    const ft = new PreflightFake({ onPull: { "/opt/s/c.yml": onDisk } });
    const r = await composePreflightHandler(
      { vmid: 101, composePath: "/opt/s/c.yml", composeContent: proposed, checkBoundPorts: false },
      ft,
      cfg
    );
    const recreate = r.hazards.filter((h) => h.kind === "netns-recreate");
    expect(recreate).toHaveLength(1);
    expect(recreate[0]!.severity).toBe("error");
  });

  it("reads composePath when no composeContent is supplied", async () => {
    const ft = new PreflightFake({ onPull: { "/opt/s/c.yml": CLEAN } });
    const r = await composePreflightHandler(
      { vmid: 101, composePath: "/opt/s/c.yml", checkBoundPorts: false },
      ft,
      cfg
    );
    expect(r.ok).toBe(true);
    expect(r.stack.services.sort()).toEqual(["dozzle", "tailscale"]);
  });

  it("throws a structured error when the file is absent and no content supplied", async () => {
    const ft = new PreflightFake({ onPull: { "/opt/s/c.yml": null } });
    await expect(
      composePreflightHandler({ vmid: 101, composePath: "/opt/s/c.yml", checkBoundPorts: false }, ft, cfg)
    ).rejects.toThrow(/no file at/);
  });

  it("surfaces a parse error as a clean refusal", async () => {
    const ft = new PreflightFake({ onPull: { "/opt/s/c.yml": null } });
    await expect(
      composePreflightHandler(
        { vmid: 101, composePath: "/opt/s/c.yml", composeContent: "services:\n  - : : :", checkBoundPorts: false },
        ft,
        cfg
      )
    ).rejects.toThrow(/compose_preflight:/);
  });

  it("runs the bound-port probe and flags a foreign-held port", async () => {
    const ss = `State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process
LISTEN 0 128 0.0.0.0:8080 0.0.0.0:* users:(("gluetun",pid=7,fd=9))`;
    const content = `
services:
  tailscale: { image: tailscale/tailscale:latest }
  dozzle: { network_mode: service:tailscale, expose: ["8080"] }
`;
    const ft = new PreflightFake({ onPull: { "/opt/s/c.yml": null }, probeStdout: ss });
    const r = await composePreflightHandler(
      { vmid: 101, composePath: "/opt/s/c.yml", composeContent: content, checkBoundPorts: true },
      ft,
      cfg
    );
    expect(r.boundPortsChecked).toBe(true);
    const bound = r.hazards.filter((h) => h.kind === "port-bound-elsewhere");
    expect(bound).toHaveLength(1);
    expect(bound[0]!.detail).toContain("gluetun");
    // The probe targeted the provider's container netns.
    expect(ft.commands.some((c) => c.includes("docker exec tailscale"))).toBe(true);
  });

  it("degrades to boundPortsChecked:false when the probe yields nothing", async () => {
    const content = `services:\n  a: { image: x }`;
    const ft = new PreflightFake({ onPull: { "/opt/s/c.yml": null }, probeStdout: "" });
    const r = await composePreflightHandler(
      { vmid: 101, composePath: "/opt/s/c.yml", composeContent: content, checkBoundPorts: true },
      ft,
      cfg
    );
    expect(r.boundPortsChecked).toBe(false);
  });
});
