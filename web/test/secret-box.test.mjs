// AES-256-GCM for secrets at rest (lib/secret-box.ts). Run: npm test (from web/).
import { test } from "node:test";
import assert from "node:assert/strict";
import { hkdfSync, randomBytes } from "node:crypto";
import { open, seal, secretsKeyFrom, SECRETS_INFO } from "../lib/secret-box.ts";

const key = randomBytes(32);

test("seal/open roundtrip, unicode and long values", () => {
  for (const v of ["ghp_abc", "", "пароль с пробелами", "x".repeat(4096)]) assert.equal(open(key, seal(key, v, "aad"), "aad"), v);
});

test("every seal uses a fresh IV", () => {
  assert.notEqual(seal(key, "same", "a"), seal(key, "same", "a"));
  assert.match(seal(key, "v", "a"), /^v1\.[A-Za-z0-9_-]+$/);
});

test("tampering anywhere is detected", () => {
  const s = seal(key, "secret-token", "aad");
  const raw = Buffer.from(s.slice(3), "base64url");
  for (const at of [0, 11, 12, 27, 28, raw.length - 1]) {
    const b = Buffer.from(raw);
    b[at] ^= 1;
    assert.throws(() => open(key, "v1." + b.toString("base64url"), "aad"), undefined, `byte ${at}`);
  }
  assert.throws(() => open(key, "v1." + raw.subarray(0, 20).toString("base64url"), "aad"));
  assert.throws(() => open(key, "v2." + s.slice(3), "aad"));
  assert.throws(() => open(key, s.slice(3), "aad"));
});

test("wrong key or wrong aad fails", () => {
  const s = seal(key, "t", "git:u1:a1");
  assert.throws(() => open(randomBytes(32), s, "git:u1:a1"));
  assert.throws(() => open(key, s, "git:u2:a1"));
  assert.throws(() => open(key, s, "git:u1:a2"));
  assert.throws(() => seal(randomBytes(16), "t", "a"));
  assert.throws(() => open(randomBytes(16), s, "a"));
});

test("secretsKeyFrom: PADDOCK_SECRETS_KEY wins, must be 64 hex", () => {
  const hex = "ab".repeat(32);
  assert.deepEqual(secretsKeyFrom({ PADDOCK_SECRETS_KEY: hex, BETTER_AUTH_SECRET: "x".repeat(40) }), Buffer.from(hex, "hex"));
  for (const bad of ["ab".repeat(31), "zz".repeat(32), "ab".repeat(33)]) assert.throws(() => secretsKeyFrom({ PADDOCK_SECRETS_KEY: bad }));
});

test("secretsKeyFrom: HKDF-SHA256 of BETTER_AUTH_SECRET with info paddock-secrets-v1", () => {
  const secret = "s".repeat(32);
  const want = Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), "paddock-secrets-v1", 32));
  assert.equal(SECRETS_INFO, "paddock-secrets-v1");
  assert.deepEqual(secretsKeyFrom({ BETTER_AUTH_SECRET: secret }), want);
  assert.equal(secretsKeyFrom({ BETTER_AUTH_SECRET: secret }).length, 32);
  assert.notDeepEqual(secretsKeyFrom({ BETTER_AUTH_SECRET: "t".repeat(32) }), want);
  // The derived key is not the secret itself.
  assert.notDeepEqual(secretsKeyFrom({ BETTER_AUTH_SECRET: secret }), Buffer.from(secret).subarray(0, 32));
  assert.throws(() => secretsKeyFrom({}));
  assert.throws(() => secretsKeyFrom({ BETTER_AUTH_SECRET: "short" }));
});
