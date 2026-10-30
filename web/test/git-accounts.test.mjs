// Git accounts: validation, matching, and the store against a temp sqlite (lib/git-accounts.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { defaultUsername, gitAccountStore, MAX_ACCOUNTS, MIN_TOKEN, normalizeHost, pathSegments, normalizePrefix, pickAccount, prefixCovers, validateAccount, validToken } from "../lib/git-accounts.ts";

const key = randomBytes(32);
const fresh = () => {
  const db = new Database(":memory:");
  return { db, store: gitAccountStore(db, () => key) };
};
const acct = (o = {}) => ({ host: "github.com", prefix: "", username: "", token: "ghp_" + "a".repeat(36), label: "", ...o });

test("normalizeHost: host names with an optional port, nothing else", () => {
  assert.equal(normalizeHost("github.com"), "github.com");
  assert.equal(normalizeHost(" GitLab.Example.COM "), "gitlab.example.com");
  assert.equal(normalizeHost("git.example.com:8443"), "git.example.com:8443");
  assert.equal(normalizeHost("localhost"), "localhost");
  for (const bad of ["https://github.com", "github.com/org", "user@github.com", "github.com:", "github.com:abc", "github.com:0", "github.com:70000", "-x.com", "x-.com", "a..b", "", " ", "git hub.com", "github.com?x", "github.com#x", "[::1]", "a_b.com", null, 5, "a".repeat(64) + ".com"])
    assert.equal(normalizeHost(bad), null, String(bad));
});

test("normalizePrefix: whole segments, slashes trimmed, no traversal", () => {
  assert.equal(normalizePrefix("my-org/"), "my-org");
  assert.equal(normalizePrefix("/my-org/repo.git"), "my-org/repo");
  assert.equal(normalizePrefix("group/sub.group/"), "group/sub.group");
  assert.equal(normalizePrefix(""), "");
  assert.equal(normalizePrefix(undefined), "");
  assert.equal(normalizePrefix("/"), "");
  for (const bad of ["a//b", "a/../b", "../x", "./x", "a b", "a?b", "a%2fb", "x".repeat(201), 5, "a\nb"]) assert.equal(normalizePrefix(bad), null, String(bad));
  assert.equal(normalizePrefix("x".repeat(200)), "x".repeat(200));
});

test("defaultUsername: x-access-token for github.com, oauth2 elsewhere", () => {
  assert.equal(defaultUsername("github.com"), "x-access-token");
  assert.equal(defaultUsername("gitlab.com"), "oauth2");
  assert.equal(defaultUsername("github.example.com"), "oauth2");
});

test("validToken: 16..4096 characters, single line", () => {
  assert.equal(MIN_TOKEN, 16);
  assert.ok(validToken("t".repeat(16)));
  assert.ok(validToken("t".repeat(4096)));
  for (const bad of ["", "t", "t".repeat(15), "t".repeat(4097), "a".repeat(10) + "\nb".repeat(5), "a\rb".repeat(6), "a\u0000b".repeat(6), "a\tb".repeat(6), 5, null]) assert.ok(!validToken(bad), JSON.stringify(bad));
});

test("validateAccount: defaults and errors", () => {
  const ok = validateAccount(acct({ host: "GitHub.com", prefix: "my-org/" }));
  assert.ok(ok.ok);
  assert.deepEqual({ ...ok.value, token: "-" }, { host: "github.com", prefix: "my-org", username: "x-access-token", token: "-", label: "github.com/my-org" });
  const gl = validateAccount(acct({ host: "gitlab.example.com", username: "  ", label: " Work " }));
  assert.equal(gl.value.username, "oauth2");
  assert.equal(gl.value.label, "Work");
  assert.equal(validateAccount(acct({ username: "bot" })).value.username, "bot");
  for (const bad of [null, [], "x", acct({ host: "https://github.com" }), acct({ prefix: "../x" }), acct({ token: "" }), acct({ token: "a\nusername=evil-and-more" }), acct({ token: "short-token" }), acct({ token: "t".repeat(4097) }),
    acct({ username: "a b" }), acct({ username: "a=b" }), acct({ username: "a\nb" }), acct({ label: "x".repeat(81) }), acct({ label: "a\nb" })])
    assert.equal(validateAccount(bad).ok, false, JSON.stringify(bad));
});

test("prefixCovers: whole leading segments, .git ignored", () => {
  assert.ok(prefixCovers("", undefined));
  assert.ok(prefixCovers("", "any/repo.git"));
  assert.ok(prefixCovers("my-org", "my-org/repo.git"));
  assert.ok(prefixCovers("my-org", "/my-org/repo"));
  assert.ok(prefixCovers("my-org/repo", "my-org/repo.git"));
  assert.ok(prefixCovers("my-org/repo", "my-org/repo/info/refs"));
  assert.ok(!prefixCovers("my-org", "my-org-evil/repo.git"));
  assert.ok(!prefixCovers("my-org", "other/my-org/repo"));
  assert.ok(!prefixCovers("my-org/repo", "my-org"));
  assert.ok(!prefixCovers("my-org", undefined));
  assert.ok(!prefixCovers("my-org", ""));
});

test("pathSegments / prefixCovers: raw paths with traversal or encoding match nothing", () => {
  assert.deepEqual(pathSegments("my-org/repo.git"), ["my-org", "repo"]);
  assert.deepEqual(pathSegments("/my-org/repo.git/"), ["my-org", "repo"]);
  assert.deepEqual(pathSegments(undefined), []);
  assert.deepEqual(pathSegments(""), []);
  for (const bad of ["my-org/../other-org/repo.git", "my-org/./repo.git", "my-org//repo.git", "../x", "my-org/%2e%2e/other/repo", "my-org%2Frepo", "my-org/repo?x=1", "my-org/repo#a", "my-org\\..\\x", "a\nb", "//", "my-org/repo//"])
    assert.equal(pathSegments(bad), null, bad);
  assert.ok(!prefixCovers("my-org", "my-org/../other-org/repo.git"));
  assert.ok(!prefixCovers("", "my-org/../other-org/repo.git"));
  const list = [{ id: "org", host: "github.com", prefix: "my-org" }, { id: "any", host: "github.com", prefix: "" }];
  for (const path of ["my-org/../other-org/repo.git", "my-org/%2e%2e/other-org/repo.git", "my-org//repo.git"])
    assert.equal(pickAccount(list, { protocol: "https", host: "github.com", path }), null, path);
});

test("pickAccount: https only, exact host, longest prefix wins", () => {
  const list = [
    { id: "any", host: "github.com", prefix: "" },
    { id: "org", host: "github.com", prefix: "my-org" },
    { id: "repo", host: "github.com", prefix: "my-org/special" },
    { id: "gl", host: "gitlab.example.com:8443", prefix: "" },
  ];
  const pick = (q) => pickAccount(list, q)?.id ?? null;
  assert.equal(pick({ protocol: "https", host: "github.com", path: "someone/x.git" }), "any");
  assert.equal(pick({ protocol: "https", host: "github.com", path: "my-org/x.git" }), "org");
  assert.equal(pick({ protocol: "https", host: "github.com", path: "my-org/special.git" }), "repo");
  assert.equal(pick({ protocol: "https", host: "GitHub.com", path: "my-org/special.git" }), "repo");
  assert.equal(pick({ protocol: "https", host: "github.com" }), "any");
  assert.equal(pick({ protocol: "http", host: "github.com", path: "my-org/x.git" }), null);
  assert.equal(pick({ host: "github.com", path: "my-org/x.git" }), null);
  assert.equal(pick({ protocol: "https", host: "evil-github.com", path: "my-org/x.git" }), null);
  assert.equal(pick({ protocol: "https", host: "github.com.evil", path: "my-org/x.git" }), null);
  assert.equal(pick({ protocol: "https", host: "gitlab.example.com", path: "a/b" }), null);
  assert.equal(pick({ protocol: "https", host: "gitlab.example.com:8443", path: "a/b" }), "gl");
  // Order does not matter.
  assert.equal(pickAccount([...list].reverse(), { protocol: "https", host: "github.com", path: "my-org/special/x" }).id, "repo");
  assert.equal(pickAccount([list[1]], { protocol: "https", host: "github.com", path: "other/x" }), null);
});

test("store: add, list without tokens, last4, delete", () => {
  const { db, store } = fresh();
  const a = store.add("u1", acct({ token: "ghp_SECRETVALUE1234", prefix: "my-org/" }), 1000);
  assert.deepEqual(a, { id: a.id, host: "github.com", prefix: "my-org", username: "x-access-token", label: "github.com/my-org", last4: "1234", createdAt: 1000 });
  assert.match(a.id, /^[0-9a-f]{24}$/);
  const listed = store.list("u1");
  assert.deepEqual(listed, [a]);
  assert.ok(!JSON.stringify(listed).includes("SECRETVALUE"));
  // Not in the database in clear either.
  assert.ok(!JSON.stringify(db.prepare("SELECT * FROM git_accounts").all()).includes("SECRETVALUE"));
  assert.deepEqual(store.list("u2"), []);
  assert.equal(store.remove("u2", a.id), false);
  assert.equal(store.list("u1").length, 1);
  assert.equal(store.remove("u1", a.id), true);
  assert.deepEqual(store.list("u1"), []);
});

test("store: limits and duplicates", () => {
  const { store } = fresh();
  for (let i = 0; i < MAX_ACCOUNTS; i++) store.add("u1", acct({ prefix: `org${i}` }));
  assert.equal(MAX_ACCOUNTS, 20);
  assert.throws(() => store.add("u1", acct({ prefix: "one-more" })), /at most 20/);
  store.add("u2", acct({ prefix: "org0" }));
  assert.throws(() => store.add("u2", acct({ prefix: "org0/", token: "other-token-0123456" })), /exists already/);
  assert.throws(() => store.add("u2", acct({ host: "https://x" })), /host/);
});

test("store: credentialFor matches only the user's own accounts", () => {
  const { store } = fresh();
  const a1 = store.add("u1", acct({ token: "tok-u1-any-0123456" }));
  const a1org = store.add("u1", acct({ token: "tok-u1-org-0123456", prefix: "my-org", username: "bot" }));
  store.add("u2", acct({ token: "tok-u2-special-0123", prefix: "my-org/special" }));
  const q = (path, protocol = "https", host = "github.com") => ({ protocol, host, path });
  assert.deepEqual(store.credentialFor("u1", q("x/y.git")), { account: a1.id, username: "x-access-token", password: "tok-u1-any-0123456" });
  assert.deepEqual(store.credentialFor("u1", q("my-org/special.git")), { account: a1org.id, username: "bot", password: "tok-u1-org-0123456" });
  assert.equal(store.credentialFor("u2", q("x/y.git")), null);
  assert.equal(store.credentialFor("u2", q("my-org/special.git")).password, "tok-u2-special-0123");
  assert.equal(store.credentialFor("u3", q("my-org/special.git")), null);
  assert.equal(store.credentialFor("u1", q("x/y.git", "http")), null);
});

test("store: editing host, prefix or username in the database makes the token undecryptable", () => {
  for (const [col, val, q] of [["host", "evil.example", { host: "evil.example", path: "my-org/r" }], ["prefix", "", { host: "github.com", path: "other/r" }], ["username", "attacker", { host: "github.com", path: "my-org/r" }]]) {
    const { db, store } = fresh();
    const a = store.add("u1", acct({ token: "tok-u1-0123456789ab", prefix: "my-org" }));
    assert.equal(store.credentialFor("u1", { protocol: "https", host: "github.com", path: "my-org/r" }).password, "tok-u1-0123456789ab");
    db.prepare(`UPDATE git_accounts SET ${col} = ? WHERE id = ?`).run(val, a.id);
    assert.equal(store.credentialFor("u1", { protocol: "https", ...q }), null, col);
  }
});

test("store: removeAll and count, per user", () => {
  const { store } = fresh();
  store.add("u1", acct({ prefix: "a" }));
  store.add("u1", acct({ prefix: "b" }));
  store.add("u2", acct());
  assert.equal(store.count("u1"), 2);
  assert.equal(store.removeAll("u1"), 2);
  assert.equal(store.count("u1"), 0);
  assert.equal(store.count("u2"), 1);
});

test("store: a token moved to another row or user, or a wrong key, does not decrypt", () => {
  const { db, store } = fresh();
  const a = store.add("u1", acct({ token: "tok-u1-0123456789ab" }));
  const b = store.add("u2", acct({ token: "tok-u2-0123456789ab" }));
  db.prepare("UPDATE git_accounts SET token_enc = (SELECT token_enc FROM git_accounts WHERE id = ?) WHERE id = ?").run(a.id, b.id);
  assert.equal(store.credentialFor("u2", { protocol: "https", host: "github.com", path: "x" }), null);
  const other = gitAccountStore(db, () => randomBytes(32));
  assert.equal(other.credentialFor("u1", { protocol: "https", host: "github.com", path: "x" }), null);
  assert.equal(store.credentialFor("u1", { protocol: "https", host: "github.com", path: "x" }).password, "tok-u1-0123456789ab");
});
