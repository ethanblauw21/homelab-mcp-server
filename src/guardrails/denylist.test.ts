import { describe, it, expect } from "vitest";
import { checkDenylist } from "./denylist.js";

describe("checkDenylist", () => {
  describe("built-in dangerous patterns", () => {
    it("blocks rm -rf /", () => {
      expect(checkDenylist("rm -rf /").denied).toBe(true);
    });

    it("blocks rm -rf / with extra whitespace", () => {
      expect(checkDenylist("rm  -rf   /").denied).toBe(true);
    });

    it("blocks rm -rf /*", () => {
      expect(checkDenylist("rm -rf /*").denied).toBe(true);
    });

    it("allows rm -rf on a specific path", () => {
      expect(checkDenylist("rm -rf ./build").denied).toBe(false);
    });

    it("allows rm -rf /tmp/mydir", () => {
      expect(checkDenylist("rm -rf /tmp/mydir").denied).toBe(false);
    });

    it("blocks mkfs commands", () => {
      expect(checkDenylist("mkfs.ext4 /dev/sda1").denied).toBe(true);
    });

    it("blocks dd if=/dev/zero", () => {
      expect(checkDenylist("dd if=/dev/zero of=/dev/sda").denied).toBe(true);
    });

    it("blocks dd if=/dev/random", () => {
      expect(checkDenylist("dd if=/dev/random of=/dev/sda").denied).toBe(true);
    });

    it("blocks dd if=/dev/zero without of= clause (catches \\bdd\\S+if= mutation)", () => {
      // No of=/dev/sd* fallback — only caught by the if=/dev/zero pattern
      expect(checkDenylist("dd if=/dev/zero count=1024").denied).toBe(true);
    });

    it("blocks dd of=/dev/sda", () => {
      expect(checkDenylist("dd bs=4M if=image.img of=/dev/sda").denied).toBe(true);
    });

    it("blocks dd of=/dev/nvme0", () => {
      expect(checkDenylist("dd if=image.img of=/dev/nvme0").denied).toBe(true);
    });

    it("blocks fork bomb", () => {
      expect(checkDenylist(":(){ :|:& };:").denied).toBe(true);
    });

    it("blocks fork bomb with two chars between | and & (kills .*|.& mutation)", () => {
      // .*\|.& requires exactly 1 char between | and &; "::" is 2 chars → must use .*\|.*&
      expect(checkDenylist(":(){ :|::& };:").denied).toBe(true);
    });

    it("blocks fork bomb with no space between & and } (kills .*&.} mutation)", () => {
      // .*&.\} requires 1 char before }; no chars here → must use .*&.*\}
      expect(checkDenylist(":(){ :|:&};:").denied).toBe(true);
    });

    it("blocks chmod -R 777 /", () => {
      expect(checkDenylist("chmod -R 777 /").denied).toBe(true);
    });

    it("blocks shutdown", () => {
      expect(checkDenylist("shutdown -h now").denied).toBe(true);
    });

    it("blocks reboot", () => {
      expect(checkDenylist("reboot").denied).toBe(true);
    });

    it("blocks halt", () => {
      expect(checkDenylist("halt").denied).toBe(true);
    });

    it("blocks poweroff", () => {
      expect(checkDenylist("poweroff").denied).toBe(true);
    });

    it("blocks init 0", () => {
      expect(checkDenylist("init 0").denied).toBe(true);
    });

    it("blocks init 6", () => {
      expect(checkDenylist("init 6").denied).toBe(true);
    });
  });

  describe("redirect to block device", () => {
    it("blocks redirect to sda with a space before /dev", () => {
      expect(checkDenylist("echo data > /dev/sda").denied).toBe(true);
    });

    it("blocks redirect to sda with no space before /dev", () => {
      expect(checkDenylist("command>/dev/sda").denied).toBe(true);
    });

    it("blocks redirect to nvme device", () => {
      expect(checkDenylist("cat file > /dev/nvme0").denied).toBe(true);
    });
  });

  describe("extra denylist entries", () => {
    it("default extra denylist is empty: unusual strings are not blocked without explicit list", () => {
      // Kills the mutation that sets the default to ["Stryker was here"]
      expect(checkDenylist("stryker was here").denied).toBe(false);
      expect(checkDenylist("stryker was here", ["stryker was here"]).denied).toBe(true);
    });

    it("blocks a custom denylist entry", () => {
      expect(checkDenylist("drop-database", ["drop-database"]).denied).toBe(true);
    });

    it("blocks a custom entry regardless of case", () => {
      expect(checkDenylist("DROP-DATABASE", ["drop-database"]).denied).toBe(true);
    });

    it("does not block an unrelated command", () => {
      expect(checkDenylist("ls -la /etc", ["drop-database"]).denied).toBe(false);
    });

    it("custom denylist reason includes the matched entry", () => {
      const result = checkDenylist("drop-database", ["drop-database"]);
      expect(result.reason).toContain("drop-database");
    });
  });

  describe("safe commands", () => {
    it("allows ls", () => expect(checkDenylist("ls /etc").denied).toBe(false));
    it("allows cat", () => expect(checkDenylist("cat /etc/hosts").denied).toBe(false));
    it("allows systemctl status", () => expect(checkDenylist("systemctl status nginx").denied).toBe(false));
    it("allows pct list", () => expect(checkDenylist("pct list").denied).toBe(false));
    it("allows pct exec", () => expect(checkDenylist("pct exec 100 -- sh -c 'echo hi'").denied).toBe(false));
  });

  describe("obfuscation resistance", () => {
    it("normalizes multiple spaces in rm -rf /", () => {
      expect(checkDenylist("rm   -rf    /").denied).toBe(true);
    });

    it("normalizes tabs around mkfs", () => {
      expect(checkDenylist("mkfs.ext4\t/dev/sdb").denied).toBe(true);
    });
  });

  describe("return value", () => {
    it("includes a reason when denied", () => {
      const result = checkDenylist("rm -rf /");
      expect(result.denied).toBe(true);
      expect(result.reason).toBeTruthy();
    });

    it("has no reason when allowed", () => {
      const result = checkDenylist("ls /");
      expect(result.denied).toBe(false);
      expect(result.reason).toBeUndefined();
    });
  });
});
