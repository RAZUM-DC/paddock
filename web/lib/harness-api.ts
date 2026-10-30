// /api/harness/* — called by harness containers, never by browsers: the git credential helper
// (codex/git-credential-paddock) and the `secrets` tool (web/tools/secrets). server.ts routes these paths here before
// Next, because Next fills in X-Forwarded-For itself and the edge check below needs the raw request.
//
// - A request that came through a proxy (edge nginx, Traefik: X-Forwarded-For / Forwarded / X-Real-IP) is answered 404.
//   edge/nginx.conf also blocks the prefix; this is the second fence.
// - The caller is authenticated as a harness by its capability token (lib/harness-auth.ts) and only ever sees its own
//   user's git accounts and its own secret requests.
// - Logs one JSON line per git credential call (harness, host, matched account id); never tokens, values or paths.
import type { IncomingMessage, ServerResponse } from "node:http";
import type Database from "better-sqlite3";
import type { GitAccountStore } from "./git-accounts";
import { bearerOf, harnessIdForToken, rateLimiter, userIdOfHarness } from "./harness-auth";
import { isRequestId, isSecretRequestError, SecretRequestError, type SecretRequestStore } from "./secret-requests";

export const HARNESS_PREFIX = "/api/harness/";
const MAX_BODY = 16 * 1024;

export type HarnessApiDeps = {
  enabled: boolean;
  tokensDir: string;
  db: Database.Database;
  gitAccounts: () => GitAccountStore;
  secrets: SecretRequestStore;
  log?: (line: Record<string, unknown>) => void;
  now?: () => number;
  // Per harness, per minute.
  gitRate?: number;
  secretsRate?: number;
};

export const isHarnessApiPath = (url: string | undefined) => !!url && url.startsWith(HARNESS_PREFIX);

// Came through a reverse proxy, i.e. from outside the container network.
export const viaProxy = (h: IncomingMessage["headers"]) => h["x-forwarded-for"] !== undefined || h["forwarded"] !== undefined || h["x-real-ip"] !== undefined;

function send(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status, { "cache-control": "no-store" });
    res.end();
    return;
  }
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "content-length": Buffer.byteLength(data) });
  res.end(data);
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (Number(req.headers["content-length"] ?? 0) > MAX_BODY) return reject(new SecretRequestError("body too large", 413));
    let size = 0;
    let tooLarge = false;
    const chunks: Buffer[] = [];
    // Past the limit the rest is read and dropped, so the client still gets its 413.
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) tooLarge = true;
      else chunks.push(c);
    });
    req.on("end", () => {
      if (tooLarge) return reject(new SecretRequestError("body too large", 413));
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        reject(new SecretRequestError("body must be JSON"));
      }
    });
    req.on("error", reject);
  });
}

export function createHarnessApi(deps: HarnessApiDeps) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((l) => console.log(JSON.stringify(l)));
  const gitLimit = rateLimiter(deps.gitRate ?? 120, 60_000, now);
  const secretsLimit = rateLimiter(deps.secretsRate ?? 120, 60_000, now);

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (viaProxy(req.headers) || !deps.enabled) return send(res, 404, { error: "not found" });
    const path = new URL(req.url ?? "/", "http://harness").pathname;
    const harness = harnessIdForToken(deps.tokensDir, bearerOf(req.headers.authorization));
    if (!harness) return send(res, 401, { error: "unauthorized" });

    try {
      if (path === "/api/harness/git-credential") {
        if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
        if (!gitLimit(harness)) return send(res, 429, { error: "too many requests" });
        const b = (await readJson(req)) as Record<string, unknown>;
        const q = { protocol: typeof b?.protocol === "string" ? b.protocol : undefined, host: typeof b?.host === "string" ? b.host : undefined, path: typeof b?.path === "string" ? b.path : undefined };
        const userId = userIdOfHarness(deps.db, harness);
        const cred = userId ? deps.gitAccounts().credentialFor(userId, q) : null;
        log({ event: "git-credential", harness, host: (q.host ?? "").slice(0, 260), account: cred?.account ?? null });
        if (!cred) return send(res, 204);
        return send(res, 200, { username: cred.username, password: cred.password });
      }

      if (path === "/api/harness/secret-requests" || path.startsWith("/api/harness/secret-requests/")) {
        if (!secretsLimit(harness)) return send(res, 429, { error: "too many requests" });
        const id = path.slice("/api/harness/secret-requests/".length);
        if (path === "/api/harness/secret-requests") {
          if (req.method === "POST") return send(res, 201, { request: deps.secrets.create(harness, await readJson(req), now()) });
          if (req.method === "GET") return send(res, 200, { requests: deps.secrets.pending(harness, now()) });
          return send(res, 405, { error: "method not allowed" });
        }
        if (!isRequestId(id)) return send(res, 404, { error: "no such request" });
        if (req.method === "GET") return send(res, 200, deps.secrets.collect(harness, id, now()));
        if (req.method === "DELETE") {
          deps.secrets.cancel(harness, id, now());
          return send(res, 204);
        }
        return send(res, 405, { error: "method not allowed" });
      }
      return send(res, 404, { error: "not found" });
    } catch (e) {
      if (isSecretRequestError(e)) return send(res, e.status, { error: e.message });
      console.error(`harness api ${harness} ${path}: ${e instanceof Error ? e.message : "error"}`);
      return send(res, 500, { error: "internal error" });
    }
  };
}
