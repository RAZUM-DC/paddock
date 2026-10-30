// Static guard for the second-factor gate: every session check in Paddock goes through sessionFromHeaders
// (auth.api.getSession, which lib/second-factor.ts gates), and every API route checks a session.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const walk = (dir) => readdirSync(join(root, dir)).flatMap((f) => {
  const p = join(dir, f);
  return statSync(join(root, p)).isDirectory() ? (f === "node_modules" || f === ".next" ? [] : walk(p)) : /\.(ts|tsx)$/.test(f) ? [p] : [];
});
const sources = [...walk("app"), ...walk("lib"), ...walk("components"), "server.ts"];

test("auth.api.getSession is called only by sessionFromHeaders in lib/auth.ts", () => {
  const callers = sources.filter((f) => /\bgetSession\s*\(/.test(readFileSync(join(root, f), "utf8")));
  assert.deepEqual(callers, ["lib/auth.ts"]);
  assert.match(readFileSync(join(root, "lib/auth.ts"), "utf8"), /export const sessionFromHeaders = \(headers: Headers\) => auth\.api\.getSession\(\{ headers \}\)\.catch\(\(\) => null\);/);
});

test("no code outside the auth libraries reads the session table or better-auth's internal adapter", () => {
  const allowed = new Set(["lib/oidc.ts", "lib/second-factor.ts", "lib/second-factor-core.ts", "lib/auth.ts"]);
  for (const f of sources) {
    if (allowed.has(f)) continue;
    const src = readFileSync(join(root, f), "utf8");
    assert.ok(!/FROM\s+"?session"?\b|internalAdapter|findSession|auth\.handler|\$context/.test(src), f);
  }
});

test("every API route except the open ones checks a session (or an admin)", () => {
  const open = new Set(["app/api/auth/[...all]/route.ts", "app/api/login-options/route.ts", "app/api/version/route.ts"]);
  for (const f of sources.filter((f) => /^app\/api\/.*route\.ts$/.test(f) && !open.has(f))) {
    const src = readFileSync(join(root, f), "utf8");
    assert.ok(/sessionFromHeaders|requireAdmin|requireUser/.test(src), f);
  }
  assert.match(readFileSync(join(root, "server.ts"), "utf8"), /const session = await sessionFromHeaders\(toHeaders\(req\.headers\)\);/);
  assert.match(readFileSync(join(root, "app/page.tsx"), "utf8"), /sessionFromHeaders\(h\)/);
});
