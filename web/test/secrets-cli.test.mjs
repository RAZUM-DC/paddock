// The `secrets` tool's command (tools/secrets/paddock-secret.mjs): .env upsert/quoting, workspace paths, file mode.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { parseArgs, quoteValue, resolveInWorkspace, upsertEnvLine, writeSecretFile } from "../tools/secrets/paddock-secret.mjs";

// What a shell reads back from NAME=<quoted> (dotenv files are commonly `source`d or used with --env-file).
const viaSh = (line) => execFileSync("sh", ["-c", `${line}\nprintf %s "$X"`], { encoding: "utf8" });

test("quoteValue: bare when plain, single quotes, else escaped double quotes; line breaks refused", () => {
  assert.equal(quoteValue("sk-abc_123.x/y:z@h%+,"), "sk-abc_123.x/y:z@h%+,");
  assert.equal(quoteValue("with space"), "'with space'");
  assert.equal(quoteValue("a#b"), "'a#b'");
  assert.equal(quoteValue("a=b"), "'a=b'");
  assert.equal(quoteValue('say "hi"'), `'say "hi"'`);
  assert.equal(quoteValue("$HOME"), "'$HOME'");
  assert.equal(quoteValue("it's"), `"it's"`);
  assert.equal(quoteValue(`it's "$x" \`y\` \\`), `"it's \\"\\$x\\" \\\`y\\\` \\\\"`);
  for (const bad of ["a\nb", "a\rb", "a\u0000b", 5]) assert.throws(() => quoteValue(bad), undefined, JSON.stringify(bad));
});

test("quoteValue: sh reads back exactly the value", () => {
  for (const v of ["plain", "with space", " lead and trail ", "a#b # c", "a=b=c", `say "hi"`, "$HOME", "it's", `it's "$x" \`y\` \\ end`, "ünïcødé пароль", "x".repeat(300)])
    assert.equal(viaSh(`X=${quoteValue(v)}`), v, v);
});

test("upsertEnvLine: append, replace in place, drop duplicates, keep the rest", () => {
  assert.equal(upsertEnvLine("", "KEY", "v"), "KEY=v\n");
  assert.equal(upsertEnvLine("A=1", "KEY", "v"), "A=1\nKEY=v\n");
  assert.equal(upsertEnvLine("A=1\n", "KEY", "v"), "A=1\nKEY=v\n");
  assert.equal(upsertEnvLine("# c\nKEY=old\nB=2\n", "KEY", "new"), "# c\nKEY=new\nB=2\n");
  assert.equal(upsertEnvLine("KEY=1\nB=2\nKEY=3\n", "KEY", "x"), "KEY=x\nB=2\n");
  assert.equal(upsertEnvLine("export KEY=old\n", "KEY", "n"), "export KEY=n\n");
  assert.equal(upsertEnvLine("  KEY = old\n", "KEY", "n"), "  KEY=n\n");
  assert.equal(upsertEnvLine("KEY_2=keep\nMY_KEY=keep\n#KEY=comment\n", "KEY", "n"), "KEY_2=keep\nMY_KEY=keep\n#KEY=comment\nKEY=n\n");
  assert.equal(upsertEnvLine("A=1\r\nKEY=o\r\n", "KEY", "n"), "A=1\r\nKEY=n\r\n");
  assert.equal(upsertEnvLine("A=1\n\n\nB=2\n", "KEY", "a b"), "A=1\n\n\nB=2\nKEY='a b'\n");
  assert.throws(() => upsertEnvLine("", "bad-name", "v"));
  assert.throws(() => upsertEnvLine("", "KEY", "a\nINJECTED=1"));
});

test("parseArgs", () => {
  assert.deepEqual(parseArgs(["request", "KEY", "--file", ".env", "--reason", "why", "--timeout", "60"]), { cmd: "request", name: "KEY", file: ".env", reason: "why", timeout: 60 });
  assert.equal(parseArgs(["request", "KEY", "--file", ".env"]).timeout, 900);
  assert.deepEqual(parseArgs(["list"]).cmd, "list");
  for (const bad of [["request", "K", "--timeout", "5"], ["request", "K", "--timeout", "901"], ["request", "K", "--timeout", "x"], ["request", "K", "--bogus"], ["request", "K", "L"]])
    assert.throws(() => parseArgs(bad), undefined, bad.join(" "));
});

test("resolveInWorkspace: inside the workspace after symlinks, folder must exist", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "paddock-ws-")));
  const root = join(base, "workspace");
  const outside = join(base, "outside");
  mkdirSync(join(root, "app"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(outside, "x.env"), "");
  symlinkSync(outside, join(root, "app", "out-dir"));
  symlinkSync(join(outside, "x.env"), join(root, "app", "out.env"));
  symlinkSync(join(root, "app", "real.env"), join(root, "app", "in.env"));
  writeFileSync(join(root, "app", "real.env"), "");
  symlinkSync(join(base, "nowhere"), join(root, "app", "dangling.env"));
  try {
    const r = (f, cwd = join(root, "app")) => resolveInWorkspace(f, { cwd, root });
    assert.equal(r(".env"), join(root, "app", ".env"));
    assert.equal(r(join(root, "app", ".env")), join(root, "app", ".env"));
    assert.equal(r("../top.env"), join(root, "top.env"));
    assert.equal(r("in.env"), join(root, "app", "real.env"));
    for (const bad of ["../../outside/x.env", join(outside, "y.env"), "/etc/passwd", "out-dir/y.env", "out.env", "dangling.env", "missing-dir/.env", ".", "..", "", "a\nb"])
      assert.ok(r(bad) instanceof Error, bad);
    assert.ok(resolveInWorkspace(".env", { cwd: base, root }) instanceof Error);
    // A sibling whose name starts with the workspace's name is still outside.
    mkdirSync(join(base, "workspace-evil"));
    assert.ok(r(join(base, "workspace-evil", ".env")) instanceof Error);
    assert.ok(r("../../workspace-evil/.env") instanceof Error);
    assert.ok(resolveInWorkspace(".env", { cwd: root, root: join(base, "missing") }) instanceof Error);
  } finally {
    rmSync(base, { recursive: true });
  }
});

test("writeSecretFile: creates with mode 600, replaces the line, keeps the rest", () => {
  const dir = mkdtempSync(join(tmpdir(), "paddock-ws-"));
  const f = join(dir, ".env");
  try {
    writeSecretFile(f, "KEY", "a b");
    assert.equal(readFileSync(f, "utf8"), "KEY='a b'\n");
    assert.equal(statSync(f).mode & 0o777, 0o600);
    writeFileSync(f, "A=1\nKEY=old\n", { mode: 0o644 });
    writeSecretFile(f, "KEY", "new");
    assert.equal(readFileSync(f, "utf8"), "A=1\nKEY=new\n");
    assert.equal(statSync(f).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
