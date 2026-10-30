// OIDC_REQUIRE_TOTP end to end through the real handlers: better-auth (lib/auth.ts) on a temp sqlite, a mock OpenID
// provider (discovery, JWKS, RS256 id_tokens, PKCE S256, nonce, the iss parameter), Paddock's API routes imported as
// modules, and the session check the WS bridge uses. The flag-off case is test/oidc-totp-off.test.mjs.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockIdp, clientIp, cookieJar, oidcLogin, PUBLIC } from "./oidc-mock.mjs";
import { hotp, PERIOD, totpKey, base32Decode } from "../lib/second-factor-core.ts";
import { createOTP } from "@better-auth/utils/otp";

let idp, dir, A, routes;
before(async () => {
  idp = await startMockIdp();
  dir = mkdtempSync(join(tmpdir(), "paddock-2fa-"));
  mkdirSync(join(dir, "tokens"));
  Object.assign(process.env, {
    AUTH_DB: join(dir, "auth.db"), TOKENS_DIR: join(dir, "tokens"), BETTER_AUTH_SECRET: "test-secret-0123456789abcdef-0123456789",
    PUBLIC_URL: PUBLIC, OIDC_ISSUER: idp.issuer, OIDC_CLIENT_ID: "paddock", OIDC_CLIENT_SECRET: "client-secret",
    OIDC_LINK_BY_EMAIL: "1", HARNESS_ID_SALT: "salt", ADMIN_USERS: "", NODE_ENV: "test",
  });
  delete process.env.OIDC_REQUIRE_TOTP;
  A = await import("../lib/auth.ts");
  await A.ensureDb();
  routes = {
    gitAccounts: await import("../app/api/git/accounts/route.ts"),
    secretRequests: await import("../app/api/secret-requests/route.ts"),
    adminGit: await import("../app/api/admin/git-accounts/route.ts"),
    harness: await import("../app/api/harness/route.ts"),
    tools: await import("../app/api/tools/route.ts"),
    turns: await import("../app/api/turns/route.ts"),
    snapshots: await import("../app/api/snapshots/route.ts"),
    proxy: await import("../app/api/proxy/route.ts"),
    net: await import("../app/api/net/route.ts"),
  };
});
after(async () => {
  idp.close();
  A?.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const authFetch = (path, { jar, method = "GET", body, ip } = {}) =>
  A.auth.handler(new Request(`${PUBLIC}/api/auth${path}`, {
    method,
    headers: { origin: PUBLIC, "x-forwarded-for": ip ?? clientIp(), ...(body ? { "content-type": "application/json" } : {}), ...(jar ? { cookie: jar.header() } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })).then(async (r) => {
    jar?.take(r);
    return { status: r.status, json: await r.json().catch(() => null), res: r };
  });

const headersOf = (jar) => new Headers({ cookie: jar.header(), origin: PUBLIC });
const sessionRow = (jar) => A.db.prepare(`SELECT * FROM "session" WHERE "token" = ?`).get(jar.sessionToken());
const userByEmail = (email) => A.db.prepare(`SELECT * FROM "user" WHERE "email" = ?`).get(email);
const secretOf = async (userId) => {
  const ctx = await A.auth.$context;
  const row = A.db.prepare(`SELECT * FROM "twoFactor" WHERE "userId" = ?`).get(userId);
  const { symmetricDecrypt } = await import("better-auth/crypto");
  return symmetricDecrypt({ key: ctx.secretConfig, data: row.secret });
};
const codeAt = (secret, offsetSteps = 0) => hotp(totpKey(secret), Math.floor(Date.now() / 1000 / PERIOD) + offsetSteps);

async function enrolAndVerify(jar) {
  const e = await authFetch("/second-factor/enrol", { jar, method: "POST", body: {} });
  assert.equal(e.status, 200, JSON.stringify(e.json));
  const user = A.db.prepare(`SELECT "userId" FROM "session" WHERE "token" = ?`).get(jar.sessionToken());
  const secret = await secretOf(user.userId);
  const v = await authFetch("/second-factor/verify", { jar, method: "POST", body: { code: codeAt(secret) } });
  assert.equal(v.status, 200, JSON.stringify(v.json));
  return { secret, enrol: e.json, verify: v.json, userId: user.userId };
}

test("an OIDC session is pending: no get-session, no WS bridge, no API route, no account settings", async () => {
  const jar = await oidcLogin(A, idp, { sub: "s-1", email: "one@corp.example" });
  assert.ok(jar.sessionToken(), "the callback set a session cookie");
  const h = headersOf(jar);
  // The session check of pages and of the WS bridge (server.ts).
  assert.equal(await A.sessionFromHeaders(h), null);
  await assert.rejects(A.auth.api.getSession({ headers: h }));
  // EVERY better-auth endpoint: 403 SECOND_FACTOR_REQUIRED, except the explicit allow-list.
  const allowed = new Set(["/sign-out", "/second-factor/status", "/second-factor/enrol", "/second-factor/verify", "/sign-in/social", "/sign-in/email", "/callback/:id", "/error", "/ok"]);
  const refused = [];
  // A body and query that pass every endpoint's input validation, so the request reaches the hooks.
  const SINK = { name: "x", email: "x@corp.example", password: "p".repeat(12), newPassword: "n".repeat(12), currentPassword: "c".repeat(12), newEmail: "n@corp.example",
    token: "t", code: "123456", provider: "oidc", providerId: "oidc", accountId: "a", callbackURL: "/", secret: "s", userId: "u" };
  for (const [key, ep] of Object.entries(A.auth.api)) {
    const method = [ep.options?.method].flat()[0] ?? "POST";
    if (!ep.path) {
      // Server-only endpoints (no route): auth.api calls go through the same gate.
      await assert.rejects(ep({ headers: h, body: SINK }), (e) => e.statusCode === 403 || e.status === "FORBIDDEN", key);
      refused.push(key);
      continue;
    }
    // The allow-list is exercised by the other tests (calling sign-out here would end this session).
    if (allowed.has(ep.path)) continue;
    // Responses must not change the cookies this walk sends.
    const r = await authFetch(ep.path.replace(/:[a-zA-Z]+/g, "x") + (method === "GET" ? "?token=t&callbackURL=%2F" : ""), { jar: { header: jar.header, take() {} }, method, body: method === "GET" ? undefined : SINK });
    {
      assert.equal(r.status, 403, `${ep.path}: ${r.status} ${JSON.stringify(r.json)}`);
      assert.equal(r.json?.code, "SECOND_FACTOR_REQUIRED", ep.path);
      refused.push(ep.path);
    }
  }
  assert.ok(await authFetch("/second-factor/status", { jar }).then((r) => r.json.pending), "still the same pending session after the walk");
  for (const p of ["/get-session", "/get-access-token", "/update-session", "/account-info", "/unlink-account", "/list-sessions", "/two-factor/disable", "/two-factor/verify-totp", "/change-password", "/link-social"])
    assert.ok(refused.includes(p), p);
  // EVERY Paddock API route (app/api/**/route.ts), every exported method: no access (401/403) for a pending session,
  // and the same answer as with no cookie at all.
  const { readdirSync, statSync } = await import("node:fs");
  const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : f === "route.ts" ? [join(d, f)] : []));
  const apiDir = new URL("../app/api", import.meta.url).pathname;
  const open = new Set(["auth/[...all]/route.ts", "login-options/route.ts", "version/route.ts"]);
  let checked = 0;
  for (const file of walk(apiDir)) {
    const rel = file.slice(apiDir.length + 1);
    if (open.has(rel)) continue;
    const mod = await import(file);
    for (const m of ["GET", "POST", "PUT", "DELETE", "PATCH"]) {
      if (typeof mod[m] !== "function") continue;
      const call = (cookie) => mod[m](new Request(`${PUBLIC}/api/${rel.replace(/\/route\.ts$/, "")}?user=x&ids=a`, {
        method: m, headers: { ...(cookie ? { cookie } : {}), origin: PUBLIC, "content-type": "application/json" }, body: m === "GET" ? undefined : "{}",
      }), { params: Promise.resolve({ id: "0123456789abcdef01234567" }) });
      const withPending = await call(jar.header());
      const without = await call(null);
      assert.ok([401, 403].includes(withPending.status), `${rel} ${m}: ${withPending.status}`);
      assert.equal(withPending.status, without.status, `${rel} ${m}`);
      checked++;
    }
  }
  assert.ok(checked >= 18, `checked ${checked} handlers`);
  // What a pending session may do.
  const st = await authFetch("/second-factor/status", { jar });
  assert.deepEqual(st.json, { signedIn: true, pending: true, enrolled: false, email: "one@corp.example" });
  assert.deepEqual(await A.secondFactorStatus(h), st.json);
});

test("first enrolment: otpauth URI, stored like better-auth's twoFactor, then a new verified session", async () => {
  const jar = await oidcLogin(A, idp, { sub: "s-2", email: "two@corp.example" });
  const old = sessionRow(jar);
  const e1 = await authFetch("/second-factor/enrol", { jar, method: "POST", body: {} });
  // Every enrol call makes a new secret (an unconfirmed one is never shown again); the first QR stops working.
  const firstSecret = base32Decode(new URL(e1.json.totpURI).searchParams.get("secret")).toString("utf8");
  const e2 = await authFetch("/second-factor/enrol", { jar, method: "POST", body: {} });
  assert.notEqual(e1.json.totpURI, e2.json.totpURI);
  assert.equal(A.db.prepare(`SELECT COUNT(*) n FROM "twoFactor" WHERE "userId" = (SELECT "id" FROM "user" WHERE "email" = 'two@corp.example')`).get().n, 1);
  assert.equal((await authFetch("/second-factor/verify", { jar, method: "POST", body: { code: codeAt(firstSecret) } })).status, 401);
  const uri = new URL(e2.json.totpURI);
  assert.equal(uri.protocol, "otpauth:");
  assert.equal(uri.searchParams.get("issuer"), "Paddock");
  const user = userByEmail("two@corp.example");
  const secret = await secretOf(user.id);
  assert.equal(base32Decode(uri.searchParams.get("secret")).toString("utf8"), secret);
  // The same URI better-auth itself would produce for this secret.
  assert.equal(e2.json.totpURI, createOTP(secret, { digits: 6, period: 30 }).url("Paddock", "two@corp.example"));
  let row = A.db.prepare(`SELECT * FROM "twoFactor" WHERE "userId" = ?`).get(user.id);
  assert.equal(row.verified, 0);
  assert.ok(row.secret.startsWith("$ba$") || /^[0-9a-f]+$/.test(row.secret), "encrypted like better-auth");
  // Backup codes exist from the start but count only after the app is confirmed.
  const { symmetricDecrypt } = await import("better-auth/crypto");
  const early = JSON.parse(await symmetricDecrypt({ key: (await A.auth.$context).secretConfig, data: row.backupCodes }))[0];
  assert.equal((await authFetch("/second-factor/verify", { jar, method: "POST", body: { code: early } })).status, 401);
  // Wrong code first: still pending.
  const bad = await authFetch("/second-factor/verify", { jar, method: "POST", body: { code: codeAt(secret, 5) } });
  assert.equal(bad.status, 401);
  assert.equal(bad.json.code, "INVALID_CODE");
  // Our code agrees with better-auth's own TOTP implementation.
  const code = codeAt(secret);
  assert.equal(code, await createOTP(secret, { digits: 6, period: 30 }).totp());
  const v = await authFetch("/second-factor/verify", { jar, method: "POST", body: { code } });
  assert.equal(v.status, 200, JSON.stringify(v.json));
  assert.equal(v.json.backupCodes.length, 10);
  assert.ok(v.json.backupCodes.every((c) => /^[A-Za-z0-9]{5}-[A-Za-z0-9]{5}$/.test(c)));
  // Session fixation: the pending session is gone, the cookie holds a new token.
  const fresh = sessionRow(jar);
  assert.notEqual(fresh.token, old.token);
  assert.equal(A.db.prepare(`SELECT 1 FROM "session" WHERE "id" = ?`).get(old.id), undefined);
  assert.equal(A.db.prepare("SELECT 1 FROM session_second_factor WHERE session_id = ?").get(old.id), undefined);
  row = A.db.prepare(`SELECT * FROM "twoFactor" WHERE "userId" = ?`).get(user.id);
  assert.equal(row.verified, 1);
  assert.equal(userByEmail("two@corp.example").twoFactorEnabled, 1);
  // Everything works now.
  const s = await A.sessionFromHeaders(headersOf(jar));
  assert.equal(s?.user.email, "two@corp.example");
  assert.equal(s.user.twoFactorEnabled, true);
  assert.equal((await routes.gitAccounts.GET(new Request(`${PUBLIC}/api/git/accounts`, { headers: { cookie: jar.header() } }))).status, 200);
  assert.equal((await authFetch("/get-session", { jar })).status, 200);
  // The same code again (replay) on a new login is refused; so is enrolling again.
  const jar2 = await oidcLogin(A, idp, { sub: "s-2", email: "two@corp.example" });
  assert.equal((await authFetch("/second-factor/status", { jar: jar2 })).json.enrolled, true);
  assert.equal((await authFetch("/second-factor/enrol", { jar: jar2, method: "POST", body: {} })).status, 409);
  const replay = await authFetch("/second-factor/verify", { jar: jar2, method: "POST", body: { code } });
  assert.equal(replay.status, 401);
  // A backup code works once.
  const bc = v.json.backupCodes[3];
  const viaBackup = await authFetch("/second-factor/verify", { jar: jar2, method: "POST", body: { code: bc } });
  assert.equal(viaBackup.status, 200);
  // Backup codes are shown only once, on the first enrolment; never again.
  assert.deepEqual(viaBackup.json, { ok: true });
  const jar3 = await oidcLogin(A, idp, { sub: "s-2", email: "two@corp.example" });
  assert.equal((await authFetch("/second-factor/verify", { jar: jar3, method: "POST", body: { code: bc } })).status, 401);
  // Disabling TOTP is refused for SSO users, even with a verified session.
  const dis = await authFetch("/two-factor/disable", { jar, method: "POST", body: { password: "whatever-12345" } });
  assert.equal(dis.status, 403);
  assert.equal(dis.json.code, "TOTP_REQUIRED_FOR_SSO");
});

test("an old code (outside the window) and a code from another secret are refused", async () => {
  const jar = await oidcLogin(A, idp, { sub: "s-3", email: "three@corp.example" });
  await authFetch("/second-factor/enrol", { jar, method: "POST", body: {} });
  const secret = await secretOf(userByEmail("three@corp.example").id);
  for (const code of [codeAt(secret, -3), codeAt(secret, 2), codeAt("another-secret-entirely-000000000"), "12345", "1234567", "abcdef", ""]) {
    const r = await authFetch("/second-factor/verify", { jar, method: "POST", body: { code } });
    assert.equal(r.status, 401, code);
    if (r.json?.code === "SESSION_REVOKED") break;
  }
});

test("lockout: 5 wrong codes revoke the session; 10 across sessions lock the user even for the right code", async () => {
  const email = "four@corp.example";
  const jar = await oidcLogin(A, idp, { sub: "s-4", email });
  await authFetch("/second-factor/enrol", { jar, method: "POST", body: {} });
  const user = userByEmail(email);
  const secret = await secretOf(user.id);
  const wrong = () => codeAt(secret, 7);
  const sid = sessionRow(jar).id;
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await authFetch("/second-factor/verify", { jar, method: "POST", body: { code: wrong() } })).json.code);
  assert.deepEqual(codes, ["INVALID_CODE", "INVALID_CODE", "INVALID_CODE", "INVALID_CODE", "SESSION_REVOKED"]);
  assert.equal(A.db.prepare(`SELECT 1 FROM "session" WHERE "id" = ?`).get(sid), undefined, "the 5th failure itself deletes the session");
  assert.equal((await authFetch("/second-factor/verify", { jar, method: "POST", body: { code: codeAt(secret) } })).status, 401);
  // Second session: 5 more wrong codes reach the user limit (10).
  const jar2 = await oidcLogin(A, idp, { sub: "s-4", email });
  for (let i = 0; i < 5; i++) await authFetch("/second-factor/verify", { jar: jar2, method: "POST", body: { code: wrong() } });
  const jar3 = await oidcLogin(A, idp, { sub: "s-4", email });
  const locked = await authFetch("/second-factor/verify", { jar: jar3, method: "POST", body: { code: codeAt(secret) } });
  assert.equal(locked.status, 429);
  assert.equal(locked.json.code, "LOCKED");
  // Still pending, still blocked.
  assert.equal(await A.sessionFromHeaders(headersOf(jar3)), null);
  // Once the lock expires the right code works.
  A.db.prepare("UPDATE second_factor_failures SET locked_until = 0, failures = 0 WHERE key = ?").run(`u:${user.id}`);
  assert.equal((await authFetch("/second-factor/verify", { jar: jar3, method: "POST", body: { code: codeAt(secret) } })).status, 200);
});

test("sign-out clears the pending session and its state", async () => {
  const jar = await oidcLogin(A, idp, { sub: "s-5", email: "five@corp.example" });
  const s = sessionRow(jar);
  assert.equal(A.db.prepare("SELECT state FROM session_second_factor WHERE session_id = ?").get(s.id).state, "pending");
  const r = await authFetch("/sign-out", { jar, method: "POST", body: {} });
  assert.equal(r.status, 200);
  assert.equal(A.db.prepare(`SELECT 1 FROM "session" WHERE "id" = ?`).get(s.id), undefined);
  assert.equal(A.db.prepare("SELECT 1 FROM session_second_factor WHERE session_id = ?").get(s.id), undefined);
});

test("sessions from before the feature (no state row) of an OIDC user are pending; password-only users are not affected", async () => {
  const jar = await oidcLogin(A, idp, { sub: "s-6", email: "six@corp.example" });
  await enrolAndVerify(jar);
  assert.ok(await A.sessionFromHeaders(headersOf(jar)));
  // Simulate a session created by an older Paddock: drop its state row.
  A.db.prepare("DELETE FROM session_second_factor WHERE session_id = ?").run(sessionRow(jar).id);
  assert.equal(await A.sessionFromHeaders(headersOf(jar)), null);
  // A password-only user: unchanged.
  const ctx = await A.auth.$context;
  const u = await ctx.internalAdapter.createUser({ email: "pw@hub.local", name: "pw", emailVerified: true });
  await ctx.internalAdapter.linkAccount({ userId: u.id, providerId: "credential", accountId: u.id, password: await ctx.password.hash("pw-password-12345") });
  const pj = cookieJar();
  const r = await authFetch("/sign-in/email", { jar: pj, method: "POST", body: { email: "pw@hub.local", password: "pw-password-12345" } });
  assert.equal(r.status, 200);
  assert.equal((await A.sessionFromHeaders(headersOf(pj)))?.user.email, "pw@hub.local");
  A.db.prepare("DELETE FROM session_second_factor WHERE session_id = ?").run(sessionRow(pj).id);
  assert.equal((await A.sessionFromHeaders(headersOf(pj)))?.user.email, "pw@hub.local");
});

test("linked user: password login keeps its harness, OIDC links by email, enrols, then password + TOTP sign-in works", async () => {
  const ctx = await A.auth.$context;
  const u = await ctx.internalAdapter.createUser({ email: "alice@hub.local", name: "alice", emailVerified: true });
  await ctx.internalAdapter.linkAccount({ userId: u.id, providerId: "credential", accountId: u.id, password: await ctx.password.hash("alice-password-1") });
  // First password login on the pilot build stores harness "alice".
  assert.equal(A.harnessIdOf({ id: u.id, email: "alice@hub.local" }), "alice");
  // The admin changes the email to the directory address; SSO then links by that email.
  A.db.prepare(`UPDATE "user" SET "email" = ? WHERE "id" = ?`).run("alice.smith@corp.example", u.id);
  // Without email_verified from the IdP there is no link.
  const unverified = await oidcLogin(A, idp, { sub: "ad-alice", email: "alice.smith@corp.example", email_verified: false }, { expectSession: false });
  assert.match(unverified.location, /error=account_not_linked/);
  const jar = await oidcLogin(A, idp, { sub: "ad-alice", email: "alice.smith@corp.example" });
  const s = sessionRow(jar);
  assert.equal(s.userId, u.id, "linked to the existing user");
  assert.equal(A.harnessIdOf({ id: u.id, email: "alice.smith@corp.example" }), "alice");
  assert.equal(await A.sessionFromHeaders(headersOf(jar)), null, "pending");
  const { secret } = await enrolAndVerify(jar);
  assert.ok(await A.sessionFromHeaders(headersOf(jar)));
  // Password sign-in of the same user now asks for better-auth's TOTP, and the secret Paddock stored works there.
  const pj = cookieJar();
  const r1 = await authFetch("/sign-in/email", { jar: pj, method: "POST", body: { email: "alice.smith@corp.example", password: "alice-password-1" } });
  assert.equal(r1.status, 200);
  assert.equal(r1.json.twoFactorRedirect, true);
  assert.deepEqual(r1.json.twoFactorMethods, ["totp"]);
  const r2 = await authFetch("/two-factor/verify-totp", { jar: pj, method: "POST", body: { code: codeAt(secret, 1) } });
  assert.equal(r2.status, 200, JSON.stringify(r2.json));
  const ps = await A.sessionFromHeaders(headersOf(pj));
  assert.equal(ps?.user.id, u.id, "password + TOTP session is valid (exempt)");
  assert.equal(A.db.prepare("SELECT state FROM session_second_factor WHERE session_id = ?").get(sessionRow(pj).id).state, "exempt");
});

test("the gate cannot be skipped by an unsigned or forged cookie, and the state is server-side", async () => {
  const jar = await oidcLogin(A, idp, { sub: "s-7", email: "seven@corp.example" });
  const token = jar.sessionToken();
  // The bare token without better-auth's signature is not a session at all.
  const forged = new Headers({ cookie: `better-auth.session_token=${token}` });
  assert.equal(await A.sessionFromHeaders(forged), null);
  // A client-side "verified" cookie means nothing.
  const extra = new Headers({ cookie: `${jar.header()}; paddock.second_factor=verified; second_factor=verified` });
  assert.equal(await A.sessionFromHeaders(extra), null);
});

// --- review fixes: concurrency, enrolment, unlink, expiry, counters, growing locks ---

async function enrolled(email, sub) {
  const jar = await oidcLogin(A, idp, { sub, email });
  const { secret, userId } = await enrolAndVerify(jar);
  return { secret, userId, login: () => oidcLogin(A, idp, { sub, email }) };
}
const wrongCode = (secret, i) => String((Number(codeAt(secret)) + 1000 + i) % 1e6).padStart(6, "0");
const verifyBurst = (jar, codes) => Promise.all(codes.map((code) => authFetch("/second-factor/verify", { jar: { header: jar.header, take() {} }, method: "POST", body: { code } })));
const tally = (rs) => rs.reduce((t, r) => ((t[r.json?.code ?? r.status] = (t[r.json?.code ?? r.status] ?? 0) + 1), t), {});
const failuresOf = (key) => A.db.prepare("SELECT failures FROM second_factor_failures WHERE key = ?").get(key)?.failures ?? 0;

test("concurrency: 40 parallel wrong codes on one pending session — exactly 5 are evaluated", async () => {
  const u = await enrolled("burst1@corp.example", "c-1");
  const jar = await u.login();
  const sid = sessionRow(jar).id;
  const t = tally(await verifyBurst(jar, Array.from({ length: 40 }, (_, i) => wrongCode(u.secret, i))));
  // 4 wrong codes evaluated, the 5th evaluated and revoking; the rest refused unevaluated (revoked or already gone).
  assert.equal(t.INVALID_CODE, 4, JSON.stringify(t));
  assert.ok(t.SESSION_REVOKED >= 1, JSON.stringify(t));
  assert.equal((t.SESSION_REVOKED ?? 0) + (t.NO_SESSION ?? 0), 36, JSON.stringify(t));
  assert.equal(failuresOf(`u:${u.userId}`), 5, "only the evaluated attempts count for the user");
  assert.equal(A.db.prepare(`SELECT 1 FROM "session" WHERE "id" = ?`).get(sid), undefined, "the session is revoked");
});

test("concurrency: a correct code cannot upgrade a session revoked by wrong codes; a burst has at most one winner within the cap", async () => {
  const u = await enrolled("burst2@corp.example", "c-2");
  const jar = await u.login();
  for (let i = 0; i < 5; i++) await authFetch("/second-factor/verify", { jar: { header: jar.header, take() {} }, method: "POST", body: { code: wrongCode(u.secret, i) } });
  const after = await verifyBurst(jar, [...Array.from({ length: 9 }, (_, i) => wrongCode(u.secret, 20 + i)), codeAt(u.secret, 1)]);
  assert.ok(after.every((r) => r.status === 401), JSON.stringify(tally(after)));
  assert.equal(await A.sessionFromHeaders(headersOf(jar)), null);
  // A fresh session, a burst of 30 with the right code last: never more than one success, never more than 5 evaluated.
  A.db.prepare("DELETE FROM second_factor_failures WHERE key = ?").run(`u:${u.userId}`);
  const jar2 = await u.login();
  const rs = await verifyBurst(jar2, [...Array.from({ length: 29 }, (_, i) => wrongCode(u.secret, 40 + i)), codeAt(u.secret, 1)]);
  const t = tally(rs);
  assert.ok((t.ok ?? 0) + (t[200] ?? 0) <= 1, JSON.stringify(t));
  assert.ok((t.INVALID_CODE ?? 0) + (t[200] ?? 0) <= 5, JSON.stringify(t));
  const winner = rs.find((r) => r.status === 200);
  if (winner) {
    const cookie = winner.res.headers.getSetCookie().find((c) => c.startsWith("better-auth.session_token=")).split(";")[0];
    assert.ok(await A.sessionFromHeaders(new Headers({ cookie })), "the one winner's new session works");
  }
});

test("concurrency: the same valid code on two pending sessions at once — exactly one succeeds", async () => {
  const u = await enrolled("replay2@corp.example", "c-3");
  const [a, b] = [await u.login(), await u.login()];
  const code = codeAt(u.secret, 1);
  const rs = await Promise.all([a, b].map((jar) => authFetch("/second-factor/verify", { jar: { header: jar.header, take() {} }, method: "POST", body: { code } })));
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 401]);
});

test("enrolment: concurrent first enrols make one row; every call a new secret; only the latest works; the other session's secret is never shown", async () => {
  const email = "race@corp.example";
  const jars = [];
  for (let i = 0; i < 5; i++) jars.push(await oidcLogin(A, idp, { sub: "c-4", email }));
  const rs = await Promise.all(jars.map((jar) => authFetch("/second-factor/enrol", { jar, method: "POST", body: {} })));
  assert.ok(rs.every((r) => r.status === 200));
  const user = userByEmail(email);
  assert.equal(A.db.prepare(`SELECT COUNT(*) n FROM "twoFactor" WHERE "userId" = ?`).get(user.id).n, 1);
  const secrets = rs.map((r) => base32Decode(new URL(r.json.totpURI).searchParams.get("secret")).toString("utf8"));
  assert.equal(new Set(secrets).size, 5, "no session ever gets another one's secret");
  const stored = await secretOf(user.id);
  assert.ok(secrets.includes(stored));
  // "Victim" scans an earlier QR: refused (an attacker's later enrol only invalidates it, it never learns the victim's).
  const stale = secrets.find((x) => x !== stored);
  assert.equal((await authFetch("/second-factor/verify", { jar: jars[0], method: "POST", body: { code: codeAt(stale) } })).status, 401);
  const owner = jars[secrets.indexOf(stored)];
  assert.equal((await authFetch("/second-factor/verify", { jar: owner, method: "POST", body: { code: codeAt(stored) } })).status, 200);
  // Once confirmed, nobody's enrol returns a secret any more, and the old unconfirmed ones never work.
  const later = await oidcLogin(A, idp, { sub: "c-4", email });
  const again = await authFetch("/second-factor/enrol", { jar: later, method: "POST", body: {} });
  assert.equal(again.status, 409);
  assert.equal(again.json.totpURI, undefined);
  for (const sec of secrets.filter((x) => x !== stored)) assert.equal((await authFetch("/second-factor/verify", { jar: later, method: "POST", body: { code: codeAt(sec, 1) } })).status, 401);
});

test("legacy twoFactor rows with verified NULL count as set up: enrol refuses and reveals nothing", async () => {
  const email = "legacy@corp.example";
  const jar = await oidcLogin(A, idp, { sub: "c-5", email });
  await authFetch("/second-factor/enrol", { jar, method: "POST", body: {} });
  const user = userByEmail(email);
  A.db.prepare(`UPDATE "twoFactor" SET "verified" = NULL WHERE "userId" = ?`).run(user.id);
  assert.equal((await authFetch("/second-factor/status", { jar })).json.enrolled, true);
  const r = await authFetch("/second-factor/enrol", { jar, method: "POST", body: {} });
  assert.equal(r.status, 409);
  assert.deepEqual(Object.keys(r.json).sort(), ["code", "message"]);
  // And its code is accepted as a normal (not a first) verification: no backup codes are returned.
  const v = await authFetch("/second-factor/verify", { jar, method: "POST", body: { code: codeAt(await secretOf(user.id)) } });
  assert.deepEqual([v.status, v.json], [200, { ok: true }]);
});

test("an SSO user cannot unlink any account (better-auth takes only accountId), so TOTP stays required", async () => {
  const ctx = await A.auth.$context;
  const u = await ctx.internalAdapter.createUser({ email: "unlink@corp.example", name: "unlink", emailVerified: true });
  await ctx.internalAdapter.linkAccount({ userId: u.id, providerId: "credential", accountId: u.id, password: await ctx.password.hash("unlink-password-1") });
  const jar = await oidcLogin(A, idp, { sub: "c-6", email: "unlink@corp.example" });
  await enrolAndVerify(jar);
  const acc = A.db.prepare(`SELECT "id", "accountId" FROM "account" WHERE "userId" = ? AND "providerId" = 'oidc'`).get(u.id);
  // The real better-auth 1.7 body is { accountId } (providerId is ignored by it); both forms are refused.
  for (const body of [{ accountId: acc.id }, { accountId: acc.accountId }, { providerId: "oidc", accountId: acc.accountId }]) {
    const r = await authFetch("/unlink-account", { jar, method: "POST", body });
    assert.deepEqual([r.status, r.json.code], [403, "SSO_ACCOUNT_REQUIRED"], JSON.stringify(body));
  }
  assert.ok(A.db.prepare(`SELECT 1 FROM "account" WHERE "id" = ?`).get(acc.id));
  const dis = await authFetch("/two-factor/disable", { jar, method: "POST", body: { password: "unlink-password-1" } });
  assert.deepEqual([dis.status, dis.json.code], [403, "TOTP_REQUIRED_FOR_SSO"]);
  assert.equal(userByEmail("unlink@corp.example").twoFactorEnabled, 1);
});

test("an expired pending session is no session for the second-factor endpoints either", async () => {
  const jar = await oidcLogin(A, idp, { sub: "c-7", email: "expired@corp.example" });
  A.db.prepare(`UPDATE "session" SET "expiresAt" = ? WHERE "token" = ?`).run(new Date(Date.now() - 1000).toISOString(), jar.sessionToken());
  assert.deepEqual((await authFetch("/second-factor/status", { jar })).json, { signedIn: false, pending: false, enrolled: false });
  assert.equal((await authFetch("/second-factor/enrol", { jar, method: "POST", body: {} })).json.code, "NO_SESSION");
  assert.equal((await authFetch("/second-factor/verify", { jar, method: "POST", body: { code: "123456" } })).json.code, "NO_SESSION");
});

test("enrol and verify need a pending session: verified and password sessions get NOT_PENDING, nothing is stored", async () => {
  const jar = await oidcLogin(A, idp, { sub: "c-8", email: "np@corp.example" });
  await enrolAndVerify(jar);
  assert.equal((await authFetch("/second-factor/enrol", { jar, method: "POST", body: {} })).json.code, "NOT_PENDING");
  assert.equal((await authFetch("/second-factor/verify", { jar, method: "POST", body: { code: "123456" } })).json.code, "NOT_PENDING");
  const ctx = await A.auth.$context;
  const u = await ctx.internalAdapter.createUser({ email: "np-pw@hub.local", name: "np", emailVerified: true });
  await ctx.internalAdapter.linkAccount({ userId: u.id, providerId: "credential", accountId: u.id, password: await ctx.password.hash("np-password-12345") });
  const pj = cookieJar();
  await authFetch("/sign-in/email", { jar: pj, method: "POST", body: { email: "np-pw@hub.local", password: "np-password-12345" } });
  assert.equal((await authFetch("/second-factor/enrol", { jar: pj, method: "POST", body: {} })).json.code, "NOT_PENDING");
  assert.equal(A.db.prepare(`SELECT COUNT(*) n FROM "twoFactor" WHERE "userId" = ?`).get(u.id).n, 0);
});

test("a success resets the user's counter: the next 10 attempts are counted from zero", async () => {
  const u = await enrolled("reset@corp.example", "c-9");
  const a = await u.login();
  for (let i = 0; i < 4; i++) assert.equal((await authFetch("/second-factor/verify", { jar: a, method: "POST", body: { code: wrongCode(u.secret, i) } })).json.code, "INVALID_CODE");
  assert.equal((await authFetch("/second-factor/verify", { jar: a, method: "POST", body: { code: codeAt(u.secret, 1) } })).status, 200);
  const b = await u.login();
  const cb = [];
  for (let i = 0; i < 5; i++) cb.push((await authFetch("/second-factor/verify", { jar: b, method: "POST", body: { code: wrongCode(u.secret, 10 + i) } })).json.code);
  assert.deepEqual(cb, ["INVALID_CODE", "INVALID_CODE", "INVALID_CODE", "INVALID_CODE", "SESSION_REVOKED"]);
  const c = await u.login();
  const cc = [];
  for (let i = 0; i < 4; i++) cc.push((await authFetch("/second-factor/verify", { jar: c, method: "POST", body: { code: wrongCode(u.secret, 20 + i) } })).json.code);
  assert.deepEqual(cc, ["INVALID_CODE", "INVALID_CODE", "INVALID_CODE", "INVALID_CODE"]);
});

test("locks grow (15 → 30 min), are logged without secrets, and a hard lock needs the admin", async () => {
  const u = await enrolled("grow@corp.example", "c-10");
  const key = `u:${u.userId}`;
  const logged = [];
  const warn = console.warn;
  console.warn = (line) => logged.push(String(line));
  try {
    const lockOnce = async () => {
      for (let s = 0; s < 2; s++) {
        const jar = await u.login();
        for (let i = 0; i < 5; i++) await authFetch("/second-factor/verify", { jar, method: "POST", body: { code: wrongCode(u.secret, s * 5 + i) } });
      }
      return A.db.prepare("SELECT locked_until, locks FROM second_factor_failures WHERE key = ?").get(key);
    };
    const t0 = Date.now();
    const first = await lockOnce();
    assert.equal(first.locks, 1);
    assert.ok(Math.abs(first.locked_until - t0 - 15 * 60_000) < 60_000, String(first.locked_until - t0));
    // The lock runs out (and a new window starts); the next lock is twice as long.
    A.db.prepare("UPDATE second_factor_failures SET locked_until = 0, first_at = 0 WHERE key = ?").run(key);
    const second = await lockOnce();
    assert.equal(second.locks, 2);
    assert.ok(Math.abs(second.locked_until - Date.now() - 30 * 60_000) < 60_000);
    const locks = logged.map((l) => JSON.parse(l)).filter((l) => l.event === "second-factor-lock");
    assert.equal(locks.length, 2);
    assert.deepEqual(Object.keys(locks[0]).sort(), ["event", "hard", "locks", "until", "user"]);
    assert.equal(locks[0].user, u.userId);
    assert.ok(!logged.join("\n").includes(u.secret));
    // Hard lock: even the right code, until the admin deletes the row.
    A.db.prepare("UPDATE second_factor_failures SET locked_until = ? WHERE key = ?").run(Number.MAX_SAFE_INTEGER, key);
    const jar = await u.login();
    const r = await authFetch("/second-factor/verify", { jar, method: "POST", body: { code: codeAt(u.secret, 1) } });
    assert.deepEqual([r.status, r.json.code], [429, "LOCKED_HARD"]);
    A.db.prepare("DELETE FROM second_factor_failures WHERE key = ?").run(key);
    assert.equal((await authFetch("/second-factor/verify", { jar, method: "POST", body: { code: codeAt(u.secret, 1) } })).status, 200);
  } finally {
    console.warn = warn;
  }
});

test("a session whose attempts are used up is revoked by its next request, even if nothing revoked it before", async () => {
  const u = await enrolled("spent@corp.example", "c-11");
  const jar = await u.login();
  const sid = sessionRow(jar).id;
  // As if 5 attempts had been counted (e.g. a crash between counting and revoking).
  A.db.prepare("INSERT INTO second_factor_failures (key, failures, first_at, locked_until, locks) VALUES (?, 5, ?, 0, 0)").run(`s:${sid}`, Date.now());
  const r = await authFetch("/second-factor/verify", { jar, method: "POST", body: { code: codeAt(u.secret, 1) } });
  assert.deepEqual([r.status, r.json.code], [401, "SESSION_REVOKED"]);
  assert.equal(A.db.prepare(`SELECT 1 FROM "session" WHERE "id" = ?`).get(sid), undefined);
});

test("a verified or exempt session rotated by another endpoint (change-password) keeps its state", async () => {
  const ctx = await A.auth.$context;
  const u = await ctx.internalAdapter.createUser({ email: "rot@corp.example", name: "rot", emailVerified: true });
  await ctx.internalAdapter.linkAccount({ userId: u.id, providerId: "credential", accountId: u.id, password: await ctx.password.hash("rot-password-12345") });
  const jar = await oidcLogin(A, idp, { sub: "c-12", email: "rot@corp.example" });
  await enrolAndVerify(jar);
  const before = sessionRow(jar);
  const r = await authFetch("/change-password", { jar, method: "POST", body: { currentPassword: "rot-password-12345", newPassword: "rot-password-67890", revokeOtherSessions: true } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const after = sessionRow(jar);
  assert.notEqual(after.id, before.id, "better-auth rotated the session");
  assert.equal(A.db.prepare("SELECT state FROM session_second_factor WHERE session_id = ?").get(after.id)?.state, "verified");
  assert.ok(await A.sessionFromHeaders(headersOf(jar)), "the rotated session still works");
});

test("a verified session of user A plus an id_token sign-in of user B gives B a pending session, never A's state", async () => {
  const jarA = await oidcLogin(A, idp, { sub: "x-a", email: "usera@corp.example" });
  await enrolAndVerify(jarA);
  // B exists as an SSO user (first login made the account).
  await oidcLogin(A, idp, { sub: "x-b", email: "userb@corp.example" });
  const r = await authFetch("/sign-in/social", { jar: jarA, method: "POST", body: { provider: "oidc", idToken: { token: idp.mint({ sub: "x-b", email: "userb@corp.example" }) } } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const s = sessionRow(jarA);
  assert.equal(s.userId, userByEmail("userb@corp.example").id, "the cookie now holds B's session");
  assert.equal(A.db.prepare("SELECT state FROM session_second_factor WHERE session_id = ?").get(s.id)?.state, "pending");
  assert.equal(await A.sessionFromHeaders(headersOf(jarA)), null);
});

test("backup codes work during a soft or hard lock (own counter, 5 per hour) and clear it; TOTP codes stay locked", async () => {
  const email = "lockbackup@corp.example";
  const jar0 = await oidcLogin(A, idp, { sub: "c-13", email });
  const { secret, verify, userId } = await enrolAndVerify(jar0);
  const codes = verify.backupCodes;
  const key = `u:${userId}`;
  for (const hard of [false, true]) {
    A.db.prepare("INSERT OR REPLACE INTO second_factor_failures (key, failures, first_at, locked_until, locks) VALUES (?, 10, ?, ?, ?)").run(key, Date.now(), hard ? Number.MAX_SAFE_INTEGER : Date.now() + 15 * 60_000, hard ? 5 : 1);
    const jar = await oidcLogin(A, idp, { sub: "c-13", email });
    const totp = await authFetch("/second-factor/verify", { jar, method: "POST", body: { code: codeAt(secret, 1) } });
    assert.deepEqual([totp.status, totp.json.code], [429, hard ? "LOCKED_HARD" : "LOCKED"]);
    const ok = await authFetch("/second-factor/verify", { jar, method: "POST", body: { code: codes.pop() } });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(A.db.prepare("SELECT 1 FROM second_factor_failures WHERE key = ?").get(key), undefined, "the lock is cleared");
  }
  // Locked again: wrong backup codes run into their own limit (5 per hour), across sessions.
  A.db.prepare("INSERT OR REPLACE INTO second_factor_failures (key, failures, first_at, locked_until, locks) VALUES (?, 10, ?, ?, 1)").run(key, Date.now(), Date.now() + 15 * 60_000);
  const seen = [];
  for (let s = 0; s < 2; s++) {
    const jar = await oidcLogin(A, idp, { sub: "c-13", email });
    for (let i = 0; i < 3; i++) seen.push((await authFetch("/second-factor/verify", { jar, method: "POST", body: { code: `wrong-${s}${i}xxx` } })).json.code);
  }
  assert.deepEqual(seen, ["INVALID_CODE", "INVALID_CODE", "INVALID_CODE", "INVALID_CODE", "INVALID_CODE", "LOCKED"]);
  const jar = await oidcLogin(A, idp, { sub: "c-13", email });
  assert.equal((await authFetch("/second-factor/verify", { jar, method: "POST", body: { code: codes.pop() } })).json.code, "LOCKED", "even a right backup code waits for the hour");
});
