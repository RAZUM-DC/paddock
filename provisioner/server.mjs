// Paddock provisioner: creates a user's harness on demand, each in its own internal network.
// The only Paddock container with the Docker socket. Listens only on the private network it shares with web.
//
//   GET  /health                  → {ok}
//   POST /harness/ensure {id, email, name}   (Bearer PROVISIONER_TOKEN) → {id, ready, state}
//   GET  /harness/<id>            (Bearer PROVISIONER_TOKEN) → {id, ready, state}
//
// ensure is idempotent: network paddock-u-<id> (internal) with web and egress attached, volumes harness-home-<id> and
// workspace-<id>, token file, container harness-<id>. Anything that already exists is left as it is.
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dockerClient } from "./docker.mjs";
import { configFromEnv, MANAGED_CONTAINERS_FILTER, containerCreateBody, hostPathOf, idFromPath, idOfNetwork, MANAGED_FILTER, missingAliases, names, networkConnectBody, networkCreateBody, parseEnvFile, readiness, validateEnsure, volumeCreateBody } from "./lib.mjs";

const { cfg, errors } = configFromEnv(process.env);
if (errors.length) {
  for (const e of errors) console.error(`config: ${e}`);
  process.exit(1);
}
const docker = dockerClient(cfg.dockerSocket, { version: cfg.dockerApiVersion });
const log = (...a) => console.log(new Date().toISOString(), ...a);
const warnedBridge = new Set();

// Harness containers bind the token file from the host: the daemon resolves bind sources on the host, not here.
async function resolveHostTokensDir() {
  if (cfg.hostTokensDir) return cfg.hostTokensDir;
  const self = await docker.inspect(`/containers/${encodeURIComponent(cfg.selfContainer)}/json`);
  const src = hostPathOf(self, cfg.tokensDir);
  if (!src) throw new Error(`cannot find the host path of ${cfg.tokensDir}: set HOST_TOKENS_DIR`);
  return src;
}

const tokenPath = (id) => join(cfg.tokensDir, names(id).token);

function ensureToken(id) {
  // The directory itself must stay readable for web (uid 1000); the 700 is on secrets/ above it, as add-user.sh does.
  mkdirSync(cfg.tokensDir, { recursive: true, mode: 0o755 });
  const p = tokenPath(id);
  if (existsSync(p)) return false;
  // Like add-user.sh: 32 random bytes, hex; 644 inside a 700 directory (uid 1000 in the harness reads it).
  writeFileSync(p, randomBytes(32).toString("hex") + "\n", { mode: 0o644, flag: "wx" });
  chmodSync(p, 0o644);
  return true;
}

function userEnv(id) {
  if (!cfg.userEnvDir) return {};
  const p = join(cfg.userEnvDir, names(id).envFile);
  if (!existsSync(p)) return {};
  const { vars, skipped } = parseEnvFile(readFileSync(p, "utf8"));
  if (skipped.length) log(`${id}: ignored in ${names(id).envFile}: ${skipped.join(", ")}`);
  return vars;
}

async function ensureNetwork(id) {
  const n = names(id);
  const net = await docker.inspect(`/networks/${n.network}`);
  if (!net) {
    await docker.post("/networks/create", networkCreateBody(id)).catch((e) => (e.status === 409 ? null : Promise.reject(e)));
    log(`${id}: network ${n.network} created`);
  } else if (net.Options?.["com.docker.network.bridge.name"] !== n.bridge && !warnedBridge.has(id)) {
    // Made before fixed bridge names: host firewall rules on pu* do not see it. Recreating it is a manual step.
    warnedBridge.add(id);
    log(`${id}: WARNING network ${n.network} is not on bridge ${n.bridge}; host firewall rules for pu* do not apply to it (recreate it: docs/services/provisioner/README.md)`);
  }
  await attachShared(id);
}

async function attachShared(id) {
  const n = names(id);
  const net = await docker.inspect(`/networks/${n.network}`);
  const attached = new Set(Object.values(net?.Containers ?? {}).map((c) => c.Name));
  // web reaches the harness by its alias; the harness reaches egress as "egress" and web as "web", the same names as in core.
  for (const [container, aliases] of [[cfg.webContainer, [cfg.webAlias]], [cfg.egressContainer, [cfg.egressAlias]]]) {
    if (attached.has(container)) {
      // Attached, but perhaps without its alias (attached before the alias existed): reconnect once with it.
      const c = await docker.inspect(`/containers/${encodeURIComponent(container)}/json`);
      const missing = missingAliases(c, n.network, aliases);
      if (missing.length === 0) continue;
      await docker.post(`/networks/${n.network}/disconnect`, { Container: container, Force: false }).catch((e) => (e.status === 404 ? null : Promise.reject(e)));
      log(`${id}: ${container} reconnecting to ${n.network} for alias ${missing.join(", ")}`);
    }
    await docker.post(`/networks/${n.network}/connect`, networkConnectBody(container, aliases)).catch((e) =>
      // 403 "already exists in network" when two ensures race.
      e.status === 403 && /already exists/i.test(e.message) ? null : Promise.reject(e));
    log(`${id}: ${container} connected to ${n.network}`);
  }
}

async function ensureVolumes(id) {
  const n = names(id);
  for (const v of [n.home, n.workspace]) if (!(await docker.inspect(`/volumes/${v}`))) await docker.post("/volumes/create", volumeCreateBody(v, id));
}

async function ensureImage() {
  if (await docker.inspect(`/images/${encodeURIComponent(cfg.image)}/json`)) return;
  if (!cfg.pullMissingImage) throw new Error(`image ${cfg.image} not found: build it (docker compose build) or set PULL_MISSING_IMAGE=1`);
  await docker.call("POST", `/images/create?fromImage=${encodeURIComponent(cfg.image)}`);
}

// MAX_HARNESSES: how many managed harness containers exist (running or not).
async function managedCount() {
  const list = (await docker.get(`/containers/json?all=1&filters=${MANAGED_CONTAINERS_FILTER}`)).body;
  return Array.isArray(list) ? list.length : 0;
}

class LimitError extends Error {}

// Creations are serialised, so concurrent ensures for different users cannot overshoot MAX_HARNESSES.
let creating = Promise.resolve();

async function ensureContainer(id) {
  const n = names(id);
  let c = await docker.inspect(`/containers/${n.container}/json`);
  if (!c) {
    const turn = creating.then(async () => {
      if (await docker.inspect(`/containers/${n.container}/json`)) return;
      if (cfg.maxHarnesses > 0 && (await managedCount()) >= cfg.maxHarnesses) throw new LimitError(`harness limit reached (MAX_HARNESSES=${cfg.maxHarnesses})`);
      await createContainer(id);
    });
    creating = turn.catch(() => {});
    await turn;
    c = await docker.inspect(`/containers/${n.container}/json`);
  }
  // Never start (or adopt) a container with this name that is not ours for this id.
  if (c && c.Config?.Labels?.["paddock.user"] !== id) throw new Error(`${n.container} exists but is not managed for ${id}`);
  if (!c?.State?.Running) await docker.post(`/containers/${n.container}/start`).catch((e) => (e.status === 304 ? null : Promise.reject(e)));
}

async function createContainer(id) {
  const n = names(id);
  await ensureImage();
  const body = containerCreateBody(id, { ...cfg, hostTokensDir: await resolveHostTokensDir() }, userEnv(id));
  await docker.post(`/containers/create?name=${n.container}`, body).catch((e) => (e.status === 409 ? null : Promise.reject(e)));
  log(`${id}: container ${n.container} created`);
}

// One ensure per id at a time; concurrent callers share it.
const inflight = new Map();
function ensure(id) {
  if (!inflight.has(id)) {
    inflight.set(id, (async () => {
      ensureToken(id);
      await ensureNetwork(id);
      await ensureVolumes(id);
      await ensureContainer(id);
    })().finally(() => inflight.delete(id)));
  }
  return inflight.get(id);
}

async function status(id) {
  const c = await docker.inspect(`/containers/${names(id).container}/json`);
  return { id, ...readiness(c, existsSync(tokenPath(id))) };
}

// web and egress lose their extra networks when compose recreates them; put them back.
async function reconcile() {
  const list = (await docker.get(`/networks?filters=${MANAGED_FILTER}`)).body;
  for (const net of Array.isArray(list) ? list : []) {
    const id = idOfNetwork(net);
    if (id) await attachShared(id).catch((e) => log(`${id}: reconcile: ${e.message}`));
  }
}
const reconcileLoop = () => reconcile().catch((e) => log(`reconcile: ${e.message}`));

// --- HTTP ---

const expected = Buffer.from(`Bearer ${cfg.token}`);
function authorized(req) {
  const got = Buffer.from(String(req.headers.authorization ?? ""));
  return got.length === expected.length && timingSafeEqual(got, expected);
}

function send(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(data);
}

async function readJson(req, limit = 4096) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error("body too large"), { status: 413 });
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
  } catch {
    throw Object.assign(new Error("body is not JSON"), { status: 400 });
  }
}

const server = createServer(async (req, res) => {
  const path = new URL(req.url ?? "/", "http://x").pathname;
  try {
    if (req.method === "GET" && path === "/health") return send(res, 200, { ok: true });
    if (!authorized(req)) return send(res, 401, { error: "unauthorized" });
    if (req.method === "POST" && path === "/harness/ensure") {
      const v = validateEnsure(await readJson(req));
      if (!v.ok) return send(res, 400, { error: v.error });
      log(`${v.value.id}: ensure requested${v.value.email ? ` for ${v.value.email}` : ""}`);
      // A new harness beyond MAX_HARNESSES is refused at once (existing ones are always ensured).
      if (cfg.maxHarnesses > 0 && !(await docker.inspect(`/containers/${names(v.value.id).container}/json`)) && (await managedCount()) >= cfg.maxHarnesses)
        return send(res, 409, { error: `harness limit reached (MAX_HARNESSES=${cfg.maxHarnesses})` });
      // Answer at once; web polls GET /harness/<id>. Errors are logged and show as "not ready".
      ensure(v.value.id).catch((e) => log(`${v.value.id}: ensure failed: ${e.message}`));
      return send(res, 202, await status(v.value.id));
    }
    if (req.method === "GET" && path.startsWith("/harness/")) {
      const id = idFromPath(path);
      if (!id) return send(res, 400, { error: "bad id" });
      return send(res, 200, await status(id));
    }
    return send(res, 404, { error: "not found" });
  } catch (e) {
    log(`${req.method} ${path}: ${e.message}`);
    return send(res, e.status ?? 500, { error: e.status ? e.message : "internal error" });
  }
});

server.listen(cfg.port, () => {
  log(`paddock provisioner on :${cfg.port}, image ${cfg.image}${cfg.llm ? `, provider ${cfg.llm.id}` : ""}`);
  if (cfg.reconcileMs > 0) {
    reconcileLoop();
    setInterval(reconcileLoop, cfg.reconcileMs).unref();
  }
});
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => server.close(() => process.exit(0)));
