// /api/harness/* end to end without Docker: the real handler (lib/harness-api.ts) on a local port, a temp sqlite with
// harness_users and git accounts, a temp tokens dir; the real git credential helper (codex/git-credential-paddock),
// real `git credential fill`, and the real `secrets` command (tools/secrets/paddock-secret.mjs).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { createHarnessApi } from "../lib/harness-api.ts";
import { gitAccountStore } from "../lib/git-accounts.ts";
import { secretRequestStore } from "../lib/secret-requests.ts";

const HELPER = resolve(import.meta.dirname, "../../codex/git-credential-paddock");
const SECRET_CLI = resolve(import.meta.dirname, "../tools/secrets/paddock-secret.mjs");
const TOK_ALICE = randomBytes(32).toString("hex");
const TOK_BOB = randomBytes(32).toString("hex");
const TOK_NOUSER = randomBytes(32).toString("hex");

let base, server, url, db, git, secrets, logs, tokensDir, workspace, opts;
function boot(extra = {}) {
  const api = createHarnessApi({ enabled: true, tokensDir, db, gitAccounts: () => git, secrets, log: (l) => logs.push(l), ...extra });
  const s = createServer((req, res) => void api(req, res));
  return new Promise((ok) => s.listen(0, "127.0.0.1", () => ok(s)));
}

before(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "paddock-api-")));
  tokensDir = join(base, "tokens");
  workspace = join(base, "workspace");
  mkdirSync(tokensDir);
  mkdirSync(join(workspace, "app"), { recursive: true });
  writeFileSync(join(tokensDir, "alice.token"), TOK_ALICE + "\n");
  writeFileSync(join(tokensDir, "u-0123456789ab.token"), TOK_BOB + "\n");
  writeFileSync(join(tokensDir, "nobody.token"), TOK_NOUSER + "\n");
  for (const [n, t] of [["alice", TOK_ALICE], ["bob", TOK_BOB], ["nobody", TOK_NOUSER]]) writeFileSync(join(base, `${n}.tok`), t);
  db = new Database(join(base, "auth.db"));
  db.exec("CREATE TABLE harness_users (user_id TEXT PRIMARY KEY, harness_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL)");
  db.prepare("INSERT INTO harness_users VALUES (?, ?, ?)").run("user-alice", "alice", 1);
  db.prepare("INSERT INTO harness_users VALUES (?, ?, ?)").run("user-bob", "u-0123456789ab", 1);
  git = gitAccountStore(db, () => Buffer.alloc(32, 7));
  git.add("user-alice", { host: "github.com", prefix: "", token: "alice-any-token-0123" });
  git.add("user-alice", { host: "github.com", prefix: "my-org", username: "alice-bot", token: "alice-org-token-0123" });
  git.add("user-bob", { host: "github.com", prefix: "bob-org", token: "bob-token-0123456789" });
  secrets = secretRequestStore({ workspace });
  logs = [];
  server = await boot();
  url = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  db.close();
  rmSync(base, { recursive: true });
});

function call(method, path, { token, body, headers = {} } = {}) {
  const data = body === undefined ? undefined : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  return new Promise((ok, fail) => {
    const r = request(url + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(data ? { "content-type": "application/json", "content-length": data.length } : {}), ...headers } }, (res) => {
      let text = "";
      res.on("data", (d) => (text += d));
      res.on("end", () => ok({ status: res.statusCode, json: text ? JSON.parse(text) : null }));
    });
    r.on("error", fail);
    r.end(data);
  });
}

// Runs the helper like git does: `git-credential-paddock get` with key=value lines on stdin.
function helper(op, input, env = {}) {
  return new Promise((ok) => {
    const p = spawn(process.execPath, [HELPER, op], { env: { PATH: process.env.PATH, PADDOCK_WEB_URL: url, PADDOCK_WS_TOKEN_FILE: join(base, "alice.tok"), ...env } });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => ok({ code, out, err }));
    p.stdin.end(input);
  });
}

test("a request that came through a proxy (X-Forwarded-For etc.) is answered 404, even with a valid token", async () => {
  for (const h of [{ "x-forwarded-for": "203.0.113.1" }, { forwarded: "for=203.0.113.1" }, { "x-real-ip": "203.0.113.1" }]) {
    const r = await call("POST", "/api/harness/git-credential", { token: TOK_ALICE, body: { protocol: "https", host: "github.com", path: "x/y" }, headers: h });
    assert.equal(r.status, 404, JSON.stringify(h));
  }
});

test("harness authentication: no, wrong, short or unknown tokens get 401", async () => {
  const body = { protocol: "https", host: "github.com", path: "x/y" };
  for (const token of [undefined, "nope", TOK_ALICE.slice(0, 40), randomBytes(32).toString("hex")])
    assert.equal((await call("POST", "/api/harness/git-credential", { token, body })).status, 401, String(token));
  assert.equal((await call("POST", "/api/harness/git-credential", { body, headers: { authorization: `Basic ${TOK_ALICE}` } })).status, 401);
});

test("git-credential: the caller's own accounts only, longest prefix, https only, 204 otherwise", async () => {
  const q = (token, path, protocol = "https", host = "github.com") => call("POST", "/api/harness/git-credential", { token, body: { protocol, host, path } });
  assert.deepEqual((await q(TOK_ALICE, "someone/repo.git")).json, { username: "x-access-token", password: "alice-any-token-0123" });
  assert.deepEqual((await q(TOK_ALICE, "my-org/repo.git")).json, { username: "alice-bot", password: "alice-org-token-0123" });
  assert.equal((await q(TOK_ALICE, "x/y", "http")).status, 204);
  assert.equal((await q(TOK_ALICE, "x/y", "https", "gitlab.com")).status, 204);
  // Bob's token reaches only Bob's account, never Alice's catch-all.
  assert.equal((await q(TOK_BOB, "someone/repo.git")).status, 204);
  assert.equal((await q(TOK_BOB, "bob-org/r.git")).json.password, "bob-token-0123456789");
  // git passes paths raw: traversal out of a prefix matches nothing at all.
  assert.equal((await q(TOK_ALICE, "my-org/../other-org/repo.git")).status, 204);
  // A harness whose owner never signed in to web has no accounts — not even a stray row with an empty user id.
  git.add("", { host: "github.com", prefix: "", token: "stray-row-token-0123" });
  try {
    assert.equal((await q(TOK_NOUSER, "someone/repo.git")).status, 204);
  } finally {
    git.removeAll("");
  }
  assert.equal((await call("GET", "/api/harness/git-credential", { token: TOK_ALICE })).status, 405);
  assert.equal((await call("POST", "/api/harness/git-credential", { token: TOK_ALICE, body: "{not json" })).status, 400);
});

test("git-credential log: harness, host, account id; never the token or the path", async () => {
  logs.length = 0;
  await call("POST", "/api/harness/git-credential", { token: TOK_ALICE, body: { protocol: "https", host: "github.com", path: "my-org/secret-repo-name.git" } });
  await call("POST", "/api/harness/git-credential", { token: TOK_ALICE, body: { protocol: "https", host: "gitlab.com", path: "a/b" } });
  assert.equal(logs.length, 2);
  assert.deepEqual(Object.keys(logs[0]).sort(), ["account", "event", "harness", "host"]);
  assert.equal(logs[0].harness, "alice");
  assert.equal(logs[0].host, "github.com");
  assert.match(logs[0].account, /^[0-9a-f]{24}$/);
  assert.equal(logs[1].account, null);
  const text = JSON.stringify(logs);
  for (const s of [TOK_ALICE, "alice-org-token-0123", "secret-repo-name", "my-org"]) assert.ok(!text.includes(s), s);
});

test("rate limit per harness", async () => {
  const s = await boot({ gitRate: 2 });
  const u = `http://127.0.0.1:${s.address().port}`;
  const old = url;
  url = u;
  try {
    const body = { protocol: "https", host: "github.com", path: "x" };
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await call("POST", "/api/harness/git-credential", { token: TOK_ALICE, body })).status);
    codes.push((await call("POST", "/api/harness/git-credential", { token: TOK_BOB, body })).status);
    assert.deepEqual(codes, [200, 200, 429, 204]);
  } finally {
    url = old;
    s.close();
  }
});

async function withServer(extra, fn) {
  const s = await boot(extra);
  const old = url;
  url = `http://127.0.0.1:${s.address().port}`;
  try {
    await fn();
  } finally {
    url = old;
    s.close();
  }
}

test("secret requests are rate limited per harness", () =>
  withServer({ secretsRate: 2 }, async () => {
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await call("GET", "/api/harness/secret-requests", { token: TOK_ALICE })).status);
    codes.push((await call("GET", "/api/harness/secret-requests", { token: TOK_BOB })).status);
    assert.deepEqual(codes, [200, 200, 429, 200]);
  }));

test("per address: all requests and failed authentications are limited before the token is looked at", async () => {
  await withServer({ addressRate: 3 }, async () => {
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await call("GET", "/api/harness/secret-requests", { token: TOK_ALICE })).status);
    assert.deepEqual(codes, [200, 200, 200, 429]);
  });
  await withServer({ authFailRate: 2 }, async () => {
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await call("GET", "/api/harness/secret-requests", { token: "x".repeat(64) })).status);
    // Even a valid token from that address waits for the window.
    codes.push((await call("GET", "/api/harness/secret-requests", { token: TOK_ALICE })).status);
    assert.deepEqual(codes, [401, 401, 429, 429]);
  });
});

// A raw request: chunked (no Content-Length), body written in pieces, optionally never finished.
function rawChunked(path, token, pieces, finish) {
  return new Promise((ok, fail) => {
    const r = request(url + path, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "transfer-encoding": "chunked" } }, (res) => {
      let text = "";
      res.on("data", (d) => (text += d));
      res.on("end", () => ok({ status: res.statusCode, text, connection: res.headers.connection }));
    });
    r.on("error", fail);
    for (const p of pieces) r.write(p);
    if (finish) r.end();
  });
}

test("bodies: chunked over 16 KB without Content-Length → 413; a body that never ends → 408", () =>
  withServer({ bodyTimeoutMs: 300 }, async () => {
    const big = await rawChunked("/api/harness/secret-requests", TOK_ALICE, Array.from({ length: 5 }, () => "x".repeat(4096)), true);
    assert.equal(big.status, 413);
    // The unread rest of the body is not waited for: the connection is closed.
    assert.equal(big.connection, "close");
    const started = Date.now();
    const slow = await rawChunked("/api/harness/git-credential", TOK_ALICE, ['{"protocol":'], false);
    assert.equal(slow.status, 408);
    assert.equal(slow.connection, "close");
    assert.ok(Date.now() - started < 5000);
  }));

test("PADDOCK_HARNESS_API=0 (enabled: false) answers 404", async () => {
  const s = await boot({ enabled: false });
  const old = url;
  url = `http://127.0.0.1:${s.address().port}`;
  try {
    assert.equal((await call("POST", "/api/harness/git-credential", { token: TOK_ALICE, body: {} })).status, 404);
  } finally {
    url = old;
    s.close();
  }
});

test("helper: get prints username/password from web; parses git's stdin", async () => {
  const r = await helper("get", "protocol=https\nhost=github.com\npath=my-org/repo.git\nwwwauth[]=Basic realm=\"GitHub\"\n\n");
  assert.equal(r.code, 0);
  assert.equal(r.out, "username=alice-bot\npassword=alice-org-token-0123\n");
  assert.equal(r.err, "");
  const crlf = await helper("get", "protocol=https\r\nhost=github.com\r\npath=x/y\r\n\r\n");
  assert.equal(crlf.out, "username=x-access-token\npassword=alice-any-token-0123\n");
});

test("helper: nothing on no match, http, errors, store/erase, or when switched off", async () => {
  for (const [op, input, env] of [
    ["get", "protocol=https\nhost=gitlab.com\npath=a/b\n"],
    ["get", "protocol=http\nhost=github.com\npath=a/b\n"],
    ["get", "host=github.com\n"],
    ["get", "protocol=https\nhost=github.com\npath=a/b\n", { PADDOCK_WS_TOKEN_FILE: join(base, "missing") }],
    ["get", "protocol=https\nhost=github.com\npath=a/b\n", { PADDOCK_WS_TOKEN_FILE: join(base, "nobody.tok") }],
    ["get", "protocol=https\nhost=github.com\npath=a/b\n", { PADDOCK_WEB_URL: "http://127.0.0.1:1" }],
    ["get", "protocol=https\nhost=github.com\npath=a/b\n", { PADDOCK_WEB_URL: url.replace("http:", "https:") }],
    ["get", "protocol=https\nhost=github.com\npath=a/b\n", { PADDOCK_GIT_CREDENTIALS: "0" }],
    ["store", "protocol=https\nhost=github.com\nusername=x\npassword=y\n"],
    ["erase", "protocol=https\nhost=github.com\n"],
  ]) {
    const r = await helper(op, input, env);
    assert.equal(r.code, 0, `${op} ${input}`);
    assert.equal(r.out, "", `${op} ${input} ${JSON.stringify(env)}`);
  }
});

test("helper: never contacts web for anything but https", async () => {
  let hits = 0;
  const counting = createServer((req, res) => {
    hits += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ username: "u", password: "p" }));
  });
  await new Promise((ok) => counting.listen(0, "127.0.0.1", ok));
  try {
    const env = { PADDOCK_WEB_URL: `http://127.0.0.1:${counting.address().port}` };
    for (const input of ["protocol=http\nhost=github.com\npath=a/b\n", "protocol=ssh\nhost=github.com\n", "host=github.com\npath=a/b\n", "protocol=https\npath=a/b\n"])
      assert.equal((await helper("get", input, env)).out, "", input);
    assert.equal(hits, 0);
    assert.equal((await helper("get", "protocol=https\nhost=github.com\npath=a/b\n", env)).out, "username=u\npassword=p\n");
    assert.equal(hits, 1);
  } finally {
    counting.close();
  }
});

test("helper: ignores HTTP(S)_PROXY and talks to web directly", async () => {
  const r = await helper("get", "protocol=https\nhost=github.com\npath=x/y\n", { HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1", http_proxy: "http://127.0.0.1:1", NODE_USE_ENV_PROXY: "1" });
  assert.equal(r.out, "username=x-access-token\npassword=alice-any-token-0123\n");
});

test("helper: an answer with a line break is dropped; the token never reaches stderr", async () => {
  const evil = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ username: "u", password: "p\nhost=evil.example" }));
  });
  await new Promise((ok) => evil.listen(0, "127.0.0.1", ok));
  try {
    const r = await helper("get", "protocol=https\nhost=github.com\npath=x\n", { PADDOCK_WEB_URL: `http://127.0.0.1:${evil.address().port}`, PADDOCK_GIT_DEBUG: "1" });
    assert.equal(r.out, "");
    assert.ok(!r.err.includes(TOK_ALICE));
  } finally {
    evil.close();
  }
  const { parseCredentialInput, formatCredential } = createRequire(import.meta.url)(HELPER);
  assert.deepEqual(parseCredentialInput("protocol=https\nhost=h\npath=a=b\nbad\nhost=other\n\nafter=blank\n"), { protocol: "https", host: "h", path: "a=b" });
  assert.equal(formatCredential({ username: "u", password: "" }), "");
  assert.equal(formatCredential(null), "");
  assert.equal(formatCredential({ username: "u\r", password: "p" }), "");
});

test("real git: `git credential fill` gets the token through the helper", async () => {
  // Async spawn: execFileSync would block this process, and with it the test server git's helper talks to.
  const fill = (input) => new Promise((ok) => {
    const p = spawn("git", ["-c", `credential.helper=!node ${HELPER}`, "-c", "credential.useHttpPath=true", "credential", "fill"], {
      env: { PATH: process.env.PATH, HOME: base, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", PADDOCK_WEB_URL: url, PADDOCK_WS_TOKEN_FILE: join(base, "alice.tok") },
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", (code) => ok({ code, out }));
    p.stdin.end(input);
  });
  const r = await fill("url=https://github.com/my-org/repo.git\n\n");
  assert.equal(r.code, 0);
  assert.match(r.out, /^username=alice-bot$/m);
  assert.match(r.out, /^password=alice-org-token-0123$/m);
  // No match: git asks the terminal, which is off, so it fails as usual.
  assert.notEqual((await fill("url=https://gitlab.com/a/b.git\n\n")).code, 0);
});

test("secret requests: harness creates, user fulfils, harness collects once; isolation and validation", async () => {
  const c = await call("POST", "/api/harness/secret-requests", { token: TOK_ALICE, body: { name: "API_KEY", file: join(workspace, "app/.env"), reason: "r", threadId: "t-1" } });
  assert.equal(c.status, 201);
  const id = c.json.request.id;
  assert.deepEqual((await call("GET", "/api/harness/secret-requests", { token: TOK_ALICE })).json.requests.map((r) => r.id), [id]);
  assert.deepEqual((await call("GET", "/api/harness/secret-requests", { token: TOK_BOB })).json.requests, []);
  assert.equal((await call("GET", `/api/harness/secret-requests/${id}`, { token: TOK_BOB })).status, 404);
  assert.deepEqual((await call("GET", `/api/harness/secret-requests/${id}`, { token: TOK_ALICE })).json, { status: "pending" });
  // The browser side (route handlers) talks to the same store, keyed by the user's harness id.
  assert.throws(() => secrets.fulfil("u-0123456789ab", id, "x"), (e) => e.status === 404);
  secrets.fulfil("alice", id, "the-value");
  assert.deepEqual((await call("GET", `/api/harness/secret-requests/${id}`, { token: TOK_ALICE })).json, { status: "fulfilled", value: "the-value" });
  assert.deepEqual((await call("GET", `/api/harness/secret-requests/${id}`, { token: TOK_ALICE })).json, { status: "consumed" });
  assert.equal((await call("POST", "/api/harness/secret-requests", { token: TOK_ALICE, body: { name: "bad-name", file: join(workspace, ".env") } })).status, 400);
  assert.equal((await call("POST", "/api/harness/secret-requests", { token: TOK_ALICE, body: { name: "K", file: "/etc/passwd" } })).status, 400);
  assert.equal((await call("GET", "/api/harness/secret-requests/not-an-id", { token: TOK_ALICE })).status, 404);
  assert.equal((await call("POST", "/api/harness/secret-requests", { token: TOK_ALICE, body: "x".repeat(17 * 1024) })).status, 413);
  assert.equal((await call("GET", "/api/harness/secret-requests", {})).status, 401);
});

function runCli(args, cwd) {
  return new Promise((ok) => {
    const p = spawn(process.execPath, [SECRET_CLI, ...args], { cwd, env: { PATH: process.env.PATH, PADDOCK_WEB_URL: url, PADDOCK_WS_TOKEN_FILE: join(base, "alice.tok"), PADDOCK_WORKSPACE: workspace, CODEX_THREAD_ID: "thread-42" } });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => ok({ code, out, err }));
  });
}
const waitPending = async (name) => {
  for (let i = 0; i < 100; i++) {
    const r = secrets.pending("alice").find((x) => x.name === name);
    if (r) return r;
    await new Promise((s) => setTimeout(s, 50));
  }
  throw new Error(`no pending ${name}`);
};

test("secrets command: request → user saves → NAME=value in the file (600), output without the value", async () => {
  writeFileSync(join(workspace, "app/.env"), "OTHER=1\nDB_PASSWORD=old\n");
  const run = runCli(["request", "DB_PASSWORD", "--file", ".env", "--reason", "database for tests", "--timeout", "30"], join(workspace, "app"));
  const r = await waitPending("DB_PASSWORD");
  assert.equal(r.file, join(workspace, "app/.env"));
  assert.equal(r.threadId, "thread-42");
  assert.equal(r.reason, "database for tests");
  const value = `p@ss word "#1" = it's`;
  secrets.fulfil("alice", r.id, value);
  const res = await run;
  assert.equal(res.code, 0, res.err);
  assert.equal(res.out, `saved DB_PASSWORD to ${join(workspace, "app/.env")} (${value.length} chars)\n`);
  assert.ok(!res.out.includes(value) && !res.err.includes(value));
  const text = readFileSync(join(workspace, "app/.env"), "utf8");
  assert.ok(text.startsWith("OTHER=1\nDB_PASSWORD="));
  assert.equal(execFileSync("sh", ["-c", `. "${join(workspace, "app/.env")}"; printf %s "$DB_PASSWORD"`], { encoding: "utf8" }), value);
  assert.equal(statSync(join(workspace, "app/.env")).mode & 0o777, 0o600);
  assert.equal(secrets.heldValues(), 0);
});

test("secrets command: declined, outside the workspace, bad name", async () => {
  const run = runCli(["request", "TOKEN_X", "--file", join(workspace, "x.env"), "--timeout", "30"], workspace);
  const r = await waitPending("TOKEN_X");
  secrets.decline("alice", r.id);
  const res = await run;
  assert.equal(res.code, 3);
  assert.match(res.err, /declined/);
  const before = secrets.pending("alice").length;
  const out = await runCli(["request", "K", "--file", join(base, "outside.env")], workspace);
  assert.equal(out.code, 2);
  assert.match(out.err, /outside/);
  assert.equal(secrets.pending("alice").length, before, "no request is made for a path outside the workspace");
  assert.equal((await runCli(["request", "bad-name", "--file", ".env"], workspace)).code, 2);
  const list = await runCli(["list"], workspace);
  assert.equal(list.code, 0);
});
