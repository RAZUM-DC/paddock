// Next.js + WebSocket-мост: браузер (с сессией) ↔ /ws/codex ↔ harness-<user>:4500 (с capability-токеном).
// Токены пользователей браузер не видит никогда.
import { Agent, createServer, type IncomingHttpHeaders } from "node:http";
import { readFileSync } from "node:fs";
import next from "next";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { db, ensureDb, harnessIdOf, sessionFromHeaders } from "./lib/auth";
import { ensureHarness, managedHarness } from "./lib/provision";
import { createHarnessApi, isHarnessApiPath } from "./lib/harness-api";
import { DEFAULT_TRUSTED_PROXIES, normalizeForwarded, parseTrustList, ProxyTrust } from "./lib/client-ip";
import { gitAccounts, harnessApiEnabled, secretRequests } from "./lib/harness-services";

const dev = process.env.NODE_ENV !== "production";
const port = Number(process.env.PORT ?? 3000);
const tokensDir = process.env.TOKENS_DIR ?? "/run/secrets/tokens";
const codexHost = process.env.CODEX_HOST_TEMPLATE ?? "harness-{user}:4500";
const publicUrl = process.env.PUBLIC_URL ?? `http://localhost:${port}`;
// Harnesses are on private networks: never through HTTP(S)_PROXY, even with NODE_USE_ENV_PROXY=1.
const direct = new Agent();

function toHeaders(h: IncomingHttpHeaders): Headers {
  const out = new Headers();
  for (const [k, v] of Object.entries(h)) if (v) out.set(k, Array.isArray(v) ? v.join(", ") : v);
  return out;
}

await ensureDb();

// Who may pass X-Forwarded-For through (the edge); everyone else's forwarding headers are replaced by the TCP peer.
const trustSpec = parseTrustList(process.env.TRUSTED_PROXIES ?? DEFAULT_TRUSTED_PROXIES);
if (trustSpec.invalid.length) console.warn(`TRUSTED_PROXIES: ignored ${trustSpec.invalid.join(", ")}`);
const proxyTrust = new ProxyTrust(trustSpec);
await proxyTrust.refresh();
setInterval(() => void proxyTrust.refresh(), 60_000).unref();
const app = next({ dev });
const handle = app.getRequestHandler();
await app.prepare();
const nextUpgrade = app.getUpgradeHandler();

// /api/harness/*: harness containers only (git credentials, secret requests), handled before Next — see lib/harness-api.ts.
const harnessApi = createHarnessApi({ enabled: harnessApiEnabled(), tokensDir, db, gitAccounts, secrets: secretRequests() });
// /api/harness/* sees the raw headers (it refuses any forwarding header); everything else gets them normalised.
const server = createServer((req, res) => {
  if (isHarnessApiPath(req.url)) return void harnessApi(req, res);
  normalizeForwarded(req.headers, req.socket.remoteAddress, proxyTrust);
  return handle(req, res);
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });

server.on("upgrade", async (req, socket, head) => {
  normalizeForwarded(req.headers, req.socket.remoteAddress, proxyTrust);
  if (!req.url?.startsWith("/ws/codex")) return nextUpgrade(req, socket, head);
  const reject = (code: string) => {
    socket.write(`HTTP/1.1 ${code}\r\n\r\n`);
    socket.destroy();
  };
  // Cookie-авторизация на WebSocket без проверки Origin открывает CSWSH: пускаем только со своего домена.
  if (!dev && req.headers.origin !== publicUrl) return reject("403 Forbidden");
  const session = await sessionFromHeaders(toHeaders(req.headers));
  if (!session) return reject("401 Unauthorized");

  let user: string, token: string;
  try {
    user = harnessIdOf(session.user);
  } catch {
    return reject("403 Forbidden");
  }
  try {
    token = readFileSync(`${tokensDir}/${user}.token`, "utf8").trim();
  } catch {
    // No harness yet: with a provisioner, start making one (the UI polls /api/harness and shows "preparing").
    if (managedHarness(user)) {
      ensureHarness({ id: user, email: session.user.email, name: session.user.name });
      return reject("503 Service Unavailable");
    }
    return reject("403 Forbidden");
  }

  wss.handleUpgrade(req, socket, head, (client) => {
    const upstream = new WebSocket(`ws://${codexHost.replace("{user}", user)}`, {
      headers: { Authorization: `Bearer ${token}` },
      agent: direct,
    });
    // ws отдаёт сообщения Buffer'ами, а send(Buffer) по умолчанию шлёт бинарный фрейм —
    // app-server такие игнорирует, поэтому тип фрейма передаём явно.
    const queue: [RawData, boolean][] = [];
    client.on("message", (data, isBinary) =>
      upstream.readyState === WebSocket.OPEN ? upstream.send(data, { binary: isBinary }) : queue.push([data, isBinary]),
    );
    upstream.on("open", () => queue.splice(0).forEach(([d, binary]) => upstream.send(d, { binary })));
    upstream.on("unexpected-response", (_req, res) => {
      console.error(`harness-${user}: upstream rejected with ${res.statusCode}`);
      client.close(1011, "codex unavailable");
    });
    upstream.on("message", (data, isBinary) => client.send(data, { binary: isBinary }));
    const closeBoth = () => {
      client.close();
      upstream.close();
    };
    client.on("close", closeBoth);
    upstream.on("close", closeBoth);
    upstream.on("error", (e) => {
      console.error(`harness-${user}: ${e.message}`);
      // The container is gone or never started: a provisioner recreates it (idempotent, volumes are kept).
      if (managedHarness(user) && /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EHOSTUNREACH/.test(e.message)) ensureHarness({ id: user, email: session.user.email, name: session.user.name });
      closeBoth();
    });
  });
});

server.listen(port, () => console.log(`paddock web on :${port} (${dev ? "dev" : "prod"})`));
