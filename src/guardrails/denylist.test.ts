import { describe, it, expect } from "vitest";
import { checkCommand, splitSegments } from "./denylist.js";

describe("splitSegments (quote-aware, A4.2)", () => {
  it("splits on ; && || | & and newline", () => {
    expect(splitSegments("a; b && c || d | e & f\ng")).toEqual([
      "a", "b", "c", "d", "e", "f", "g",
    ]);
  });

  it("does NOT split on separators inside single quotes", () => {
    expect(splitSegments("echo 'a; b && c'")).toEqual(["echo 'a; b && c'"]);
  });

  it("does NOT split on separators inside double quotes", () => {
    expect(splitSegments('echo "a | b"')).toEqual(['echo "a | b"']);
  });

  it("splits at command substitution $( and )", () => {
    expect(splitSegments("echo $(reboot)")).toEqual(["echo", "reboot"]);
  });

  it("splits at backtick command substitution", () => {
    expect(splitSegments("echo `id`")).toEqual(["echo", "id"]);
  });
});

describe("checkCommand — DENY tier (unconditional)", () => {
  const denied = (cmd: string) => checkCommand(cmd).tier === "deny";

  it("blocks rm -rf /", () => expect(denied("rm -rf /")).toBe(true));
  it("blocks rm -rf / with extra whitespace", () => expect(denied("rm  -rf   /")).toBe(true));
  it("blocks rm -rf /*", () => expect(denied("rm -rf /*")).toBe(true));
  it("allows rm -rf on a specific path", () => expect(denied("rm -rf ./build")).toBe(false));
  it("allows rm -rf /tmp/mydir", () => expect(denied("rm -rf /tmp/mydir")).toBe(false));
  it("blocks mkfs commands", () => expect(denied("mkfs.ext4 /dev/sda1")).toBe(true));
  it("blocks dd if=/dev/zero", () => expect(denied("dd if=/dev/zero of=/dev/sda")).toBe(true));
  it("blocks dd if=/dev/random", () => expect(denied("dd if=/dev/random of=/dev/sda")).toBe(true));
  it("blocks dd if=/dev/zero without of= clause", () =>
    expect(denied("dd if=/dev/zero count=1024")).toBe(true));
  it("blocks dd of=/dev/sda", () => expect(denied("dd bs=4M if=image.img of=/dev/sda")).toBe(true));
  it("blocks dd of=/dev/nvme0", () => expect(denied("dd if=image.img of=/dev/nvme0")).toBe(true));
  it("blocks fork bomb", () => expect(denied(":(){ :|:& };:")).toBe(true));
  it("blocks chmod -R 777 /", () => expect(denied("chmod -R 777 /")).toBe(true));

  describe("redirect to block device", () => {
    it("blocks redirect to sda with a space", () => expect(denied("echo data > /dev/sda")).toBe(true));
    it("blocks redirect to sda with no space", () => expect(denied("command>/dev/sda")).toBe(true));
    it("blocks redirect to nvme device", () => expect(denied("cat file > /dev/nvme0")).toBe(true));
  });

  it("includes a reason when denied", () => {
    const r = checkCommand("rm -rf /");
    expect(r.tier).toBe("deny");
    expect(r.reason).toBeTruthy();
  });
});

describe("checkCommand — CONFIRM tier (command position only)", () => {
  const tierOf = (cmd: string) => checkCommand(cmd).tier;

  it("flags shutdown for confirm", () => expect(tierOf("shutdown -h now")).toBe("confirm"));
  it("flags reboot for confirm", () => expect(tierOf("reboot")).toBe("confirm"));
  it("flags halt for confirm", () => expect(tierOf("halt")).toBe("confirm"));
  it("flags poweroff for confirm", () => expect(tierOf("poweroff")).toBe("confirm"));
  it("flags init 0 for confirm", () => expect(tierOf("init 0")).toBe("confirm"));
  it("flags init 6 for confirm", () => expect(tierOf("init 6")).toBe("confirm"));
  it("flags systemctl reboot for confirm", () => expect(tierOf("systemctl reboot")).toBe("confirm"));
  it("flags systemctl poweroff for confirm", () =>
    expect(tierOf("systemctl poweroff")).toBe("confirm"));
  it("flags /sbin/reboot (basename-stripped) for confirm", () =>
    expect(tierOf("/sbin/reboot")).toBe("confirm"));
  it("flags reboot hidden in command substitution", () =>
    expect(tierOf("echo $(reboot)")).toBe("confirm"));

  it("includes a confirm reason", () => {
    const r = checkCommand("reboot");
    expect(r.reason).toMatch(/confirm:true/);
  });
});

describe("checkCommand — false-positive regression (ADR-004 §5)", () => {
  const allowed = (cmd: string) => checkCommand(cmd).tier === "allow";

  it("allows grep reboot in a log file", () =>
    expect(allowed("grep reboot /var/log/syslog")).toBe(true));
  it("allows systemctl status reboot.target", () =>
    expect(allowed("systemctl status reboot.target")).toBe(true));
  it('allows echo "reboot"', () => expect(allowed('echo "reboot"')).toBe(true));
  it("allows echo 'do not reboot'", () => expect(allowed("echo 'do not reboot'")).toBe(true));
  it("allows recursive chown (chown -R no longer denied)", () =>
    expect(allowed("chown -R www-data:www-data /var/www")).toBe(true));
  it("allows journalctl -u reboot.target", () =>
    expect(allowed("journalctl -u reboot.target")).toBe(true));
});

describe("checkCommand — safe commands", () => {
  const allowed = (cmd: string) => checkCommand(cmd).tier === "allow";
  it("allows ls", () => expect(allowed("ls /etc")).toBe(true));
  it("allows cat", () => expect(allowed("cat /etc/hosts")).toBe(true));
  it("allows systemctl status nginx", () => expect(allowed("systemctl status nginx")).toBe(true));
  it("allows pct list", () => expect(allowed("pct list")).toBe(true));
  it("allows pct exec", () => expect(allowed("pct exec 100 -- sh -c 'echo hi'")).toBe(true));
});

describe("checkCommand — configured denylist (segment-prefix + tier annotation)", () => {
  it("default empty list does not block unusual strings", () => {
    expect(checkCommand("stryker was here").tier).toBe("allow");
  });

  it("blocks a custom DENY entry by segment prefix", () => {
    expect(checkCommand("drop-database --all", ["drop-database"]).tier).toBe("deny");
  });

  it("does NOT match a configured entry mid-segment (prefix-anchored)", () => {
    // "database" is not at the start of any segment, so a "drop-database" entry won't fire
    expect(checkCommand("echo my-drop-database-backup", ["drop-database"]).tier).toBe("allow");
  });

  it("matches a configured entry regardless of case", () => {
    expect(checkCommand("DROP-DATABASE now", ["drop-database"]).tier).toBe("deny");
  });

  it("honors a confirm: tier annotation on a configured entry", () => {
    expect(checkCommand("apt full-upgrade", ["confirm:apt full-upgrade"]).tier).toBe("confirm");
  });

  it("does not block an unrelated command", () => {
    expect(checkCommand("ls -la /etc", ["drop-database"]).tier).toBe("allow");
  });

  it("custom denylist reason includes the matched entry", () => {
    expect(checkCommand("drop-database", ["drop-database"]).reason).toContain("drop-database");
  });

  it("DENY built-in beats a configured confirm entry", () => {
    expect(checkCommand("rm -rf /", ["confirm:rm"]).tier).toBe("deny");
  });
});

describe("checkCommand — protected set (ADR-007 §4)", () => {
  it("DENIES destructive ops against /etc/pve", () => {
    expect(checkCommand("rm -rf /etc/pve/qemu-server/100.conf").tier).toBe("deny");
    expect(checkCommand("rm /etc/pve").tier).toBe("deny");
    expect(checkCommand("mv /etc/pve/foo /tmp/bar").tier).toBe("deny");
    expect(checkCommand("truncate -s0 /etc/pve/storage.cfg").tier).toBe("deny");
    expect(checkCommand("echo x > /etc/pve/corosync.conf").tier).toBe("deny");
  });

  it("DENIES cluster-membership mutation via pvecm", () => {
    expect(checkCommand("pvecm delnode pve2").tier).toBe("deny");
    expect(checkCommand("pvecm add 10.0.0.20").tier).toBe("deny");
    expect(checkCommand("pvecm addnode pve3").tier).toBe("deny");
  });

  it("the protected-set DENY cannot be confirm-bypassed (still deny tier)", () => {
    // deny tier is unconditional — confirm:true never downgrades it.
    expect(checkCommand("rm -rf /etc/pve").tier).toBe("deny");
    expect(checkCommand("rm -rf /etc/pve").reason).toMatch(/protected set/i);
  });

  it("does NOT block reading /etc/pve or unrelated pvecm verbs", () => {
    expect(checkCommand("cat /etc/pve/storage.cfg").tier).toBe("allow");
    expect(checkCommand("grep -r onboot /etc/pve").tier).toBe("allow");
    expect(checkCommand("pvecm status").tier).toBe("allow");
    expect(checkCommand("pvecm nodes").tier).toBe("allow");
  });

  it("does not false-positive on a similarly named path", () => {
    expect(checkCommand("rm -rf /etc/pveproxy-cache").tier).toBe("allow");
  });
});

describe("checkCommand — heavy patterns are never gated (ADR-008 §4 regression)", () => {
  // The CONFIRM gate is reserved for availability-class commands and DENY for
  // destruction. Heavy patterns (curl/wget/tar/rsync/…) are an audit annotation
  // only and MUST resolve to `allow` — gating them was implementation drift.
  const tierOf = (cmd: string) => checkCommand(cmd).tier;

  it("allows curl (the dogfooding health-check case)", () =>
    expect(tierOf("curl http://localhost:3000/health")).toBe("allow"));
  it("allows wget", () => expect(tierOf("wget https://example.com/file.iso")).toBe("allow"));
  it("allows tar", () => expect(tierOf("tar -czf backup.tar.gz /var")).toBe("allow"));
  it("allows rsync", () => expect(tierOf("rsync -av /src /dst")).toBe("allow"));
  it("allows scp", () => expect(tierOf("scp root@host:/etc/cfg /tmp/")).toBe("allow"));

  it("the gate is unchanged for the classes it does cover", () => {
    expect(tierOf("reboot")).toBe("confirm");
    expect(tierOf("rm -rf /")).toBe("deny");
  });
});

describe("checkCommand — obfuscation resistance", () => {
  it("normalizes multiple spaces in rm -rf /", () =>
    expect(checkCommand("rm   -rf    /").tier).toBe("deny"));
  it("normalizes tabs around mkfs", () => expect(checkCommand("mkfs.ext4\t/dev/sdb").tier).toBe("deny"));
});
