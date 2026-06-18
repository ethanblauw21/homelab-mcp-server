import { describe, it, expect } from "vitest";
import {
  parseCompose,
  ComposeParseError,
  groupByNetns,
  netnsOwner,
  containerPortOf,
  extractPortClaims,
  detectPortCollisions,
  detectNetnsRecreate,
  crossCheckBoundPorts,
  analyzeCompose,
  parseProcNetTcpPorts,
  parseSsListeners,
  PORT_ENV_HINTS,
  type ComposeModel,
} from "./composePreflight.js";

// ---------------------------------------------------------------------------
// parseCompose
// ---------------------------------------------------------------------------
describe("parseCompose", () => {
  it("parses services with network_mode, ports, expose, environment (array + map)", () => {
    const text = `
services:
  tailscale:
    image: tailscale/tailscale:latest
    ports:
      - "8080:8080"
      - "9090:9090/tcp"
  dozzle:
    image: amir20/dozzle
    network_mode: service:tailscale
    environment:
      - DOZZLE_LEVEL=info
      - PORT=9090
  qbittorrent:
    network_mode: "service:tailscale"
    environment:
      WEBUI_PORT: 8080
`;
    const m = parseCompose(text);
    expect(m.services.map((s) => s.name).sort()).toEqual(["dozzle", "qbittorrent", "tailscale"]);
    const ts = m.services.find((s) => s.name === "tailscale")!;
    expect(ts.ports).toEqual(["8080:8080", "9090:9090/tcp"]);
    const dz = m.services.find((s) => s.name === "dozzle")!;
    expect(dz.networkMode).toBe("service:tailscale");
    expect(dz.environment.PORT).toBe("9090");
    const qb = m.services.find((s) => s.name === "qbittorrent")!;
    expect(qb.environment.WEBUI_PORT).toBe("8080");
  });

  it("folds long-form ports to canonical strings", () => {
    const text = `
services:
  app:
    ports:
      - target: 80
        published: 8080
        protocol: tcp
      - target: 443
`;
    const app = parseCompose(text).services[0]!;
    expect(app.ports).toEqual(["8080:80/tcp", "443"]);
  });

  it("throws a structured ComposeParseError on malformed YAML", () => {
    expect(() => parseCompose("services:\n  a:\n  - bad: : :")).toThrow(ComposeParseError);
  });

  it("rejects a non-mapping services key", () => {
    expect(() => parseCompose("services:\n  - a\n  - b")).toThrow(ComposeParseError);
  });

  it("treats an empty / serviceless compose as zero services (not an error)", () => {
    expect(parseCompose("version: '3'").services).toEqual([]);
    expect(parseCompose("{}").services).toEqual([]);
  });

  it("rejects empty / scalar documents", () => {
    expect(() => parseCompose("")).toThrow(ComposeParseError);
    expect(() => parseCompose("just a string")).toThrow(ComposeParseError);
  });

  it("parses YAML anchors/aliases correctly", () => {
    const text = `
x-common: &common
  image: base:latest
services:
  a:
    <<: *common
    network_mode: service:gw
  gw:
    image: gw:latest
`;
    const m = parseCompose(text);
    expect(m.services.find((s) => s.name === "a")!.image).toBe("base:latest");
  });
});

// ---------------------------------------------------------------------------
// containerPortOf
// ---------------------------------------------------------------------------
describe("containerPortOf", () => {
  it("takes the container/internal side", () => {
    expect(containerPortOf("8080:80")).toBe(80);
    expect(containerPortOf("127.0.0.1:8080:80/tcp")).toBe(80);
    expect(containerPortOf("80")).toBe(80);
    expect(containerPortOf("80/tcp")).toBe(80);
  });
  it("returns null for ranges and junk", () => {
    expect(containerPortOf("8000-8010:8000-8010")).toBeNull();
    expect(containerPortOf("nope")).toBeNull();
    expect(containerPortOf("70000")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// netnsOwner / groupByNetns
// ---------------------------------------------------------------------------
describe("groupByNetns", () => {
  it("parses service:/container: owners", () => {
    expect(netnsOwner("service:tailscale")).toBe("tailscale");
    expect(netnsOwner("container:abc")).toBe("abc");
    expect(netnsOwner("host")).toBeNull();
    expect(netnsOwner(undefined)).toBeNull();
  });

  it("groups a provider with its dependents and marks dependents", () => {
    const m = parseCompose(`
services:
  tailscale:
    image: ts
    ports: ["8080:8080"]
  dozzle:
    network_mode: service:tailscale
  qbit:
    network_mode: service:tailscale
`);
    const groups = groupByNetns(m);
    const g = groups.find((x) => x.key === "tailscale")!;
    expect(g.provider).toBe("tailscale");
    expect(g.external).toBe(false);
    expect(g.members.sort()).toEqual(["dozzle", "qbit", "tailscale"]);
    expect(g.dependents.sort()).toEqual(["dozzle", "qbit"]);
  });

  it("a service with its own bridge is its own single-member group (no shared netns)", () => {
    const m = parseCompose(`
services:
  standalone:
    image: x
    ports: ["80:80"]
`);
    const groups = groupByNetns(m);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.members).toEqual(["standalone"]);
    expect(groups[0]!.dependents).toEqual([]);
  });

  it("marks an external container: owner not defined in the file", () => {
    const m = parseCompose(`
services:
  app:
    network_mode: container:some-external
`);
    const g = groupByNetns(m).find((x) => x.key === "some-external")!;
    expect(g.external).toBe(true);
    expect(g.provider).toBeNull();
    expect(g.dependents).toEqual(["app"]);
  });
});

// ---------------------------------------------------------------------------
// extractPortClaims
// ---------------------------------------------------------------------------
describe("extractPortClaims", () => {
  it("collects ports, expose, and env hints with provenance", () => {
    const svc = parseCompose(`
services:
  s:
    ports: ["8080:80"]
    expose: ["9000"]
    environment:
      WEBUI_PORT: "7000"
      UNRELATED: hello
`).services[0]!;
    const claims = extractPortClaims(svc);
    expect(claims).toEqual([
      { service: "s", port: 80, source: "ports", raw: "8080:80" },
      { service: "s", port: 9000, source: "expose", raw: "9000" },
      { service: "s", port: 7000, source: "env-hint", raw: "WEBUI_PORT=7000" },
    ]);
  });

  it("only honors known env hints", () => {
    expect(PORT_ENV_HINTS).toContain("PORT");
    const svc = parseCompose(`
services:
  s:
    environment:
      SOME_PORT_THING: "1234"
`).services[0]!;
    expect(extractPortClaims(svc)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// detectPortCollisions
// ---------------------------------------------------------------------------
describe("detectPortCollisions", () => {
  function run(model: ComposeModel) {
    const groups = groupByNetns(model);
    const claims = model.services.flatMap(extractPortClaims);
    return detectPortCollisions(groups, claims, model);
  }

  it("flags a hard duplicate (ports/expose) as error — the Dozzle 8080 case", () => {
    const m = parseCompose(`
services:
  tailscale:
    image: ts
  qbittorrent:
    network_mode: service:tailscale
    expose: ["8080"]
  dozzle:
    network_mode: service:tailscale
    expose: ["8080"]
`);
    const hz = run(m).filter((h) => h.kind === "port-collision");
    expect(hz).toHaveLength(1);
    expect(hz[0]!.severity).toBe("error");
    expect(hz[0]!.port).toBe(8080);
    expect(hz[0]!.services.sort()).toEqual(["dozzle", "qbittorrent"]);
  });

  it("downgrades an env-hint-derived collision to warn", () => {
    const m = parseCompose(`
services:
  tailscale:
    image: ts
  qbittorrent:
    network_mode: service:tailscale
    environment: { WEBUI_PORT: 8080 }
  dozzle:
    network_mode: service:tailscale
    environment: { PORT: 8080 }
`);
    const hz = run(m).filter((h) => h.kind === "port-collision");
    expect(hz).toHaveLength(1);
    expect(hz[0]!.severity).toBe("warn");
  });

  it("flags a dependent that publishes its own ports as a dependent-publishes error", () => {
    const m = parseCompose(`
services:
  tailscale:
    image: ts
  dozzle:
    network_mode: service:tailscale
    ports: ["9090:8080"]
`);
    const hz = run(m).filter((h) => h.kind === "dependent-publishes");
    expect(hz).toHaveLength(1);
    expect(hz[0]!.severity).toBe("error");
    expect(hz[0]!.services).toEqual(["dozzle"]);
  });

  it("clean stack: no collisions", () => {
    const m = parseCompose(`
services:
  tailscale:
    image: ts
    ports: ["8080:8080", "9090:9090"]
  dozzle:
    network_mode: service:tailscale
    environment: { PORT: 9091 }
`);
    expect(run(m).filter((h) => h.kind === "port-collision")).toHaveLength(0);
  });

  it("does NOT cross-flag the same port in two different (non-shared) netns", () => {
    const m = parseCompose(`
services:
  a:
    ports: ["80:80"]
  b:
    ports: ["80:80"]
`);
    // a and b each have their own netns — port 80 in each is fine.
    expect(run(m).filter((h) => h.kind === "port-collision")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// detectNetnsRecreate
// ---------------------------------------------------------------------------
describe("detectNetnsRecreate", () => {
  const stack = (tsPorts: string) =>
    parseCompose(`
services:
  tailscale:
    image: tailscale/tailscale:latest
    ports: [${tsPorts}]
  dozzle:
    network_mode: service:tailscale
`);

  it("provider ports change with dependents → error (the recreate deadlock)", () => {
    const prev = stack(`"8080:8080"`);
    const next = stack(`"8080:8080", "9090:9090"`);
    const hz = detectNetnsRecreate(next, prev);
    expect(hz).toHaveLength(1);
    expect(hz[0]!.kind).toBe("netns-recreate");
    expect(hz[0]!.severity).toBe("error");
    expect(hz[0]!.services).toContain("tailscale");
    expect(hz[0]!.services).toContain("dozzle");
  });

  it("no change to the provider → no hazard", () => {
    const prev = stack(`"8080:8080"`);
    const next = stack(`"8080:8080"`);
    expect(detectNetnsRecreate(next, prev)).toHaveLength(0);
  });

  it("provider with NO dependents → no hazard even on change", () => {
    const prev = parseCompose(`services:\n  tailscale:\n    ports: ["8080:8080"]`);
    const next = parseCompose(`services:\n  tailscale:\n    ports: ["9090:9090"]`);
    expect(detectNetnsRecreate(next, prev)).toHaveLength(0);
  });

  it("non-provider change is clean (only dozzle changed)", () => {
    const prev = parseCompose(`
services:
  tailscale: { image: ts, ports: ["8080:8080"] }
  dozzle: { network_mode: service:tailscale, image: dozzle:1 }
`);
    const next = parseCompose(`
services:
  tailscale: { image: ts, ports: ["8080:8080"] }
  dozzle: { network_mode: service:tailscale, image: dozzle:2 }
`);
    expect(detectNetnsRecreate(next, prev)).toHaveLength(0);
  });

  it("degraded mode (no prev): conservative info reminder when provider has dependents", () => {
    const next = stack(`"8080:8080"`);
    const hz = detectNetnsRecreate(next);
    expect(hz).toHaveLength(1);
    expect(hz[0]!.severity).toBe("info");
  });
});

// ---------------------------------------------------------------------------
// crossCheckBoundPorts
// ---------------------------------------------------------------------------
describe("crossCheckBoundPorts", () => {
  const claims = [
    { service: "dozzle", port: 9999, source: "expose" as const, raw: "9999" },
    { service: "newsvc", port: 7000, source: "ports" as const, raw: "7000:7000" },
  ];

  it("requested port bound by a known foreign holder → error", () => {
    const hz = crossCheckBoundPorts(claims, [{ port: 9999, holder: "gluetun" }], ["dozzle", "newsvc"]);
    expect(hz).toHaveLength(1);
    expect(hz[0]!.severity).toBe("error");
    expect(hz[0]!.detail).toContain("gluetun");
  });

  it("bound by our own service is ignored", () => {
    const hz = crossCheckBoundPorts(claims, [{ port: 9999, holder: "dozzle" }], ["dozzle", "newsvc"]);
    expect(hz).toHaveLength(0);
  });

  it("unknown holder downgrades to warn (could be our own running instance)", () => {
    const hz = crossCheckBoundPorts(claims, [{ port: 7000 }], ["dozzle", "newsvc"]);
    expect(hz).toHaveLength(1);
    expect(hz[0]!.severity).toBe("warn");
  });

  it("no overlap → clean", () => {
    expect(crossCheckBoundPorts(claims, [{ port: 1, holder: "x" }], [])).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// analyzeCompose — the orchestrator + ok flag
// ---------------------------------------------------------------------------
describe("analyzeCompose", () => {
  it("ok=false when any error hazard is present; provider + groups reported", () => {
    const next = parseCompose(`
services:
  tailscale:
    image: ts
    ports: ["8080:8080"]
  dozzle:
    network_mode: service:tailscale
    expose: ["8080"]
  qbit:
    network_mode: service:tailscale
    expose: ["8080"]
`);
    const r = analyzeCompose(next);
    expect(r.ok).toBe(false);
    expect(r.stack.provider).toBe("tailscale");
    expect(r.stack.services.sort()).toEqual(["dozzle", "qbit", "tailscale"]);
    expect(r.hazards.some((h) => h.kind === "port-collision")).toBe(true);
  });

  it("ok=true on a clean stack; boundPortsChecked reflects the option", () => {
    const next = parseCompose(`
services:
  tailscale:
    image: ts
    ports: ["8080:8080"]
  dozzle:
    network_mode: service:tailscale
    environment: { PORT: 9090 }
`);
    expect(analyzeCompose(next).boundPortsChecked).toBe(false);
    const r = analyzeCompose(next, { bound: [{ port: 1 }], boundPortsChecked: true });
    expect(r.ok).toBe(true);
    expect(r.boundPortsChecked).toBe(true);
  });

  it("a bound foreign port flips ok to false", () => {
    const next = parseCompose(`
services:
  tailscale: { image: ts }
  dozzle: { network_mode: service:tailscale, expose: ["9999"] }
`);
    const r = analyzeCompose(next, { bound: [{ port: 9999, holder: "gluetun" }], boundPortsChecked: true });
    expect(r.ok).toBe(false);
    expect(r.hazards.some((h) => h.kind === "port-bound-elsewhere")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// probe parsers
// ---------------------------------------------------------------------------
describe("parseProcNetTcpPorts", () => {
  it("extracts LISTEN ports from /proc/net/tcp hex rows", () => {
    const out = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid
   0: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0
   1: 0100007F:23F0 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0
   2: 00000000:C002 0A0A0A0A:1234 01 00000000:00000000 00:00000000 00000000     0`;
    // 1F90=8080, 23F0=9200; the 3rd row is state 01 (not LISTEN) → skipped.
    expect(parseProcNetTcpPorts(out)).toEqual([8080, 9200]);
  });
  it("tolerates junk/blank lines", () => {
    expect(parseProcNetTcpPorts("\n  \nheader only\n")).toEqual([]);
  });
});

describe("parseSsListeners", () => {
  it("parses ss -tlnp rows with holder names", () => {
    const out = `State   Recv-Q  Send-Q   Local Address:Port   Peer Address:Port  Process
LISTEN  0       128      0.0.0.0:8080         0.0.0.0:*          users:(("qbittorrent",pid=42,fd=3))
LISTEN  0       128      0.0.0.0:9999         0.0.0.0:*          users:(("gluetun",pid=7,fd=9))`;
    const bound = parseSsListeners(out);
    expect(bound).toEqual([
      { port: 8080, holder: "qbittorrent" },
      { port: 9999, holder: "gluetun" },
    ]);
  });
  it("parses rows without a process column (no -p / no permission)", () => {
    const out = `State  Recv-Q Send-Q Local Address:Port Peer Address:Port
LISTEN 0      128    *:7000             *:*`;
    expect(parseSsListeners(out)).toEqual([{ port: 7000 }]);
  });
});
