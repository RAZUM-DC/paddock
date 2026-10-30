// NODE_ENV=production (better-auth relaxes its Origin/CSRF check in test and development): the second-factor
// endpoints accept POSTs only from PUBLIC_URL.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockIdp, clientIp, oidcLogin, PUBLIC } from "./oidc-mock.mjs";

let idp, dir, A;
before(async () => {
  idp = await startMockIdp();
  dir = mkdtempSync(join(tmpdir(), "paddock-2fa-prod-"));
  Object.assign(process.env, {
    AUTH_DB: join(dir, "auth.db"), TOKENS_DIR: dir, BETTER_AUTH_SECRET: "test-secret-0123456789abcdef-0123456789", PUBLIC_URL: PUBLIC,
    OIDC_ISSUER: idp.issuer, OIDC_CLIENT_ID: "paddock", OIDC_CLIENT_SECRET: "client-secret", NODE_ENV: "production",
  });
  delete process.env.OIDC_REQUIRE_TOTP;
  A = await import("../lib/auth.ts");
  await A.ensureDb();
});
after(() => {
  idp.close();
  A?.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const post = (path, jar, origin) => A.auth.handler(new Request(`${PUBLIC}/api/auth${path}`, {
  method: "POST",
  headers: { ...(origin ? { origin } : {}), "content-type": "application/json", "x-forwarded-for": clientIp(), cookie: jar.header() },
  body: JSON.stringify({ code: "123456" }),
}));

test("production: enrol and verify refuse a foreign or missing Origin, accept PUBLIC_URL", async () => {
  assert.equal(process.env.NODE_ENV, "production");
  const jar = await oidcLogin(A, idp, { sub: "p-1", email: "prod@corp.example" });
  for (const path of ["/second-factor/enrol", "/second-factor/verify"]) {
    for (const origin of ["https://evil.example", null, "http://localhost:3999.evil.example"]) {
      const r = await post(path, jar, origin);
      assert.equal(r.status, 403, `${path} from ${origin}: ${r.status}`);
    }
  }
  // Nothing was stored by the refused calls.
  assert.equal(A.db.prepare(`SELECT COUNT(*) n FROM "twoFactor"`).get().n, 0);
  assert.equal(A.db.prepare("SELECT COUNT(*) n FROM second_factor_failures").get().n, 0);
  assert.equal((await post("/second-factor/enrol", jar, PUBLIC)).status, 200);
});
