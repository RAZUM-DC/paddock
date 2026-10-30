// server.mjs against a fake Docker Engine API on a unix socket: the requests it makes, idempotency, auth, readiness.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fakeDocker(sock, tokensDir) {
  const state = { networks: new Map(), volumes: new Map(), containers: new Map(), images: new Set(["paddock-harness-codex"]), calls: [], versions: new Set() };
  const srv = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const url = new URL(req.url, "http://d");
    const path = url.pathname.replace(/^\/v[\d.]+/, "");
    state.versions.add(/^\/(v[\d.]+)\//.exec(url.pathname)?.[1] ?? "none");
    state.calls.push(`${req.method} ${path}`);
    const json = (code, v) => { res.writeHead(code, { "content-type": "application/json" }); res.end(v === undefined ? "" : JSON.stringify(v)); };
    const b = body ? JSON.parse(body) : null;
    let m;
    if (req.method === "GET" && path === "/networks") {
      const want = JSON.parse(url.searchParams.get("filters") ?? "{}").label ?? [];
      return json(200, [...state.networks.values()].filter((n) => want.every((l) => { const [k, v] = l.split("="); return n.Labels?.[k] === v; })).map((n) => ({ ...n, Containers: {} })));
    }
    if (req.method === "GET" && (m = /^\/networks\/([^/]+)$/.exec(path))) return state.networks.has(m[1]) ? json(200, state.networks.get(m[1])) : json(404, { message: "no such network" });
    if (req.method === "POST" && path === "/networks/create") {
      if (state.networks.has(b.Name)) return json(409, { message: "exists" });
      state.networks.set(b.Name, { ...b, Containers: {} });
      return json(201, { Id: b.Name });
    }
    if (req.method === "POST" && (m = /^\/networks\/([^/]+)\/connect$/.exec(path))) {
      const n = state.networks.get(m[1]);
      if (Object.values(n.Containers).some((c) => c.Name === b.Container)) return json(403, { message: "endpoint already exists in network" });
      n.Containers[b.Container] = { Name: b.Container, Aliases: b.EndpointConfig?.Aliases, MacAddress: b.EndpointConfig?.MacAddress ?? "02:42:0a:00:00:09" };
      return json(200);
    }
    if (req.method === "POST" && (m = /^\/networks\/([^/]+)\/disconnect$/.exec(path))) {
      const n = state.networks.get(m[1]);
      if (!n?.Containers[b.Container]) return json(404, { message: "not connected" });
      delete n.Containers[b.Container];
      return json(200);
    }
    if (req.method === "GET" && (m = /^\/volumes\/([^/]+)$/.exec(path))) return state.volumes.has(m[1]) ? json(200, state.volumes.get(m[1])) : json(404, { message: "no such volume" });
    if (req.method === "POST" && path === "/volumes/create") { state.volumes.set(b.Name, b); return json(201, b); }
    if (req.method === "GET" && (m = /^\/images\/(.+)\/json$/.exec(path))) return state.images.has(decodeURIComponent(m[1])) ? json(200, {}) : json(404, { message: "no such image" });
    if (req.method === "GET" && (m = /^\/containers\/([^/]+)\/json$/.exec(path))) {
      if (m[1] === "paddock-provisioner") return json(200, { Mounts: [{ Type: "bind", Destination: tokensDir, Source: "/host/secrets/tokens" }] });
      if (m[1] === "paddock-web" || m[1] === "paddock-egress") {
        const nets = {};
        for (const [name, n] of state.networks) if (n.Containers[m[1]]) nets[name] = { Aliases: n.Containers[m[1]].Aliases ?? null, MacAddress: n.Containers[m[1]].MacAddress };
        return json(200, { Name: `/${m[1]}`, NetworkSettings: { Networks: nets } });
      }
      return state.containers.has(m[1]) ? json(200, state.containers.get(m[1])) : json(404, { message: "no such container" });
    }
    if (req.method === "GET" && path === "/containers/json") {
      const want = JSON.parse(url.searchParams.get("filters") ?? "{}").label ?? [];
      const all = url.searchParams.get("all") === "1" || url.searchParams.get("all") === "true";
      return json(200, [...state.containers.values()].filter((c) => all || c.State?.Running).filter((c) => want.every((l) => { const [k, v] = l.split("="); return c.Config?.Labels?.[k] === v; })).map((c) => ({ Names: [`/${c.Name}`], Labels: c.Config?.Labels })));
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

// Ask the OS for a free port (listen on 0, read it, close).
const freePort = () => new Promise((resolve, reject) => {
  const s = createServer();
  s.on("error", reject);
  s.listen(0, "127.0.0.1", () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

async function start(extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), "prov-"));
  const sock = join(dir, "docker.sock");
  const tokens = join(dir, "secrets", "tokens");
  const { srv, state } = await fakeDocker(sock, tokens);
  const userEnv = join(dir, "user-env");
  mkdirSync(userEnv);
  writeFileSync(join(userEnv, "u-a1ce00000001.env"), "LLM_API_KEY=sk-test-1\nHTTPS_PROXY=http://evil:1\n");
  // A port the OS reports free, and a retry if another process takes it before the provisioner binds it; the
  // provisioner's own start is waited for up to 10 s (a loaded CI machine is slow to spawn node).
  let port, child, out = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    port = await freePort();
    out = "";
    child = spawn(process.execPath, [new URL("../server.mjs", import.meta.url).pathname], {
      env: { PATH: process.env.PATH, PORT: String(port), PROVISIONER_TOKEN: "x".repeat(40), DOCKER_SOCKET: sock, TOKENS_DIR: tokens, USER_ENV_DIR: userEnv, RECONCILE_INTERVAL_MS: "0", ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    let exited = false;
    child.on("exit", () => (exited = true));
    for (let i = 0; i < 200 && !exited && !out.includes("paddock provisioner on"); i++) await new Promise((r) => setTimeout(r, 50));
    if (out.includes("paddock provisioner on") && !exited) break;
    child.kill();
    if (!/EADDRINUSE/.test(out) && !exited) throw new Error(`provisioner did not start:\n${out}`);
  }
  const call = (method, path, body, auth = `Bearer ${"x".repeat(40)}`) =>
    fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { authorization: auth, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })
      .then(async (r) => ({ status: r.status, body: await r.json() }));
  const stop = () => { child.kill(); srv.close(); };
  return { call, state, tokens, stop, out: () => out };
}

const waitReady = async (call, id) => {
  for (let i = 0; i < 200; i++) {
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
    assert.equal((await p.call("GET", "/harness/u-a1ce00000001", undefined, "")).status, 401);
    assert.equal((await p.call("GET", "/harness/u-a1ce00000001", undefined, `Bearer ${"y".repeat(40)}`)).status, 401);
    assert.equal((await p.call("POST", "/harness/ensure", { id: "u-a1ce00000001" }, "Bearer short")).status, 401);
  } finally { p.stop(); }
});

test("bad ids and bodies are refused before Docker is touched", async () => {
  const p = await start();
  try {
    assert.equal((await p.call("POST", "/harness/ensure", { id: "../x" })).status, 400);
    assert.equal((await p.call("POST", "/harness/ensure", ["u-a1ce00000001"])).status, 400);
    assert.equal((await p.call("GET", "/harness/Alice")).status, 400);
    assert.equal(p.state.calls.length, 0);
  } finally { p.stop(); }
});

test("ensure creates network, attachments, volumes, token and container, then reports ready", async () => {
  const p = await start();
  try {
    const r = await p.call("POST", "/harness/ensure", { id: "u-a1ce00000001", email: "u-a1ce00000001@hub.local", name: "Alice" });
    assert.equal(r.status, 202);
    assert.equal(r.body.ready, false);
    const ready = await waitReady(p.call, "u-a1ce00000001");
    assert.deepEqual(ready.body, { id: "u-a1ce00000001", ready: true, state: "running" });

    const net = p.state.networks.get("paddock-u-u-a1ce00000001");
    assert.equal(net.Internal, true);
    assert.deepEqual(Object.keys(net.Containers).sort(), ["paddock-egress", "paddock-web"]);
    assert.deepEqual(net.Containers["paddock-egress"].Aliases, ["egress"]);
    assert.deepEqual(net.Containers["paddock-web"].Aliases, ["web"]);
    assert.ok(p.state.volumes.has("harness-home-u-a1ce00000001") && p.state.volumes.has("workspace-u-a1ce00000001"));

    const token = readFileSync(join(p.tokens, "u-a1ce00000001.token"), "utf8");
    assert.match(token, /^[0-9a-f]{64}\n$/);
    assert.equal(statSync(join(p.tokens, "u-a1ce00000001.token")).mode & 0o777, 0o644);

    const c = p.state.containers.get("harness-u-a1ce00000001").Create;
    assert.equal(c.HostConfig.NetworkMode, "paddock-u-u-a1ce00000001");
    assert.ok(c.HostConfig.Binds.includes("/host/secrets/tokens/u-a1ce00000001.token:/run/secrets/ws-token:ro"));
    assert.ok(c.Env.includes("LLM_API_KEY=sk-test-1"));
    assert.ok(c.Env.includes("HTTPS_PROXY=http://egress:8080"));
    assert.ok(!c.Env.includes("HTTPS_PROXY=http://evil:1"));
  } finally { p.stop(); }
});

test("ensure is idempotent: a second run creates nothing and keeps the token", async () => {
  const p = await start();
  try {
    await p.call("POST", "/harness/ensure", { id: "u-a1ce00000001" });
    await waitReady(p.call, "u-a1ce00000001");
    const token = readFileSync(join(p.tokens, "u-a1ce00000001.token"), "utf8");
    const before = p.state.calls.length;
    await p.call("POST", "/harness/ensure", { id: "u-a1ce00000001" });
    await new Promise((r) => setTimeout(r, 300));
    const again = p.state.calls.slice(before);
    assert.ok(!again.some((c) => /create|connect|start/.test(c)), again.join("\n"));
    assert.equal(readFileSync(join(p.tokens, "u-a1ce00000001.token"), "utf8"), token);
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
    await p.call("POST", "/harness/ensure", { id: "u-a1ce00000001" });
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual((await p.call("GET", "/harness/u-a1ce00000001")).body, { id: "u-a1ce00000001", ready: false, state: "absent" });
    assert.match(p.out(), /image nope not found/);
    assert.ok(!p.state.calls.some((c) => c.startsWith("POST /images/create")));
  } finally { p.stop(); }
});

test("refuses to start with a bad configuration", async () => {
  const child = spawn(process.execPath, [new URL("../server.mjs", import.meta.url).pathname], { env: { PATH: process.env.PATH, PROVISIONER_TOKEN: "x".repeat(40), LLM_PROVIDER_NAME: "openai", LLM_BASE_URL: "https://x" } });
  const code = await new Promise((r) => child.on("exit", r));
  assert.equal(code, 1);
});

test("reconcile re-attaches web and egress to managed networks after they were recreated", async () => {
  const p = await start({ RECONCILE_INTERVAL_MS: "200" });
  try {
    await p.call("POST", "/harness/ensure", { id: "u-a1ce00000001" });
    await waitReady(p.call, "u-a1ce00000001");
    // Compose recreated web and egress: their dynamic attachments are gone. A foreign network must be left alone.
    p.state.networks.get("paddock-u-u-a1ce00000001").Containers = {};
    p.state.networks.set("paddock-u-evil", { Name: "paddock-u-evil", Labels: { "paddock.user": "evil" }, Containers: {} });
    await new Promise((r) => setTimeout(r, 600));
    assert.deepEqual(Object.keys(p.state.networks.get("paddock-u-u-a1ce00000001").Containers).sort(), ["paddock-egress", "paddock-web"]);
    assert.deepEqual(p.state.networks.get("paddock-u-evil").Containers, {});
  } finally { p.stop(); }
});

test("web already on a user network without its alias is reconnected with it", async () => {
  const p = await start();
  try {
    // A network from before the alias existed: web and egress attached without aliases.
    p.state.networks.set("paddock-u-u-a1ce00000001", { Name: "paddock-u-u-a1ce00000001", Internal: true, Labels: { "paddock.user": "u-a1ce00000001", "paddock.managed-by": "paddock-provisioner" },
      Containers: { "paddock-web": { Name: "paddock-web", Aliases: [] }, "paddock-egress": { Name: "paddock-egress", Aliases: ["egress"], MacAddress: "02:00:00:00:00:e1" } } });
    await p.call("POST", "/harness/ensure", { id: "u-a1ce00000001" });
    await waitReady(p.call, "u-a1ce00000001");
    const net = p.state.networks.get("paddock-u-u-a1ce00000001");
    assert.deepEqual(net.Containers["paddock-web"].Aliases, ["web"]);
    assert.deepEqual(net.Containers["paddock-egress"].Aliases, ["egress"]);
    assert.equal(p.state.calls.filter((c) => c === "POST /networks/paddock-u-u-a1ce00000001/disconnect").length, 1);
    // Fixed once: the next ensure leaves it alone.
    const before = p.state.calls.length;
    await p.call("POST", "/harness/ensure", { id: "u-a1ce00000001" });
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!p.state.calls.slice(before).some((c) => /disconnect|connect$/.test(c)));
  } finally { p.stop(); }
});

test("egress gets the fixed EGRESS_MAC on user networks (web does not); an older attachment is reconnected once", async () => {
  const p = await start();
  try {
    const U = "u-0000000000ab";
    p.state.networks.set(`paddock-u-${U}`, { Name: `paddock-u-${U}`, Internal: true, Options: { "com.docker.network.bridge.name": "pu0000000000ab" }, Labels: { "paddock.user": U, "paddock.managed-by": "paddock-provisioner" },
      Containers: { "paddock-egress": { Name: "paddock-egress", Aliases: ["egress"], MacAddress: "02:42:0a:00:00:07" } } });
    await p.call("POST", "/harness/ensure", { id: U });
    await waitReady(p.call, U);
    const net = p.state.networks.get(`paddock-u-${U}`);
    assert.equal(net.Containers["paddock-egress"].MacAddress, "02:00:00:00:00:e1");
    assert.deepEqual(net.Containers["paddock-egress"].Aliases, ["egress"]);
    assert.equal(net.Containers["paddock-web"].MacAddress, "02:42:0a:00:00:09", "web keeps Docker's MAC");
    assert.equal(p.state.calls.filter((c) => c === `POST /networks/paddock-u-${U}/disconnect`).length, 1);
    assert.match(p.out(), /paddock-egress reconnecting to paddock-u-u-0000000000ab for MAC 02:00:00:00:00:e1/);
    const before = p.state.calls.length;
    await p.call("POST", "/harness/ensure", { id: U });
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!p.state.calls.slice(before).some((c) => /disconnect|connect$/.test(c)));
  } finally { p.stop(); }
  // EGRESS_MAC="" leaves Docker's MAC alone.
  const q = await start({ EGRESS_MAC: "" });
  try {
    await q.call("POST", "/harness/ensure", { id: "u-0000000000ac" });
    await waitReady(q.call, "u-0000000000ac");
    assert.equal(q.state.networks.get("paddock-u-u-0000000000ac").Containers["paddock-egress"].MacAddress, "02:42:0a:00:00:09");
  } finally { q.stop(); }
});

test("a removed container is recreated on the next ensure, with the same token", async () => {
  const p = await start();
  try {
    await p.call("POST", "/harness/ensure", { id: "u-a1ce00000001" });
    await waitReady(p.call, "u-a1ce00000001");
    const token = readFileSync(join(p.tokens, "u-a1ce00000001.token"), "utf8");
    p.state.containers.delete("harness-u-a1ce00000001"); // docker rm -f harness-u-a1ce00000001 (e.g. to apply a new env file)
    assert.equal((await p.call("GET", "/harness/u-a1ce00000001")).body.ready, false);
    await p.call("POST", "/harness/ensure", { id: "u-a1ce00000001" });
    await waitReady(p.call, "u-a1ce00000001");
    assert.equal(readFileSync(join(p.tokens, "u-a1ce00000001.token"), "utf8"), token);
    assert.equal(p.state.calls.filter((c) => c === "POST /containers/create").length, 2);
    assert.doesNotMatch(p.out(), /ensure failed/);
  } finally { p.stop(); }
});

test("a legacy harness id is never provisioned: 400, and Docker is not touched", async () => {
  const p = await start();
  try {
    const before = p.state.calls.length;
    for (const id of ["evgenii", "alice", "ops-2"]) {
      const r = await p.call("POST", "/harness/ensure", { id, email: `${id}@hub.local` });
      assert.deepEqual([r.status, r.body.error], [400, "bad id"], id);
      assert.equal((await p.call("GET", `/harness/${id}`)).status, 400);
    }
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(p.state.calls.slice(before), [], "no Docker call at all");
    assert.equal(p.state.containers.size, 0);
    assert.equal(p.state.networks.size, 0);
  } finally { p.stop(); }
});

test("a container with the harness name but not labelled for this id is never started or adopted", async () => {
  const p = await start();
  try {
    const U = "u-0000000000aa";
    p.state.containers.set(`harness-${U}`, { Name: `harness-${U}`, Config: { Labels: { "paddock.user": "someone-else" } }, State: { Running: false, Status: "created" } });
    await p.call("POST", "/harness/ensure", { id: U });
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(!p.state.calls.includes(`POST /containers/harness-${U}/start`), p.state.calls.join("\n"));
    assert.equal(p.state.containers.get(`harness-${U}`).State.Running, false);
    assert.match(p.out(), new RegExp(`harness-${U} exists but is not managed for ${U}`));
    assert.equal((await p.call("GET", `/harness/${U}`)).body.ready, false);
  } finally { p.stop(); }
});

test("user networks get a pu<12 hex> bridge name; containers bounded logs and no extra swap", async () => {
  const p = await start();
  try {
    const U = "u-0000000000bb";
    await p.call("POST", "/harness/ensure", { id: U });
    await waitReady(p.call, U);
    assert.deepEqual(p.state.networks.get(`paddock-u-${U}`).Options, { "com.docker.network.bridge.name": "pu0000000000bb" });
    const hc = p.state.containers.get(`harness-${U}`).Create.HostConfig;
    assert.deepEqual(hc.LogConfig, { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } });
    assert.equal(hc.MemorySwap, hc.Memory);
    assert.equal(hc.PidsLimit, 512);
  } finally { p.stop(); }
});

test("a user network made before fixed bridge names is kept and reported once", async () => {
  const p = await start();
  try {
    const U = "u-0000000000cc";
    p.state.networks.set(`paddock-u-${U}`, { Name: `paddock-u-${U}`, Options: {}, Labels: { "paddock.user": U, "paddock.managed-by": "paddock-provisioner" }, Containers: {} });
    await p.call("POST", "/harness/ensure", { id: U });
    await waitReady(p.call, U);
    await p.call("POST", "/harness/ensure", { id: U });
    assert.equal(p.state.calls.filter((c) => c === "POST /networks/create").length, 0);
    assert.equal(p.out().match(new RegExp(`WARNING network paddock-u-${U} is not on bridge pu0000000000cc`, "g"))?.length, 1);
    const V = "u-0000000000dd";
    await p.call("POST", "/harness/ensure", { id: V });
    await waitReady(p.call, V);
    assert.doesNotMatch(p.out(), new RegExp(`${V}: WARNING`));
  } finally { p.stop(); }
});

test("DOCKER_API_VERSION is the version in every Engine API path (default v1.44)", async () => {
  for (const [env, want] of [[{}, "v1.44"], [{ DOCKER_API_VERSION: "v1.47" }, "v1.47"]]) {
    const p = await start(env);
    try {
      await p.call("POST", "/harness/ensure", { id: "u-0000000000ee" });
      await waitReady(p.call, "u-0000000000ee");
      assert.deepEqual([...p.state.versions], [want]);
    } finally { p.stop(); }
  }
});

test("MAX_HARNESSES counts managed containers, stopped ones too, and nothing else", async () => {
  const managed = { "paddock.user": "u-0000000000f1", "paddock.managed-by": "paddock-provisioner" };
  // An unmanaged container (e.g. a legacy harness) does not use up the cap.
  let p = await start({ MAX_HARNESSES: "1" });
  try {
    p.state.containers.set("harness-legacy", { Name: "harness-legacy", Config: { Labels: { "paddock.user": "legacy" } }, State: { Running: true, Status: "running" } });
    assert.equal((await p.call("POST", "/harness/ensure", { id: "u-0000000000f2" })).status, 202);
    await waitReady(p.call, "u-0000000000f2");
  } finally { p.stop(); }
  // A stopped managed harness still counts.
  p = await start({ MAX_HARNESSES: "1" });
  try {
    p.state.containers.set("harness-u-0000000000f1", { Name: "harness-u-0000000000f1", Config: { Labels: managed }, State: { Running: false, Status: "exited" } });
    assert.equal((await p.call("POST", "/harness/ensure", { id: "u-0000000000f2" })).status, 409);
    assert.equal(p.state.containers.has("harness-u-0000000000f2"), false);
  } finally { p.stop(); }
});

test("MAX_HARNESSES: a new harness beyond the cap is refused (409), existing ones are still ensured", async () => {
  const p = await start({ MAX_HARNESSES: "2" });
  try {
    for (const U of ["u-000000000001", "u-000000000002"]) {
      assert.equal((await p.call("POST", "/harness/ensure", { id: U })).status, 202);
      await waitReady(p.call, U);
    }
    const r = await p.call("POST", "/harness/ensure", { id: "u-000000000003" });
    assert.deepEqual([r.status, r.body.error], [409, "harness limit reached (MAX_HARNESSES=2)"]);
    assert.ok(!p.state.containers.has("harness-u-000000000003"));
    // An existing one is ensured (e.g. started again) despite the cap.
    p.state.containers.get("harness-u-000000000001").State = { Running: false, Status: "exited" };
    assert.equal((await p.call("POST", "/harness/ensure", { id: "u-000000000001" })).status, 202);
    await waitReady(p.call, "u-000000000001");
    // Concurrent ensures of new ids cannot overshoot the cap (creations are serialised).
    const q = await start({ MAX_HARNESSES: "1" });
    try {
      await Promise.all(["u-00000000000a", "u-00000000000b", "u-00000000000c"].map((id) => q.call("POST", "/harness/ensure", { id })));
      await new Promise((r) => setTimeout(r, 800));
      assert.equal([...q.state.containers.keys()].filter((k) => k.startsWith("harness-")).length, 1);
    } finally { q.stop(); }
  } finally { p.stop(); }
});

test("request bodies over 4 KB are refused with 413", async () => {
  const p = await start();
  try {
    const r = await p.call("POST", "/harness/ensure", { id: "u-0000000000cc", name: "x".repeat(5000) });
    assert.equal(r.status, 413);
    assert.ok(!p.state.calls.some((c) => c.startsWith("POST")), "nothing created");
  } finally { p.stop(); }
});
