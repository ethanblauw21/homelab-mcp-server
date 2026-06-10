import { describe, it, expect } from "vitest";
import { redactSecrets } from "./redact.js";
import { buildAuditRecord } from "./record.js";

describe("redactSecrets", () => {
  describe("env-var assignments", () => {
    it("redacts PASSWORD=value", () => {
      const out = redactSecrets("export PASSWORD=hunter2");
      expect(out).toContain("PASSWORD=[REDACTED]");
      expect(out).not.toContain("hunter2");
    });

    it("redacts --password=value (MySQL-style flag)", () => {
      const out = redactSecrets("mysql -u root --password=s3cr3t");
      expect(out).not.toContain("s3cr3t");
    });

    it("redacts SECRET=value", () => {
      const out = redactSecrets("SECRET=mysecretvalue ./run.sh");
      expect(out).toContain("SECRET=[REDACTED]");
      expect(out).not.toContain("mysecretvalue");
    });

    it("redacts TOKEN=value", () => {
      const out = redactSecrets("TOKEN=ghp_abc123xyz ./deploy.sh");
      expect(out).not.toContain("ghp_abc123xyz");
    });

    it("redacts API_KEY=value", () => {
      const out = redactSecrets("curl -d API_KEY=abc123 https://api.example.com");
      expect(out).not.toContain("abc123");
      expect(out).toContain("API_KEY=[REDACTED]");
    });

    it("redacts API_SECRET=value", () => {
      const out = redactSecrets("API_SECRET=topsecret123 npm run deploy");
      expect(out).not.toContain("topsecret123");
    });

    it("redacts ACCESS_KEY=value", () => {
      const out = redactSecrets("ACCESS_KEY=ABCDEF1234567890 aws s3 ls");
      expect(out).not.toContain("ABCDEF1234567890");
    });

    it("redacts AUTH_TOKEN=value", () => {
      const out = redactSecrets("AUTH_TOKEN=tok_live_abc123 ./call.sh");
      expect(out).not.toContain("tok_live_abc123");
    });

    it("redacts CLIENT_SECRET=value", () => {
      const out = redactSecrets("CLIENT_SECRET=xyzzy123 oauth-flow.sh");
      expect(out).not.toContain("xyzzy123");
    });

    it("redacts AWS_SECRET_ACCESS_KEY=value", () => {
      const out = redactSecrets("AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCY curl ...");
      expect(out).not.toContain("wJalrXUtnFEMI");
      expect(out).toContain("[REDACTED]");
    });

    it("redacts DB_PASSWORD=value", () => {
      const out = redactSecrets("DB_PASSWORD=dbpass123 pg_dump mydb");
      expect(out).not.toContain("dbpass123");
    });

    it("is case-insensitive for the key name", () => {
      expect(redactSecrets("password=abc")).toContain("[REDACTED]");
      expect(redactSecrets("PASSWORD=abc")).toContain("[REDACTED]");
      expect(redactSecrets("Password=abc")).toContain("[REDACTED]");
    });

    it("redacts multiple secrets in one string", () => {
      const out = redactSecrets("TOKEN=tok1 PASSWORD=pass1 ./run");
      expect(out).not.toContain("tok1");
      expect(out).not.toContain("pass1");
    });
  });

  describe("HTTP headers", () => {
    it("redacts Authorization: Bearer token", () => {
      const out = redactSecrets("curl -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9'");
      expect(out).not.toContain("eyJhbGciOiJIUzI1NiJ9");
      expect(out).toContain("Authorization: [REDACTED]");
    });

    it("redacts Authorization: Token value (full multi-word value)", () => {
      const out = redactSecrets("curl -H 'Authorization: Token abc123xyz'");
      expect(out).not.toContain("abc123xyz");
    });

    it("redacts x-api-key header value", () => {
      const out = redactSecrets("curl -H 'x-api-key: sk-abc123'");
      expect(out).not.toContain("sk-abc123");
      expect(out).toContain("[REDACTED]");
    });

    it("redacts x-auth-token header value", () => {
      const out = redactSecrets("x-auth-token: mytoken456");
      expect(out).not.toContain("mytoken456");
    });
  });

  describe("AWS access key IDs", () => {
    it("redacts AKIA-format AWS access key", () => {
      const out = redactSecrets("aws configure set aws_access_key_id AKIAIOSFODNN7EXAMPLE");
      expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
      expect(out).toContain("[REDACTED]");
    });

    it("does not redact strings that only start with AKIA but are not 20 chars", () => {
      const out = redactSecrets("AKIASHORT");
      expect(out).toBe("AKIASHORT");
    });
  });

  describe("PEM key / certificate blocks", () => {
    it("redacts RSA private key block", () => {
      const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234\n-----END RSA PRIVATE KEY-----";
      const out = redactSecrets(key);
      expect(out).toBe("[REDACTED]");
    });

    it("redacts EC PRIVATE KEY block", () => {
      const key = "-----BEGIN EC PRIVATE KEY-----\nMHQCAQEEIK\n-----END EC PRIVATE KEY-----";
      const out = redactSecrets(key);
      expect(out).toBe("[REDACTED]");
    });

    it("redacts CERTIFICATE block", () => {
      const cert = "-----BEGIN CERTIFICATE-----\nMIICpDCC\n-----END CERTIFICATE-----";
      expect(redactSecrets(cert)).toBe("[REDACTED]");
    });

    it("redacts key block embedded in a longer string", () => {
      const s = "cat key.pem && -----BEGIN RSA PRIVATE KEY-----\ndata\n-----END RSA PRIVATE KEY-----";
      expect(redactSecrets(s)).not.toContain("data");
    });
  });

  describe("safe commands pass through unchanged", () => {
    it("does not touch ls", () => {
      expect(redactSecrets("ls /etc/hosts")).toBe("ls /etc/hosts");
    });

    it("does not touch systemctl", () => {
      expect(redactSecrets("systemctl restart nginx")).toBe("systemctl restart nginx");
    });

    it("does not touch grep with ordinary args", () => {
      expect(redactSecrets("grep -r 'error' /var/log")).toBe("grep -r 'error' /var/log");
    });

    it("does not redact TIMESTAMP= or VERSION=", () => {
      expect(redactSecrets("TIMESTAMP=2024-01-01 run.sh")).toBe("TIMESTAMP=2024-01-01 run.sh");
      expect(redactSecrets("VERSION=1.2.3 build.sh")).toBe("VERSION=1.2.3 build.sh");
    });

    it("does not redact pct list output", () => {
      expect(redactSecrets("pct list")).toBe("pct list");
    });
  });
});

describe("buildAuditRecord secret redaction", () => {
  it("redacts secrets in the cmd field", () => {
    const r = buildAuditRecord({ tool: "execute", cmd: "export API_KEY=supersecret123" });
    expect(r.cmd).toContain("[REDACTED]");
    expect(r.cmd).not.toContain("supersecret123");
  });

  it("redacts secrets in the note field", () => {
    const r = buildAuditRecord({ tool: "write_file", note: "TOKEN=tok_abc123 used for auth" });
    expect(r.note).not.toContain("tok_abc123");
  });

  it("leaves safe cmd values unchanged", () => {
    const r = buildAuditRecord({ tool: "execute", cmd: "ls /etc" });
    expect(r.cmd).toBe("ls /etc");
  });

  it("leaves cmd undefined when not provided", () => {
    const r = buildAuditRecord({ tool: "read_file", path: "/etc/hosts" });
    expect(r.cmd).toBeUndefined();
  });

  it("leaves note undefined when not provided", () => {
    const r = buildAuditRecord({ tool: "execute", cmd: "ls /" });
    expect(r.note).toBeUndefined();
  });
});
