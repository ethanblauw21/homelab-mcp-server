/// <reference path="./setup-types.d.ts" />
import { execSync, spawnSync } from "child_process";
import type { GlobalSetupContext } from "vitest/node";
import fs from "fs";
import path from "path";
import os from "os";
import net from "net";

const KEY_PATH = path.join(os.tmpdir(), "test-mcp-ssh-key");
const KEY_PUB_PATH = KEY_PATH + ".pub";
const COMPOSE_FILE = path.resolve("docker/docker-compose.test.yml");
const DOCKER_SSH_HOST = "localhost";
const DOCKER_SSH_PORT = 2222;

// Real SSH mode: set SSH_INT_HOST (and optionally SSH_INT_KEY_PATH, SSH_INT_PORT)
// to run integration tests against a live SSH target instead of a Docker container.
const REAL_SSH_HOST = process.env["SSH_INT_HOST"] ?? "";
const REAL_SSH_KEY_PATH = process.env["SSH_INT_KEY_PATH"] ?? "";
const REAL_SSH_PORT = parseInt(process.env["SSH_INT_PORT"] ?? "22", 10);

function isDockerAvailable(): boolean {
  try {
    const result = spawnSync("docker", ["info"], { stdio: "pipe" });
    return result.status === 0;
  } catch {
    return false;
  }
}

function generateKeyPair(): string {
  for (const p of [KEY_PATH, KEY_PUB_PATH]) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  execSync(`ssh-keygen -t ed25519 -f "${KEY_PATH}" -N ""`, { stdio: "pipe" });
  return fs.readFileSync(KEY_PUB_PATH, "utf8").trim();
}

function dockerComposeDown(): void {
  spawnSync("docker", ["compose", "-f", COMPOSE_FILE, "down", "--volumes", "--remove-orphans"], {
    stdio: "inherit",
    env: { ...process.env },
  });
}

function dockerComposeUp(publicKey: string): void {
  const result = spawnSync(
    "docker",
    ["compose", "-f", COMPOSE_FILE, "up", "--build", "-d"],
    {
      stdio: "inherit",
      env: { ...process.env, SSH_TEST_PUBLIC_KEY: publicKey },
    }
  );
  if (result.status !== 0) {
    throw new Error("docker compose up failed");
  }
}

async function waitForSsh(host: string, port: number, maxWaitMs = 30_000): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const ready = await new Promise<boolean>((resolve) => {
      const sock = net.createConnection({ host, port });
      sock.setTimeout(1000);
      sock.on("connect", () => { sock.destroy(); resolve(true); });
      sock.on("error", () => resolve(false));
      sock.on("timeout", () => { sock.destroy(); resolve(false); });
    });
    if (ready) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`SSH at ${host}:${port} not ready within ${maxWaitMs}ms`);
}

export async function setup({ provide }: GlobalSetupContext): Promise<void> {
  const p = provide as (key: string, value: unknown) => void;

  // Real SSH mode: skip Docker, connect to a live host directly.
  if (REAL_SSH_HOST) {
    if (!REAL_SSH_KEY_PATH || !fs.existsSync(REAL_SSH_KEY_PATH)) {
      throw new Error(
        `SSH_INT_KEY_PATH not set or file not found: '${REAL_SSH_KEY_PATH}'\n` +
        "Set SSH_INT_KEY_PATH to the path of the private key for SSH_INT_HOST."
      );
    }
    console.log(`\n[integration setup] Real SSH mode — target: ${REAL_SSH_HOST}:${REAL_SSH_PORT}`);
    console.log("[integration setup] Verifying SSH connectivity...");
    await waitForSsh(REAL_SSH_HOST, REAL_SSH_PORT);
    console.log("[integration setup] SSH target reachable.");

    console.log("[integration setup] Building project for MCP protocol tests...");
    execSync("npm run build", { stdio: "inherit" });

    p("dockerAvailable", true); // re-uses the existing inject key so tests run
    p("sshKeyPath", REAL_SSH_KEY_PATH);
    p("sshHost", REAL_SSH_HOST);
    p("sshPort", REAL_SSH_PORT);
    return;
  }

  if (!isDockerAvailable()) {
    console.warn(
      "\n[integration setup] Docker not available — integration tests will be skipped.\n" +
      "  To run with Docker:   npm run test:int\n" +
      "  To run against a real SSH host:\n" +
      "    SSH_INT_HOST=<ip> SSH_INT_KEY_PATH=<path> npm run test:int\n"
    );
    p("dockerAvailable", false);
    p("sshKeyPath", "");
    p("sshHost", "");
    p("sshPort", 0);
    return;
  }

  console.log("\n[integration setup] Generating SSH test key pair...");
  const publicKey = generateKeyPair();

  console.log("[integration setup] Starting Docker SSH test container...");
  dockerComposeDown();
  dockerComposeUp(publicKey);

  console.log(`[integration setup] Waiting for SSH on ${DOCKER_SSH_HOST}:${DOCKER_SSH_PORT}...`);
  await waitForSsh(DOCKER_SSH_HOST, DOCKER_SSH_PORT);
  console.log("[integration setup] SSH container ready.");

  console.log("[integration setup] Building project for MCP protocol tests...");
  execSync("npm run build", { stdio: "inherit" });

  p("dockerAvailable", true);
  p("sshKeyPath", KEY_PATH);
  p("sshHost", DOCKER_SSH_HOST);
  p("sshPort", DOCKER_SSH_PORT);
}

export async function teardown(): Promise<void> {
  // In real SSH mode there's nothing to tear down (no container started).
  if (REAL_SSH_HOST) return;

  if (!isDockerAvailable()) return;
  console.log("\n[integration teardown] Stopping Docker SSH test container...");
  dockerComposeDown();
  for (const f of [KEY_PATH, KEY_PUB_PATH]) {
    try { fs.unlinkSync(f); } catch { /* already gone */ }
  }
}
