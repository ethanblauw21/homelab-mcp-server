import { describe, it, expect } from "vitest";
import { FakeTransport } from "../ssh/fakeTransport.js";
import { buildPctExecCommand, parsePctList } from "./pctHelpers.js";
import { describeGuestHandler, resolveGuestKind, DescribeGuestInputSchema } from "./describeGuest.js";
import { parseQmList } from "./censusParsers.js";
import type { Config } from "../config.js";

function makeConfig(): Config {
  return {
    ssh: { commandTimeoutMs: 5000 },
    census: { redactionExtraKeys: [] },
  } as unknown as Config;
}

function parse(input: unknown) {
  return DescribeGuestInputSchema.parse(input);
}

const PCT_LIST = "VMID Status Lock Name\n101 running gluetun\n102 stopped portainer";
const QM_LIST = "VMID NAME STATUS MEM BOOTDISK PID\n100 truenas running 8192 32 1234";
const PVESM = "Name Type Status Total Used Available %\nlocal dir active 100 10 90 10%\nlocal-lvm lvmthin active 200 20 180 10%";

function baseTransport(): FakeTransport {
  const t = new FakeTransport();
  t.setExecResult("pct list", { stdout: PCT_LIST, stderr: "", exitCode: 0 });
  t.setExecResult("qm list", { stdout: QM_LIST, stderr: "", exitCode: 0 });
  t.setExecResult("pvesm status", { stdout: PVESM, stderr: "", exitCode: 0 });
  return t;
}

describe("resolveGuestKind (pure)", () => {
  const pct = parsePctList(PCT_LIST);
  const qm = parseQmList(QM_LIST);

  it("resolves an LXC, a QEMU, and returns null for an unknown vmid", () => {
    expect(resolveGuestKind(pct, qm, 101)).toEqual({ kind: "lxc", name: "gluetun", status: "running" });
    expect(resolveGuestKind(pct, qm, 100)).toEqual({ kind: "qemu", name: "truenas", status: "running" });
    expect(resolveGuestKind(pct, qm, 999)).toBeNull();
  });
});

describe("describeGuestHandler (ADR-017 §4)", () => {
  it("returns identity + redacted config + snapshotCapable + docker/units for a running LXC", async () => {
    const t = baseTransport();
    t.setExecResult("pct config 101", {
      stdout: "arch: amd64\nrootfs: local-lvm:subvol-101-disk-0,size=8G\npassword: supersecret",
      stderr: "",
      exitCode: 0,
    });
    t.setExecResult(
      buildPctExecCommand(
        101,
        'command -v docker >/dev/null 2>&1 && docker ps --format "{{.Names}}\\t{{.Image}}\\t{{.Status}}" || true'
      ),
      { stdout: "web\tnginx:latest\tUp 2 days\n", stderr: "", exitCode: 0 }
    );
    t.setExecResult(buildPctExecCommand(101, "systemctl list-units --failed --no-legend --plain"), {
      stdout: "  nginx.service loaded failed failed Nginx\n",
      stderr: "",
      exitCode: 0,
    });

    const res = await describeGuestHandler(parse({ vmid: 101 }), t, makeConfig());

    expect(res).toMatchObject({ vmid: 101, kind: "lxc", name: "gluetun", status: "running" });
    // local-lvm is lvmthin (not dir) ⇒ snapshot-capable.
    expect(res.snapshotCapable).toEqual({ capable: true });
    // config is redacted, not raw.
    expect(res.config?.password).toBe("[REDACTED:password]");
    expect(res.redactions).toBe(1);
    expect(JSON.stringify(res)).not.toContain("supersecret");
    expect(res.docker).toEqual([{ name: "web", image: "nginx:latest", status: "Up 2 days" }]);
    expect(res.failedUnits).toEqual(["nginx.service"]);
    expect(res.errors).toEqual([]);
  });

  it("marks a dir-backed rootfs snapshot-incapable using the pvesm storage map", async () => {
    const t = baseTransport();
    t.setExecResult("pct config 101", { stdout: "arch: amd64\nrootfs: local:subvol-101-disk-0,size=8G", stderr: "", exitCode: 0 });
    t.setExecResult(
      buildPctExecCommand(
        101,
        'command -v docker >/dev/null 2>&1 && docker ps --format "{{.Names}}\\t{{.Image}}\\t{{.Status}}" || true'
      ),
      { stdout: "", stderr: "", exitCode: 0 }
    );
    t.setExecResult(buildPctExecCommand(101, "systemctl list-units --failed --no-legend --plain"), { stdout: "", stderr: "", exitCode: 0 });

    const res = await describeGuestHandler(parse({ vmid: 101 }), t, makeConfig());
    expect(res.snapshotCapable?.capable).toBe(false);
    expect(res.snapshotCapable?.reason).toContain("dir storage");
  });

  it("scopes via sections — config only, no docker/units probes", async () => {
    const t = baseTransport();
    t.setExecResult("pct config 101", { stdout: "arch: amd64\nrootfs: local-lvm:subvol-101-disk-0,size=8G", stderr: "", exitCode: 0 });
    const res = await describeGuestHandler(parse({ vmid: 101, sections: ["config"] }), t, makeConfig());
    expect(res.config).toBeDefined();
    expect(res.docker).toBeUndefined();
    expect(res.failedUnits).toBeUndefined();
  });

  it("a QEMU guest yields config but never docker/units (LXC-only)", async () => {
    const t = baseTransport();
    t.setExecResult("qm config 100", { stdout: "cores: 4\nmemory: 8192\nscsi0: local-lvm:vm-100-disk-0,size=32G", stderr: "", exitCode: 0 });
    const res = await describeGuestHandler(parse({ vmid: 100 }), t, makeConfig());
    expect(res.kind).toBe("qemu");
    expect(res.config?.cores).toBe("4");
    expect(res.docker).toBeUndefined();
    expect(res.failedUnits).toBeUndefined();
  });

  it("skips docker/units for a stopped LXC (pct exec needs a running guest)", async () => {
    const t = baseTransport();
    t.setExecResult("pct config 102", { stdout: "arch: amd64\nrootfs: local-lvm:subvol-102-disk-0,size=8G", stderr: "", exitCode: 0 });
    const res = await describeGuestHandler(parse({ vmid: 102 }), t, makeConfig());
    expect(res.status).toBe("stopped");
    expect(res.config).toBeDefined();
    expect(res.docker).toBeUndefined();
    expect(res.failedUnits).toBeUndefined();
  });

  it("throws for an unknown vmid", async () => {
    const t = baseTransport();
    await expect(describeGuestHandler(parse({ vmid: 777 }), t, makeConfig())).rejects.toThrow(/not found/i);
  });

  it("records a soft probe failure without aborting", async () => {
    const t = baseTransport();
    t.setExecResult("pct config 101", { stdout: "", stderr: "config boom", exitCode: 2 });
    t.setExecResult(
      buildPctExecCommand(
        101,
        'command -v docker >/dev/null 2>&1 && docker ps --format "{{.Names}}\\t{{.Image}}\\t{{.Status}}" || true'
      ),
      { stdout: "", stderr: "", exitCode: 0 }
    );
    t.setExecResult(buildPctExecCommand(101, "systemctl list-units --failed --no-legend --plain"), { stdout: "", stderr: "", exitCode: 0 });

    const res = await describeGuestHandler(parse({ vmid: 101 }), t, makeConfig());
    expect(res.config).toBeUndefined();
    expect(res.snapshotCapable).toBeUndefined();
    expect(res.errors.some((e) => e.probe === "pct config 101")).toBe(true);
  });
});
