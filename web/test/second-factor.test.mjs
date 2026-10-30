// The pure rules of the second factor after OIDC (lib/second-factor-core.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { base32 } from "@better-auth/utils/base32";
import { readFileSync } from "node:fs";
import { createOTP } from "@better-auth/utils/otp";
import {
  allowedWhilePending, base32Decode, base32Encode, beginAttempt, classifyNewSession, cleanupSecondFactor, consumeSuccess, countAttempt, hotp, isPending, lastTotpStep, lockedUntil,
  LOCK_MS, LOCK_MEMORY_MS, lockDuration, matchBackupCode, matchTotp, MAX_LOCK_MS, MAX_SESSION_FAILURES, MAX_USER_FAILURES, HARD_LOCK_AFTER, HARD_LOCKED, newBackupCodes, newTotpSecret,
  PERIOD, resetFailures, revokeSession, safeNext, saveTotpStep, secondFactorPageAction, secondFactorRequired, sessionState, setSessionState, setupSecondFactorTables, storeEnrolment,
  totpKey, totpUri, FAILURE_WINDOW_MS, inheritedState, MAX_BACKUP_WHILE_LOCKED, BACKUP_WINDOW_MS, backupKeyOf,
} from "../lib/second-factor-core.ts";

function db() {
  const d = new Database(":memory:");
  d.exec(`CREATE TABLE "account" ("id" text primary key, "accountId" text, "providerId" text, "userId" text);
    CREATE TABLE "session" ("id" text primary key, "expiresAt" date not null, "token" text, "userId" text);
    CREATE TABLE "user" ("id" text primary key, "twoFactorEnabled" integer);
    CREATE TABLE "twoFactor" ("id" text not null primary key, "secret" text not null, "backupCodes" text not null, "userId" text not null, "verified" integer, "failedVerificationCount" integer, "lockedUntil" date)`);
  setupSecondFactorTables(d);
  return d;
}

test("secondFactorRequired: on with OIDC unless OIDC_REQUIRE_TOTP=0, never without OIDC", () => {
  assert.equal(secondFactorRequired(true, {}), true);
  assert.equal(secondFactorRequired(true, { OIDC_REQUIRE_TOTP: "1" }), true);
  assert.equal(secondFactorRequired(true, { OIDC_REQUIRE_TOTP: "" }), true);
  assert.equal(secondFactorRequired(true, { OIDC_REQUIRE_TOTP: "false" }), true, "only 0 switches it off");
  assert.equal(secondFactorRequired(true, { OIDC_REQUIRE_TOTP: "0" }), false);
  assert.equal(secondFactorRequired(false, {}), false);
});

test("classifyNewSession: OIDC callback pending, password paths exempt, the rest unknown", () => {
  assert.equal(classifyNewSession("/callback/:id", { id: "oidc" }, "oidc"), "pending");
  assert.equal(classifyNewSession("/oauth2/callback/:providerId", { providerId: "oidc" }, "oidc"), "pending");
  assert.equal(classifyNewSession("/callback/:id", { id: "github" }, "oidc"), null);
  for (const p of ["/sign-in/email", "/two-factor/verify-totp", "/two-factor/verify-backup-code", "/two-factor/verify-otp"]) assert.equal(classifyNewSession(p, {}, "oidc"), "exempt", p);
  assert.equal(classifyNewSession("/sign-in/social", {}, "oidc"), "pending", "the id_token branch of sign-in/social is an SSO sign-in");
  for (const p of ["/change-password", "/two-factor/enable", "/second-factor/verify", undefined, ""]) assert.equal(classifyNewSession(p, {}, "oidc"), null, String(p));
});

test("allowedWhilePending: only sign-out, sign-in and the second-factor endpoints", () => {
  for (const p of ["/sign-out", "/second-factor/status", "/second-factor/enrol", "/second-factor/verify", "/sign-in/social", "/sign-in/email", "/callback/:id", "/error", "/ok"]) assert.ok(allowedWhilePending(p), p);
  for (const p of ["/get-session", "/list-sessions", "/two-factor/disable", "/two-factor/enable", "/two-factor/verify-totp", "/change-password", "/update-user", "/revoke-sessions",
    "/link-social", "/delete-user", "/second-factor", "/second-factor/verify/x", "/sign-out/", "", undefined]) assert.ok(!allowedWhilePending(p), String(p));
});

test("sessionState / isPending: a row decides; no row = pending only for OIDC users; a row of another user is ignored", () => {
  const d = db();
  d.prepare(`INSERT INTO "account" VALUES ('a1', 'sub-1', 'oidc', 'u-oidc'), ('a2', 'u-pw', 'credential', 'u-pw')`).run();
  assert.equal(sessionState(d, "s1", "u-oidc", "oidc"), null);
  assert.equal(isPending(d, "s1", "u-oidc", "oidc"), true);
  assert.equal(sessionState(d, "s2", "u-pw", "oidc"), "exempt");
  assert.equal(isPending(d, "s2", "u-pw", "oidc"), false);
  setSessionState(d, "s1", "u-oidc", "verified");
  assert.equal(isPending(d, "s1", "u-oidc", "oidc"), false);
  setSessionState(d, "s1", "u-oidc", "pending");
  assert.equal(isPending(d, "s1", "u-oidc", "oidc"), true);
  setSessionState(d, "s3", "u-pw", "pending");
  assert.equal(isPending(d, "s3", "u-pw", "oidc"), true, "an explicit pending row counts for anyone");
  setSessionState(d, "s4", "someone-else", "verified");
  assert.equal(isPending(d, "s4", "u-oidc", "oidc"), true, "row for another user = no row");
  setSessionState(d, "s5", "u-oidc", "exempt");
  assert.equal(isPending(d, "s5", "u-oidc", "oidc"), false);
  assert.throws(() => setSessionState(d, "s6", "u-oidc", "bogus"));
});

test("cleanup drops rows of missing or expired sessions and old failure counters", () => {
  const d = db();
  const now = Date.parse("2026-10-30T12:00:00Z");
  d.prepare(`INSERT INTO "session" VALUES ('live', ?, 't1', 'u'), ('old', ?, 't2', 'u')`).run(new Date(now + 3600e3).toISOString(), new Date(now - 1000).toISOString());
  for (const s of ["live", "old", "gone"]) setSessionState(d, s, "u", "verified");
  countAttempt(d, "u:old", 10, now - FAILURE_WINDOW_MS - 1);
  countAttempt(d, "u:new", 10, now);
  // Lock history is kept for a week so locks keep growing.
  d.prepare("INSERT INTO second_factor_failures VALUES ('u:history', 1, ?, ?, 2)").run(now - 2 * FAILURE_WINDOW_MS, now - 1000);
  d.prepare("INSERT INTO second_factor_failures VALUES ('u:ancient', 1, ?, ?, 2)").run(now - LOCK_MEMORY_MS - 2 * FAILURE_WINDOW_MS, now - LOCK_MEMORY_MS - 1);
  cleanupSecondFactor(d, now);
  assert.deepEqual(d.prepare("SELECT session_id FROM session_second_factor").all().map((r) => r.session_id), ["live"]);
  assert.deepEqual(d.prepare("SELECT key FROM second_factor_failures ORDER BY key").all().map((r) => r.key), ["u:history", "u:new"]);
});

test("countAttempt: count within the window, lock at the maximum, growing locks, hard lock, reset", () => {
  const d = db();
  assert.equal(MAX_SESSION_FAILURES, 5);
  assert.equal(MAX_USER_FAILURES, 10);
  let t = 1_000_000;
  assert.deepEqual(countAttempt(d, "k", 3, t), { count: 1, lockedUntil: 0, locks: 0, newLock: false });
  assert.equal(countAttempt(d, "k", 3, t).count, 2);
  assert.equal(lockedUntil(d, "k", t), 0);
  assert.deepEqual(countAttempt(d, "k", 3, t), { count: 3, lockedUntil: t + LOCK_MS, locks: 1, newLock: true });
  assert.equal(lockedUntil(d, "k", t), t + LOCK_MS);
  assert.equal(lockedUntil(d, "k", t + LOCK_MS), 0);
  // The next window starts over, but the second lock lasts twice as long, the third four times…
  const durations = [LOCK_MS];
  for (let lock = 2; lock <= HARD_LOCK_AFTER; lock++) {
    t += FAILURE_WINDOW_MS + MAX_LOCK_MS;
    assert.equal(countAttempt(d, "k", 3, t).count, 1, "a new window starts over");
    countAttempt(d, "k", 3, t);
    const c = countAttempt(d, "k", 3, t);
    assert.equal(c.locks, lock);
    durations.push(c.lockedUntil === HARD_LOCKED ? "hard" : c.lockedUntil - t);
  }
  assert.deepEqual(durations, [LOCK_MS, 2 * LOCK_MS, 4 * LOCK_MS, 8 * LOCK_MS, "hard"]);
  assert.equal(HARD_LOCK_AFTER, 5);
  assert.equal(lockedUntil(d, "k", t + 365 * 24 * 3600_000), HARD_LOCKED, "a hard lock does not expire");
  assert.equal(lockDuration(0), LOCK_MS);
  assert.equal(lockDuration(20), MAX_LOCK_MS);
  resetFailures(d, "k");
  assert.equal(lockedUntil(d, "k", t), 0);
  assert.equal(countAttempt(d, "k", 3, t).locks, 0);
});

test("beginAttempt: user lock first, then at most MAX_SESSION_FAILURES attempts per session, both counted up front", () => {
  const d = db();
  const now = 5_000_000;
  for (let i = 1; i <= 5; i++) {
    const a = beginAttempt(d, "u:1", "s:1", now);
    assert.equal(a.ok, true);
    assert.equal(a.session.count, i);
    assert.equal(a.user.count, i);
  }
  assert.deepEqual(beginAttempt(d, "u:1", "s:1", now), { ok: false, reason: "revoked" });
  assert.equal(d.prepare("SELECT failures FROM second_factor_failures WHERE key = 'u:1'").get().failures, 5, "refused attempts do not count for the user");
  for (let i = 1; i <= 5; i++) assert.equal(beginAttempt(d, "u:1", "s:2", now).ok, true);
  const locked = beginAttempt(d, "u:1", "s:3", now);
  assert.equal(locked.ok, false);
  assert.equal(locked.reason, "locked");
  assert.equal(locked.until, now + LOCK_MS);
  assert.equal(d.prepare("SELECT failures FROM second_factor_failures WHERE key = 's:3'").get(), undefined, "a locked user's attempt counts nowhere");
});

function liveSession(d, id, userId, now) {
  d.prepare(`INSERT INTO "session" VALUES (?, ?, ?, ?)`).run(id, new Date(now + 3600e3).toISOString(), "tok-" + id, userId);
  setSessionState(d, id, userId, "pending");
}

test("consumeSuccess: one winner, nothing half-done", () => {
  const d = db();
  const now = 7_000_000_000;
  const base = (id) => ({ sessionId: id, userId: "u", userKey: "u:u", sessionKey: `s:${id}`, step: null, backup: null, confirm: null });
  liveSession(d, "a", "u", now);
  countAttempt(d, "u:u", 10, now);
  countAttempt(d, "s:a", 5, now);
  assert.equal(consumeSuccess(d, { ...base("a"), step: 100 }, "oidc", now), "ok");
  assert.equal(d.prepare(`SELECT 1 FROM "session" WHERE "id" = 'a'`).get(), undefined, "the pending session is deleted");
  assert.equal(d.prepare("SELECT 1 FROM session_second_factor WHERE session_id = 'a'").get(), undefined);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM second_factor_failures").get().n, 0, "counters reset");
  assert.equal(lastTotpStep(d, "u"), 100);
  // The same step (or an older one) again: replay, and the session stays as it was.
  liveSession(d, "b", "u", now);
  assert.equal(consumeSuccess(d, { ...base("b"), step: 100 }, "oidc", now), "replay");
  assert.equal(consumeSuccess(d, { ...base("b"), step: 99 }, "oidc", now), "replay");
  assert.ok(d.prepare(`SELECT 1 FROM "session" WHERE "id" = 'b'`).get());
  // A revoked / missing / expired session cannot be upgraded.
  assert.equal(consumeSuccess(d, { ...base("missing"), step: 200 }, "oidc", now), "gone");
  d.prepare(`INSERT INTO "session" VALUES ('old', ?, 't', 'u')`).run(new Date(now - 1).toISOString());
  setSessionState(d, "old", "u", "pending");
  assert.equal(consumeSuccess(d, { ...base("old"), step: 201 }, "oidc", now), "gone");
  assert.equal(lastTotpStep(d, "u"), 100, "nothing was written by the failed attempts");
  // Not pending (already verified): refused.
  setSessionState(d, "b", "u", "verified");
  assert.equal(consumeSuccess(d, { ...base("b"), step: 300 }, "oidc", now), "not-pending");
  setSessionState(d, "b", "u", "pending");
  // Backup codes: compare-and-swap on the stored list; a step is rolled back when the backup part fails.
  d.prepare(`INSERT INTO "twoFactor" VALUES ('tf', 'enc-secret', 'list-v1', 'u', 1, 0, NULL)`).run();
  assert.equal(consumeSuccess(d, { ...base("b"), backup: { rowId: "tf", before: "list-v0", after: "list-v2" } }, "oidc", now), "replay");
  assert.equal(consumeSuccess(d, { ...base("b"), step: 400, backup: { rowId: "tf", before: "stale", after: "x" } }, "oidc", now), "replay");
  assert.equal(lastTotpStep(d, "u"), 100, "rolled back");
  assert.equal(consumeSuccess(d, { ...base("b"), backup: { rowId: "tf", before: "list-v1", after: "list-v2" } }, "oidc", now), "ok");
  assert.equal(d.prepare(`SELECT "backupCodes" b FROM "twoFactor"`).get().b, "list-v2");
  // First enrolment: only the unconfirmed row with the secret that was checked; the user's flag in the same transaction.
  d.prepare(`INSERT INTO "twoFactor" VALUES ('tf2', 'enc-new', 'codes', 'v', 0, 0, NULL)`).run();
  liveSession(d, "c", "v", now);
  const cv = { ...base("c"), userId: "v", userKey: "u:v", step: 500 };
  assert.equal(consumeSuccess(d, { ...cv, confirm: { rowId: "tf2", secret: "enc-other" } }, "oidc", now), "changed");
  assert.equal(lastTotpStep(d, "v"), -1);
  // The flag cannot be set (no user row): everything rolls back, the row is not left confirmed.
  assert.equal(consumeSuccess(d, { ...cv, confirm: { rowId: "tf2", secret: "enc-new" } }, "oidc", now), "gone");
  assert.equal(d.prepare(`SELECT "verified" v FROM "twoFactor" WHERE "id" = 'tf2'`).get().v, 0);
  assert.equal(lastTotpStep(d, "v"), -1);
  assert.ok(d.prepare(`SELECT 1 FROM "session" WHERE "id" = 'c'`).get());
  d.prepare(`INSERT INTO "user" VALUES ('v', 0)`).run();
  assert.equal(consumeSuccess(d, { ...cv, confirm: { rowId: "tf2", secret: "enc-new" } }, "oidc", now), "ok");
  assert.equal(d.prepare(`SELECT "verified" v FROM "twoFactor" WHERE "id" = 'tf2'`).get().v, 1);
  assert.equal(d.prepare(`SELECT "twoFactorEnabled" f FROM "user" WHERE "id" = 'v'`).get().f, 1);
});

test("revokeSession removes the session row and its state at once", () => {
  const d = db();
  liveSession(d, "r", "u", Date.now());
  revokeSession(d, "r");
  assert.equal(d.prepare(`SELECT 1 FROM "session" WHERE "id" = 'r'`).get(), undefined);
  assert.equal(d.prepare("SELECT 1 FROM session_second_factor WHERE session_id = 'r'").get(), undefined);
});

test("storeEnrolment: one row per user, replaces only an unconfirmed one, never touches a confirmed or legacy (NULL) one", () => {
  const d = db();
  assert.equal(storeEnrolment(d, "u", "s1", "b1", "id1"), "stored");
  assert.equal(storeEnrolment(d, "u", "s2", "b2", "id2"), "stored");
  assert.deepEqual(d.prepare(`SELECT "id", "secret", "backupCodes", "verified" FROM "twoFactor" WHERE "userId" = 'u'`).all(), [{ id: "id1", secret: "s2", backupCodes: "b2", verified: 0 }]);
  d.prepare(`UPDATE "twoFactor" SET "verified" = 1`).run();
  assert.equal(storeEnrolment(d, "u", "s3", "b3", "id3"), "enrolled");
  d.prepare(`UPDATE "twoFactor" SET "verified" = NULL`).run();
  assert.equal(storeEnrolment(d, "u", "s3", "b3", "id3"), "enrolled", "better-auth treats verified NULL as set up");
  assert.equal(d.prepare(`SELECT "secret" s FROM "twoFactor"`).get().s, "s2");
});

test("secondFactorPageAction: login, the sanitised target, or the form", () => {
  assert.deepEqual(secondFactorPageAction(null, "/x"), { redirect: "/login" });
  assert.deepEqual(secondFactorPageAction({ signedIn: false, pending: false }, "/x"), { redirect: "/login" });
  assert.deepEqual(secondFactorPageAction({ signedIn: true, pending: false }, "/?chat=1"), { redirect: "/?chat=1" });
  for (const bad of ["//evil.example", "https://evil.example", "/\\evil.example", "/\u0007x", "/a\nb"]) {
    assert.deepEqual(secondFactorPageAction({ signedIn: true, pending: false }, bad), { redirect: "/" }, bad);
    assert.deepEqual(secondFactorPageAction({ signedIn: true, pending: true }, bad), { render: true, next: "/" }, bad);
  }
  assert.deepEqual(secondFactorPageAction({ signedIn: true, pending: true }, "/?chat=1"), { render: true, next: "/?chat=1" });
  // The page uses exactly this.
  const page = readFileSync(new URL("../app/2fa/page.tsx", import.meta.url), "utf8");
  assert.match(page, /const action = secondFactorPageAction\(st, \(await searchParams\)\.next\);/);
  assert.match(page, /if \("redirect" in action\) redirect\(action\.redirect\);/);
  assert.match(page, /next=\{action\.next\}/);
});

test("secrets and backup codes come from node:crypto, not Math.random", () => {
  const src = readFileSync(new URL("../lib/second-factor-core.ts", import.meta.url), "utf8");
  assert.match(src, /import \{[^}]*\brandomInt\b[^}]*\} from "node:crypto";/);
  assert.match(src, /ALNUM\[randomInt\(ALNUM\.length\)\]/);
  assert.doesNotMatch(src.replace(/\/\/.*$/gm, ""), /Math\.random/);
});

test("hotp: RFC 4226 / RFC 6238 test vectors and better-auth's implementation", async () => {
  const key = Buffer.from("12345678901234567890");
  const rfc4226 = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
  rfc4226.forEach((want, i) => assert.equal(hotp(key, i), want, `counter ${i}`));
  assert.equal(hotp(key, 1, 8), "94287082");
  assert.equal(hotp(key, Math.floor(1111111109 / 30), 8), "07081804");
  const secret = newTotpSecret();
  assert.match(secret, /^[A-Za-z0-9]{32}$/);
  const otp = createOTP(secret, { digits: 6, period: 30 });
  for (const c of [0, 1, 56_000_000, 2 ** 31 + 5]) assert.equal(hotp(totpKey(secret), c), await otp.hotp(c));
});

test("matchTotp: window of ±1 step, constant shape, replay refused", () => {
  const key = Buffer.from("12345678901234567890");
  const now = 1_793_000_000_000;
  const step = Math.floor(now / 1000 / PERIOD);
  assert.equal(PERIOD, 30);
  assert.equal(matchTotp(key, hotp(key, step), now), step);
  assert.equal(matchTotp(key, hotp(key, step - 1), now), step - 1);
  assert.equal(matchTotp(key, hotp(key, step + 1), now), step + 1);
  assert.equal(matchTotp(key, hotp(key, step - 2), now), null);
  assert.equal(matchTotp(key, hotp(key, step + 2), now), null);
  assert.equal(matchTotp(key, hotp(key, step), now, { lastStep: step }), null, "the same step again");
  assert.equal(matchTotp(key, hotp(key, step - 1), now, { lastStep: step - 1 }), null);
  assert.equal(matchTotp(key, hotp(key, step), now, { lastStep: step - 1 }), step);
  for (const bad of ["", "12345", "1234567", "12345a", " 123456", hotp(key, step) + " "]) assert.equal(matchTotp(key, bad, now), null, JSON.stringify(bad));
});

test("last TOTP step per user never goes back", () => {
  const d = db();
  assert.equal(lastTotpStep(d, "u"), -1);
  saveTotpStep(d, "u", 100);
  saveTotpStep(d, "u", 90);
  assert.equal(lastTotpStep(d, "u"), 100);
  saveTotpStep(d, "u", 101);
  assert.equal(lastTotpStep(d, "u"), 101);
  assert.equal(lastTotpStep(d, "v"), -1);
});

test("totpKey: plain secrets as UTF-8, imported base32: secrets decoded", () => {
  assert.deepEqual(totpKey("abc"), Buffer.from("abc"));
  assert.deepEqual(totpKey("base32:" + base32Encode(Buffer.from("raw-bytes")).toLowerCase()), Buffer.from("raw-bytes"));
});

test("base32 agrees with better-auth's; otpauth URI as better-auth builds it", () => {
  for (const s of ["", "f", "fo", "foo", "foob", "fooba", "foobar", newTotpSecret()]) {
    const enc = base32Encode(Buffer.from(s));
    assert.equal(enc, base32.encode(new TextEncoder().encode(s), { padding: false }), s);
    assert.equal(base32Decode(enc).toString(), s);
  }
  assert.throws(() => base32Decode("01"));
  const secret = newTotpSecret();
  assert.equal(totpUri(secret, "Paddock", "a.b+c@corp.example"), createOTP(secret, { digits: 6, period: 30 }).url("Paddock", "a.b+c@corp.example"));
});

test("backup codes: format, exact match only, index of the match", () => {
  const codes = newBackupCodes();
  assert.equal(codes.length, 10);
  assert.ok(codes.every((c) => /^[A-Za-z0-9]{5}-[A-Za-z0-9]{5}$/.test(c)));
  assert.equal(new Set(codes).size, 10);
  assert.equal(matchBackupCode(codes, codes[4]), 4);
  assert.equal(matchBackupCode(codes, ` ${codes[4]} `), 4);
  assert.equal(matchBackupCode(codes, codes[4].toLowerCase() === codes[4] ? codes[4].toUpperCase() : codes[4].toLowerCase()), -1);
  for (const bad of ["", codes[0].slice(0, 9), codes[0] + "x", "aaaaa-aaaaa"]) assert.equal(matchBackupCode(codes, bad), -1, bad);
  assert.equal(matchBackupCode([], codes[0]), -1);
});

test("safeNext: a path on this site, nothing else", () => {
  assert.equal(safeNext("/?chat=abc"), "/?chat=abc");
  assert.equal(safeNext("/"), "/");
  for (const bad of [undefined, null, 5, "", "https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)", "/a\nb", "/2fa?next=/", "/api/auth/sign-out", "x".repeat(10)])
    assert.equal(safeNext(bad), "/", String(bad));
});

test("inheritedState: same user only, verified/exempt only", () => {
  assert.equal(inheritedState({ userId: "a", state: "verified" }, "a"), "verified");
  assert.equal(inheritedState({ userId: "a", state: "exempt" }, "a"), "exempt");
  assert.equal(inheritedState({ userId: "a", state: "verified" }, "b"), null, "A's verified session never verifies B");
  assert.equal(inheritedState({ userId: "a", state: "pending" }, "a"), null);
  assert.equal(inheritedState({ userId: "a", state: null }, "a"), null);
  assert.equal(inheritedState(undefined, "a"), null);
});

test("beginAttempt while locked: TOTP refused, backup codes on their own counter (5 per hour), session cap still applies", () => {
  const d = db();
  const now = 9_000_000;
  for (let s = 0; s < 2; s++) for (let i = 0; i < 5; i++) beginAttempt(d, "u:x", `s:${s}`, now);
  assert.equal(beginAttempt(d, "u:x", "s:9", now).reason, "locked");
  assert.equal(MAX_BACKUP_WHILE_LOCKED, 5);
  assert.equal(BACKUP_WINDOW_MS, 3600_000);
  const userBefore = d.prepare("SELECT failures, locked_until FROM second_factor_failures WHERE key = 'u:x'").get();
  for (let i = 0; i < 5; i++) assert.equal(beginAttempt(d, "u:x", `s:b${i}`, now, { backupCode: true }).ok, true, `backup ${i}`);
  const sixth = beginAttempt(d, "u:x", "s:b6", now, { backupCode: true });
  assert.deepEqual([sixth.ok, sixth.reason], [false, "locked"]);
  assert.deepEqual(d.prepare("SELECT failures, locked_until FROM second_factor_failures WHERE key = 'u:x'").get(), userBefore, "the lock itself is untouched");
  assert.equal(beginAttempt(d, "u:x", "s:b7", now + BACKUP_WINDOW_MS, { backupCode: true }).ok, true, "a new hour, new backup attempts");
  // The session cap applies to backup attempts too.
  for (let i = 0; i < 4; i++) beginAttempt(d, "u:y", "s:same", now);
  d.prepare("UPDATE second_factor_failures SET locked_until = ? WHERE key = 'u:y'").run(now + 1000);
  assert.equal(beginAttempt(d, "u:y", "s:same", now, { backupCode: true }).ok, true);
  assert.equal(beginAttempt(d, "u:y", "s:same", now, { backupCode: true }).reason, "revoked");
  // Not locked: a backup attempt counts for the user like any other.
  beginAttempt(d, "u:z", "s:z", now, { backupCode: true });
  assert.equal(d.prepare("SELECT failures FROM second_factor_failures WHERE key = 'u:z'").get().failures, 1);
  assert.equal(d.prepare("SELECT 1 FROM second_factor_failures WHERE key = ?").get(backupKeyOf("u:z")), undefined);
});
