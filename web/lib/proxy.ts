// Цепочка внешних прокси в egress (gost). Морда читает и меняет её через API gost; пароли наружу не отдаёт.
import { request as httpRequest } from "node:http";
import { connect as tlsConnect } from "node:tls";
import { auth, codexUserOf } from "./auth";

const api = process.env.GOST_API ?? "http://egress:18080/api";
const basic = "Basic " + Buffer.from(`${process.env.GOST_API_USER ?? ""}:${process.env.GOST_API_PASS ?? ""}`).toString("base64");
const CHAIN = "upstream";

export type ProxyNode = { name: string; addr: string; username: string; hasPassword: boolean };
export type ProxyInput = { name: string; addr: string; username: string; password: string };

async function gost(path: string, init: RequestInit = {}) {
  const r = await fetch(`${api}${path}`, { ...init, headers: { authorization: basic, "content-type": "application/json" } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`gost ${path}: ${r.status} ${body.msg ?? ""}`);
  return body;
}

// Только админы (ADMIN_USERS=valera,...) и только со своего домена.
export async function requireAdmin(req: Request): Promise<Response | null> {
  const session = await auth.api.getSession({ headers: req.headers }).catch(() => null);
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const admins = (process.env.ADMIN_USERS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!admins.includes(codexUserOf(session.user.email))) return Response.json({ error: "forbidden" }, { status: 403 });
  if (req.method !== "GET" && req.headers.get("origin") !== process.env.PUBLIC_URL) return Response.json({ error: "bad origin" }, { status: 403 });
  return null;
}

async function readChain(): Promise<any> {
  return (await gost(`/config/chains/${CHAIN}`)).data;
}

export async function listNodes(): Promise<{ nodes: ProxyNode[]; strategy: string | null }> {
  const chain = await readChain();
  const hop = chain.hops?.[0] ?? {};
  return {
    strategy: hop.selector?.strategy ?? null,
    nodes: (hop.nodes ?? []).map((n: any) => ({
      name: n.name,
      addr: n.addr,
      username: n.connector?.auth?.username ?? "",
      hasPassword: !!n.connector?.auth?.password,
    })),
  };
}

// Новый список узлов: порядок = приоритет (fifo). Пустой пароль у существующего узла = оставить прежний.
export async function saveNodes(input: ProxyInput[]) {
  if (input.length === 0) throw new Error("нужен хотя бы один прокси, иначе Codex останется без сети");
  const names = new Set<string>();
  for (const n of input) {
    if (!/^[\w-]{1,40}$/.test(n.name)) throw new Error(`имя «${n.name}»: латиница, цифры, - _`);
    if (names.has(n.name)) throw new Error(`имя «${n.name}» повторяется`);
    names.add(n.name);
    if (!/^[\w.-]+:\d{1,5}$/.test(n.addr)) throw new Error(`адрес «${n.addr}»: нужен host:port`);
  }
  const chain = await readChain();
  const hop = chain.hops?.[0] ?? { name: "hop-0" };
  const old = new Map<string, any>((hop.nodes ?? []).map((n: any) => [n.name, n]));
  hop.nodes = input.map((n) => {
    const prev = old.get(n.name)?.connector?.auth;
    const password = n.password || (prev?.username === n.username ? prev?.password : "") || "";
    return {
      name: n.name,
      addr: n.addr,
      connector: { type: "http", ...(n.username ? { auth: { username: n.username, password } } : {}) },
      dialer: { type: "tcp" },
    };
  });
  chain.hops = [hop];
  await gost(`/config/chains/${CHAIN}`, { method: "PUT", body: JSON.stringify(chain) });
  await gost("/config?format=yaml", { method: "POST" }); // сохранить в gost.yaml, чтобы пережило рестарт
}

// HTTPS-запрос наружу через egress:8080 (CONNECT): у морды нет прямого выхода в интернет.
export function viaEgress(host: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("таймаут 15 с")), 15000);
    const req = httpRequest({ host: "egress", port: 8080, method: "CONNECT", path: `${host}:443` });
    req.on("connect", (res, socket) => {
      if (res.statusCode !== 200) return reject(new Error(`egress ответил ${res.statusCode}`));
      const tls = tlsConnect({ socket, servername: host }, () => {
        const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join("");
        // HTTP/1.0 — ответ без chunked, читаем до закрытия соединения
        tls.write(`GET ${path} HTTP/1.0\r\nHost: ${host}\r\nAccept: application/json\r\n${extra}\r\n`);
      });
      let raw = "";
      tls.setEncoding("utf8");
      tls.on("data", (d) => (raw += d));
      tls.on("end", () => {
        clearTimeout(timer);
        const status = Number(raw.slice(9, 12));
        resolve({ status, body: raw.slice(raw.indexOf("\r\n\r\n") + 4) });
      });
      tls.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

// Какой IP видит интернет и сколько занял путь через цепочку.
export async function checkExit(): Promise<{ ip: string; country: string | null; org: string | null; ms: number }> {
  const started = Date.now();
  const r = await viaEgress("ipinfo.io", "/json");
  const j = JSON.parse(r.body);
  return { ip: j.ip, country: j.country ?? null, org: j.org ?? null, ms: Date.now() - started };
}
