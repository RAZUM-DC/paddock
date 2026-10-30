// Web's provisioning hook (lib/provision.ts): only SSO ids (u-<12 hex>) are ever sent to the provisioner; a legacy
// harness is "unmanaged" whatever state its container is in (the reviewer's repro: harness absent → no create).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fake, calls, dir, P;
before(async () => {
  calls = [];
  fake = createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    res.writeHead(req.method === "POST" ? 202 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ready: false, state: "absent" }));
  });
  await new Promise((ok) => fake.listen(0, "127.0.0.1", ok));
  dir = mkdtempSync(join(tmpdir(), "paddock-prov-"));
  Object.assign(process.env, { PROVISIONER_URL: `http://127.0.0.1:${fake.address().port}`, PROVISIONER_TOKEN: "t".repeat(32), TOKENS_DIR: dir, CODEX_HOST_TEMPLATE: "127.0.0.1:1", PROVISION_TIMEOUT_MS: "300" });
  P = await import("../lib/provision.ts");
});
after(() => {
  fake.close();
  rmSync(dir, { recursive: true, force: true });
});

test("legacy harness ids are unmanaged: no ensure, no status call, even when the harness is absent", async () => {
  for (const id of ["evgenii", "alice", "ops-2"]) {
    assert.equal(P.isProvisionedId(id), false);
    assert.equal(P.managedHarness(id), false);
    assert.equal(P.ensureHarness({ id, email: `${id}@hub.local` }), null);
    assert.deepEqual(await P.harnessState({ id, email: `${id}@hub.local` }), { state: "unmanaged" });
    assert.deepEqual(await P.harnessState({ id, email: `${id}@hub.local` }, true), { state: "unmanaged" });
  }
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(calls, []);
});

test("SSO ids are provisioned when PROVISIONER_URL is set, and only then", async () => {
  const id = "u-0123456789ab";
  assert.equal(P.managedHarness(id), true);
  const st = await P.harnessState({ id, email: "x@corp.example" });
  assert.equal(st.state, "preparing");
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(calls.includes("POST /harness/ensure"), calls.join(","));
  const url = process.env.PROVISIONER_URL;
  delete process.env.PROVISIONER_URL;
  try {
    assert.equal(P.managedHarness(id), false);
    assert.deepEqual(await P.harnessState({ id: "u-0123456789ac", email: "y@corp.example" }), { state: "unmanaged" });
  } finally {
    process.env.PROVISIONER_URL = url;
  }
  for (const bad of ["u-0123456789AB", "u-0123456789a", "u-0123456789abc", "", null, 5]) assert.equal(P.isProvisionedId(bad), false, String(bad));
});

test("server.ts only provisions managed (SSO) harnesses, also on a refused WS connection", () => {
  const src = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /provisioningEnabled\(\)/);
  assert.equal(src.match(/managedHarness\(user\)/g)?.length, 2);
  assert.match(src, /if \(managedHarness\(user\) && \/ENOTFOUND\|EAI_AGAIN\|ECONNREFUSED\|EHOSTUNREACH\/\.test\(e\.message\)\)/);
});
