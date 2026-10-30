// Second factor after an OIDC login (OIDC_REQUIRE_TOTP, on by default with OIDC): better-auth's twoFactor plugin only
// guards email/password sign-in; a session from the OIDC callback would otherwise be complete. This plugin:
//
// - marks the sessions the OIDC callback creates "pending" (session hooks below; rules in lib/second-factor-core.ts);
// - gates EVERY better-auth endpoint, including get-session: a pending session gets 403 except on sign-out, sign-in
//   and the /second-factor/* endpoints. All of Paddock's session checks (pages, API routes, requireAdmin, requireUser,
//   the WS bridge in server.ts) go through auth.api.getSession, so a pending session is no session anywhere;
// - /second-factor/verify checks a TOTP code (or a backup code) against better-auth's own twoFactor row, or confirms a
//   first enrolment made by /second-factor/enrol, stored exactly as better-auth stores it; then it replaces the session
//   with a new one (new token) marked "verified";
// - refuses /two-factor/disable for users with an OIDC account (their next login would only enrol again).
import type Database from "better-sqlite3";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, createAuthMiddleware } from "better-auth/api";
import { deleteSessionCookie, setSessionCookie } from "better-auth/cookies";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import {
  allowedWhilePending, beginAttempt, classifyNewSession, cleanupSecondFactor, consumeSuccess, hasOidcAccount, isPending, lastTotpStep, matchBackupCode,
  matchTotp, MAX_SESSION_FAILURES, newBackupCodes, newTotpSecret, randomString, revokeSession, sessionState, setSessionState,
  setupSecondFactorTables, storeEnrolment, inheritedState, totpKey, totpUri, forgetSession, HARD_LOCKED, type SessionState,
} from "./second-factor-core";

type TwoFactorRow = { id: string; secret: string; backupCodes: string; userId: string; verified?: boolean | number | null };
type Ctx = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

const ISSUER = "Paddock";
const CLEANUP_EVERY_MS = 10 * 60_000;

const refuse = (status: "FORBIDDEN" | "UNAUTHORIZED" | "BAD_REQUEST" | "CONFLICT" | "TOO_MANY_REQUESTS", code: string, message: string) => new APIError(status, { code, message });

// The state of the session a request came with, recorded by the gate and keyed by the request's Headers object (the
// same object better-auth hands to its database hooks). A session that another endpoint creates for the same user in
// that request (better-auth rotates sessions on password change etc.) inherits it.
const requestSessions = new WeakMap<object, { userId: string; state: SessionState | null }>();

// One line per lock, for the admin; no codes, no secrets.
function logLock(userId: string, c: { lockedUntil: number; locks: number } | null) {
  if (!c) return;
  const hard = c.lockedUntil === HARD_LOCKED;
  console.warn(JSON.stringify({ event: "second-factor-lock", user: userId, locks: c.locks, hard, until: hard ? null : new Date(c.lockedUntil).toISOString() }));
}

export function secondFactorPlugin(db: Database.Database, providerId: string) {
  let lastCleanup = 0;
  const tables = () => setupSecondFactorTables(db);

  // The session in the request's cookie (signed), or null. Expired sessions count as none.
  async function cookieSession(ctx: Ctx) {
    const token = await ctx.getSignedCookie(ctx.context.authCookies.sessionToken.name, ctx.context.secret).catch(() => null);
    if (!token) return null;
    const found = await ctx.context.internalAdapter.findSession(token);
    // Expiry checked here, not left to the adapter: an expired session is no session, pending or not.
    if (!found || !(new Date(found.session.expiresAt).getTime() > Date.now())) return null;
    return found;
  }

  const twoFactorRow = (ctx: Ctx, userId: string) =>
    ctx.context.adapter.findOne<TwoFactorRow>({ model: "twoFactor", where: [{ field: "userId", value: userId }] });
  const enrolled = (row: TwoFactorRow | null) => !!row && row.verified !== false && row.verified !== 0;
  const decrypt = (ctx: Ctx, data: string) => symmetricDecrypt({ key: ctx.context.secretConfig, data });
  const encrypt = (ctx: Ctx, data: string) => symmetricEncrypt({ key: ctx.context.secretConfig, data });

  // Every better-auth endpoint, for HTTP and for auth.api.* calls alike.
  const gate = createAuthMiddleware(async (ctx) => {
    const found = await cookieSession(ctx);
    if (!found) return;
    tables();
    if (Date.now() - lastCleanup > CLEANUP_EVERY_MS) {
      lastCleanup = Date.now();
      cleanupSecondFactor(db);
    }
    const { session, user } = found;
    if (ctx.headers) requestSessions.set(ctx.headers, { userId: user.id, state: sessionState(db, session.id, user.id, providerId) });
    if (isPending(db, session.id, user.id, providerId) && !allowedWhilePending(ctx.path)) throw refuse("FORBIDDEN", "SECOND_FACTOR_REQUIRED", "Second factor required");
    // For any session of a user with an SSO account: no unlinking of accounts at all (better-auth's /unlink-account takes
    // only an accountId, so the SSO account cannot be singled out from the body) and no disabling of TOTP.
    if (ctx.path === "/unlink-account" && hasOidcAccount(db, user.id, providerId))
      throw refuse("FORBIDDEN", "SSO_ACCOUNT_REQUIRED", "Accounts of single sign-on users cannot be unlinked while two-factor authentication is required for them");
    if (ctx.path === "/two-factor/disable" && hasOidcAccount(db, user.id, providerId))
      throw refuse("FORBIDDEN", "TOTP_REQUIRED_FOR_SSO", "Two-factor authentication is required for single sign-on users and cannot be disabled");
  });

  const status = createAuthEndpoint("/second-factor/status", { method: "GET" }, async (ctx) => {
    const found = await cookieSession(ctx);
    if (!found) return ctx.json({ signedIn: false, pending: false, enrolled: false });
    tables();
    const row = await twoFactorRow(ctx, found.user.id);
    return ctx.json({ signedIn: true, pending: isPending(db, found.session.id, found.user.id, providerId), enrolled: enrolled(row), email: found.user.email });
  });

  // First enrolment of a pending session's user: a NEW secret and new backup codes on every call (an unconfirmed
  // enrolment of another session is replaced, never shown); a confirmed one is never touched or revealed.
  const enrol = createAuthEndpoint("/second-factor/enrol", { method: "POST" }, async (ctx) => {
    const found = await cookieSession(ctx);
    if (!found) throw refuse("UNAUTHORIZED", "NO_SESSION", "Sign in first");
    tables();
    if (!isPending(db, found.session.id, found.user.id, providerId)) throw refuse("BAD_REQUEST", "NOT_PENDING", "No second factor is pending for this session");
    const secret = newTotpSecret();
    const stored = storeEnrolment(db, found.user.id, await encrypt(ctx, secret), await encrypt(ctx, JSON.stringify(newBackupCodes())), randomString(32));
    if (stored === "enrolled") throw refuse("CONFLICT", "ALREADY_ENROLLED", "An authenticator app is already set up; enter its code");
    const uri = totpUri(secret, ISSUER, found.user.email);
    return ctx.json({ totpURI: uri, secret: new URL(uri).searchParams.get("secret") });
  });

  const verify = createAuthEndpoint("/second-factor/verify", { method: "POST" }, async (ctx) => {
    const found = await cookieSession(ctx);
    if (!found) throw refuse("UNAUTHORIZED", "NO_SESSION", "Sign in first");
    tables();
    const { session, user } = found;
    if (!isPending(db, session.id, user.id, providerId)) throw refuse("BAD_REQUEST", "NOT_PENDING", "No second factor is pending for this session");
    const userKey = `u:${user.id}`;
    const sessionKey = `s:${session.id}`;
    const raw = (ctx.body as { code?: unknown } | undefined)?.code;
    const code = typeof raw === "string" ? raw.replace(/\s+/g, "").slice(0, 64) : "";
    const totpFormat = /^\d{6}$/.test(code);
    // Counted before anything is awaited (see beginAttempt): concurrent guesses cannot exceed the limits. A locked user
    // may still try backup codes (own counter).
    const attempt = beginAttempt(db, userKey, sessionKey, Date.now(), { backupCode: !totpFormat && code.length > 0 });
    if (!attempt.ok && attempt.reason === "locked") throw (attempt.until === HARD_LOCKED ? refuse("TOO_MANY_REQUESTS", "LOCKED_HARD", "Locked; ask an admin") : refuse("TOO_MANY_REQUESTS", "LOCKED", "Too many wrong codes; try again later"));
    if (!attempt.ok) {
      revokeSession(db, session.id);
      deleteSessionCookie(ctx);
      throw refuse("UNAUTHORIZED", "SESSION_REVOKED", "Too many wrong codes; sign in again");
    }

    const row = await twoFactorRow(ctx, user.id);
    if (!row) throw refuse("BAD_REQUEST", "NOT_ENROLLED", "Set up an authenticator app first");
    const confirming = !enrolled(row);
    let step: number | null = null;
    let backup: { rowId: string; before: string; after: string } | null = null;
    if (totpFormat) {
      step = matchTotp(totpKey(await decrypt(ctx, row.secret)), code, Date.now(), { lastStep: lastTotpStep(db, user.id) });
    } else if (!confirming && code) {
      const codes = JSON.parse(await decrypt(ctx, row.backupCodes)) as string[];
      const i = matchBackupCode(codes, code);
      if (i >= 0) backup = { rowId: row.id, before: row.backupCodes, after: await encrypt(ctx, JSON.stringify(codes.filter((_, j) => j !== i))) };
    }

    // All checks and the consumption of the session, the step or the backup code happen in one transaction.
    const result = step !== null || backup
      ? consumeSuccess(db, { sessionId: session.id, userId: user.id, userKey, sessionKey, step, backup, confirm: confirming ? { rowId: row.id, secret: row.secret } : null }, providerId)
      : "wrong";
    if (result !== "ok") {
      if (result === "gone") {
        deleteSessionCookie(ctx);
        throw refuse("UNAUTHORIZED", "SESSION_REVOKED", "This sign-in is no longer valid; sign in again");
      }
      if (attempt.session.count >= MAX_SESSION_FAILURES) {
        // The last attempt of this session failed: it is gone, the person signs in through SSO again.
        revokeSession(db, session.id);
        deleteSessionCookie(ctx);
        logLock(user.id, attempt.user.newLock ? attempt.user : null);
        throw refuse("UNAUTHORIZED", "SESSION_REVOKED", "Too many wrong codes; sign in again");
      }
      if (attempt.user.newLock) {
        logLock(user.id, attempt.user);
        throw (attempt.user.lockedUntil === HARD_LOCKED ? refuse("TOO_MANY_REQUESTS", "LOCKED_HARD", "Locked; ask an admin") : refuse("TOO_MANY_REQUESTS", "LOCKED", "Too many wrong codes; try again later"));
      }
      throw refuse("UNAUTHORIZED", "INVALID_CODE", "Invalid code");
    }

    let backupCodes: string[] | undefined;
    let current = user;
    if (confirming) {
      // twoFactorEnabled was set inside consumeSuccess, with the row.
      current = { ...user, twoFactorEnabled: true };
      backupCodes = JSON.parse(await decrypt(ctx, row.backupCodes));
    }
    // The pending session is already deleted (consumeSuccess); a new one (new token) replaces it.
    const fresh = await ctx.context.internalAdapter.createSession(user.id, false, session);
    setSessionState(db, fresh.id, user.id, "verified");
    await setSessionCookie(ctx, { session: fresh, user: current });
    forgetSession(db, session.id);
    return ctx.json({ ok: true, ...(backupCodes ? { backupCodes } : {}) });
  });

  return {
    id: "paddock-second-factor",
    endpoints: { secondFactorStatus: status, secondFactorEnrol: enrol, secondFactorVerify: verify },
    hooks: { before: [{ matcher: () => true, handler: gate }] },
    rateLimit: [{ pathMatcher: (path: string) => path.startsWith("/second-factor/"), window: 60, max: 20 }],
  } satisfies BetterAuthPlugin;
}

// better-auth's database hooks for sessions (passed in lib/auth.ts): the state of every new session, and cleanup.
export function secondFactorSessionHooks(db: Database.Database, providerId: string) {
  return {
    session: {
      create: {
        after: async (session: { id: string; userId: string }, ctx: unknown) => {
          setupSecondFactorTables(db);
          const c = ctx as { path?: string; params?: Record<string, unknown>; headers?: object } | null;
          let state: SessionState | null = classifyNewSession(c?.path, c?.params, providerId);
          // A session rotated by another endpoint keeps the state of the one the request came with (same user only);
          // the gate made sure that one was not pending.
          const prev = c?.headers ? requestSessions.get(c.headers) : undefined;
          if (state === null) state = inheritedState(prev, session.userId);
          // Never overwrite: /second-factor/verify sets "verified" itself.
          if (state) db.prepare("INSERT OR IGNORE INTO session_second_factor (session_id, user_id, state, updated_at) VALUES (?, ?, ?, ?)").run(session.id, session.userId, state, Date.now());
        },
      },
      delete: {
        after: async (session: { id: string }) => {
          setupSecondFactorTables(db);
          forgetSession(db, session.id);
        },
      },
    },
  };
}
