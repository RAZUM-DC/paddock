// Pure logic of the provisioner: validation, names, Docker Engine API request bodies, the harness config seed.
// No I/O here, so every rule is unit-tested (provisioner/test/) and the server stays a thin shell around it.

export const ID_RE = /^u-[0-9a-f]{12}$|^[a-z0-9-]{1,32}$/;
export const isValidId = (id) => typeof id === "string" && ID_RE.test(id);

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PROVIDER_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
// Codex reserves these provider ids for its built-ins.
const RESERVED_PROVIDERS = new Set(["openai", "ollama", "lmstudio"]);
// The harness's way out and its config home are the provisioner's business, not a per-user env file's.
export const RESERVED_ENV = new Set(["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "CODEX_HOME", "PADDOCK_CONFIG_PREPEND", "PADDOCK_CONFIG_APPEND"]);

export const names = (id) => ({
  container: `harness-${id}`,
  alias: `harness-${id}`,
  network: `paddock-u-${id}`,
  home: `harness-home-${id}`,
  workspace: `workspace-${id}`,
  token: `${id}.token`,
  envFile: `${id}.env`,
});

// POST /harness/ensure body: {id, email, name}. Returns {ok, value} or {ok: false, error}.
export function validateEnsure(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "body must be a JSON object" };
  const { id, email, name } = body;
  if (!isValidId(id)) return { ok: false, error: "bad id" };
  if (email !== undefined && (typeof email !== "string" || email.length > 320 || /[\s<>]/.test(email))) return { ok: false, error: "bad email" };
  if (name !== undefined && (typeof name !== "string" || name.length > 200 || /[\u0000-\u001f]/.test(name))) return { ok: false, error: "bad name" };
  return { ok: true, value: { id, email: email ?? "", name: name ?? "" } };
}

// "/harness/<id>" → id, or null. Anything else in the path is refused (no traversal, no extra segments).
export function idFromPath(path) {
  const m = /^\/harness\/([^/?#]+)$/.exec(path);
  return m && isValidId(m[1]) ? m[1] : null;
}

const int = (v, def, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : def;
};

// "4g", "512m", "1073741824" → bytes.
export function parseMemory(v, def = 4 * 1024 ** 3) {
  const m = /^(\d+(?:\.\d+)?)\s*([kmg]?)b?$/i.exec(String(v ?? "").trim());
  if (!m) return def;
  const mult = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2].toLowerCase()];
  const bytes = Math.floor(Number(m[1]) * mult);
  return bytes >= 64 * 1024 ** 2 ? bytes : def;
}

export function parseList(s) {
  return String(s ?? "").split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
}

// Everything the provisioner needs from its environment, checked once at start.
export function configFromEnv(env) {
  const errors = [];
  const cfg = {
    port: int(env.PORT, 8080, 1, 65535),
    token: env.PROVISIONER_TOKEN ?? "",
    dockerSocket: env.DOCKER_SOCKET || "/var/run/docker.sock",
    image: env.HARNESS_IMAGE || "paddock-harness-codex",
    pullMissingImage: env.PULL_MISSING_IMAGE === "1",
    tokensDir: env.TOKENS_DIR || "/run/secrets/tokens",
    hostTokensDir: env.HOST_TOKENS_DIR || "",
    selfContainer: env.PROVISIONER_CONTAINER || "paddock-provisioner",
    userEnvDir: env.USER_ENV_DIR || "",
    webContainer: env.WEB_CONTAINER || "paddock-web",
    egressContainer: env.EGRESS_CONTAINER || "paddock-egress",
    egressAlias: env.EGRESS_ALIAS || "egress",
    egressPort: int(env.EGRESS_PORT, 8080, 1, 65535),
    memory: parseMemory(env.HARNESS_MEMORY ?? "4g"),
    nanoCpus: Math.round((Number(env.HARNESS_CPUS) > 0 && Number(env.HARNESS_CPUS) <= 256 ? Number(env.HARNESS_CPUS) : 2) * 1e9),
    pidsLimit: int(env.HARNESS_PIDS_LIMIT, 1024, 16, 1_000_000),
    readyTimeoutMs: int(env.READY_TIMEOUT_MS, 120_000, 1000, 3_600_000),
    // Re-attach web and egress to every user network (they lose them when compose recreates them). 0 = off.
    reconcileMs: int(env.RECONCILE_INTERVAL_MS, 60_000, 0, 86_400_000),
    llm: null,
    mcp: [],
  };
  if (cfg.token.length < 16) errors.push("PROVISIONER_TOKEN must be set (16+ characters)");
  if (cfg.hostTokensDir && !cfg.hostTokensDir.startsWith("/")) errors.push("HOST_TOKENS_DIR must be an absolute path on the host");

  if (env.LLM_PROVIDER_NAME) {
    const llm = {
      id: env.LLM_PROVIDER_NAME,
      displayName: env.LLM_PROVIDER_LABEL || env.LLM_PROVIDER_NAME,
      baseUrl: env.LLM_BASE_URL ?? "",
      wireApi: env.LLM_WIRE_API || "responses",
      model: env.LLM_DEFAULT_MODEL ?? "",
      envKey: env.LLM_API_KEY_ENV || "LLM_API_KEY",
    };
    if (!PROVIDER_ID_RE.test(llm.id) || RESERVED_PROVIDERS.has(llm.id)) errors.push(`LLM_PROVIDER_NAME "${llm.id}": letters, digits, - and _; not openai/ollama/lmstudio`);
    if (!/^https?:\/\/[^\s"]+$/.test(llm.baseUrl)) errors.push("LLM_BASE_URL must be an http(s) URL");
    if (llm.wireApi !== "responses") errors.push(`LLM_WIRE_API "${llm.wireApi}": Codex supports only "responses"`);
    if (!ENV_NAME_RE.test(llm.envKey)) errors.push("LLM_API_KEY_ENV must be an environment variable name");
    if (llm.model && /[\u0000-\u001f"]/.test(llm.model)) errors.push("LLM_DEFAULT_MODEL has forbidden characters");
    cfg.llm = llm;
  }

  if (env.MCP_SERVERS_JSON) {
    let list;
    try {
      list = JSON.parse(env.MCP_SERVERS_JSON);
    } catch {
      list = null;
    }
    if (!Array.isArray(list)) errors.push("MCP_SERVERS_JSON must be a JSON array of {id, url, bearer_env}");
    else for (const s of list) {
      const ok = s && PROVIDER_ID_RE.test(s.id ?? "") && /^https?:\/\/[^\s"]+$/.test(s.url ?? "") && (s.bearer_env === undefined || ENV_NAME_RE.test(s.bearer_env));
      if (!ok) errors.push(`MCP_SERVERS_JSON entry ${JSON.stringify(s)}: need id (letters, digits, -, _), http(s) url, optional bearer_env`);
      else cfg.mcp.push({ id: s.id, url: s.url, bearerEnv: s.bearer_env });
    }
  }
  return { cfg, errors };
}

// TOML basic string.
export function tomlString(s) {
  return '"' + String(s).replace(/[\\"\u0000-\u001f\u007f]/g, (c) => {
    const named = { "\\": "\\\\", '"': '\\"', "\b": "\\b", "\t": "\\t", "\n": "\\n", "\f": "\\f", "\r": "\\r" }[c];
    return named ?? "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0");
  }) + '"';
}
const tomlKey = (k) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : tomlString(k));

// The harness writes config.toml once, on first start (codex/entrypoint.sh): PREPEND + the image's base config + APPEND.
// Top-level keys must come before any [table] in TOML, so they go first and the tables last.
// The API key itself is never in config.toml: env_key names the variable that holds it (from USER_ENV_DIR/<id>.env).
export function configSeed(cfg) {
  const prepend = [];
  const append = [];
  if (cfg.llm) {
    prepend.push(`model_provider = ${tomlString(cfg.llm.id)}`);
    if (cfg.llm.model) prepend.push(`model = ${tomlString(cfg.llm.model)}`);
    append.push(
      `[model_providers.${tomlKey(cfg.llm.id)}]`,
      `name = ${tomlString(cfg.llm.displayName)}`,
      `base_url = ${tomlString(cfg.llm.baseUrl)}`,
      `env_key = ${tomlString(cfg.llm.envKey)}`,
      `wire_api = ${tomlString(cfg.llm.wireApi)}`,
      "",
    );
  }
  for (const s of cfg.mcp ?? []) {
    append.push(`[mcp_servers.${tomlKey(s.id)}]`, `url = ${tomlString(s.url)}`);
    if (s.bearerEnv) append.push(`bearer_token_env_var = ${tomlString(s.bearerEnv)}`);
    append.push("");
  }
  return { prepend: prepend.join("\n"), append: append.join("\n").trimEnd() };
}

// KEY=value lines; # comments; optional "double" or 'single' quotes; "export " prefix tolerated.
export function parseEnvFile(text) {
  const vars = {};
  const skipped = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([^=\s]+)\s*=\s*(.*)$/.exec(line);
    if (!m || !ENV_NAME_RE.test(m[1])) {
      skipped.push(m ? m[1] : line.slice(0, 20));
      continue;
    }
    if (RESERVED_ENV.has(m[1])) {
      skipped.push(m[1]);
      continue;
    }
    let v = m[2];
    if (/^"(.*)"$/.test(v)) v = v.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    else if (/^'(.*)'$/.test(v)) v = v.slice(1, -1);
    vars[m[1]] = v;
  }
  return { vars, skipped };
}

// --- Docker Engine API bodies ---

export function networkCreateBody(id) {
  return {
    Name: names(id).network,
    Driver: "bridge",
    // No route out: the harness reaches the internet only through the egress proxy on this network.
    Internal: true,
    Labels: { "paddock.user": id, "paddock.managed-by": "paddock-provisioner" },
  };
}

export const networkConnectBody = (container, aliases = []) => ({ Container: container, EndpointConfig: { Aliases: aliases } });

export const volumeCreateBody = (name, id) => ({ Name: name, Labels: { "paddock.user": id, "paddock.managed-by": "paddock-provisioner" } });

// The same container users/_template.yml describes, but alone on its own network.
export function containerCreateBody(id, cfg, userEnv = {}) {
  const n = names(id);
  const proxy = `http://${cfg.egressAlias}:${cfg.egressPort}`;
  const seed = configSeed(cfg);
  const env = {
    ...Object.fromEntries(Object.entries(userEnv).filter(([k]) => !RESERVED_ENV.has(k))),
    HTTPS_PROXY: proxy,
    HTTP_PROXY: proxy,
    NO_PROXY: "localhost,127.0.0.1",
  };
  if (seed.prepend) env.PADDOCK_CONFIG_PREPEND = seed.prepend;
  if (seed.append) env.PADDOCK_CONFIG_APPEND = seed.append;
  return {
    Image: cfg.image,
    Cmd: ["codex", "app-server", "--listen", "ws://0.0.0.0:4500", "--ws-auth", "capability-token", "--ws-token-file", "/run/secrets/ws-token"],
    Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
    Labels: { "paddock.user": id, "paddock.managed-by": "paddock-provisioner" },
    HostConfig: {
      Binds: [`${n.home}:/home/codex/.codex`, `${n.workspace}:/workspace`, `${cfg.hostTokensDir}/${n.token}:/run/secrets/ws-token:ro`],
      NetworkMode: n.network,
      RestartPolicy: { Name: "unless-stopped" },
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      Memory: cfg.memory,
      NanoCpus: cfg.nanoCpus,
      PidsLimit: cfg.pidsLimit,
    },
    NetworkingConfig: { EndpointsConfig: { [n.network]: { Aliases: [n.alias] } } },
  };
}

// Filter for GET /networks: only what this provisioner made.
export const MANAGED_FILTER = encodeURIComponent(JSON.stringify({ label: ["paddock.managed-by=paddock-provisioner"] }));

// The user id of a managed network, or null for anything else (never act on a network we did not create).
export function idOfNetwork(net) {
  const id = net?.Labels?.["paddock.user"];
  return isValidId(id) && net?.Name === names(id).network && net?.Labels?.["paddock.managed-by"] === "paddock-provisioner" ? id : null;
}

// Where a bind mount of the provisioner itself comes from on the host (so harness binds use host paths).
export function hostPathOf(inspect, containerPath) {
  const m = (inspect?.Mounts ?? []).find((x) => x.Destination === containerPath && x.Type === "bind");
  return m?.Source ?? null;
}

// What GET /harness/<id> answers, from the container's inspect (null = no container).
export function readiness(inspect, tokenPresent) {
  if (!inspect) return { ready: false, state: "absent" };
  const st = inspect.State ?? {};
  if (st.Running && !st.Restarting && tokenPresent) return { ready: true, state: "running" };
  return { ready: false, state: st.Restarting ? "restarting" : st.Running ? "starting" : st.Status || "stopped" };
}
