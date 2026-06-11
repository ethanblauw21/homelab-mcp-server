import https from "https";
import tls from "tls";
import {
  sha256Fingerprint,
  decidePin,
  PinStore,
  type PinDecision,
  type PinLabels,
} from "./pinnedTrust.js";
import type { Config } from "../config.js";

/**
 * API TLS cert pinning (ADR-007 §3) — the second consumer of the shared
 * pinnedTrust core. PVE ships a self-signed cert on :8006, so the default CA
 * chain is useless; we replace it with an explicit fingerprint pin using the SAME
 * fail-closed pin/TOFU decision as the SSH host key. Never a blind
 * `rejectUnauthorized: false` left to flow — the handshake completes only so we
 * can read the peer cert, then we verify the fingerprint and destroy the socket
 * on mismatch.
 *
 * The pure pieces (certFingerprint, decideTlsPin) are unit-tested; the https.Agent
 * glue is validated against the live node at setup (the 403 negative test path).
 */

const TLS_LABELS: PinLabels = {
  pin: "the configured API TLS pin",
  tofu: "the API known_certs (TOFU) store",
};

/** SHA-256 fingerprint of an X.509 certificate in DER form: "SHA256:<base64>". */
export function certFingerprint(der: Buffer): string {
  return sha256Fingerprint(der);
}

export function decideTlsPin(args: {
  presented: string;
  pinned?: string;
  stored?: string;
  key: string;
}): PinDecision {
  return decidePin({ ...args, labels: TLS_LABELS });
}

/** Host:port key used to index the TOFU store for an API base URL. */
export function apiTrustKey(baseUrl: string | undefined): string {
  if (!baseUrl) return "pve-api";
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/**
 * https.Agent that pins the PVE API TLS cert fail-closed. The handshake runs with
 * rejectUnauthorized:false (the self-signed cert would otherwise be refused before
 * we can inspect it); on `secureConnect` we compute the cert fingerprint and, on a
 * pin/TOFU mismatch, destroy the socket with the decision's reason so the request
 * errors out instead of trusting an unverified peer.
 */
export function makePinnedHttpsAgent(api: Config["api"]): https.Agent {
  const store = new PinStore(api.knownCertsPath);
  const key = apiTrustKey(api.baseUrl);

  const createConnection = (
    options: tls.ConnectionOptions & { host?: string },
    callback?: (err: Error | null, socket?: tls.TLSSocket) => void
  ): tls.TLSSocket => {
    const socket = tls.connect(
      { ...options, rejectUnauthorized: false, servername: options.host },
      () => {
        const cert = socket.getPeerCertificate(false);
        const der = cert && cert.raw;
        if (!der || der.length === 0) {
          socket.destroy(new Error("API TLS: server presented no certificate (fail-closed)"));
          return;
        }
        const presented = certFingerprint(der);
        const decision = decideTlsPin({
          presented,
          pinned: api.tlsFingerprint,
          stored: store.get(key),
          key,
        });
        if (decision.accept) {
          if (decision.persist) {
            store.set(decision.persist.key, decision.persist.fingerprint);
            console.error(
              `[api] WARNING: ${key} TLS cert pinned on first use: ${presented}. Verify out of band.`
            );
          }
          return;
        }
        console.error(`[api] TLS cert verification FAILED for ${key}:\n${decision.reason}`);
        socket.destroy(new Error(decision.reason));
      }
    );
    // Defer to the base Agent's callback wiring without re-validating the chain.
    if (callback) socket.once("secureConnect", () => callback(null, socket));
    return socket;
  };

  const agent = new https.Agent({ keepAlive: false });
  // Override the connection factory so every socket is pin-verified. Assigned
  // rather than subclassed to avoid fighting the overloaded base signature.
  (agent as unknown as { createConnection: typeof createConnection }).createConnection = createConnection;
  return agent;
}
