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
    locked_until INTEGER NOT NULL DEFAULT 0,
    locks INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS second_factor_totp (
    user_id TEXT PRIMARY KEY,
    last_step INTEGER NOT NULL
  )`);
  // Databases from the first version of this branch lack the lock counter.
  const cols = db.prepare("PRAGMA table_info(second_factor_failures)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "locks")) db.exec("ALTER TABLE second_factor_failures ADD COLUMN locks INTEGER NOT NULL DEFAULT 0");
}

// Which state a session gets when better-auth creates it, from the endpoint that creates it.
//   OIDC callback                          → pending
//   password sign-in, better-auth 2FA step → exempt (the password path is unchanged)
//   anything else (rotations by other endpoints, scripts) → null: the caller copies the state of the session the
//   request was made with, or leaves no row (= pending for OIDC users).
export function classifyNewSession(path: string | undefined, params: Record<string, unknown> | undefined, providerId: string): SessionState | null {
  if (path === "/callback/:id" || path === "/oauth2/callback/:providerId") return params?.id === providerId || params?.providerId === providerId ? "pending" : null;
  // /sign-in/social creates a session only on its id_token branch, i.e. an SSO sign-in without the redirect.
  if (path === "/sign-in/social") return "pending";
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
  // Counters without locks go when their window is over; lock history (for growing locks) after LOCK_MEMORY_MS.
  db.prepare("DELETE FROM second_factor_failures WHERE first_at < ? AND locked_until < ? AND (locks = 0 OR locked_until < ?)").run(now - FAILURE_WINDOW_MS, now, now - LOCK_MEMORY_MS);
}

// --- attempts and lockout ---
//
// Attempts are counted BEFORE the code is checked, in one synchronous transaction (beginAttempt): concurrent requests
// cannot all slip past the limits while earlier ones are still being evaluated. A success resets both counters.

export const FAILURE_WINDOW_MS = 15 * 60_000;
// A pending session gets this many attempts; the last one failing revokes it (sign in again through SSO).
export const MAX_SESSION_FAILURES = 5;
// Across all of a user's sessions: this many attempts without success in the window lock the user.
export const MAX_USER_FAILURES = 10;
// The first lock lasts LOCK_MS, every further one twice as long (up to MAX_LOCK_MS); after HARD_LOCK_AFTER locks the
// user stays locked until an admin clears it (docs/razum/g017-oidc-totp.md). Locks are remembered LOCK_MEMORY_MS.
export const LOCK_MS = 15 * 60_000;
export const MAX_LOCK_MS = 24 * 3600_000;
export const HARD_LOCK_AFTER = 5;
export const HARD_LOCKED = Number.MAX_SAFE_INTEGER;
export const LOCK_MEMORY_MS = 7 * 24 * 3600_000;

export const lockDuration = (previousLocks: number) => Math.min(LOCK_MS * 2 ** previousLocks, MAX_LOCK_MS);

export function lockedUntil(db: Database.Database, key: string, now = Date.now()): number {
  const r = db.prepare("SELECT locked_until FROM second_factor_failures WHERE key = ?").get(key) as { locked_until: number } | undefined;
  return r && r.locked_until > now ? r.locked_until : 0;
}

export type Counted = { count: number; lockedUntil: number; locks: number; newLock: boolean };

// One more attempt for `key` within the window. Reaching `max` locks the key (growing, then hard).
export function countAttempt(db: Database.Database, key: string, max: number, now = Date.now()): Counted {
  const r = db.prepare("SELECT failures, first_at, locks FROM second_factor_failures WHERE key = ?").get(key) as { failures: number; first_at: number; locks: number } | undefined;
  const fresh = !r || now - r.first_at >= FAILURE_WINDOW_MS;
  const count = fresh ? 1 : r!.failures + 1;
  const firstAt = fresh ? now : r!.first_at;
  const prevLocks = r?.locks ?? 0;
  const newLock = count === max;
  const locks = newLock ? prevLocks + 1 : prevLocks;
  const until = newLock ? (locks >= HARD_LOCK_AFTER ? HARD_LOCKED : now + lockDuration(prevLocks)) : 0;
  db.prepare(`INSERT INTO second_factor_failures (key, failures, first_at, locked_until, locks) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (key) DO UPDATE SET failures = excluded.failures, first_at = excluded.first_at, locked_until = excluded.locked_until, locks = excluded.locks`)
    .run(key, count, firstAt, until, locks);
  return { count, lockedUntil: until, locks, newLock };
}

export const resetFailures = (db: Database.Database, key: string) => db.prepare("DELETE FROM second_factor_failures WHERE key = ?").run(key);

export type Attempt = { ok: true; session: Counted; user: Counted } | { ok: false; reason: "locked"; until: number } | { ok: false; reason: "revoked" };

// Before any await: refuse when the user is locked or the session has used its attempts, otherwise count this attempt
// for both. Synchronous (better-sqlite3), so no other request runs in between.
// While the user is locked (soft or hard), TOTP codes are refused, but backup codes still work under their own
// counter: MAX_BACKUP_WHILE_LOCKED attempts per BACKUP_WINDOW_MS per user, so the owner can recover without an admin.
export const MAX_BACKUP_WHILE_LOCKED = 5;
export const BACKUP_WINDOW_MS = 3600_000;
export const backupKeyOf = (userKey: string) => `b${userKey}`;

function countBackupAttempt(db: Database.Database, key: string, now: number): number {
  const r = db.prepare("SELECT failures, first_at FROM second_factor_failures WHERE key = ?").get(key) as { failures: number; first_at: number } | undefined;
  const fresh = !r || now - r.first_at >= BACKUP_WINDOW_MS;
  const count = fresh ? 1 : r!.failures + 1;
  db.prepare(`INSERT INTO second_factor_failures (key, failures, first_at, locked_until, locks) VALUES (?, ?, ?, 0, 0)
    ON CONFLICT (key) DO UPDATE SET failures = excluded.failures, first_at = excluded.first_at`).run(key, count, fresh ? now : r!.first_at);
  return count;
}

const NOT_COUNTED: Counted = { count: 0, lockedUntil: 0, locks: 0, newLock: false };

export function beginAttempt(db: Database.Database, userKey: string, sessionKey: string, now = Date.now(), { backupCode = false } = {}): Attempt {
  return db.transaction((): Attempt => {
    const until = lockedUntil(db, userKey, now);
    if (until && !backupCode) return { ok: false, reason: "locked", until };
    const session = countAttempt(db, sessionKey, MAX_SESSION_FAILURES, now);
    if (session.count > MAX_SESSION_FAILURES) return { ok: false, reason: "revoked" };
    if (until) {
      // Locked, backup code: only the backup counter, the lock itself is untouched (a success clears it).
      if (countBackupAttempt(db, backupKeyOf(userKey), now) > MAX_BACKUP_WHILE_LOCKED) return { ok: false, reason: "locked", until };
      return { ok: true, session, user: NOT_COUNTED };
    }
    const user = countAttempt(db, userKey, MAX_USER_FAILURES, now);
    return { ok: true, session, user };
  })();
}

// The session row itself (better-auth's), removed synchronously: a revoked session can never be upgraded later.
export function revokeSession(db: Database.Database, sessionId: string) {
  db.prepare(`DELETE FROM "session" WHERE "id" = ?`).run(sessionId);
  forgetSession(db, sessionId);
}

export type Consume = {
  sessionId: string;
  userId: string;
  userKey: string;
  sessionKey: string;
  // The TOTP step that matched (replay protection), or null for a backup code.
  step: number | null;
  // Backup code used: the row and its encrypted list before and after (compare-and-swap).
  backup: { rowId: string; before: string; after: string } | null;
  // First enrolment: the row and the encrypted secret the code was checked against.
  confirm: { rowId: string; secret: string } | null;
};
export type ConsumeResult = "ok" | "gone" | "not-pending" | "replay" | "changed";

class Abort extends Error {
  constructor(readonly result: ConsumeResult) {
    super(result);
  }
}

// After a correct code, all at once or not at all: the session must still exist and still be pending; the TOTP step
// must be newer than any used before; the backup code must still be in the list; the enrolment must still be the one
// the code was checked against; then the pending session is deleted (its replacement is created by the caller) and the
// counters reset. Two concurrent successes: exactly one gets "ok".
export function consumeSuccess(db: Database.Database, c: Consume, providerId: string, now = Date.now()): ConsumeResult {
  try {
    db.transaction(() => {
      const live = db.prepare(`SELECT 1 FROM "session" WHERE "id" = ? AND "userId" = ? AND "expiresAt" > ?`).get(c.sessionId, c.userId, new Date(now).toISOString());
      if (!live) throw new Abort("gone");
      if (!isPending(db, c.sessionId, c.userId, providerId)) throw new Abort("not-pending");
      if (c.step !== null) {
        const r = db.prepare(`INSERT INTO second_factor_totp (user_id, last_step) VALUES (?, ?)
          ON CONFLICT (user_id) DO UPDATE SET last_step = excluded.last_step WHERE excluded.last_step > second_factor_totp.last_step`).run(c.userId, c.step);
        if (r.changes !== 1) throw new Abort("replay");
      }
      if (c.backup) {
        const r = db.prepare(`UPDATE "twoFactor" SET "backupCodes" = ? WHERE "id" = ? AND "backupCodes" = ?`).run(c.backup.after, c.backup.rowId, c.backup.before);
        if (r.changes !== 1) throw new Abort("replay");
      }
      if (c.confirm) {
        const r = db.prepare(`UPDATE "twoFactor" SET "verified" = 1 WHERE "id" = ? AND "secret" = ? AND "verified" = 0`).run(c.confirm.rowId, c.confirm.secret);
        if (r.changes !== 1) throw new Abort("changed");
        // The user's flag in the same transaction: never a confirmed row with twoFactorEnabled still false.
        if (db.prepare(`UPDATE "user" SET "twoFactorEnabled" = 1 WHERE "id" = ?`).run(c.userId).changes !== 1) throw new Abort("gone");
      }
      if (db.prepare(`DELETE FROM "session" WHERE "id" = ?`).run(c.sessionId).changes !== 1) throw new Abort("gone");
      forgetSession(db, c.sessionId);
      resetFailures(db, c.sessionKey);
      resetFailures(db, c.userKey);
      resetFailures(db, backupKeyOf(c.userKey));
    })();
    return "ok";
  } catch (e) {
    if (e instanceof Abort) return e.result;
    throw e;
  }
}

// First enrolment, atomically: never touches a confirmed (or legacy, verified NULL) row; replaces an unconfirmed one
// with the new secret and backup codes; at most one row per user even with concurrent calls.
export function storeEnrolment(db: Database.Database, userId: string, encSecret: string, encBackupCodes: string, newId: string): "stored" | "enrolled" {
  return db.transaction((): "stored" | "enrolled" => {
    const rows = db.prepare(`SELECT "id", "verified" FROM "twoFactor" WHERE "userId" = ?`).all(userId) as { id: string; verified: number | null }[];
    if (rows.some((r) => r.verified === null || r.verified !== 0)) return "enrolled";
    if (rows.length) db.prepare(`UPDATE "twoFactor" SET "secret" = ?, "backupCodes" = ? WHERE "userId" = ? AND "verified" = 0`).run(encSecret, encBackupCodes, userId);
    else db.prepare(`INSERT INTO "twoFactor" ("id", "secret", "backupCodes", "userId", "verified", "failedVerificationCount") VALUES (?, ?, ?, ?, 0, 0)`).run(newId, encSecret, encBackupCodes, userId);
    return "stored";
  })();
}

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

// What /2fa does for a request: no session → login; nothing pending → straight to the (sanitised) target; else the form.
export function secondFactorPageAction(st: { signedIn: boolean; pending: boolean } | null | undefined, rawNext: unknown): { redirect: string } | { render: true; next: string } {
  const next = safeNext(rawNext);
  if (!st?.signedIn) return { redirect: "/login" };
  if (!st.pending) return { redirect: next };
  return { render: true, next };
}

// A session created by another endpoint in a request that came with a verified/exempt session inherits that state,
// but only for the SAME user: a request authenticated as A that ends up signing in B gives B nothing.
export function inheritedState(prev: { userId: string; state: SessionState | null } | undefined, newUserId: string): SessionState | null {
  if (!prev || prev.userId !== newUserId) return null;
  return prev.state === "verified" || prev.state === "exempt" ? prev.state : null;
}
