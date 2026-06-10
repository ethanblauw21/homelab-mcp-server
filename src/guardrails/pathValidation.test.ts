import { describe, it, expect } from "vitest";
import { validatePath } from "./pathValidation.js";

describe("validatePath", () => {
  describe("absolute path requirement", () => {
    it("rejects relative paths", () => {
      expect(validatePath("etc/hosts").valid).toBe(false);
    });

    it("rejects empty string", () => {
      expect(validatePath("").valid).toBe(false);
    });

    it("accepts absolute paths", () => {
      expect(validatePath("/etc/hosts").valid).toBe(true);
    });
  });

  describe("traversal detection", () => {
    it("rejects paths with ..", () => {
      expect(validatePath("/etc/../etc/passwd").valid).toBe(false);
    });

    it("traversal reason mentions ..", () => {
      const result = validatePath("/etc/../etc/passwd");
      expect(result.reason).toContain("..");
    });

    it("rejects paths starting with ..", () => {
      expect(validatePath("/../etc/passwd").valid).toBe(false);
    });

    it("rejects sneaky encoded traversal using ..", () => {
      expect(validatePath("/var/log/../../etc/shadow").valid).toBe(false);
    });
  });

  describe("null byte injection", () => {
    it("rejects paths containing null bytes", () => {
      expect(validatePath("/etc/hosts\0.txt").valid).toBe(false);
    });

    it("null byte reason is non-empty", () => {
      const result = validatePath("/etc/\0/passwd");
      expect(result.reason).toBeTruthy();
      expect(typeof result.reason).toBe("string");
      expect((result.reason as string).length).toBeGreaterThan(0);
    });
  });

  describe("denylist", () => {
    const denylist = ["/proc", "/sys", "/dev"];

    it("rejects paths under /proc", () => {
      expect(validatePath("/proc/self/mem", { denylist }).valid).toBe(false);
    });

    it("rejects exact /dev", () => {
      expect(validatePath("/dev", { denylist }).valid).toBe(false);
    });

    it("rejects /sys/kernel", () => {
      expect(validatePath("/sys/kernel/config", { denylist }).valid).toBe(false);
    });

    it("allows /etc under default denylist", () => {
      expect(validatePath("/etc/nginx/nginx.conf", { denylist }).valid).toBe(true);
    });

    it("allows paths that share a denylist prefix but are not children", () => {
      // /procedures is NOT under /proc — the slash separator is required
      expect(validatePath("/procedures/config", { denylist: ["/proc"] }).valid).toBe(true);
      expect(validatePath("/develop/app", { denylist: ["/dev"] }).valid).toBe(true);
      expect(validatePath("/syslog", { denylist: ["/sys"] }).valid).toBe(true);
    });

    it("denylist reason includes the matched denied prefix", () => {
      const result = validatePath("/proc/net", { denylist: ["/proc"] });
      expect(result.reason).toContain("/proc");
    });
  });

  describe("allowlist", () => {
    const allowlist = ["/etc", "/var/lib/lxc"];

    it("allows /etc/hosts when under allowlist", () => {
      expect(validatePath("/etc/hosts", { allowlist }).valid).toBe(true);
    });

    it("allows /var/lib/lxc/100/config when under allowlist", () => {
      expect(validatePath("/var/lib/lxc/100/config", { allowlist }).valid).toBe(true);
    });

    it("allows exact match — path equals an allowlist entry exactly", () => {
      expect(validatePath("/etc", { allowlist: ["/etc"] }).valid).toBe(true);
    });

    it("rejects path that shares allowlist prefix but is not a child or exact match", () => {
      // /etcfoo is NOT under /etc — the slash separator is required
      expect(validatePath("/etcfoo", { allowlist: ["/etc"] }).valid).toBe(false);
    });

    it("rejects /tmp when not in allowlist", () => {
      expect(validatePath("/tmp/foo", { allowlist }).valid).toBe(false);
    });

    it("rejects /root when not in allowlist", () => {
      expect(validatePath("/root/.ssh/authorized_keys", { allowlist }).valid).toBe(false);
    });

    it("allows everything when allowlist is empty", () => {
      expect(validatePath("/anything/goes", { allowlist: [] }).valid).toBe(true);
    });

    it("allowlist reject reason mentions allowed prefix", () => {
      const result = validatePath("/tmp/foo", { allowlist: ["/etc"] });
      expect(result.reason).toContain("allowed prefix");
    });
  });

  describe("combined allowlist + denylist", () => {
    it("denylist wins even if path would be in allowlist", () => {
      expect(
        validatePath("/proc/net/tcp", { allowlist: ["/proc"], denylist: ["/proc"] }).valid
      ).toBe(false);
    });
  });

  describe("error messages", () => {
    it("includes a reason when invalid", () => {
      const result = validatePath("relative/path");
      expect(result.valid).toBe(false);
      expect(result.reason).toBeTruthy();
    });
  });
});
