// Harness callers: bearer token → harness id → web user (lib/harness-auth.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { bearerOf, findUserId, harnessIdForToken, MIN_TOKEN, rateLimiter, userIdOfHarness } from "../lib/harness-auth.ts";

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
    assert.equal(harnessIdForToken(dir, "x".repeat(32)), "bob");
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
