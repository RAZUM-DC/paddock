// /api/gate/<app> (lib/gate.ts): the pure rules, the handler with fake dependencies, and the handler on a real HTTP
// server with the real better-auth (temp sqlite, mock OpenID provider, OIDC_REQUIRE_TOTP on).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockIdp, clientIp, cookieJar, oidcLogin, PUBLIC } from "./oidc-mock.mjs";
import { hotp, PERIOD, totpKey } from "../lib/second-factor-core.ts";
import { createGate, gateAllows, gateAppOf, gateRule, isGatePath, loggedPath } from "../lib/gate.ts";
import { clientAddress } from "../lib/client-ip.ts";

test("gateRule: GATE_<APP>_EMAILS / _GROUPS / _ADMINS=1; nothing configured or a bad name = no rule", () => {
  const env = { GATE_BB_EMAILS: "A@Corp.example, b@corp.example", GATE_MY_APP_GROUPS: "devs ops", GATE_ADM_ADMINS: "1", GATE_OFF_ADMINS: "true", GATE_EMPTY_EMAILS: " , " };
  const bb = gateRule("bb", env);
  assert.deepEqual([...bb.emails], ["a@corp.example", "b@corp.example"]);
  assert.deepEqual([...bb.groups], []);
  assert.equal(bb.admins, false);
  assert.deepEqual([...gateRule("my-app", env).groups], ["devs", "ops"]);
  assert.equal(gateRule("adm", env).admins, true);
  for (const app of ["off", "empty", "unknown", "BB", "b_b", "", "a".repeat(33), "bb/x", "../bb", "bb "]) assert.equal(gateRule(app, env), null, app);
  assert.ok(gateRule("a".repeat(32), { [`GATE_${"A".repeat(32)}_ADMINS`]: "1" }));
});

test("gateAllows: email (any case), any shared group, or admin when the rule admits admins", () => {
  const rule = { emails: new Set(["a@corp.example"]), groups: new Set(["devs"]), admins: false };
  assert.ok(gateAllows(rule, { email: "A@corp.EXAMPLE", groups: [], admin: false }));
  assert.ok(gateAllows(rule, { email: "x@corp.example", groups: ["ops", "devs"], admin: false }));
  assert.ok(!gateAllows(rule, { email: "x@corp.example", groups: ["ops"], admin: true }), "admins only when the rule says so");
  assert.ok(gateAllows({ ...rule, admins: true }, { email: "x@corp.example", groups: [], admin: true }));
  assert.ok(!gateAllows(rule, { email: "", groups: [], admin: false }));
});

test("gateAppOf / isGatePath / loggedPath / clientAddress", () => {
  assert.equal(gateAppOf("/api/gate/bb"), "bb");
  assert.equal(gateAppOf("/api/gate/bb?x=1"), "bb");
  for (const u of ["/api/gate/bb/x", "/api/gate/", "/api/gate", "/api/gateway/bb", "/x/api/gate/bb", undefined]) assert.equal(gateAppOf(u), "", String(u));
  assert.ok(isGatePath("/api/gate/bb") && isGatePath("/api/gate") && isGatePath("/api/gate/"));
  assert.ok(!isGatePath("/api/gateway") && !isGatePath("/api/harness/x") && !isGatePath(undefined));
  assert.equal(loggedPath("/files/a.js?token=secret"), "/files/a.js");
  assert.equal(loggedPath(undefined), "");
  assert.equal(loggedPath("/a\nb"), "?");
  assert.equal(loggedPath("/" + "x".repeat(300)).length, 200);
  assert.equal(clientAddress("203.0.113.9, 10.0.0.5", ["10.0.0.0/8"]), "203.0.113.9", "proxies in front of the edge are skipped");
  assert.equal(clientAddress("203.0.113.9, 10.0.0.5", []), "10.0.0.5");
  assert.equal(clientAddress("::ffff:192.0.2.1", []), "192.0.2.1");
  assert.equal(clientAddress("garbage", []), "");
  assert.equal(clientAddress(undefined, []), "");
});

// The handler with fake dependencies on a real HTTP server.
async function serve(handler) {
  const srv = createServer(handler);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  return { base, close: () => srv.close() };
}

function fakeDeps(over = {}) {
  const seen = [];
  const logs = [];
  const users = { "tok-a": { id: "user-a", email: "a@corp.example" }, "tok-b": { id: "user-b", email: "b@corp.example" }, "tok-bad": { id: "user-c", email: "c@corp.example\r\nX-Evil: 1" } };
  return {
    seen, logs,
    deps: {
      session: async (h) => {
        seen.push([...h.keys()]);
        const m = /sid=([\w-]+)/.exec(h.get("cookie") ?? "");
        return m && users[m[1]] ? { user: users[m[1]] } : null;
      },
      groupsOf: (id) => (id === "user-b" ? ["devs"] : id === "user-c" ? ["everyone"] : []),
      isAdmin: () => false,
      harnessOf: (u) => (u.id === "user-a" ? "u-0123456789ab" : (() => { throw new Error("none"); })()),
      clientAddress: (req) => clientAddress(req.headers["x-forwarded-for"], []),
      env: { GATE_BB_EMAILS: "a@corp.example,c@corp.example\r\nx-evil: 1", GATE_DEV_GROUPS: "devs", GATE_ALL_GROUPS: "everyone" },
      failRate: 100,
      log: (l) => logs.push(l),
      ...over,
    },
  };
}

test("handler: 204 with identity headers, 401/403/404, no-store, no body, cookie only, HEAD, 405", async () => {
  const f = fakeDeps();
  const s = await serve(createGate(f.deps));
  try {
    const get = (path, headers = {}, method = "GET") => fetch(s.base + path, { method, headers: { "x-forwarded-for": "198.51.100.7", ...headers } });
    let r = await get("/api/gate/bb", { cookie: "other=1; sid=tok-a", "x-forwarded-host": "evil", "x-forwarded-uri": "/x?token=t", authorization: "Bearer tok-b" });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get("x-gate-user-id"), "user-a");
    assert.equal(r.headers.get("x-gate-user-email"), "a@corp.example");
    assert.equal(r.headers.get("x-gate-harness"), "u-0123456789ab");
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.equal(await r.text(), "");
    assert.equal(r.headers.get("content-type"), null, "nothing to type on a 204");
    assert.ok(![...r.headers.values()].some((v) => v.includes("tok-a")), "the cookie is never reflected");
    assert.deepEqual(f.seen.at(-1), ["cookie"], "the session check sees the Cookie header and nothing else");
    // Another user who is not on the list; and who is in the group of another app.
    r = await get("/api/gate/bb", { cookie: "sid=tok-b" });
    assert.equal(r.status, 403);
    assert.equal(r.headers.get("x-gate-user-id"), null);
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.equal(await r.text(), "403\n");
    r = await get("/api/gate/dev", { cookie: "sid=tok-b" });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get("x-gate-harness"), null, "no harness → no header");
    // No cookie, an unknown cookie, a bearer token instead of a cookie.
    for (const h of [{}, { cookie: "sid=nope" }, { authorization: "Bearer tok-a" }, { "x-forwarded-user": "user-a" }]) assert.equal((await get("/api/gate/bb", h)).status, 401, JSON.stringify(h));
    // Unknown or unconfigured apps and bad names: 404 before any session check.
    const before = f.seen.length;
    for (const p of ["/api/gate/other", "/api/gate/BB", "/api/gate/bb/x", "/api/gate/", "/api/gate"]) assert.equal((await get(p, { cookie: "sid=tok-a" })).status, 404, p);
    assert.equal(f.seen.length, before);
    // A value that cannot be a header is left out, never sent.
    r = await get("/api/gate/bb", { cookie: "sid=tok-bad", "x-forwarded-for": "198.51.100.8" });
    assert.equal(r.status, 403, "the email list entry with CRLF does not match");
    r = await get("/api/gate/all", { cookie: "sid=tok-bad" });
    assert.equal(r.status, 204, "allowed by group");
    assert.equal(r.headers.get("x-gate-user-id"), "user-c");
    assert.equal(r.headers.get("x-gate-user-email"), null, "an email with CR/LF is not sent as a header");
    assert.equal(r.headers.get("x-evil"), null);
    r = await get("/api/gate/bb", { cookie: "sid=tok-a" }, "HEAD");
    assert.equal(r.status, 204);
    r = await get("/api/gate/bb", { cookie: "sid=tok-a" }, "POST");
    assert.equal(r.status, 405);
    // The log has the app, the status, the client and the path of X-Forwarded-Uri, never a query or a cookie.
    await get("/api/gate/bb", { cookie: "sid=nope", "x-forwarded-uri": "/ide/file.js?auth=zzz" });
    assert.match(f.logs.at(-1), /^gate bb 401 198\.51\.100\.7 \/ide\/file\.js$/);
    assert.ok(!f.logs.some((l) => /zzz|tok-|sid=/.test(l)));
  } finally { s.close(); }
});

test("handler: failed checks are limited per client address (429), others are not affected", async () => {
  const f = fakeDeps({ failRate: 3 });
  const s = await serve(createGate(f.deps));
  try {
    const get = (ip, cookie) => fetch(s.base + "/api/gate/bb", { headers: { "x-forwarded-for": ip, ...(cookie ? { cookie } : {}) } });
    for (let i = 0; i < 3; i++) assert.equal((await get("198.51.100.20")).status, 401);
    assert.equal((await get("198.51.100.20", "sid=tok-a")).status, 429, "blocked even with a valid cookie");
    assert.equal((await get("198.51.100.21", "sid=tok-a")).status, 204);
    // Successful checks do not count as failures.
    for (let i = 0; i < 10; i++) assert.equal((await get("198.51.100.22", "sid=tok-a")).status, 204);
  } finally { s.close(); }
  const g = fakeDeps({ rate: 4 });
  const t = await serve(createGate(g.deps));
  try {
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await fetch(t.base + "/api/gate/bb", { headers: { "x-forwarded-for": "198.51.100.30", cookie: "sid=tok-a" } })).status);
    assert.deepEqual(statuses, [204, 204, 204, 204, 429], "a cap on all checks too");
  } finally { t.close(); }
});

test("server.ts: the gate runs after the forwarding headers are normalised, with the gated session check", () => {
  const src = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
  assert.match(src, /normalizeForwarded\(req\.headers, req\.socket\.remoteAddress, proxyTrust\);\n\s*if \(isGatePath\(req\.url\)\) return void gate\(req, res\);\n\s*return handle\(req, res\);/);
  assert.match(src, /createGate\(\{\n\s*session: sessionFromHeaders,\n\s*groupsOf: oidcGroupsOf,\n\s*isAdmin: isAdminUser,\n\s*harnessOf: harnessIdOf,\n\s*clientAddress: \(req\) => clientAddress\(req\.headers\["x-forwarded-for"\], hops\),/);
  assert.match(src, /const hops = trustedHops\(process\.env\.TRUSTED_PROXY_HOPS\);/);
});

// --- Real better-auth: OIDC with OIDC_REQUIRE_TOTP (default on), temp sqlite.
let idp, dir, A, real;
before(async () => {
  idp = await startMockIdp();
  dir = mkdtempSync(join(tmpdir(), "paddock-gate-"));
  mkdirSync(join(dir, "tokens"));
  Object.assign(process.env, {
    AUTH_DB: join(dir, "auth.db"), TOKENS_DIR: join(dir, "tokens"), BETTER_AUTH_SECRET: "test-secret-0123456789abcdef-0123456789",
    PUBLIC_URL: PUBLIC, OIDC_ISSUER: idp.issuer, OIDC_CLIENT_ID: "paddock", OIDC_CLIENT_SECRET: "client-secret",
    OIDC_ADMIN_GROUPS: "paddock-admins", HARNESS_ID_SALT: "salt", ADMIN_USERS: "", NODE_ENV: "test",
  });
  delete process.env.OIDC_REQUIRE_TOTP;
  A = await import("../lib/auth.ts");
  await A.ensureDb();
  real = await serve(createGate({
    session: A.sessionFromHeaders, groupsOf: A.oidcGroupsOf, isAdmin: A.isAdminUser, harnessOf: A.harnessIdOf,
    clientAddress: (req) => clientAddress(req.headers["x-forwarded-for"], []),
    env: { GATE_BB_EMAILS: "dev.one@corp.example", GATE_OPS_GROUPS: "ops", GATE_ADM_ADMINS: "1" },
    log: () => {},
  }));
});
after(async () => {
  real?.close();
  idp?.close();
  A?.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const authFetch = (path, { jar, method = "GET", body } = {}) =>
  A.auth.handler(new Request(`${PUBLIC}/api/auth${path}`, {
    method,
    headers: { origin: PUBLIC, "x-forwarded-for": clientIp(), ...(body ? { "content-type": "application/json" } : {}), ...(jar ? { cookie: jar.header() } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })).then(async (r) => {
    jar?.take(r);
    return { status: r.status, json: await r.json().catch(() => null) };
  });

// Enrols on the first pending session of a user, then verifies; a later session only verifies (with the next code:
// a TOTP step is accepted once).
const enrolled = new Map();
async function enrolAndVerify(jar) {
  const { userId } = A.db.prepare(`SELECT "userId" FROM "session" WHERE "token" = ?`).get(jar.sessionToken());
  let step = 0;
  if (!enrolled.has(userId)) {
    const e = await authFetch("/second-factor/enrol", { jar, method: "POST", body: {} });
    assert.equal(e.status, 200, JSON.stringify(e.json));
    const ctx = await A.auth.$context;
    const row = A.db.prepare(`SELECT * FROM "twoFactor" WHERE "userId" = ?`).get(userId);
    const { symmetricDecrypt } = await import("better-auth/crypto");
    enrolled.set(userId, await symmetricDecrypt({ key: ctx.secretConfig, data: row.secret }));
  } else step = 1;
  const secret = enrolled.get(userId);
  const v = await authFetch("/second-factor/verify", { jar, method: "POST", body: { code: hotp(totpKey(secret), Math.floor(Date.now() / 1000 / PERIOD) + step) } });
  assert.equal(v.status, 200, JSON.stringify(v.json));
  return userId;
}

const gateGet = (app, jar, extra = {}) =>
  fetch(`${real.base}/api/gate/${app}`, { headers: { "x-forwarded-for": clientIp(), ...(jar ? { cookie: jar.header() } : {}), ...extra } });

test("real auth: no cookie 401; pending OIDC session 401; verified 204 with headers; not allowed 403; unknown app 404", async () => {
  assert.equal((await gateGet("bb")).status, 401);
  const jar = await oidcLogin(A, idp, { sub: "g-1", email: "dev.one@corp.example", groups: ["paddock-users", "ops"] });
  assert.equal((await gateGet("bb", jar)).status, 401, "pending second factor");
  assert.equal((await gateGet("ops", jar)).status, 401);
  const userId = await enrolAndVerify(jar);
  const r = await gateGet("bb", jar, { "x-forwarded-host": "ide.example", "x-forwarded-uri": "/", "x-forwarded-method": "GET" });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get("x-gate-user-id"), userId);
  assert.equal(r.headers.get("x-gate-user-email"), "dev.one@corp.example");
  assert.match(r.headers.get("x-gate-harness"), /^u-[0-9a-f]{12}$/);
  assert.equal(r.headers.get("x-gate-harness"), A.harnessIdOf({ id: userId, email: "dev.one@corp.example" }));
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.equal((await gateGet("ops", jar)).status, 204, "by OIDC group of the last login");
  assert.equal((await gateGet("adm", jar)).status, 403, "not a Paddock admin");
  assert.equal((await gateGet("nope", jar)).status, 404);
  // A forged or unsigned cookie with the right token value is no session.
  const raw = jar.sessionToken();
  assert.equal((await fetch(`${real.base}/api/gate/bb`, { headers: { cookie: `better-auth.session_token=${raw}`, "x-forwarded-for": clientIp() } })).status, 401);
});

test("real auth: other users by email/group/admin; groups follow the last login; sign-out ends access", async () => {
  const other = await oidcLogin(A, idp, { sub: "g-2", email: "someone@corp.example", groups: ["paddock-users"] });
  await enrolAndVerify(other);
  assert.equal((await gateGet("bb", other)).status, 403);
  assert.equal((await gateGet("ops", other)).status, 403);
  assert.equal((await gateGet("adm", other)).status, 403);
  // Next login: now in ops and an admin by OIDC_ADMIN_GROUPS.
  const again = await oidcLogin(A, idp, { sub: "g-2", email: "someone@corp.example", groups: ["paddock-users", "ops", "paddock-admins"] });
  await enrolAndVerify(again);
  assert.equal((await gateGet("ops", again)).status, 204);
  assert.equal((await gateGet("adm", again)).status, 204);
  assert.equal((await gateGet("ops", other)).status, 204, "groups are per user, as of the last login");
  const out = await authFetch("/sign-out", { jar: again, method: "POST", body: {} });
  assert.equal(out.status, 200);
  assert.equal((await gateGet("ops", again)).status, 401);
});

test("real auth: a password user (exempt from the SSO second factor) is checked by email", async () => {
  const ctx = await A.auth.$context;
  const u = await ctx.internalAdapter.createUser({ email: "Dev.One.PW@corp.example", name: "pw", emailVerified: true });
  await ctx.internalAdapter.linkAccount({ userId: u.id, providerId: "credential", accountId: u.id, password: await ctx.password.hash("pw-password-12") });
  const jar = cookieJar();
  const r = await authFetch("/sign-in/email", { jar, method: "POST", body: { email: "dev.one.pw@corp.example", password: "pw-password-12" } });
  assert.equal(r.status, 200);
  assert.equal(A.oidcGroupsOf(u.id).length, 0);
  assert.equal((await gateGet("bb", jar)).status, 403);
});
