// Second factor after an OIDC login (OIDC_REQUIRE_TOTP): the pure part. No better-auth imports here, only node:crypto
// and the database handle, so every rule runs under `node --test` (test/second-factor.test.mjs). The better-auth side
// (gate hook, endpoints, session hooks) is lib/second-factor.ts.
//
// Model: every session has a state in `session_second_factor`:
//   pending  — created by the OIDC callback; works nowhere but the second-factor page and sign-out,
//   verified — the TOTP (or a backup code) was checked for this session,
//   exempt   — created by a password sign-in (with better-auth's own TOTP when the user has it on).
// A session WITHOUT a row is pending when its user has an OIDC account (sessions from before this feature are not
// grandfathered), and fine otherwise (password-only users are not affected).
import type Database from "better-sqlite3";
import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

export type SessionState = "pending" | "verified" | "exempt";

// OIDC_REQUIRE_TOTP: on by default whenever OIDC is configured; "0" switches it off.
export const secondFactorRequired = (oidcConfigured: boolean, env: Record<string, string | undefined> = process.env) => oidcConfigured && env.OIDC_REQUIRE_TOTP !== "0";

export function setupSecondFactorTables(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS session_second_factor (
    session_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'verified', 'exempt')),
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS second_factor_failures (
    key TEXT PRIMARY KEY,
    failures INTEGER NOT NULL,
    first_at INTEGER NOT NULL,
    locked_until INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS second_factor_totp (
    user_id TEXT PRIMARY KEY,
    last_step INTEGER NOT NULL
  )`);
}

// Which state a session gets when better-auth creates it, from the endpoint that creates it.
//   OIDC callback                          → pending
//   password sign-in, better-auth 2FA step → exempt (the password path is unchanged)
//   anything else (rotations by other endpoints, scripts) → null: the caller copies the state of the session the
//   request was made with, or leaves no row (= pending for OIDC users).
export function classifyNewSession(path: string | undefined, params: Record<string, unknown> | undefined, providerId: string): SessionState | null {
  if (path === "/callback/:id" || path === "/oauth2/callback/:providerId") return params?.id === providerId || params?.providerId === providerId ? "pending" : null;
  if (path === "/sign-in/email" || path === "/two-factor/verify-totp" || path === "/two-factor/verify-backup-code" || path === "/two-factor/verify-otp") return "exempt";
  return null;
}

// better-auth endpoints a session in "pending" may still reach. Everything else answers 403.
const ALLOWED_WHILE_PENDING = new Set([
  "/sign-out",
  "/second-factor/status",
  "/second-factor/enrol",
  "/second-factor/verify",
  // A fresh sign-in replaces the pending cookie.
  "/sign-in/social",
  "/sign-in/email",
  "/callback/:id",
  "/error",
  "/ok",
]);
export const allowedWhilePending = (path: string | undefined) => !!path && ALLOWED_WHILE_PENDING.has(path);

export const hasOidcAccount = (db: Database.Database, userId: string, providerId: string) =>
  !!db.prepare(`SELECT 1 FROM "account" WHERE "userId" = ? AND "providerId" = ? LIMIT 1`).get(userId, providerId);

export function sessionState(db: Database.Database, sessionId: string, userId: string, providerId: string): SessionState | null {
  const row = db.prepare("SELECT state, user_id FROM session_second_factor WHERE session_id = ?").get(sessionId) as { state: SessionState; user_id: string } | undefined;
  // A row for another user (cannot happen unless the db was edited) counts as no row.
  if (row && row.user_id === userId) return row.state;
  return hasOidcAccount(db, userId, providerId) ? null : "exempt";
}

export const isPending = (db: Database.Database, sessionId: string, userId: string, providerId: string) => {
  const s = sessionState(db, sessionId, userId, providerId);
  return s === null || s === "pending";
};

export function setSessionState(db: Database.Database, sessionId: string, userId: string, state: SessionState, now = Date.now()) {
  db.prepare(`INSERT INTO session_second_factor (session_id, user_id, state, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (session_id) DO UPDATE SET user_id = excluded.user_id, state = excluded.state, updated_at = excluded.updated_at`).run(sessionId, userId, state, now);
}

export const forgetSession = (db: Database.Database, sessionId: string) => db.prepare("DELETE FROM session_second_factor WHERE session_id = ?").run(sessionId);

// Rows of sessions that are gone (signed out, expired, deleted by SQL) and stale failure counters.
export function cleanupSecondFactor(db: Database.Database, now = Date.now()) {
  db.prepare(`DELETE FROM session_second_factor WHERE session_id NOT IN (SELECT "id" FROM "session" WHERE "expiresAt" > ?)`).run(new Date(now).toISOString());
  db.prepare("DELETE FROM second_factor_failures WHERE first_at < ? AND locked_until < ?").run(now - FAILURE_WINDOW_MS, now);
}

// --- failures and lockout ---

export const FAILURE_WINDOW_MS = 15 * 60_000;
// A pending session that guesses wrong this often is revoked (sign in again through SSO).
export const MAX_SESSION_FAILURES = 5;
// Across all of a user's sessions: this many wrong codes in the window lock the user out for LOCK_MS.
export const MAX_USER_FAILURES = 10;
export const LOCK_MS = 15 * 60_000;

export function lockedUntil(db: Database.Database, key: string, now = Date.now()): number {
  const r = db.prepare("SELECT locked_until FROM second_factor_failures WHERE key = ?").get(key) as { locked_until: number } | undefined;
  return r && r.locked_until > now ? r.locked_until : 0;
}

// Counts one failure; returns the count within the current window. Reaching `max` sets locked_until.
export function recordFailure(db: Database.Database, key: string, max: number, now = Date.now()): number {
  const r = db.prepare("SELECT failures, first_at FROM second_factor_failures WHERE key = ?").get(key) as { failures: number; first_at: number } | undefined;
  const fresh = !r || now - r.first_at >= FAILURE_WINDOW_MS;
  const failures = fresh ? 1 : r!.failures + 1;
  const firstAt = fresh ? now : r!.first_at;
  db.prepare(`INSERT INTO second_factor_failures (key, failures, first_at, locked_until) VALUES (?, ?, ?, ?)
    ON CONFLICT (key) DO UPDATE SET failures = excluded.failures, first_at = excluded.first_at, locked_until = excluded.locked_until`)
    .run(key, failures, firstAt, failures >= max ? now + LOCK_MS : 0);
  return failures;
}

export const resetFailures = (db: Database.Database, key: string) => db.prepare("DELETE FROM second_factor_failures WHERE key = ?").run(key);

// --- TOTP (RFC 6238 over RFC 4226, SHA-1, the same as better-auth's twoFactor plugin) ---

export const PERIOD = 30;
export const DIGITS = 6;

// The HMAC key is the secret's UTF-8 bytes (better-auth stores a random string and uses it as is), or the decoded
// bytes of an imported "base32:<secret>".
export function totpKey(decryptedSecret: string): Buffer {
  if (decryptedSecret.startsWith("base32:")) return base32Decode(decryptedSecret.slice(7).toUpperCase());
  return Buffer.from(decryptedSecret, "utf8");
}

export function hotp(key: Buffer, counter: number, digits = DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", key).update(msg).digest();
  const offset = h[h.length - 1] & 15;
  const bin = ((h[offset] & 0x7f) << 24) | (h[offset + 1] << 16) | (h[offset + 2] << 8) | h[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

const sameText = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  // Length is not secret (always DIGITS); compare in constant time when equal.
  return x.length === y.length && timingSafeEqual(x, y);
};

// The time step a code belongs to (now - window … now + window), or null. Every step is computed and compared, so
// the time taken does not reveal which one matched. Steps at or before `lastStep` are refused (no replay).
export function matchTotp(key: Buffer, code: string, now = Date.now(), { window = 1, lastStep = -1 } = {}): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = Math.floor(now / 1000 / PERIOD);
  let found: number | null = null;
  for (let i = -window; i <= window; i++) {
    const step = current + i;
    if (sameText(hotp(key, step), code) && found === null) found = step;
  }
  return found !== null && found > lastStep ? found : null;
}

export const lastTotpStep = (db: Database.Database, userId: string) =>
  (db.prepare("SELECT last_step FROM second_factor_totp WHERE user_id = ?").get(userId) as { last_step: number } | undefined)?.last_step ?? -1;

export const saveTotpStep = (db: Database.Database, userId: string, step: number) =>
  db.prepare(`INSERT INTO second_factor_totp (user_id, last_step) VALUES (?, ?)
    ON CONFLICT (user_id) DO UPDATE SET last_step = MAX(last_step, excluded.last_step)`).run(userId, step);

// --- secrets, backup codes, otpauth URI (same formats as better-auth's twoFactor plugin) ---

const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
export const randomString = (n: number) => Array.from({ length: n }, () => ALNUM[randomInt(ALNUM.length)]).join("");

export const newTotpSecret = () => randomString(32);

// 10 codes of 10 characters as "xxxxx-xxxxx", like better-auth's generateBackupCodes.
export const newBackupCodes = (n = 10) => Array.from({ length: n }, () => randomString(10)).map((c) => `${c.slice(0, 5)}-${c.slice(5)}`);

// Index of the matching backup code, or -1. Every code is compared (constant time each).
export function matchBackupCode(codes: string[], input: string): number {
  const want = input.trim();
  let found = -1;
  for (let i = 0; i < codes.length; i++) if (sameText(codes[i], want) && found === -1) found = i;
  return found;
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32Encode(data: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s: string): Buffer {
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of s.replace(/=+$/, "")) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error("bad base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// otpauth URI as better-auth builds it (createOTP(secret).url(issuer, account)).
export function totpUri(secret: string, issuer: string, account: string): string {
  const params = new URLSearchParams({ secret: base32Encode(Buffer.from(secret, "utf8")), issuer });
  params.set("digits", String(DIGITS));
  params.set("period", String(PERIOD));
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?${params.toString()}`;
}

// Where to go after the second factor: a path on this site only.
export function safeNext(next: unknown): string {
  if (typeof next !== "string" || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\") || /[\u0000-\u001f]/.test(next) || next.length > 2000) return "/";
  if (next.startsWith("/2fa") || next.startsWith("/api/")) return "/";
  return next;
}
