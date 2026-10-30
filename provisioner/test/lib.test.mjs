// Pure provisioner logic. Run: node --test test/ (from provisioner/).
import { test } from "node:test";
import assert from "node:assert/strict";
import { configFromEnv, configSeed, containerCreateBody, hostPathOf, idFromPath, idOfNetwork, isValidId, missingAliases, names, networkConnectBody, networkCreateBody, wrongMac, parseEnvFile, parseMemory, readiness, tomlString, validateEnsure, volumeCreateBody } from "../lib.mjs";

const TOKEN = "t".repeat(32);
const base = (extra = {}) => configFromEnv({ PROVISIONER_TOKEN: TOKEN, ...extra });

test("isValidId: only u-<12 hex> (SSO ids); legacy names are never provisioned", () => {
  for (const ok of ["u-0123456789ab", "u-a1ce00000001"]) assert.ok(isValidId(ok), ok);
  for (const bad of ["alice", "evgenii", "ops-2", "a".repeat(32), "u-0123456789a", "u-0123456789abc", "", "u-0123456789AB", "U-0123456789ab", "a".repeat(33), "a.b", "a_b", "../etc",
    "alice/x", "alice\n", " alice", "u-0123456789ab\n", null, 3, {}]) assert.ok(!isValidId(bad), String(bad));
});

test("validateEnsure: id required and checked, email and name optional and bounded", () => {
  assert.deepEqual(validateEnsure({ id: "u-0123456789ab", email: "a@b.c", name: "A B" }), { ok: true, value: { id: "u-0123456789ab", email: "a@b.c", name: "A B" } });
  const U = "u-a1ce00000001";
  assert.deepEqual(validateEnsure({ id: U }), { ok: true, value: { id: U, email: "", name: "" } });
  assert.equal(validateEnsure({ id: "evgenii" }).ok, false, "a legacy harness is never ensured");
  for (const bad of [null, [], "x", {}, { id: "../x" }, { id: U, email: 5 }, { id: U, email: "a b@c" }, { id: U, email: "x".repeat(321) }, { id: U, name: "a\nb" }, { id: U, name: "x".repeat(201) }])
    assert.equal(validateEnsure(bad).ok, false, JSON.stringify(bad));
});

test("idFromPath: exactly /harness/<valid id>", () => {
  assert.equal(idFromPath("/harness/alice"), null);
  assert.equal(idFromPath("/harness/u-0123456789ab"), "u-0123456789ab");
  for (const p of ["/harness/", "/harness/u-0123456789ab/x", "/harness/..", "/harness/%2e%2e", "/harnessx/alice", "/harness/Alice", "/x/harness/alice"]) assert.equal(idFromPath(p), null, p);
});

test("names", () => {
  const U = "u-a1ce00000001";
  assert.deepEqual(names(U), { container: `harness-${U}`, alias: `harness-${U}`, network: `paddock-u-${U}`, home: `harness-home-${U}`, workspace: `workspace-${U}`, token: `${U}.token`, envFile: `${U}.env`, bridge: "pua1ce00000001" });
  assert.ok(names(U).bridge.length <= 15, "Linux interface names are at most 15 characters");
  assert.match(names(U).bridge, /^pu[0-9a-f]{12}$/);
});

test("parseMemory", () => {
  assert.equal(parseMemory("4g"), 4 * 1024 ** 3);
  assert.equal(parseMemory("512m"), 512 * 1024 ** 2);
  assert.equal(parseMemory("1.5G"), 1.5 * 1024 ** 3);
  assert.equal(parseMemory(String(2 * 1024 ** 3)), 2 * 1024 ** 3);
  assert.equal(parseMemory("lots"), 4 * 1024 ** 3);
  assert.equal(parseMemory("1m"), 4 * 1024 ** 3);
  assert.equal(parseMemory(undefined), 4 * 1024 ** 3);
});

test("configFromEnv: defaults", () => {
  const { cfg, errors } = base();
  assert.deepEqual(errors, []);
  assert.equal(cfg.image, "paddock-harness-codex");
  assert.equal(cfg.memory, 4 * 1024 ** 3);
  assert.equal(cfg.nanoCpus, 2e9);
  assert.equal(cfg.pidsLimit, 512);
  assert.equal(cfg.dockerApiVersion, "v1.44");
  assert.equal(cfg.maxHarnesses, 0);
  assert.equal(cfg.readyTimeoutMs, 120000);
  assert.equal(cfg.webContainer, "paddock-web");
  assert.equal(cfg.webAlias, "web");
  assert.equal(cfg.egressContainer, "paddock-egress");
  assert.equal(cfg.llm, null);
  assert.deepEqual(cfg.mcp, []);
});

test("configFromEnv: limits from env", () => {
  const { cfg } = base({ HARNESS_MEMORY: "6g", HARNESS_CPUS: "4", HARNESS_PIDS_LIMIT: "2048", HARNESS_IMAGE: "reg/harness:1" });
  assert.equal(cfg.memory, 6 * 1024 ** 3);
  assert.equal(cfg.nanoCpus, 4e9);
  assert.equal(cfg.pidsLimit, 2048);
  assert.equal(cfg.image, "reg/harness:1");
  assert.equal(base({ HARNESS_CPUS: "-1" }).cfg.nanoCpus, 2e9);
  assert.equal(base({ HARNESS_PIDS_LIMIT: "1" }).cfg.pidsLimit, 512);
  assert.equal(base({ DOCKER_API_VERSION: "v1.47" }).cfg.dockerApiVersion, "v1.47");
  for (const bad of ["1.44", "v2.0", "v1.4", "latest", "v1.44/../x"]) assert.ok(base({ DOCKER_API_VERSION: bad }).errors.some((e) => /DOCKER_API_VERSION/.test(e)), bad);
  assert.equal(base({ MAX_HARNESSES: "25" }).cfg.maxHarnesses, 25);
  for (const bad of ["-1", "lots", "2.5"]) assert.ok(base({ MAX_HARNESSES: bad }).errors.some((e) => /MAX_HARNESSES/.test(e)), bad);
});

test("configFromEnv: token is mandatory", () => {
  assert.ok(configFromEnv({}).errors.some((e) => /PROVISIONER_TOKEN/.test(e)));
  assert.ok(configFromEnv({ PROVISIONER_TOKEN: "short" }).errors.length > 0);
  assert.ok(base({ HOST_TOKENS_DIR: "relative/dir" }).errors.some((e) => /HOST_TOKENS_DIR/.test(e)));
});

test("configFromEnv: LLM provider", () => {
  const { cfg, errors } = base({ LLM_PROVIDER_NAME: "corp", LLM_BASE_URL: "https://llm.example/v1", LLM_DEFAULT_MODEL: "m1" });
  assert.deepEqual(errors, []);
  assert.deepEqual(cfg.llm, { id: "corp", displayName: "corp", baseUrl: "https://llm.example/v1", wireApi: "responses", model: "m1", envKey: "LLM_API_KEY" });
  assert.ok(base({ LLM_PROVIDER_NAME: "openai", LLM_BASE_URL: "https://x" }).errors.length > 0);
  assert.ok(base({ LLM_PROVIDER_NAME: "corp", LLM_BASE_URL: "ftp://x" }).errors.length > 0);
  assert.ok(base({ LLM_PROVIDER_NAME: "corp", LLM_BASE_URL: "https://x", LLM_WIRE_API: "chat" }).errors.length > 0);
  assert.ok(base({ LLM_PROVIDER_NAME: "c p", LLM_BASE_URL: "https://x" }).errors.length > 0);
  assert.ok(base({ LLM_PROVIDER_NAME: "corp", LLM_BASE_URL: "https://x", LLM_API_KEY_ENV: "1BAD" }).errors.length > 0);
});

test("configFromEnv: MCP servers", () => {
  const { cfg, errors } = base({ MCP_SERVERS_JSON: JSON.stringify([{ id: "gw", url: "https://mcp.example/mcp", bearer_env: "MCP_GW_TOKEN" }, { id: "open", url: "http://mcp.local/x" }]) });
  assert.deepEqual(errors, []);
  assert.deepEqual(cfg.mcp, [{ id: "gw", url: "https://mcp.example/mcp", bearerEnv: "MCP_GW_TOKEN" }, { id: "open", url: "http://mcp.local/x", bearerEnv: undefined }]);
  assert.ok(base({ MCP_SERVERS_JSON: "{" }).errors.length > 0);
  assert.ok(base({ MCP_SERVERS_JSON: '[{"id":"x y","url":"https://a"}]' }).errors.length > 0);
  assert.ok(base({ MCP_SERVERS_JSON: '[{"id":"x","url":"https://a","bearer_env":"a-b"}]' }).errors.length > 0);
});

test("tomlString escapes", () => {
  assert.equal(tomlString('a"b\\c\nd'), '"a\\"b\\\\c\\nd"');
  assert.equal(tomlString("\u0001"), '"\\u0001"');
});

test("configSeed: provider via env_key, never the key itself", () => {
  const { cfg } = base({ LLM_PROVIDER_NAME: "corp", LLM_PROVIDER_LABEL: "Corp LLM", LLM_BASE_URL: "https://llm.example/v1", LLM_DEFAULT_MODEL: "m1", MCP_SERVERS_JSON: '[{"id":"gw","url":"https://mcp.example/mcp","bearer_env":"MCP_GW_TOKEN"}]' });
  const seed = configSeed(cfg);
  assert.equal(seed.prepend, 'model_provider = "corp"\nmodel = "m1"');
  assert.equal(seed.append, [
    "[model_providers.corp]", 'name = "Corp LLM"', 'base_url = "https://llm.example/v1"', 'env_key = "LLM_API_KEY"', 'wire_api = "responses"', "",
    "[mcp_servers.gw]", 'url = "https://mcp.example/mcp"', 'bearer_token_env_var = "MCP_GW_TOKEN"',
  ].join("\n"));
  assert.deepEqual(configSeed(base().cfg), { prepend: "", append: "" });
  assert.equal(configSeed(base({ LLM_PROVIDER_NAME: "corp", LLM_BASE_URL: "https://x" }).cfg).prepend, 'model_provider = "corp"');
});

test("parseEnvFile: KEY=value, quotes, comments, reserved and bad names skipped", () => {
  const { vars, skipped } = parseEnvFile([
    "# per-user key", "LLM_API_KEY=sk-abc", 'QUOTED="a b"', "SINGLE='x=y'", "export EXPORTED=1", "",
    "HTTPS_PROXY=http://evil:1", "PADDOCK_CONFIG_APPEND=x", "1BAD=x", "no equals",
  ].join("\n"));
  assert.deepEqual(vars, { LLM_API_KEY: "sk-abc", QUOTED: "a b", SINGLE: "x=y", EXPORTED: "1" });
  assert.deepEqual(skipped, ["HTTPS_PROXY", "PADDOCK_CONFIG_APPEND", "1BAD", "no equals"]);
});

test("networkCreateBody: internal bridge, labelled", () => {
  const U = "u-a1ce00000001";
  assert.deepEqual(networkCreateBody(U), { Name: `paddock-u-${U}`, Driver: "bridge", Internal: true, Options: { "com.docker.network.bridge.name": "pua1ce00000001" }, Labels: { "paddock.user": U, "paddock.managed-by": "paddock-provisioner" } });
});

test("networkConnectBody and volumeCreateBody", () => {
  assert.deepEqual(networkConnectBody("paddock-egress", ["egress"]), { Container: "paddock-egress", EndpointConfig: { Aliases: ["egress"] } });
  assert.deepEqual(networkConnectBody("paddock-egress", ["egress"], "02:00:00:00:00:e1"), { Container: "paddock-egress", EndpointConfig: { Aliases: ["egress"], MacAddress: "02:00:00:00:00:e1" } });
  assert.deepEqual(volumeCreateBody("workspace-alice", "alice"), { Name: "workspace-alice", Labels: { "paddock.user": "alice", "paddock.managed-by": "paddock-provisioner" } });
});

test("containerCreateBody: same command and hardening as users/_template.yml, own network only", () => {
  const { cfg } = base();
  const b = containerCreateBody("u-a1ce00000001", { ...cfg, hostTokensDir: "/srv/paddock/secrets/tokens" });
  assert.equal(b.Image, "paddock-harness-codex");
  assert.deepEqual(b.Cmd, ["codex", "app-server", "--listen", "ws://0.0.0.0:4500", "--ws-auth", "capability-token", "--ws-token-file", "/run/secrets/ws-token"]);
  assert.deepEqual(b.Env, ["HTTPS_PROXY=http://egress:8080", "HTTP_PROXY=http://egress:8080", "NO_PROXY=localhost,127.0.0.1", "PADDOCK_WEB_URL=http://paddock-web:3000"]);
  assert.deepEqual(b.Labels, { "paddock.user": "u-a1ce00000001", "paddock.managed-by": "paddock-provisioner" });
  assert.deepEqual(b.HostConfig, {
    Binds: ["harness-home-u-a1ce00000001:/home/codex/.codex", "workspace-u-a1ce00000001:/workspace", "/srv/paddock/secrets/tokens/u-a1ce00000001.token:/run/secrets/ws-token:ro"],
    NetworkMode: "paddock-u-u-a1ce00000001",
    RestartPolicy: { Name: "unless-stopped" },
    CapDrop: ["ALL"],
    SecurityOpt: ["no-new-privileges:true"],
    Memory: 4 * 1024 ** 3,
    NanoCpus: 2e9,
    PidsLimit: 512,
    MemorySwap: 4 * 1024 ** 3,
    LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } },
  });
  assert.deepEqual(b.NetworkingConfig, { EndpointsConfig: { "paddock-u-u-a1ce00000001": { Aliases: ["harness-u-a1ce00000001"] } } });
});

test("containerCreateBody: user env passes, cannot override the proxy; seed goes in env", () => {
  const { cfg } = base({ LLM_PROVIDER_NAME: "corp", LLM_BASE_URL: "https://llm.example/v1" });
  const b = containerCreateBody("alice", { ...cfg, hostTokensDir: "/h" }, { LLM_API_KEY: "sk-1", HTTPS_PROXY: "http://evil:1", PADDOCK_WEB_URL: "http://evil:1" });
  assert.ok(b.Env.includes("PADDOCK_WEB_URL=http://paddock-web:3000"));
  assert.ok(!b.Env.includes("PADDOCK_WEB_URL=http://evil:1"));
  assert.ok(b.Env.includes("LLM_API_KEY=sk-1"));
  assert.ok(b.Env.includes("HTTPS_PROXY=http://egress:8080"));
  assert.ok(!b.Env.includes("HTTPS_PROXY=http://evil:1"));
  assert.ok(b.Env.includes('PADDOCK_CONFIG_PREPEND=model_provider = "corp"'));
  assert.ok(b.Env.some((e) => e.startsWith("PADDOCK_CONFIG_APPEND=[model_providers.corp]")));
  assert.ok(!b.Env.some((e) => e.includes("sk-1") && e.startsWith("PADDOCK_CONFIG")));
});

test("hostPathOf: source of a bind mount", () => {
  const inspect = { Mounts: [{ Type: "volume", Destination: "/run/secrets/tokens", Source: "/var/lib/docker/x" }, { Type: "bind", Destination: "/run/secrets/tokens", Source: "/srv/p/secrets/tokens" }] };
  assert.equal(hostPathOf(inspect, "/run/secrets/tokens"), "/srv/p/secrets/tokens");
  assert.equal(hostPathOf(inspect, "/other"), null);
  assert.equal(hostPathOf(null, "/x"), null);
});

test("readiness: running with a token, nothing else", () => {
  assert.deepEqual(readiness(null, true), { ready: false, state: "absent" });
  assert.deepEqual(readiness({ State: { Running: true } }, true), { ready: true, state: "running" });
  assert.deepEqual(readiness({ State: { Running: true } }, false), { ready: false, state: "starting" });
  assert.deepEqual(readiness({ State: { Running: true, Restarting: true } }, true), { ready: false, state: "restarting" });
  assert.deepEqual(readiness({ State: { Running: false, Status: "exited" } }, true), { ready: false, state: "exited" });
  assert.deepEqual(readiness({}, true), { ready: false, state: "stopped" });
});

test("idOfNetwork: only networks this provisioner made, named after a valid id", () => {
  const L = (user, by = "paddock-provisioner") => ({ "paddock.user": user, "paddock.managed-by": by });
  const U = "u-a1ce00000001";
  assert.equal(idOfNetwork({ Name: `paddock-u-${U}`, Labels: L(U) }), U);
  assert.equal(idOfNetwork({ Name: "paddock-u-u-b0b000000001", Labels: L(U) }), null);
  assert.equal(idOfNetwork({ Name: `paddock-u-${U}`, Labels: L(U, "someone") }), null);
  assert.equal(idOfNetwork({ Name: "paddock-u-alice", Labels: L("alice") }), null, "legacy names are not ours");
  assert.equal(idOfNetwork({ Name: "paddock-u-../x", Labels: L("../x") }), null);
  assert.equal(idOfNetwork({ Name: "bridge" }), null);
  assert.equal(idOfNetwork(null), null);
});

test("missingAliases: from the container's endpoint on that network", () => {
  const c = { NetworkSettings: { Networks: { "paddock-u-a": { Aliases: ["abc123"], DNSNames: ["paddock-web", "abc123"] }, core: { Aliases: ["web"] } } } };
  assert.deepEqual(missingAliases(c, "paddock-u-a", ["web"]), ["web"]);
  assert.deepEqual(missingAliases(c, "core", ["web"]), []);
  assert.deepEqual(missingAliases({ NetworkSettings: { Networks: { n: { Aliases: null, DNSNames: ["web"] } } } }, "n", ["web"]), []);
  // Not on that network (or no inspect): nothing to fix here, connect handles it.
  assert.deepEqual(missingAliases(c, "other", ["web"]), []);
  assert.deepEqual(missingAliases(null, "n", ["web"]), []);
});

test("configFromEnv: WEB_PORT", () => {
  assert.equal(base().cfg.webPort, 3000);
  assert.equal(base({ WEB_PORT: "8080" }).cfg.webPort, 8080);
});

test("RESERVED_ENV: a per-user env file can set none of the proxy, config-home, seed or web-URL variables", () => {
  const { cfg } = base({ LLM_PROVIDER_NAME: "corp", LLM_BASE_URL: "https://llm.example/v1" });
  const evil = { HTTPS_PROXY: "http://evil:1", HTTP_PROXY: "http://evil:1", NO_PROXY: "*", https_proxy: "http://evil:1", http_proxy: "http://evil:1", no_proxy: "*",
    CODEX_HOME: "/tmp/x", PADDOCK_CONFIG_PREPEND: "model_provider = \"evil\"", PADDOCK_CONFIG_APPEND: "[x]", PADDOCK_WEB_URL: "http://evil:1", OK_VAR: "fine" };
  const env = Object.fromEntries(containerCreateBody("u-a1ce00000001", { ...cfg, hostTokensDir: "/h" }, evil).Env.map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)]));
  assert.equal(env.OK_VAR, "fine");
  assert.equal(env.HTTPS_PROXY, "http://egress:8080");
  assert.equal(env.HTTP_PROXY, "http://egress:8080");
  assert.equal(env.NO_PROXY, "localhost,127.0.0.1");
  assert.equal(env.PADDOCK_WEB_URL, "http://paddock-web:3000");
  assert.equal(env.PADDOCK_CONFIG_PREPEND, 'model_provider = "corp"');
  assert.ok(env.PADDOCK_CONFIG_APPEND.startsWith("[model_providers.corp]"));
  for (const k of ["https_proxy", "http_proxy", "no_proxy", "CODEX_HOME"]) assert.equal(env[k], undefined, k);
  // The env file parser reports them as skipped.
  const { vars, skipped } = parseEnvFile(Object.entries(evil).map(([k, v]) => `${k}=${v}`).join("\n"));
  assert.deepEqual(Object.keys(vars), ["OK_VAR"]);
  assert.equal(skipped.length, Object.keys(evil).length - 1);
});

test("wrongMac and EGRESS_MAC", () => {
  const c = { NetworkSettings: { Networks: { n: { MacAddress: "02:00:00:00:00:E1" }, m: { MacAddress: "02:42:0a:00:00:02" }, o: {} } } };
  assert.equal(wrongMac(c, "n", "02:00:00:00:00:e1"), false);
  assert.equal(wrongMac(c, "m", "02:00:00:00:00:e1"), true);
  assert.equal(wrongMac(c, "o", "02:00:00:00:00:e1"), true);
  assert.equal(wrongMac(c, "m", ""), false);
  assert.equal(wrongMac(c, "absent", "02:00:00:00:00:e1"), false);
  const base = { PROVISIONER_TOKEN: "x".repeat(20) };
  assert.equal(configFromEnv(base).cfg.egressMac, "02:00:00:00:00:e1");
  assert.equal(configFromEnv({ ...base, EGRESS_MAC: "02:AB:00:00:00:01" }).cfg.egressMac, "02:ab:00:00:00:01");
  assert.equal(configFromEnv({ ...base, EGRESS_MAC: "" }).cfg.egressMac, "");
  assert.deepEqual(configFromEnv({ ...base, EGRESS_MAC: "" }).errors, []);
  assert.match(configFromEnv({ ...base, EGRESS_MAC: "02:00:00:00:e1" }).errors.join(), /EGRESS_MAC/);
});
