// Pure identity rules: harness ids, group policy, admins. Run: node --test test/ (from web/).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { checkGroups, chooseHarnessId, deriveHarnessId, discoveryUrl, groupsOf, isAdmin, isValidHarnessId, legacyHarnessId, parseList } from "../lib/identity.ts";

test("deriveHarnessId: u- + first 12 hex of sha256(salt:issuer:sub)", () => {
  const want = "u-" + createHash("sha256").update("s3:https://idp.example/o:abc").digest("hex").slice(0, 12);
  assert.equal(deriveHarnessId("s3", "https://idp.example/o", "abc"), want);
  assert.match(want, /^u-[0-9a-f]{12}$/);
});

test("deriveHarnessId: a trailing slash on the issuer does not move the user", () => {
  assert.equal(deriveHarnessId("s", "https://idp.example/o/", "abc"), deriveHarnessId("s", "https://idp.example/o", "abc"));
});

test("deriveHarnessId: salt, issuer and sub all matter", () => {
  const base = deriveHarnessId("s", "https://idp.example/o", "abc");
  assert.notEqual(deriveHarnessId("t", "https://idp.example/o", "abc"), base);
  assert.notEqual(deriveHarnessId("s", "https://idp.example/p", "abc"), base);
  assert.notEqual(deriveHarnessId("s", "https://idp.example/o", "abd"), base);
});

test("deriveHarnessId: empty sub is refused", () => {
  assert.throws(() => deriveHarnessId("s", "https://idp.example/o", ""));
});

test("legacyHarnessId: email local part, a-z0-9- only", () => {
  assert.equal(legacyHarnessId("alice@hub.local"), "alice");
  assert.equal(legacyHarnessId("ops-2@hub.local"), "ops-2");
  assert.throws(() => legacyHarnessId("first.last@corp.example"));
  assert.throws(() => legacyHarnessId("Alice@hub.local"));
  assert.throws(() => legacyHarnessId("@hub.local"));
});

test("chooseHarnessId: a stored id always wins", () => {
  assert.deepEqual(chooseHarnessId({ stored: "bob", email: "x.y@corp", hasCredential: false, oidcSub: "1", issuer: "i", salt: "s" }), { id: "bob", store: false });
});

test("chooseHarnessId: OIDC-only user gets a derived id, password user keeps the legacy name", () => {
  assert.deepEqual(chooseHarnessId({ email: "first.last@corp", hasCredential: false, oidcSub: "42", issuer: "https://idp.example/o", salt: "s" }),
    { id: deriveHarnessId("s", "https://idp.example/o", "42"), store: true });
  assert.deepEqual(chooseHarnessId({ email: "alice@hub.local", hasCredential: true, oidcSub: "42", issuer: "https://idp.example/o", salt: "s" }), { id: "alice", store: true });
  assert.deepEqual(chooseHarnessId({ email: "alice@hub.local", hasCredential: false }), { id: "alice", store: true });
});

test("isValidHarnessId", () => {
  for (const ok of ["u-0123456789ab", "alice", "a", "ops-2", "a".repeat(32)]) assert.ok(isValidHarnessId(ok), ok);
  for (const bad of ["", "u-0123456789AB", "Alice", "a".repeat(33), "a_b", "a.b", "../x", "alice\n", "u-0123456789abc0".repeat(3), 7, null, undefined])
    assert.ok(!isValidHarnessId(bad), String(bad));
});

test("groupsOf: array or space/comma separated string, nothing else", () => {
  assert.deepEqual(groupsOf({ groups: ["a", "b", 3, ""] }), ["a", "b"]);
  assert.deepEqual(groupsOf({ groups: "a, b c" }), ["a", "b", "c"]);
  assert.deepEqual(groupsOf({ roles: ["x"] }, "roles"), ["x"]);
  assert.deepEqual(groupsOf({}), []);
  assert.deepEqual(groupsOf(null), []);
  assert.deepEqual(groupsOf({ groups: { a: 1 } }), []);
});

test("checkGroups: empty allow-list admits everyone", () => {
  assert.deepEqual(checkGroups([], [], []), { allowed: true, admin: false });
});

test("checkGroups: membership in any allowed group admits, none rejects", () => {
  assert.equal(checkGroups(["dev", "x"], ["ops", "dev"], []).allowed, true);
  assert.equal(checkGroups(["x"], ["ops", "dev"], []).allowed, false);
  assert.equal(checkGroups([], ["ops"], []).allowed, false);
  assert.equal(checkGroups(["Dev"], ["dev"], []).allowed, false);
});

test("checkGroups: admin groups", () => {
  assert.equal(checkGroups(["admins"], [], ["admins"]).admin, true);
  assert.equal(checkGroups(["dev"], [], ["admins"]).admin, false);
  assert.equal(checkGroups(["dev"], [], []).admin, false);
});

test("isAdmin: ADMIN_USERS by harness id or email, or OIDC admin group", () => {
  assert.equal(isAdmin({ harnessId: "alice", email: "alice@hub.local", adminUsers: ["alice"], oidcAdmin: false }), true);
  assert.equal(isAdmin({ harnessId: "u-0123456789ab", email: "First.Last@corp", adminUsers: ["first.last@corp"], oidcAdmin: false }), true);
  assert.equal(isAdmin({ harnessId: "bob", email: "bob@hub.local", adminUsers: ["alice"], oidcAdmin: false }), false);
  assert.equal(isAdmin({ harnessId: "bob", email: "bob@hub.local", adminUsers: [], oidcAdmin: true }), true);
  assert.equal(isAdmin({ harnessId: "", email: "bob@hub.local", adminUsers: [""], oidcAdmin: false }), false);
});

test("parseList and discoveryUrl", () => {
  assert.deepEqual(parseList(" a, b ,,c d "), ["a", "b", "c", "d"]);
  assert.deepEqual(parseList(undefined), []);
  assert.equal(discoveryUrl("https://idp.example/o/"), "https://idp.example/o/.well-known/openid-configuration");
});
