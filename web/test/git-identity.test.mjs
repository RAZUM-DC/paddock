// Commit identity file written into the harness home (lib/git-identity.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GIT_IDENTITY_FILE, identityConfig, parseIdentity, validateIdentity } from "../lib/git-identity.ts";

test("the file is the one /etc/gitconfig of the harness image includes", () => {
  assert.equal(GIT_IDENTITY_FILE, "/home/codex/.codex/paddock/gitconfig");
});

test("validateIdentity", () => {
  assert.equal(validateIdentity({ name: "Ada Lovelace", email: "ada@example.com" }), null);
  assert.equal(validateIdentity({ name: "", email: "" }), null);
  for (const bad of [{ name: "Ada", email: "" }, { name: "", email: "a@b.c" }, { name: "A\nB", email: "a@b.c" }, { name: "A", email: "a b@c" }, { name: "A", email: "nope" },
    { name: "A", email: "a@b.c\n[core]" }, { name: "x".repeat(201), email: "a@b.c" }, { name: "A", email: 'a"@b.c' }])
    assert.notEqual(validateIdentity(bad), null, JSON.stringify(bad));
});

test("identityConfig escapes quotes and backslashes; real git reads back the same values", () => {
  const id = { name: `Ada "the Countess" \\ Lovelace; #1`, email: "ada+bot@example.com" };
  const text = identityConfig(id);
  assert.match(text, /\[user\]\n\tname = ".*"\n\temail = "ada\+bot@example\.com"\n$/);
  assert.deepEqual(parseIdentity(text), id);
  const dir = mkdtempSync(join(tmpdir(), "paddock-gitcfg-"));
  try {
    writeFileSync(join(dir, "cfg"), text);
    const get = (k) => execFileSync("git", ["config", "--file", join(dir, "cfg"), "--get", k], { encoding: "utf8" }).replace(/\n$/, "");
    assert.equal(get("user.name"), id.name);
    assert.equal(get("user.email"), id.email);
  } finally {
    rmSync(dir, { recursive: true });
  }
  assert.throws(() => identityConfig({ name: "A\n[core]\n\tsshCommand = x", email: "a@b.c" }));
  assert.equal(parseIdentity(identityConfig({ name: "", email: "" })).name, "");
});

test("parseIdentity: hand-written forms, other sections ignored", () => {
  assert.deepEqual(parseIdentity("[user]\n  name = Ada L  # comment\n  email = ada@example.com\n"), { name: "Ada L", email: "ada@example.com" });
  assert.deepEqual(parseIdentity("[core]\nname = x\n[User]\nEmail = a@b.c\n"), { name: "", email: "a@b.c" });
  assert.deepEqual(parseIdentity(null), { name: "", email: "" });
});
