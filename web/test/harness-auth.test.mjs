// Harness callers: bearer token → harness id → web user (lib/harness-auth.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { bearerOf, clearTokenCache, findUserId, harnessIdForToken, MIN_TOKEN, rateLimiter, userIdOfHarness } from "../lib/harness-auth.ts";

const hex = (c) => c.repeat(64);
function tokensDir() {
  const dir = mkdtempSync(join(tmpdir(), "paddock-tokens-"));
  writeFileSync(join(dir, "alice.token"), hex("a") + "\n");
  writeFileSync(join(dir, "u-0123456789ab.token"), hex("b") + "\n");
  writeFileSync(join(dir, "short.token"), "abc\n");
  writeFileSync(join(dir, "Bad_Name.token"), hex("c") + "\n");
  writeFileSync(join(dir, "notes.txt"), hex("d") + "\n");
  return dir;
}

test("bearerOf", () => {
  assert.equal(bearerOf("Bearer " + hex("a")), hex("a"));
  assert.equal(bearerOf(["Bearer xyz"]), "xyz");
  for (const bad of [undefined, null, "", "Bearer", "Bearer ", "bearer xyz", "Basic xyz", "Bearer a b", "Bearer xyz\n", "xyz"]) assert.equal(bearerOf(bad), null, String(bad));
});

test("harnessIdForToken: the token file decides which harness is calling", () => {
  const dir = tokensDir();
  try {
    assert.equal(harnessIdForToken(dir, hex("a")), "alice");
    assert.equal(harnessIdForToken(dir, hex("b")), "u-0123456789ab");
    // Wrong token, a prefix or extension of a real one, a token from a file with a bad name or extension.
    for (const bad of [hex("e"), hex("a").slice(0, 63), hex("a") + "a", hex("c"), hex("d"), "abc", "", null, undefined])
      assert.equal(harnessIdForToken(dir, bad), null, String(bad));
    assert.equal(MIN_TOKEN, 32);
    assert.equal(harnessIdForToken(dir, "abc".padEnd(31, "x")), null);
    assert.equal(harnessIdForToken(join(dir, "missing"), hex("a")), null);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("harnessIdForToken: a short token file never matches, even with the same short token", () => {
  const dir = mkdtempSync(join(tmpdir(), "paddock-tokens-"));
  try {
    writeFileSync(join(dir, "bob.token"), "x".repeat(31));
    assert.equal(harnessIdForToken(dir, "x".repeat(31)), null);
    writeFileSync(join(dir, "bob.token"), "x".repeat(32));
    assert.equal(harnessIdForToken(dir, "x".repeat(32), { ttlMs: 0 }), "bob");
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("harnessIdForToken: digests are cached; a new or removed file is seen at once, an in-place rewrite after the TTL", () => {
  clearTokenCache();
  const dir = mkdtempSync(join(tmpdir(), "paddock-tokens-"));
  try {
    writeFileSync(join(dir, "alice.token"), hex("a"));
    assert.equal(harnessIdForToken(dir, hex("a"), { now: 0 }), "alice");
    writeFileSync(join(dir, "bob.token"), hex("b"));
    assert.equal(harnessIdForToken(dir, hex("b"), { now: 1 }), "bob");
    unlinkSync(join(dir, "bob.token"));
    assert.equal(harnessIdForToken(dir, hex("b"), { now: 2 }), null);
    // Rewritten in place (the directory does not change): the old token works until the cache expires.
    writeFileSync(join(dir, "alice.token"), hex("c"));
    assert.equal(harnessIdForToken(dir, hex("a"), { now: 3, ttlMs: 5000 }), "alice");
    assert.equal(harnessIdForToken(dir, hex("c"), { now: 3, ttlMs: 5000 }), null);
    assert.equal(harnessIdForToken(dir, hex("a"), { now: 5003, ttlMs: 5000 }), null);
    assert.equal(harnessIdForToken(dir, hex("c"), { now: 5004, ttlMs: 5000 }), "alice");
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("userIdOfHarness: from harness_users, nothing for unknown harnesses or a missing table", () => {
  const db = new Database(":memory:");
  assert.equal(userIdOfHarness(db, "alice"), null);
  db.exec("CREATE TABLE harness_users (user_id TEXT PRIMARY KEY, harness_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL)");
  db.prepare("INSERT INTO harness_users VALUES (?, ?, ?)").run("user-1", "alice", 1);
  db.prepare("INSERT INTO harness_users VALUES (?, ?, ?)").run("user-2", "u-0123456789ab", 1);
  assert.equal(userIdOfHarness(db, "alice"), "user-1");
  assert.equal(userIdOfHarness(db, "u-0123456789ab"), "user-2");
  assert.equal(userIdOfHarness(db, "bob"), null);
});

test("rateLimiter: max per window per key", () => {
  let t = 0;
  const allow = rateLimiter(3, 60_000, () => t);
  assert.deepEqual([allow("a"), allow("a"), allow("a"), allow("a")], [true, true, true, false]);
  assert.equal(allow("b"), true);
  t = 59_999;
  assert.equal(allow("a"), false);
  t = 60_000;
  assert.equal(allow("a"), true);
});

test("rateLimiter.blocked looks without counting", () => {
  let t = 0;
  const fail = rateLimiter(2, 60_000, () => t);
  assert.equal(fail.blocked("x"), false);
  fail("x");
  assert.equal(fail.blocked("x"), false);
  fail("x");
  assert.equal(fail.blocked("x"), true);
  assert.equal(fail.blocked("x"), true);
  assert.equal(fail.blocked("y"), false);
  t = 60_000;
  assert.equal(fail.blocked("x"), false);
});

test("findUserId: by harness id or email (case-insensitive), nothing else", () => {
  const db = new Database(":memory:");
  assert.equal(findUserId(db, "alice"), null);
  db.exec(`CREATE TABLE harness_users (user_id TEXT PRIMARY KEY, harness_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
    CREATE TABLE "user" ("id" TEXT PRIMARY KEY, "email" TEXT NOT NULL)`);
  db.prepare("INSERT INTO harness_users VALUES (?, ?, ?)").run("user-1", "alice", 1);
  db.prepare(`INSERT INTO "user" VALUES (?, ?)`).run("user-2", "Bob.Smith@Example.com");
  assert.equal(findUserId(db, "alice"), "user-1");
  assert.equal(findUserId(db, "bob.smith@example.com"), "user-2");
  for (const bad of ["", " ", "bob", "%", "bob.smith@example", "Alice"]) assert.equal(findUserId(db, bad), null, bad);
});
