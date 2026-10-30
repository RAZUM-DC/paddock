// Client address for rate limits (lib/client-ip.ts): only trusted proxies may pass X-Forwarded-For; everyone else is
// their TCP peer. Integration through better-auth's real rate limiter on a temp sqlite.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TRUSTED_PROXIES, normalizeForwarded, parseTrustList, peerAddress, ProxyTrust, trustedHops } from "../lib/client-ip.ts";

test("parseTrustList: addresses, CIDRs, host names; garbage reported", () => {
  assert.deepEqual(parseTrustList("172.20.1.250, 10.0.0.0/8 ::1 fd00::/8 edge my-proxy.internal"), {
    addresses: ["172.20.1.250", "::1"], cidrs: ["10.0.0.0/8", "fd00::/8"], hosts: ["edge", "my-proxy.internal"], invalid: [] });
  assert.deepEqual(parseTrustList("10.0.0.0/33 1.2.3.4/x a/b/c -bad http://x").invalid, ["10.0.0.0/33", "1.2.3.4/x", "a/b/c", "-bad", "http://x"]);
  assert.deepEqual(parseTrustList(DEFAULT_TRUSTED_PROXIES), { addresses: ["127.0.0.1", "::1"], cidrs: [], hosts: ["edge"], invalid: [] });
  assert.deepEqual(parseTrustList(undefined), { addresses: [], cidrs: [], hosts: [], invalid: [] });
  assert.deepEqual(trustedHops("192.0.2.10, 198.51.100.0/24, edge"), ["192.0.2.10", "198.51.100.0/24"]);
  assert.deepEqual(trustedHops(undefined), [], "no hops trusted by default (no more private ranges)");
});

test("peerAddress strips the IPv4-mapped prefix", () => {
  assert.equal(peerAddress("::ffff:172.20.1.5"), "172.20.1.5");
  assert.equal(peerAddress("::1"), "::1");
  assert.equal(peerAddress(undefined), "");
});

test("ProxyTrust: static entries and resolved host names, refreshed", async () => {
  let edge = ["172.20.1.250"];
  const t = new ProxyTrust(parseTrustList("127.0.0.1,10.9.0.0/16,edge"), async (h) => (h === "edge" ? edge : []));
  assert.equal(t.isTrusted("172.20.1.250"), false, "not before the first resolution");
  await t.refresh();
  for (const ok of ["172.20.1.250", "::ffff:172.20.1.250", "127.0.0.1", "10.9.3.4"]) assert.ok(t.isTrusted(ok), ok);
  for (const bad of ["172.20.1.251", "10.10.0.1", "", "garbage", "::1"]) assert.ok(!t.isTrusted(bad), bad);
  edge = ["172.20.1.99"];
  await t.refresh();
  assert.ok(t.isTrusted("172.20.1.99"));
  assert.ok(!t.isTrusted("172.20.1.250"), "an old address is forgotten");
  const failing = new ProxyTrust(parseTrustList("edge"), async () => { throw new Error("ENOTFOUND"); });
  await failing.refresh();
  assert.ok(!failing.isTrusted("172.20.1.250"));
});

test("normalizeForwarded: untrusted peers lose every forwarding header, trusted ones keep X-Forwarded-For", () => {
  const trust = { isTrusted: (a) => a === "172.20.1.250" };
  const spoof = () => ({ "x-forwarded-for": "1.2.3.4", forwarded: "for=1.2.3.4", "x-real-ip": "1.2.3.4", "x-forwarded-host": "evil", "x-forwarded-proto": "https", "x-forwarded-port": "1", "true-client-ip": "1.2.3.4", "cf-connecting-ip": "1.2.3.4", "x-client-ip": "1.2.3.4", cookie: "c=1" });
  const h = spoof();
  normalizeForwarded(h, "::ffff:10.200.0.7", trust);
  assert.deepEqual(h, { "x-forwarded-for": "10.200.0.7", cookie: "c=1" });
  const e = spoof();
  normalizeForwarded(e, "172.20.1.250", trust);
  assert.equal(e["x-forwarded-for"], "1.2.3.4", "the edge's header is kept");
  const e2 = {};
  normalizeForwarded(e2, "172.20.1.250", trust);
  assert.equal(e2["x-forwarded-for"], "172.20.1.250");
  const none = { "x-forwarded-for": "1.2.3.4" };
  normalizeForwarded(none, undefined, trust);
  assert.deepEqual(none, {}, "no peer: nothing to trust");
});

test("server.ts normalises every request except /api/harness/*, and every WS upgrade", () => {
  const src = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
  assert.match(src, /if \(isHarnessApiPath\(req\.url\)\) return void harnessApi\(req, res\);\n\s*normalizeForwarded\(req\.headers, req\.socket\.remoteAddress, proxyTrust\);\n\s*return handle\(req, res\);/);
  assert.match(src, /server\.on\("upgrade", async \(req, socket, head\) => \{\n\s*normalizeForwarded\(req\.headers, req\.socket\.remoteAddress, proxyTrust\);/);
  assert.match(src, /parseTrustList\(process\.env\.TRUSTED_PROXIES \?\? DEFAULT_TRUSTED_PROXIES\)/);
  assert.match(readFileSync(new URL("../lib/auth.ts", import.meta.url), "utf8"), /trustedProxies: trustedHops\(process\.env\.TRUSTED_PROXY_HOPS\)/);
});

// --- integration: better-auth's sign-in rate limit (3 per 10 s per client) ---
let A, dir;
before(async () => {
  dir = mkdtempSync(join(tmpdir(), "paddock-ip-"));
  Object.assign(process.env, { AUTH_DB: join(dir, "auth.db"), BETTER_AUTH_SECRET: "test-secret-0123456789abcdef-0123456789", PUBLIC_URL: "http://localhost:3999", NODE_ENV: "test" });
  for (const k of ["OIDC_ISSUER", "OIDC_CLIENT_ID", "TRUSTED_PROXY_HOPS"]) delete process.env[k];
  A = await import("../lib/auth.ts");
  await A.ensureDb();
});
after(() => {
  A?.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const signIn = (headers) => A.auth.handler(new Request("http://localhost:3999/api/auth/sign-in/email", {
  method: "POST", headers: { ...headers, origin: "http://localhost:3999", "content-type": "application/json" }, body: JSON.stringify({ email: "nobody@hub.local", password: "wrong-password-123" }),
})).then((r) => r.status);
const edge = { isTrusted: (a) => a === "172.20.1.250" };

test("a harness rotating X-Forwarded-For is one client: rate-limited after 3 attempts", async () => {
  const statuses = [];
  for (let i = 0; i < 5; i++) {
    const h = { "x-forwarded-for": `203.0.113.${i + 1}` };
    normalizeForwarded(h, "10.200.0.66", edge);
    statuses.push(await signIn(h));
  }
  assert.deepEqual(statuses.slice(0, 3).map((s) => s === 429), [false, false, false]);
  assert.equal(statuses[3], 429);
  assert.equal(statuses[4], 429);
});

test("clients behind the trusted edge keep their own buckets; the edge is not one shared client", async () => {
  const statuses = [];
  for (let i = 0; i < 6; i++) {
    const h = { "x-forwarded-for": `198.51.100.${i + 1}` };
    normalizeForwarded(h, "172.20.1.250", edge);
    statuses.push(await signIn(h));
  }
  assert.ok(statuses.every((s) => s !== 429), statuses.join(","));
});

test("without normalisation (the old trust of private ranges is gone too) a forged header from a private peer is still its own address", async () => {
  // A request whose XFF names a private hop and a public "client": with no hops trusted, better-auth takes the
  // rightmost entry, i.e. what server.ts put there (the TCP peer), never something further left.
  const statuses = [];
  for (let i = 0; i < 4; i++) statuses.push(await signIn({ "x-forwarded-for": `203.0.113.${50 + i}, 10.200.0.77` }));
  assert.equal(statuses[3], 429);
});
