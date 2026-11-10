// GET /api/gate/<app>: a forward-auth check for other apps on the same host (e.g. a reverse proxy's forward_auth in
// front of an app that has no login of its own). Paddock's session cookie is host-only, so the browser sends it to any
// port of the host, and the proxy forwards it here on every request.
//   204 + X-Gate-User-Id / X-Gate-User-Email / X-Gate-Harness   signed in (second factor done) and allowed for <app>
//   401   no session, or a session still waiting for its second factor (OIDC_REQUIRE_TOTP)
//   403   signed in, not allowed for <app>
//   404   <app> is not a valid name or has no GATE_<APP>_* rule (deny by default)
//   429   too many failed checks from one client address
// Who is allowed (any of): GATE_<APP>_EMAILS (comma list), GATE_<APP>_GROUPS (OIDC groups as of the user's last OIDC
// login), GATE_<APP>_ADMINS=1 (Paddock admins). <APP> is the app name upper-cased with - → _.
// Identity comes from the Cookie header only: no other request header reaches the session check.
import type { IncomingMessage, ServerResponse } from "node:http";
import { rateLimiter } from "./harness-auth";
import { parseList } from "./identity";

export const GATE_PREFIX = "/api/gate/";
export const GATE_APP_RE = /^[a-z0-9-]{1,32}$/;
export const isGatePath = (url: string | undefined) => !!url && (url === "/api/gate" || url.startsWith(GATE_PREFIX));

export type GateRule = { emails: Set<string>; groups: Set<string>; admins: boolean };
export type GateUser = { id: string; email: string };

const envKey = (app: string) => `GATE_${app.toUpperCase().replace(/-/g, "_")}_`;

export function gateRule(app: string, env: Record<string, string | undefined> = process.env): GateRule | null {
  if (!GATE_APP_RE.test(app)) return null;
  const k = envKey(app);
  const rule = {
    emails: new Set(parseList(env[`${k}EMAILS`]).map((e) => e.toLowerCase())),
    groups: new Set(parseList(env[`${k}GROUPS`])),
    admins: env[`${k}ADMINS`] === "1",
  };
  return rule.emails.size || rule.groups.size || rule.admins ? rule : null;
}

export function gateAllows(rule: GateRule, who: { email: string; groups: string[]; admin: boolean }): boolean {
  if (who.email && rule.emails.has(who.email.toLowerCase())) return true;
  if (who.groups.some((g) => rule.groups.has(g))) return true;
  return rule.admins && who.admin;
}

// The app name of /api/gate/<app>[?query]; "" for anything else (a deeper path, an empty name).
export function gateAppOf(url: string | undefined): string {
  const path = (url ?? "").split("?")[0];
  if (!path.startsWith(GATE_PREFIX)) return "";
  const app = path.slice(GATE_PREFIX.length);
  return app.includes("/") ? "" : app;
}

// A header value we are willing to send back (printable ASCII, bounded); anything else is left out.
const headerSafe = (v: string | null | undefined) => (v && v.length <= 320 && /^[\x20-\x7e]+$/.test(v) ? v : null);
// For the log: the path of X-Forwarded-Uri only (no query: it may carry tokens).
export const loggedPath = (v: string | string[] | undefined) => {
  const p = (Array.isArray(v) ? v[0] : v ?? "").split("?")[0].slice(0, 200);
  return /^[\x21-\x7e]*$/.test(p) ? p : "?";
};

export type GateDeps = {
  session: (headers: Headers) => Promise<{ user: GateUser } | null>;
  groupsOf: (userId: string) => string[];
  isAdmin: (user: GateUser) => boolean;
  harnessOf: (user: GateUser) => string;
  clientAddress: (req: IncomingMessage) => string;
  env?: Record<string, string | undefined>;
  failRate?: number;
  rate?: number;
  now?: () => number;
  log?: (line: string) => void;
};

export function createGate(deps: GateDeps) {
  const now = deps.now ?? Date.now;
  // Failed checks per client address (probing, cookie guessing); and a generous cap on all checks, since the proxy
  // calls once per request of the app (every asset of a page).
  const failures = rateLimiter(deps.failRate ?? 60, 60_000, now);
  const all = rateLimiter(deps.rate ?? 6000, 60_000, now);
  const log = deps.log ?? ((l: string) => console.log(l));

  return async (req: IncomingMessage, res: ServerResponse) => {
    const reply = (status: number, headers: Record<string, string> = {}) => {
      const body = status === 204 || req.method === "HEAD" ? "" : `${status}\n`;
      res.writeHead(status, { "cache-control": "no-store", "x-content-type-options": "nosniff", ...(body ? { "content-type": "text/plain" } : {}), ...headers });
      res.end(body);
    };
    const addr = deps.clientAddress(req) || "unknown";
    const app = gateAppOf(req.url);
    const deny = (status: number) => {
      failures(addr);
      log(`gate ${GATE_APP_RE.test(app) ? app : "-"} ${status} ${addr} ${loggedPath(req.headers["x-forwarded-uri"])}`);
      return reply(status);
    };
    if (req.method !== "GET" && req.method !== "HEAD") return reply(405, { allow: "GET, HEAD" });
    if (!all(addr) || failures.blocked(addr)) return reply(429);
    const rule = gateRule(app, deps.env ?? process.env);
    if (!rule) return deny(404);
    // Only the cookie: X-Forwarded-*, Authorization and the rest never take part in finding the user.
    const cookie = req.headers.cookie;
    const session = cookie ? await deps.session(new Headers({ cookie })).catch(() => null) : null;
    if (!session?.user) return deny(401);
    const user = session.user;
    let groups: string[] = [];
    try {
      groups = deps.groupsOf(user.id);
    } catch {}
    if (!gateAllows(rule, { email: user.email, groups, admin: deps.isAdmin(user) })) return deny(403);
    let harness: string | null = null;
    try {
      harness = deps.harnessOf(user);
    } catch {}
    const out: Record<string, string> = {};
    for (const [h, v] of [["x-gate-user-id", user.id], ["x-gate-user-email", user.email], ["x-gate-harness", harness]] as const) {
      const safe = headerSafe(v);
      if (safe) out[h] = safe;
    }
    return reply(204, out);
  };
}
