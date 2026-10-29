// server.mjs against a fake Docker Engine API on a unix socket: the requests it makes, idempotency, auth, readiness.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fakeDocker(sock, tokensDir) {
  const state = { networks: new Map(), volumes: new Map(), containers: new Map(), images: new Set(["paddock-harness-codex"]), calls: [] };
  const srv = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const url = new URL(req.url, "http://d");
    const path = url.pathname.replace(/^\/v[\d.]+/, "");
    state.calls.push(`${req.method} ${path}`);
    const json = (code, v) => { res.writeHead(code, { "content-type": "application/json" }); res.end(v === undefined ? "" : JSON.stringify(v)); };
    const b = body ? JSON.parse(body) : null;
    let m;
    if (req.method === "GET" && (m = /^\/networks\/([^/]+)$/.exec(path))) return state.networks.has(m[1]) ? json(200, state.networks.get(m[1])) : json(404, { message: "no such network" });
    if (req.method === "POST" && path === "/networks/create") {
      if (state.networks.has(b.Name)) return json(409, { message: "exists" });
      state.networks.set(b.Name, { ...b, Containers: {} });
      return json(201, { Id: b.Name });
    }
    if (req.method === "POST" && (m = /^\/networks\/([^/]+)\/connect$/.exec(path))) {
      const n = state.networks.get(m[1]);
      if (Object.values(n.Containers).some((c) => c.Name === b.Container)) return json(403, { message: "endpoint already exists in network" });
      n.Containers[b.Container] = { Name: b.Container, Aliases: b.EndpointConfig?.Aliases };
      return json(200);
    }
    if (req.method === "GET" && (m = /^\/volumes\/([^/]+)$/.exec(path))) return state.volumes.has(m[1]) ? json(200, state.volumes.get(m[1])) : json(404, { message: "no such volume" });
    if (req.method === "POST" && path === "/volumes/create") { state.volumes.set(b.Name, b); return json(201, b); }
    if (req.method === "GET" && (m = /^\/images\/(.+)\/json$/.exec(path))) return state.images.has(decodeURIComponent(m[1])) ? json(200, {}) : json(404, { message: "no such image" });
    if (req.method === "GET" && (m = /^\/containers\/([^/]+)\/json$/.exec(path))) {
      if (m[1] === "paddock-provisioner") return json(200, { Mounts: [{ Type: "bind", Destination: tokensDir, Source: "/host/secrets/tokens" }] });
      return state.containers.has(m[1]) ? json(200, state.containers.get(m[1])) : json(404, { message: "no such container" });
    }
    if (req.method === "POST" && path === "/containers/create") {
      const name = url.searchParams.get("name");
      if (state.containers.has(name)) return json(409, { message: "conflict" });
      state.containers.set(name, { Name: name, Config: { Labels: b.Labels }, Create: b, State: { Running: false, Status: "created" } });
      return json(201, { Id: name });
    }
    if (req.method === "POST" && (m = /^\/containers\/([^/]+)\/start$/.exec(path))) {
      const c = state.containers.get(m[1]);
      if (c.State.Running) return json(304);
      c.State = { Running: true, Status: "running" };
      return json(204);
    }
    json(404, { message: `fake docker: ${req.method} ${path}` });
  });
  return new Promise((r) => srv.listen(sock, () => r({ srv, state })));
}

async function start(extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), "prov-"));
  const sock = join(dir, "docker.sock");
  const tokens = join(dir, "secrets", "tokens");
  const { srv, state } = await fakeDocker(sock, tokens);
  const userEnv = join(dir, "user-env");
  mkdirSync(userEnv);
  writeFileSync(join(userEnv, "alice.env"), "LLM_API_KEY=sk-test-1\nHTTPS_PROXY=http://evil:1\n");
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [new URL("../server.mjs", import.meta.url).pathname], {
    env: { PATH: process.env.PATH, PORT: String(port), PROVISIONER_TOKEN: "x".repeat(40), DOCKER_SOCKET: sock, TOKENS_DIR: tokens, USER_ENV_DIR: userEnv, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  for (let i = 0; i < 50 && !out.includes("paddock provisioner on"); i++) await new Promise((r) => setTimeout(r, 50));
  const call = (method, path, body, auth = `Bearer ${"x".repeat(40)}`) =>
    fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { authorization: auth, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })
      .then(async (r) => ({ status: r.status, body: await r.json() }));
  const stop = () => { child.kill(); srv.close(); };
  return { call, state, tokens, stop, out: () => out };
}

const waitReady = async (call, id) => {
  for (let i = 0; i < 50; i++) {
    const r = await call("GET", `/harness/${id}`);
    if (r.body.ready) return r;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("never ready");
};

test("health needs no auth, everything else does", async () => {
  const p = await start();
  try {
    assert.deepEqual(await p.call("GET", "/health", undefined, ""), { status: 200, body: { ok: true } });
    assert.equal((await p.call("GET", "/harness/alice", undefined, "")).status, 401);
    assert.equal((await p.call("GET", "/harness/alice", undefined, `Bearer ${"y".repeat(40)}`)).status, 401);
    assert.equal((await p.call("POST", "/harness/ensure", { id: "alice" }, "Bearer short")).status, 401);
  } finally { p.stop(); }
});

test("bad ids and bodies are refused before Docker is touched", async () => {
  const p = await start();
  try {
    assert.equal((await p.call("POST", "/harness/ensure", { id: "../x" })).status, 400);
    assert.equal((await p.call("POST", "/harness/ensure", ["alice"])).status, 400);
    assert.equal((await p.call("GET", "/harness/Alice")).status, 400);
    assert.equal(p.state.calls.length, 0);
  } finally { p.stop(); }
});

test("ensure creates network, attachments, volumes, token and container, then reports ready", async () => {
  const p = await start();
  try {
    const r = await p.call("POST", "/harness/ensure", { id: "alice", email: "alice@hub.local", name: "Alice" });
    assert.equal(r.status, 202);
    assert.equal(r.body.ready, false);
    const ready = await waitReady(p.call, "alice");
    assert.deepEqual(ready.body, { id: "alice", ready: true, state: "running" });

    const net = p.state.networks.get("paddock-u-alice");
    assert.equal(net.Internal, true);
    assert.deepEqual(Object.keys(net.Containers).sort(), ["paddock-egress", "paddock-web"]);
    assert.deepEqual(net.Containers["paddock-egress"].Aliases, ["egress"]);
    assert.ok(p.state.volumes.has("harness-home-alice") && p.state.volumes.has("workspace-alice"));

    const token = readFileSync(join(p.tokens, "alice.token"), "utf8");
    assert.match(token, /^[0-9a-f]{64}\n$/);
    assert.equal(statSync(join(p.tokens, "alice.token")).mode & 0o777, 0o644);

    const c = p.state.containers.get("harness-alice").Create;
    assert.equal(c.HostConfig.NetworkMode, "paddock-u-alice");
    assert.ok(c.HostConfig.Binds.includes("/host/secrets/tokens/alice.token:/run/secrets/ws-token:ro"));
    assert.ok(c.Env.includes("LLM_API_KEY=sk-test-1"));
    assert.ok(c.Env.includes("HTTPS_PROXY=http://egress:8080"));
    assert.ok(!c.Env.includes("HTTPS_PROXY=http://evil:1"));
  } finally { p.stop(); }
});

test("ensure is idempotent: a second run creates nothing and keeps the token", async () => {
  const p = await start();
  try {
    await p.call("POST", "/harness/ensure", { id: "alice" });
    await waitReady(p.call, "alice");
    const token = readFileSync(join(p.tokens, "alice.token"), "utf8");
    const before = p.state.calls.length;
    await p.call("POST", "/harness/ensure", { id: "alice" });
    await new Promise((r) => setTimeout(r, 300));
    const again = p.state.calls.slice(before);
    assert.ok(!again.some((c) => /create|connect|start/.test(c)), again.join("\n"));
    assert.equal(readFileSync(join(p.tokens, "alice.token"), "utf8"), token);
  } finally { p.stop(); }
});

test("concurrent ensures for one id share a single run", async () => {
  const p = await start();
  try {
    await Promise.all([1, 2, 3, 4].map(() => p.call("POST", "/harness/ensure", { id: "u-0123456789ab" })));
    await waitReady(p.call, "u-0123456789ab");
    assert.equal(p.state.calls.filter((c) => c === "POST /containers/create").length, 1);
    assert.equal(p.state.calls.filter((c) => c === "POST /networks/create").length, 1);
  } finally { p.stop(); }
});

test("a missing image is reported as not ready, not pulled unless asked", async () => {
  const p = await start({ HARNESS_IMAGE: "nope" });
  try {
    await p.call("POST", "/harness/ensure", { id: "alice" });
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual((await p.call("GET", "/harness/alice")).body, { id: "alice", ready: false, state: "absent" });
    assert.match(p.out(), /image nope not found/);
    assert.ok(!p.state.calls.some((c) => c.startsWith("POST /images/create")));
  } finally { p.stop(); }
});

test("refuses to start with a bad configuration", async () => {
  const child = spawn(process.execPath, [new URL("../server.mjs", import.meta.url).pathname], { env: { PATH: process.env.PATH, PROVISIONER_TOKEN: "x".repeat(40), LLM_PROVIDER_NAME: "openai", LLM_BASE_URL: "https://x" } });
  const code = await new Promise((r) => child.on("exit", r));
  assert.equal(code, 1);
});
