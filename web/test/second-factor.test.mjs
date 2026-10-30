// The pure rules of the second factor after OIDC (lib/second-factor-core.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { base32 } from "@better-auth/utils/base32";
import { createOTP } from "@better-auth/utils/otp";
import {
  allowedWhilePending, base32Decode, base32Encode, classifyNewSession, cleanupSecondFactor, hotp, isPending, lastTotpStep, lockedUntil, LOCK_MS, matchBackupCode,
  matchTotp, MAX_SESSION_FAILURES, MAX_USER_FAILURES, newBackupCodes, newTotpSecret, PERIOD, recordFailure, resetFailures, safeNext, saveTotpStep,
  secondFactorRequired, sessionState, setSessionState, setupSecondFactorTables, totpKey, totpUri, FAILURE_WINDOW_MS,
} from "../lib/second-factor-core.ts";

function db() {
  const d = new Database(":memory:");
  d.exec(`CREATE TABLE "account" ("id" text primary key, "accountId" text, "providerId" text, "userId" text);
    CREATE TABLE "session" ("id" text primary key, "expiresAt" date not null, "token" text, "userId" text)`);
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
  for (const p of ["/change-password", "/two-factor/enable", "/second-factor/verify", "/sign-in/social", undefined, ""]) assert.equal(classifyNewSession(p, {}, "oidc"), null, String(p));
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
  recordFailure(d, "u:old", 10, now - FAILURE_WINDOW_MS - 1);
  recordFailure(d, "u:new", 10, now);
  cleanupSecondFactor(d, now);
  assert.deepEqual(d.prepare("SELECT session_id FROM session_second_factor").all().map((r) => r.session_id), ["live"]);
  assert.deepEqual(d.prepare("SELECT key FROM second_factor_failures").all().map((r) => r.key), ["u:new"]);
});

test("failures: count within the window, lock at the maximum, reset", () => {
  const d = db();
  assert.equal(MAX_SESSION_FAILURES, 5);
  assert.equal(MAX_USER_FAILURES, 10);
  let t = 1_000_000;
  for (let i = 1; i < 3; i++) assert.equal(recordFailure(d, "k", 3, t), i);
  assert.equal(lockedUntil(d, "k", t), 0);
  assert.equal(recordFailure(d, "k", 3, t), 3);
  assert.equal(lockedUntil(d, "k", t), t + LOCK_MS);
  assert.equal(lockedUntil(d, "k", t + LOCK_MS), 0);
  assert.equal(recordFailure(d, "k", 3, t + FAILURE_WINDOW_MS), 1, "a new window starts over");
  resetFailures(d, "k");
  assert.equal(lockedUntil(d, "k", t), 0);
  assert.equal(recordFailure(d, "k", 3, t), 1);
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
