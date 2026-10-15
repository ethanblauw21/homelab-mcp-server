/**
 * Redaction fixtures (ADR-026) — shared by `redaction.test.ts` and the MCP-boundary
 * test (`redactionBoundary.test.ts`). Not imported by production code. EVERY value
 * here is fake; none is, or was, a live credential.
 *
 * `secrets` must be absent from the redacted output; `keep` must survive verbatim.
 */

export interface RedactionFixture {
  name: string;
  input: string;
  secrets: string[];
  keep: string[];
}

export const FAKE_WEBHOOK_ID = "123456789012345678";
export const FAKE_WEBHOOK_TOKEN = "FAKE-test-token-abcDEF0123456789xyzXYZ_fake-0000";
export const FAKE_DISCORD_WEBHOOK = `https://discord.com/api/webhooks/${FAKE_WEBHOOK_ID}/${FAKE_WEBHOOK_TOKEN}`;

/** The regression case: the Diun container's env as `docker inspect` returns it. */
export const DIUN_ENV = [
  "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  "TZ=America/Chicago",
  "DIUN_WATCH_SCHEDULE=0 0 6 * * 1",
  `DIUN_NOTIF_DISCORD_WEBHOOKURL=${FAKE_DISCORD_WEBHOOK}`,
  "DIUN_PROVIDERS_DOCKER=true",
];

const IMAGE_DIGEST = "sha256:3a820372f19fcb2981ea19fe4b5382934d67414afaba974bce831ddda0a64a02";
const CONTAINER_ID = "c19aa4ecdf03d73e1d5c901da33744cb7eb4d921f89bafed1ca264601d7fa224";
const GIT_SHA = "bf2951c0a1b2c3d4e5f60718293a4b5c6d7e8f90";
const FAKE_UUID = "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0";
const FAKE_JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJmYWtlLXRlc3QifQ.FAKEsigFAKEsig0123456789_FAKEsigFAKEsig-x";

export const REDACT_FIXTURES: RedactionFixture[] = [
  // ---- key name ---------------------------------------------------------
  {
    name: "env KEY=value (webhook key name)",
    input: DIUN_ENV.join("\n"),
    secrets: [FAKE_WEBHOOK_TOKEN, FAKE_WEBHOOK_ID],
    keep: ["DIUN_NOTIF_DISCORD_WEBHOOKURL=", "TZ=America/Chicago", "DIUN_WATCH_SCHEDULE=0 0 6 * * 1", "DIUN_PROVIDERS_DOCKER=true"],
  },
  {
    name: "env-style names from the key list",
    input: [
      "DB_PASSWORD=fake-pw-0001",
      "MYSQL_PASSWD=fake-pw-0002",
      "PGPASS=fake-pw-0003",
      "SONARR_API_KEY=fake-apikey-0004",
      "APIKEY=fake-apikey-0005",
      "ENCRYPTION_KEY=fake-key-0006",
      "KEY=fake-key-0007",
      "OAUTH_CLIENT_ID_AUTH=fake-auth-0008",
      "SESSION_COOKIE=fake-cookie-0009",
      "AWS_CREDENTIALS=fake-cred-0010",
      "RSA_PRIVATE=fake-priv-0011",
      "FLASK_SESSION=fake-sess-0012",
      "HMAC_SIGNATURE=fake-sig-0013",
      "PW_SALT=fake-salt-0014",
      "SENTRY_DSN=fake-dsn-0015",
      "DB_CONNECTION_STRING=fake-conn-0016",
      "AZ_CONNSTRING=fake-conn-0017",
      "JWT_SECRET=fake-secret-0018",
      "GH_TOKEN=fake-token-0019",
    ].join("\n"),
    secrets: Array.from({ length: 19 }, (_, i) => `-${String(i + 1).padStart(4, "0")}`),
    keep: ["DB_PASSWORD=", "SONARR_API_KEY=", "KEY=", "SENTRY_DSN=", "DB_CONNECTION_STRING="],
  },
  {
    name: "label k=v (comma-joined docker ps Labels)",
    input: "com.docker.compose.project=1,diun.notif.webhook=fake-label-secret-01,traefik.enable=true",
    secrets: ["fake-label-secret-01"],
    keep: ["com.docker.compose.project=1", "diun.notif.webhook="],
  },
  {
    name: "YAML key: value lines + block scalar",
    input: [
      "services:",
      "  app:",
      "    environment:",
      "      api_token: fake-yaml-token-01",
      '      "password": "fake yaml pw 02"',
      "      private_key: |",
      "        fake-block-line-03",
      "        fake-block-line-04",
      "    image: nginx:1.27",
    ].join("\n"),
    secrets: ["fake-yaml-token-01", "fake yaml pw 02", "fake-block-line-03", "fake-block-line-04"],
    keep: ["api_token:", "private_key: |", "image: nginx:1.27", "services:"],
  },
  {
    name: "INI key = value with spaces",
    input: "[server]\nport = 8080\nadmin_password = fake ini pw with spaces 01\nhost = 0.0.0.0",
    secrets: ["fake ini pw with spaces 01", "spaces 01"],
    keep: ["port = 8080", "admin_password = ", "host = 0.0.0.0"],
  },
  {
    name: "JSON keys (string + number)",
    input: '{"user":"admin","password":"fake-json-pw-01","apiKey":"fake-json-key-02","pin_secret":424242,"port":8080}',
    secrets: ["fake-json-pw-01", "fake-json-key-02", "424242"],
    keep: ['"user":"admin"', '"port":8080', '"password":'],
  },
  {
    name: "XML element (arr config.xml)",
    input: "<Config>\n  <Port>8989</Port>\n  <ApiKey>fakeapikeyvalue0000001</ApiKey>\n</Config>",
    secrets: ["fakeapikeyvalue0000001"],
    keep: ["<Port>8989</Port>", "<ApiKey>"],
  },
  {
    name: "CLI flags --token=x and --password x",
    input: "mytool --token=fake-cli-token-01 --password fake-cli-pw-02 --port 8080 -v",
    secrets: ["fake-cli-token-01", "fake-cli-pw-02"],
    keep: ["--token=", "--password ", "--port 8080", "-v"],
  },
  {
    name: "compose ${VAR} / $VAR references are pointers, not secrets",
    input: "      - DB_PASSWORD=${DB_PASSWORD}\n      - API_TOKEN=$API_TOKEN\n      password: ${PG_PASS:?required}",
    secrets: [],
    keep: ["DB_PASSWORD=${DB_PASSWORD}", "API_TOKEN=$API_TOKEN", "password: ${PG_PASS:?required}"],
  },
  {
    name: "compose ${VAR:-default} default IS redacted",
    input: "      - DB_PASSWORD=${DB_PASSWORD:-fake-default-pw-01}",
    secrets: ["fake-default-pw-01"],
    keep: ["DB_PASSWORD="],
  },
  {
    name: "booleans under secret-ish names stay readable",
    input: "AUTH_ENABLED=true\nPASSWORDLESS=false",
    secrets: [],
    keep: ["AUTH_ENABLED=true", "PASSWORDLESS=false"],
  },
  // ---- shape ------------------------------------------------------------
  {
    name: "Discord webhook in free text (no key)",
    input: `notify -> ${FAKE_DISCORD_WEBHOOK} done`,
    secrets: [FAKE_WEBHOOK_TOKEN, FAKE_WEBHOOK_ID],
    keep: ["https://discord.com/api/webhooks/", " done"],
  },
  {
    name: "Slack / Teams / generic webhooks",
    input: [
      "https://hooks.slack.com/services/TFAKE0001/BFAKE0002/fakeSlackSecret0003",
      "https://fakeorg.webhook.office.com/webhookb2/fake-teams-guid-0004@fake/IncomingWebhook/fakehex0005/fake0006",
      "https://ha.lan:8123/api/webhook/fake-ha-hook-0007",
    ].join("\n"),
    secrets: ["fakeSlackSecret0003", "TFAKE0001", "fake-teams-guid-0004", "fakehex0005", "fake-ha-hook-0007"],
    keep: ["https://hooks.slack.com/services/", "https://fakeorg.webhook.office.com/webhookb2/", "https://ha.lan:8123/api/webhook/"],
  },
  {
    name: "shoutrrr notification URLs",
    input: "WATCHTOWER_NOTIFICATION_URL is discord://fakeShoutrrrToken01@123456 and telegram://fake:tg02@telegram",
    secrets: ["fakeShoutrrrToken01", "fake:tg02"],
    keep: ["discord://", "telegram://"],
  },
  {
    name: "URL userinfo user:pass@ (existing rule)",
    input: "postgres://admin:fake-url-pw-01@db.local:5432/app",
    secrets: ["fake-url-pw-01"],
    keep: ["postgres://admin:", "@db.local:5432/app"],
  },
  {
    name: "secret query parameters",
    input:
      "GET https://api.example.test/v1/x?id=5&token=fakeq01&apikey=fakeq02&api_key=fakeq03&access_token=fakeq04&secret=fakeq05&sig=fakeq06&signature=fakeq07&password=fakeq08&auth=fakeq09&key=fakeq10&page=2",
    secrets: ["fakeq01", "fakeq02", "fakeq03", "fakeq04", "fakeq05", "fakeq06", "fakeq07", "fakeq08", "fakeq09", "fakeq10"],
    keep: ["https://api.example.test/v1/x?id=5&token=", "&page=2"],
  },
  {
    name: "Authorization Bearer / Basic + X-Api-Key",
    input: [
      "Authorization: Bearer fakeBearerToken0001",
      "authorization: Basic ZmFrZTpmYWtlcGFzcw==",
      'curl -H "X-Api-Key: fake-x-api-key-0003" http://x.test',
      "Cookie: session=fake-cookie-0004",
    ].join("\n"),
    secrets: ["fakeBearerToken0001", "ZmFrZTpmYWtlcGFzcw==", "fake-x-api-key-0003", "fake-cookie-0004"],
    keep: ["Authorization: Bearer ", "authorization: Basic ", "X-Api-Key: ", '" http://x.test'],
  },
  {
    name: "PVEAPIToken keeps the token id, redacts the UUID",
    input: `Authorization: PVEAPIToken=mcp@pve!mcp-agent=${FAKE_UUID}\nPVE_TOKEN=mcp@pve!mcp-x=${FAKE_UUID}`,
    secrets: [FAKE_UUID],
    keep: ["PVEAPIToken=mcp@pve!mcp-agent="],
  },
  {
    name: "JWT",
    input: `token is ${FAKE_JWT} ok`,
    secrets: ["FAKEsigFAKEsig0123456789_FAKEsigFAKEsig-x", "eyJzdWIiOiJmYWtlLXRlc3QifQ"],
    keep: ["token is ", " ok"],
  },
  {
    name: "PEM private key block",
    input: "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAAFAKEFAKEFAKE\nFAKEFAKEline2==\n-----END OPENSSH PRIVATE KEY-----",
    secrets: ["b3BlbnNzaC1rZXktdjEAAAAAFAKEFAKEFAKE", "FAKEFAKEline2=="],
    keep: ["-----BEGIN OPENSSH PRIVATE KEY-----", "-----END OPENSSH PRIVATE KEY-----"],
  },
  {
    name: "known token prefixes keep the prefix",
    input: [
      "ghp_FAKEfake0123456789FAKEfake0123456789",
      "github_pat_FAKE0123456789_fakeFAKEfake0123456789",
      "glpat-FAKEfake0123456789abcd",
      "xoxb-0000000000-FAKEfakeFAKE",
      "sk-ant-FAKEfake0123456789FAKEfake",
      "AKIAFAKEFAKE00000000",
      "tskey-auth-kFAKE0CNTRL-FAKEfake0123456789",
    ].join(" "),
    secrets: [
      "FAKEfake0123456789FAKEfake0123456789",
      "FAKE0123456789_fakeFAKEfake0123456789",
      "FAKEfake0123456789abcd",
      "0000000000-FAKEfakeFAKE",
      "FAKEfake0123456789FAKEfake",
      "FAKEFAKE00000000",
      "kFAKE0CNTRL-FAKEfake0123456789",
    ],
    keep: ["ghp_", "github_pat_", "glpat-", "xoxb-", "sk-ant-", "AKIA", "tskey-auth-"],
  },
  {
    name: "high-entropy hex (32) and base64 (no key)",
    input: "seed 9f86d081884c7d659a2feaa0c55ad015 and blob Zm9vYmFyQkFaMTIzNDU2Nzg5MGFiY2RlZnhZWg== end",
    secrets: ["9f86d081884c7d659a2feaa0c55ad015", "Zm9vYmFyQkFaMTIzNDU2Nzg5MGFiY2RlZnhZWg=="],
    keep: ["seed ", " and blob ", " end"],
  },
  // ---- must NOT be redacted ---------------------------------------------
  {
    name: "image digests, container ids, git SHAs, uuids, ports, paths, normal URLs",
    input: [
      `lscr.io/linuxserver/bazarr@${IMAGE_DIGEST}`,
      `container ${CONTAINER_ID} running`,
      `commit ${GIT_SHA}`,
      `fs uuid ${FAKE_UUID}`,
      "ports 0.0.0.0:8989->8989/tcp, :::8080->80/tcp",
      "/var/lib/docker/volumes/sonarr_config/_data/config.xml",
      "/mnt/Media/Movies/Interstellar2014/Interstellar.2014.2160p.mkv",
      "https://github.com/linuxserver/docker-sonarr/releases/tag/4.0.19.2979-ls322",
      "SSH SHA256:Qk9HVVMtRkFLRS1GSU5HRVJQUklOVC0wMDAwMDAwMDAw",
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFAKEFAKEFAKEFAKEpublicKEYfake0000000 user@host",
      "PublicKey = FAKEpubKEY0123456789abcdefFAKEpubKEY01234567=",
      "image: ghcr.io/gethomepage/homepage:v2.4.0",
      "GLUETUN-QBITTORRENT-PORT-MANAGER segmem-tailscale-1",
    ].join("\n"),
    secrets: [],
    keep: [
      IMAGE_DIGEST,
      CONTAINER_ID,
      GIT_SHA,
      FAKE_UUID,
      "0.0.0.0:8989->8989/tcp",
      "/var/lib/docker/volumes/sonarr_config/_data/config.xml",
      "/mnt/Media/Movies/Interstellar2014/Interstellar.2014.2160p.mkv",
      "https://github.com/linuxserver/docker-sonarr/releases/tag/4.0.19.2979-ls322",
      "SHA256:Qk9HVVMtRkFLRS1GSU5HRVJQUklOVC0wMDAwMDAwMDAw",
      "AAAAC3NzaC1lZDI1NTE5AAAAIFAKEFAKEFAKEFAKEpublicKEYfake0000000",
      "FAKEpubKEY0123456789abcdefFAKEpubKEY01234567=",
      "image: ghcr.io/gethomepage/homepage:v2.4.0",
      "GLUETUN-QBITTORRENT-PORT-MANAGER segmem-tailscale-1",
    ],
  },
];
