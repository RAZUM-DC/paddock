// Next.js + WebSocket-мост: браузер (с сессией) ↔ /ws/codex ↔ codex-<user>:4500 (с capability-токеном).
// Токены пользователей браузер не видит никогда.
import { createServer, type IncomingHttpHeaders } from "node:http";
import { readFileSync } from "node:fs";
import next from "next";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { auth, codexUserOf, ensureDb } from "./lib/auth";

const dev = process.env.NODE_ENV !== "production";
const port = Number(process.env.PORT ?? 3000);
const tokensDir = process.env.TOKENS_DIR ?? "/run/secrets/tokens";
const codexHost = process.env.CODEX_HOST_TEMPLATE ?? "codex-{user}:4500";
const publicUrl = process.env.PUBLIC_URL ?? `http://localhost:${port}`;

function toHeaders(h: IncomingHttpHeaders): Headers {
  const out = new Headers();
  for (const [k, v] of Object.entries(h)) if (v) out.set(k, Array.isArray(v) ? v.join(", ") : v);
  return out;
}

await ensureDb();
const app = next({ dev });
const handle = app.getRequestHandler();
await app.prepare();
const nextUpgrade = app.getUpgradeHandler();

const server = createServer((req, res) => handle(req, res));
const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });

server.on("upgrade", async (req, socket, head) => {
  if (!req.url?.startsWith("/ws/codex")) return nextUpgrade(req, socket, head);
  const reject = (code: string) => {
    socket.write(`HTTP/1.1 ${code}\r\n\r\n`);
    socket.destroy();
  };
  // Cookie-авторизация на WebSocket без проверки Origin открывает CSWSH: пускаем только со своего домена.
  if (!dev && req.headers.origin !== publicUrl) return reject("403 Forbidden");
  const session = await auth.api.getSession({ headers: toHeaders(req.headers) }).catch(() => null);
  if (!session) return reject("401 Unauthorized");

  let user: string, token: string;
  try {
    user = codexUserOf(session.user.email);
    token = readFileSync(`${tokensDir}/${user}.token`, "utf8").trim();
  } catch {
    return reject("403 Forbidden");
  }

  wss.handleUpgrade(req, socket, head, (client) => {
    const upstream = new WebSocket(`ws://${codexHost.replace("{user}", user)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    // ws отдаёт сообщения Buffer'ами, а send(Buffer) по умолчанию шлёт бинарный фрейм —
    // app-server такие игнорирует, поэтому тип фрейма передаём явно.
    const queue: [RawData, boolean][] = [];
    client.on("message", (data, isBinary) =>
      upstream.readyState === WebSocket.OPEN ? upstream.send(data, { binary: isBinary }) : queue.push([data, isBinary]),
    );
    upstream.on("open", () => queue.splice(0).forEach(([d, binary]) => upstream.send(d, { binary })));
    upstream.on("unexpected-response", (_req, res) => {
      console.error(`codex-${user}: upstream rejected with ${res.statusCode}`);
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
      console.error(`codex-${user}: ${e.message}`);
      closeBoth();
    });
  });
});

server.listen(port, () => console.log(`codex-hub web on :${port} (${dev ? "dev" : "prod"})`));
