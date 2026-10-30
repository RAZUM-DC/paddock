// Git accounts per user: host + optional path prefix + username + token. The token is sealed with lib/secret-box.ts
// and only ever leaves the server towards the user's own harness, through the git credential helper
// (codex/git-credential-paddock → POST /api/harness/git-credential, see lib/harness-api.ts).
// Validation and matching are pure; the store takes the database as an argument, so tests use a temp sqlite.
import type Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { open, seal } from "./secret-box";

export const MAX_ACCOUNTS = 20;
export const MAX_TOKEN = 4096;
// Real tokens (GitHub, GitLab, Gitea, Bitbucket app passwords) are longer; 16 keeps the last 4 shown in the list
// from being a large share of the secret.
export const MIN_TOKEN = 16;

export type GitAccountInput = { host: string; prefix: string; username: string; token: string; label: string };
export type GitAccount = { id: string; host: string; prefix: string; username: string; label: string; last4: string; createdAt: number };
export type CredentialQuery = { protocol?: string; host?: string; path?: string };

const LABEL = /^[^\u0000-\u001f\u007f]{0,80}$/;
const USERNAME = /^[^\s\u0000-\u001f\u007f=]{1,200}$/;
// A DNS name of letters, digits and hyphens, optionally with :port. No scheme, no path, no user info.
const LABEL_DNS = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOST = new RegExp(`^${LABEL_DNS}(?:\\.${LABEL_DNS})*(?::(\\d{1,5}))?$`);
const PREFIX = /^[A-Za-z0-9._/-]{0,200}$/;

export function normalizeHost(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const h = raw.trim().toLowerCase();
  const m = HOST.exec(h);
  if (!m || h.length > 253) return null;
  if (m[1] !== undefined && (Number(m[1]) < 1 || Number(m[1]) > 65535)) return null;
  return h;
}

// "my-org/", "/my-org", "my-org" → "my-org"; "" → "" (any repository on the host). Segments are compared whole,
// so "my-org" never matches "my-org-evil/…", and a trailing ".git" does not matter.
export function normalizePrefix(raw: unknown): string | null {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string" || !PREFIX.test(raw.trim())) return null;
  const segs = raw.trim().replace(/^\/+|\/+$/g, "").replace(/\.git$/, "").split("/");
  if (segs.length === 1 && segs[0] === "") return "";
  if (segs.some((s) => s === "" || s === "." || s === "..")) return null;
  return segs.join("/");
}

export const defaultUsername = (host: string) => (host === "github.com" ? "x-access-token" : "oauth2");

// Git's credential protocol is line based: a token with a newline or a NUL could inject extra fields.
export const validToken = (t: unknown): t is string => typeof t === "string" && t.length >= MIN_TOKEN && t.length <= MAX_TOKEN && !/[\u0000-\u001f\u007f]/.test(t);

export function validateAccount(input: unknown): { ok: true; value: GitAccountInput } | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "body must be a JSON object" };
  const b = input as Record<string, unknown>;
  const host = normalizeHost(b.host);
  if (!host) return { ok: false, error: "host: a host name like github.com or git.example.com[:port], without https:// or a path" };
  const prefix = normalizePrefix(b.prefix);
  if (prefix === null) return { ok: false, error: "prefix: letters, digits, . _ - and /, up to 200 characters, no empty or .. segments" };
  const username = typeof b.username === "string" && b.username.trim() ? b.username.trim() : defaultUsername(host);
  if (!USERNAME.test(username)) return { ok: false, error: "username: no spaces, = or control characters, up to 200 characters" };
  const token = typeof b.token === "string" ? b.token.trim() : b.token;
  if (!validToken(token)) return { ok: false, error: `token: ${MIN_TOKEN} to ${MAX_TOKEN} characters, no line breaks` };
  const label = typeof b.label === "string" && b.label.trim() ? b.label.trim() : prefix ? `${host}/${prefix}` : host;
  if (!LABEL.test(label)) return { ok: false, error: "label: up to 80 characters" };
  return { ok: true, value: { host, prefix, username, token, label } };
}

// The path git sends (credential.useHttpPath), as segments; null for anything that is not a plain repository path.
// git passes it raw, so "my-org/../other-org/repo.git" must not count as being under "my-org"; percent-encoding,
// query, fragment, backslashes, empty, "." and ".." segments are all refused rather than interpreted.
export function pathSegments(path: string | undefined): string[] | null {
  if (path === undefined || path === "") return [];
  if (/[%?#\\\u0000-\u001f\u007f]/.test(path) || path.length > 1024) return null;
  const segs = path.replace(/^\//, "").replace(/\/$/, "").replace(/\.git$/, "").split("/");
  if (segs.some((s) => s === "" || s === "." || s === "..")) return null;
  return segs;
}

// Does an account prefix cover a repository path? "" covers everything; otherwise whole leading segments.
export function prefixCovers(prefix: string, path: string | undefined): boolean {
  const have = pathSegments(path);
  if (have === null) return false;
  if (prefix === "") return true;
  const want = prefix.split("/");
  return want.length <= have.length && want.every((s, i) => s === have[i]);
}

// The account git should use for a request: https only, the exact host, and among the prefixes that cover the
// path the longest one (an org-wide account loses to a repository-specific one).
export function pickAccount<T extends { host: string; prefix: string }>(accounts: T[], q: CredentialQuery): T | null {
  if (q.protocol !== "https") return null;
  const host = normalizeHost(q.host);
  if (!host) return null;
  // A path that is not plain matches nothing, not even an account without a prefix.
  if (pathSegments(q.path) === null) return null;
  let best: T | null = null;
  let bestLen = -1;
  for (const a of accounts) {
    if (a.host !== host || !prefixCovers(a.prefix, q.path)) continue;
    const len = a.prefix === "" ? 0 : a.prefix.split("/").length;
    if (len > bestLen) {
      best = a;
      bestLen = len;
    }
  }
  return best;
}

export function setupGitTables(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS git_accounts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    host TEXT NOT NULL,
    prefix TEXT NOT NULL,
    username TEXT NOT NULL,
    label TEXT NOT NULL,
    token_enc TEXT NOT NULL,
    last4 TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (user_id, host, prefix)
  )`);
}

type Row = { id: string; user_id: string; host: string; prefix: string; username: string; label: string; token_enc: string; last4: string; created_at: number };
const toPublic = (r: Row): GitAccount => ({ id: r.id, host: r.host, prefix: r.prefix, username: r.username, label: r.label, last4: r.last4, createdAt: r.created_at });
// The ciphertext is bound to its owner, row, host, prefix and username: someone who can only write the database
// cannot move a token to another user or row, or redirect it to another host or repository, without it failing to
// decrypt.
const aadOf = (r: Pick<Row, "user_id" | "id" | "host" | "prefix" | "username">) => JSON.stringify(["git-v1", r.user_id, r.id, r.host, r.prefix, r.username]);

export class GitAccountError extends Error {
  readonly name = "GitAccountError";
}
// By name: the store is shared through globalThis between server.ts and Next's route handlers (see secret-requests.ts).
export const isGitAccountError = (e: unknown): e is GitAccountError => e instanceof Error && e.name === "GitAccountError";

export function gitAccountStore(db: Database.Database, key: () => Buffer) {
  setupGitTables(db);
  const rows = (userId: string) => db.prepare("SELECT * FROM git_accounts WHERE user_id = ? ORDER BY created_at, id").all(userId) as Row[];
  return {
    list: (userId: string): GitAccount[] => rows(userId).map(toPublic),

    add(userId: string, input: unknown, now = Date.now()): GitAccount {
      const v = validateAccount(input);
      if (!v.ok) throw new GitAccountError(v.error);
      const { host, prefix, username, token, label } = v.value;
      const id = randomBytes(12).toString("hex");
      const row: Row = { id, user_id: userId, host, prefix, username, label, token_enc: "", last4: token.slice(-4), created_at: now };
      row.token_enc = seal(key(), token, aadOf(row));
      db.transaction(() => {
        const existing = rows(userId);
        if (existing.length >= MAX_ACCOUNTS) throw new GitAccountError(`at most ${MAX_ACCOUNTS} accounts`);
        if (existing.some((r) => r.host === host && r.prefix === prefix)) throw new GitAccountError("an account for this host and prefix exists already; delete it first");
        db.prepare("INSERT INTO git_accounts (id, user_id, host, prefix, username, label, token_enc, last4, created_at) VALUES (@id, @user_id, @host, @prefix, @username, @label, @token_enc, @last4, @created_at)").run(row);
      })();
      return toPublic(row);
    },

    remove: (userId: string, id: string): boolean => db.prepare("DELETE FROM git_accounts WHERE user_id = ? AND id = ?").run(userId, id).changes > 0,

    // Offboarding (admin): every account of one user.
    removeAll: (userId: string): number => db.prepare("DELETE FROM git_accounts WHERE user_id = ?").run(userId).changes,
    count: (userId: string): number => (db.prepare("SELECT COUNT(*) AS n FROM git_accounts WHERE user_id = ?").get(userId) as { n: number }).n,

    // Only this user's accounts take part. A row that does not decrypt (other key, tampering) is treated as absent.
    credentialFor(userId: string, q: CredentialQuery): { account: string; username: string; password: string } | null {
      const row = pickAccount(rows(userId), q);
      if (!row) return null;
      try {
        return { account: row.id, username: row.username, password: open(key(), row.token_enc, aadOf(row)) };
      } catch {
        return null;
      }
    },
  };
}
export type GitAccountStore = ReturnType<typeof gitAccountStore>;
