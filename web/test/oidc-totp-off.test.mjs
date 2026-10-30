// OIDC_REQUIRE_TOTP=0: the behaviour before the feature. An OIDC login is a complete session at once.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockIdp, clientIp, oidcLogin, PUBLIC } from "./oidc-mock.mjs";

let idp, dir, A;
before(async () => {
  idp = await startMockIdp();
  dir = mkdtempSync(join(tmpdir(), "paddock-2fa-off-"));
  Object.assign(process.env, {
    AUTH_DB: join(dir, "auth.db"), TOKENS_DIR: dir, BETTER_AUTH_SECRET: "test-secret-0123456789abcdef-0123456789", PUBLIC_URL: PUBLIC,
    OIDC_ISSUER: idp.issuer, OIDC_CLIENT_ID: "paddock", OIDC_CLIENT_SECRET: "client-secret", OIDC_REQUIRE_TOTP: "0", NODE_ENV: "test",
  });
  A = await import("../lib/auth.ts");
  await A.ensureDb();
});
after(() => {
  idp.close();
  A?.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("OIDC_REQUIRE_TOTP=0: the OIDC session works at once, no second-factor endpoints, no state rows", async () => {
  assert.equal(A.requireSecondFactor, false);
  const jar = await oidcLogin(A, idp, { sub: "x-1", email: "x@corp.example" });
  const h = new Headers({ cookie: jar.header() });
  assert.equal((await A.sessionFromHeaders(h))?.user.email, "x@corp.example");
  assert.equal(await A.secondFactorStatus(h), null);
  const r = await A.auth.handler(new Request(`${PUBLIC}/api/auth/second-factor/status`, { headers: { cookie: jar.header(), "x-forwarded-for": clientIp() } }));
  assert.equal(r.status, 404);
  assert.equal(A.db.prepare("SELECT COUNT(*) AS n FROM session_second_factor").get().n, 0);
});
