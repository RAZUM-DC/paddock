// Secret request store (lib/secret-requests.ts): one-time read, TTL, isolation, limits, validation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isRequestId, MAX_PENDING, secretRequestStore, TTL_MS, validateValue, validFile } from "../lib/secret-requests.ts";

const req = (o = {}) => ({ name: "OPENAI_API_KEY", file: "/workspace/app/.env", reason: "to call the API", threadId: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b", ...o });

test("create: public fields only, random 128-bit id, 15 min TTL", () => {
  const s = secretRequestStore();
  const r = s.create("alice", req(), 1000);
  assert.match(r.id, /^[0-9a-f]{32}$/);
  assert.ok(isRequestId(r.id));
  assert.deepEqual({ ...r, id: "-" }, { id: "-", name: "OPENAI_API_KEY", file: "/workspace/app/.env", reason: "to call the API", threadId: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b", createdAt: 1000, expiresAt: 1000 + 15 * 60_000 });
  assert.equal(TTL_MS, 15 * 60_000);
  assert.notEqual(s.create("alice", req(), 1000).id, r.id);
  assert.equal(s.create("alice", req({ threadId: "bad id!" }), 1000).threadId, null);
  assert.equal(s.create("alice", req({ reason: undefined }), 1000).reason, "");
});

test("create: name, file and reason are validated", () => {
  const s = secretRequestStore({ maxPending: 100 });
  for (const name of ["A", "_X", "OPENAI_API_KEY", "A".repeat(64)]) s.create("u", req({ name }));
  for (const name of ["", "a", "1A", "A-B", "A B", "A".repeat(65), "A\n", 5, undefined]) assert.throws(() => s.create("u", req({ name })), /name/, String(name));
  for (const file of ["/workspace", "/workspace/", "relative/.env", "/etc/passwd", "/workspace/../etc/x", "/workspace/a/./b", "/workspacex/.env", "/workspace/a\nb", "/workspace/a\tb", "/workspace/" + "a".repeat(1100), 7])
    assert.throws(() => s.create("u", req({ file })), /file/, String(file));
  assert.throws(() => s.create("u", req({ reason: "x".repeat(301) })), /reason/);
  assert.throws(() => s.create("u", req({ reason: "a\nb" })), /reason/);
  assert.throws(() => s.create("u", req({ reason: 5 })), /reason/);
  assert.throws(() => s.create("u", null), /name/);
});

test("validFile and validateValue", () => {
  assert.ok(validFile("/workspace/.env"));
  assert.ok(validFile("/tmp/w/x/.env", "/tmp/w"));
  assert.ok(!validFile("/workspace/.env", "/tmp/w"));
  assert.equal(validateValue("v"), "v");
  assert.equal(validateValue("x".repeat(8192)), "x".repeat(8192));
  for (const bad of ["", "x".repeat(8193), "я".repeat(4097), "a\nb", "a\rb", "a\u0000b", 5, null, undefined]) assert.throws(() => validateValue(bad), undefined, JSON.stringify(bad));
  // Spaces, quotes, # and = are fine: the command quotes them.
  assert.equal(validateValue(` a "b" 'c' #d =e `), ` a "b" 'c' #d =e `);
});

test("the value is handed out exactly once, then wiped", () => {
  const s = secretRequestStore();
  const r = s.create("alice", req(), 0);
  assert.deepEqual(s.collect("alice", r.id, 1), { status: "pending" });
  s.fulfil("alice", r.id, "sk-secret", 2);
  assert.equal(s.heldValues(), 1);
  assert.deepEqual(s.pending("alice", 3), []);
  assert.deepEqual(s.collect("alice", r.id, 4), { status: "fulfilled", value: "sk-secret" });
  assert.equal(s.heldValues(), 0);
  assert.deepEqual(s.collect("alice", r.id, 5), { status: "consumed" });
  assert.throws(() => s.fulfil("alice", r.id, "again", 6), /consumed/);
});

test("decline and cancel", () => {
  const s = secretRequestStore();
  const a = s.create("alice", req(), 0);
  s.decline("alice", a.id, 1);
  assert.deepEqual(s.collect("alice", a.id, 2), { status: "declined" });
  assert.throws(() => s.fulfil("alice", a.id, "late", 3), /declined/);
  assert.throws(() => s.decline("alice", a.id, 3), /declined/);
  const b = s.create("alice", req(), 0);
  s.fulfil("alice", b.id, "v", 1);
  s.cancel("alice", b.id, 2);
  assert.equal(s.heldValues(), 0);
  assert.deepEqual(s.collect("alice", b.id, 3), { status: "expired" });
});

test("TTL: pending and uncollected requests expire, values are wiped, finished ones are forgotten later", () => {
  const s = secretRequestStore({ ttlMs: 1000, keepDoneMs: 500 });
  const a = s.create("alice", req(), 0);
  const b = s.create("alice", req(), 0);
  s.fulfil("alice", b.id, "never-collected", 10);
  assert.equal(s.pending("alice", 999).length, 1);
  assert.deepEqual(s.pending("alice", 1000), []);
  assert.equal(s.heldValues(), 0);
  assert.deepEqual(s.collect("alice", a.id, 1001), { status: "expired" });
  assert.deepEqual(s.collect("alice", b.id, 1001), { status: "expired" });
  assert.throws(() => s.fulfil("alice", a.id, "late", 1002), /expired/);
  assert.throws(() => s.collect("alice", a.id, 1500), /no such request/);
  assert.equal(s.size(), 0);
});

test("requests are isolated per owner", () => {
  const s = secretRequestStore();
  const a = s.create("alice", req(), 0);
  s.create("bob", req({ name: "BOB_KEY" }), 0);
  assert.deepEqual(s.pending("alice", 1).map((r) => r.name), ["OPENAI_API_KEY"]);
  assert.deepEqual(s.pending("bob", 1).map((r) => r.name), ["BOB_KEY"]);
  for (const op of [() => s.fulfil("bob", a.id, "x", 1), () => s.decline("bob", a.id, 1), () => s.collect("bob", a.id, 1), () => s.cancel("bob", a.id, 1)])
    assert.throws(op, (e) => e.status === 404);
  s.fulfil("alice", a.id, "v", 2);
  assert.throws(() => s.collect("bob", a.id, 3), (e) => e.status === 404);
  assert.equal(s.collect("alice", a.id, 3).value, "v");
  assert.throws(() => s.collect("alice", "f".repeat(32), 3), (e) => e.status === 404);
  assert.throws(() => s.collect("alice", "../x", 3), (e) => e.status === 404);
});

test("at most 5 pending per owner; answered ones free a slot", () => {
  const s = secretRequestStore();
  assert.equal(MAX_PENDING, 5);
  const ids = Array.from({ length: 5 }, () => s.create("alice", req(), 0).id);
  assert.throws(() => s.create("alice", req(), 0), (e) => e.status === 429);
  s.create("bob", req(), 0);
  s.decline("alice", ids[0], 1);
  s.create("alice", req(), 2);
  assert.throws(() => s.create("alice", req(), 2), (e) => e.status === 429);
});

test("isSecretRequestError works across copies of the class (server.ts and Next load the module separately)", async () => {
  const { isSecretRequestError, SecretRequestError } = await import("../lib/secret-requests.ts");
  class Other extends Error {
    name = "SecretRequestError";
    status = 404;
  }
  assert.ok(isSecretRequestError(new SecretRequestError("x", 409)));
  assert.ok(isSecretRequestError(new Other("x")));
  assert.ok(!isSecretRequestError(new Error("x")));
  assert.ok(!isSecretRequestError({ name: "SecretRequestError", status: 400 }));
});
