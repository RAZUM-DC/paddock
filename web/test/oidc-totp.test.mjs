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
  // better-auth HTTP endpoints that would read or change the account.
  for (const [path, method, body] of [["/get-session", "GET"], ["/list-sessions", "GET"], ["/two-factor/disable", "POST", { password: "x" }], ["/two-factor/enable", "POST", { password: "x" }],
    ["/change-password", "POST", { currentPassword: "a", newPassword: "b".repeat(12) }], ["/update-user", "POST", { name: "x" }], ["/revoke-sessions", "POST", {}], ["/list-accounts", "GET"],
    ["/two-factor/verify-totp", "POST", { code: "123456" }], ["/link-social", "POST", { provider: "oidc" }], ["/delete-user", "POST", {}]]) {
    const r = await authFetch(path, { jar, method, body });
    assert.equal(r.status, 403, `${path}: ${r.status} ${JSON.stringify(r.json)}`);
  }
  // Paddock's API routes (requireUser, requireAdmin, the plain session checks).
  const req = (method = "GET", body) => new Request(`${PUBLIC}/api/x`, { method, headers: { cookie: jar.header(), origin: PUBLIC, "content-type": "application/json" }, body });
  for (const [name, fn] of [["git GET", () => routes.gitAccounts.GET(req())], ["git POST", () => routes.gitAccounts.POST(req("POST", JSON.stringify({ host: "github.com", token: "t".repeat(20) })))],
    ["secret-requests", () => routes.secretRequests.GET(req())], ["admin git", () => routes.adminGit.GET(new Request(`${PUBLIC}/api/admin/git-accounts?user=x`, { headers: { cookie: jar.header() } }))],
    ["harness", () => routes.harness.GET(req())], ["tools", () => routes.tools.GET(req())], ["turns", () => routes.turns.GET(new Request(`${PUBLIC}/api/turns?ids=a`, { headers: { cookie: jar.header() } }))],
    ["snapshots", () => routes.snapshots.GET(req())], ["proxy", () => routes.proxy.GET(req())], ["net", () => routes.net.GET(req())]]) {
    const r = await fn();
    assert.equal(r.status, 401, `${name}: ${r.status}`);
  }
  // What a pending session may do.
  const st = await authFetch("/second-factor/status", { jar });
  assert.deepEqual(st.json, { signedIn: true, pending: true, enrolled: false, email: "one@corp.example" });
  assert.deepEqual(await A.secondFactorStatus(h), st.json);
});

test("first enrolment: otpauth URI, stored like better-auth's twoFactor, then a new verified session", async () => {
  const jar = await oidcLogin(A, idp, { sub: "s-2", email: "two@corp.example" });
  const old = sessionRow(jar);
  const e1 = await authFetch("/second-factor/enrol", { jar, method: "POST", body: {} });
  // Reloading the page shows the same secret until it is confirmed.
  const e2 = await authFetch("/second-factor/enrol", { jar, method: "POST", body: {} });
  assert.equal(e1.json.totpURI, e2.json.totpURI);
  const uri = new URL(e1.json.totpURI);
  assert.equal(uri.protocol, "otpauth:");
  assert.equal(uri.searchParams.get("issuer"), "Paddock");
  const user = userByEmail("two@corp.example");
  const secret = await secretOf(user.id);
  assert.equal(base32Decode(uri.searchParams.get("secret")).toString("utf8"), secret);
  // The same URI better-auth itself would produce for this secret.
  assert.equal(e1.json.totpURI, createOTP(secret, { digits: 6, period: 30 }).url("Paddock", "two@corp.example"));
  let row = A.db.prepare(`SELECT * FROM "twoFactor" WHERE "userId" = ?`).get(user.id);
  assert.equal(row.verified, 0);
  assert.ok(row.secret.startsWith("$ba$") || /^[0-9a-f]+$/.test(row.secret), "encrypted like better-auth");
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
  assert.equal((await authFetch("/second-factor/verify", { jar: jar2, method: "POST", body: { code: bc } })).status, 200);
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
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await authFetch("/second-factor/verify", { jar, method: "POST", body: { code: wrong() } })).json.code);
  assert.deepEqual(codes, ["INVALID_CODE", "INVALID_CODE", "INVALID_CODE", "INVALID_CODE", "SESSION_REVOKED"]);
  assert.equal(sessionRow(jar), undefined, "the session is deleted");
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
  const u = await ctx.internalAdapter.createUser({ email: "evgenii@hub.local", name: "evgenii", emailVerified: true });
  await ctx.internalAdapter.linkAccount({ userId: u.id, providerId: "credential", accountId: u.id, password: await ctx.password.hash("evgenii-password-1") });
  // First password login on the pilot build stores harness "evgenii".
  assert.equal(A.harnessIdOf({ id: u.id, email: "evgenii@hub.local" }), "evgenii");
  // The admin changes the email to the directory address; SSO then links by that email.
  A.db.prepare(`UPDATE "user" SET "email" = ? WHERE "id" = ?`).run("evgenii.erman@corp.example", u.id);
  // Without email_verified from the IdP there is no link.
  const unverified = await oidcLogin(A, idp, { sub: "ad-evgenii", email: "Evgenii.Erman@corp.example", email_verified: false }, { expectSession: false });
  assert.match(unverified.location, /error=account_not_linked/);
  const jar = await oidcLogin(A, idp, { sub: "ad-evgenii", email: "Evgenii.Erman@corp.example" });
  const s = sessionRow(jar);
  assert.equal(s.userId, u.id, "linked to the existing user");
  assert.equal(A.harnessIdOf({ id: u.id, email: "evgenii.erman@corp.example" }), "evgenii");
  assert.equal(await A.sessionFromHeaders(headersOf(jar)), null, "pending");
  const { secret } = await enrolAndVerify(jar);
  assert.ok(await A.sessionFromHeaders(headersOf(jar)));
  // Password sign-in of the same user now asks for better-auth's TOTP, and the secret Paddock stored works there.
  const pj = cookieJar();
  const r1 = await authFetch("/sign-in/email", { jar: pj, method: "POST", body: { email: "evgenii.erman@corp.example", password: "evgenii-password-1" } });
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
