// Pure provisioner logic. Run: node --test test/ (from provisioner/).
import { test } from "node:test";
import assert from "node:assert/strict";
import { configFromEnv, configSeed, containerCreateBody, hostPathOf, idFromPath, idOfNetwork, isValidId, names, networkConnectBody, networkCreateBody, parseEnvFile, parseMemory, readiness, tomlString, validateEnsure, volumeCreateBody } from "../lib.mjs";

const TOKEN = "t".repeat(32);
const base = (extra = {}) => configFromEnv({ PROVISIONER_TOKEN: TOKEN, ...extra });

test("isValidId: u-<12 hex> or a legacy name", () => {
  for (const ok of ["u-0123456789ab", "alice", "ops-2", "a".repeat(32)]) assert.ok(isValidId(ok), ok);
  for (const bad of ["", "u-0123456789AB", "U-0123456789ab", "a".repeat(33), "a.b", "a_b", "../etc", "alice/x", "alice\n", " alice", null, 3, {}]) assert.ok(!isValidId(bad), String(bad));
});

test("validateEnsure: id required and checked, email and name optional and bounded", () => {
  assert.deepEqual(validateEnsure({ id: "u-0123456789ab", email: "a@b.c", name: "A B" }), { ok: true, value: { id: "u-0123456789ab", email: "a@b.c", name: "A B" } });
  assert.deepEqual(validateEnsure({ id: "alice" }), { ok: true, value: { id: "alice", email: "", name: "" } });
  for (const bad of [null, [], "x", {}, { id: "../x" }, { id: "alice", email: 5 }, { id: "alice", email: "a b@c" }, { id: "alice", email: "x".repeat(321) }, { id: "alice", name: "a\nb" }, { id: "alice", name: "x".repeat(201) }])
    assert.equal(validateEnsure(bad).ok, false, JSON.stringify(bad));
});

test("idFromPath: exactly /harness/<valid id>", () => {
  assert.equal(idFromPath("/harness/alice"), "alice");
  assert.equal(idFromPath("/harness/u-0123456789ab"), "u-0123456789ab");
  for (const p of ["/harness/", "/harness/alice/x", "/harness/..", "/harness/%2e%2e", "/harnessx/alice", "/harness/Alice", "/x/harness/alice"]) assert.equal(idFromPath(p), null, p);
});

test("names", () => {
  assert.deepEqual(names("alice"), { container: "harness-alice", alias: "harness-alice", network: "paddock-u-alice", home: "harness-home-alice", workspace: "workspace-alice", token: "alice.token", envFile: "alice.env" });
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
  assert.equal(cfg.pidsLimit, 1024);
  assert.equal(cfg.readyTimeoutMs, 120000);
  assert.equal(cfg.webContainer, "paddock-web");
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
  assert.equal(base({ HARNESS_PIDS_LIMIT: "1" }).cfg.pidsLimit, 1024);
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
  assert.deepEqual(networkCreateBody("alice"), { Name: "paddock-u-alice", Driver: "bridge", Internal: true, Labels: { "paddock.user": "alice", "paddock.managed-by": "paddock-provisioner" } });
});

test("networkConnectBody and volumeCreateBody", () => {
  assert.deepEqual(networkConnectBody("paddock-egress", ["egress"]), { Container: "paddock-egress", EndpointConfig: { Aliases: ["egress"] } });
  assert.deepEqual(volumeCreateBody("workspace-alice", "alice"), { Name: "workspace-alice", Labels: { "paddock.user": "alice", "paddock.managed-by": "paddock-provisioner" } });
});

test("containerCreateBody: same command and hardening as users/_template.yml, own network only", () => {
  const { cfg } = base();
  const b = containerCreateBody("alice", { ...cfg, hostTokensDir: "/srv/paddock/secrets/tokens" });
  assert.equal(b.Image, "paddock-harness-codex");
  assert.deepEqual(b.Cmd, ["codex", "app-server", "--listen", "ws://0.0.0.0:4500", "--ws-auth", "capability-token", "--ws-token-file", "/run/secrets/ws-token"]);
  assert.deepEqual(b.Env, ["HTTPS_PROXY=http://egress:8080", "HTTP_PROXY=http://egress:8080", "NO_PROXY=localhost,127.0.0.1"]);
  assert.deepEqual(b.Labels, { "paddock.user": "alice", "paddock.managed-by": "paddock-provisioner" });
  assert.deepEqual(b.HostConfig, {
    Binds: ["harness-home-alice:/home/codex/.codex", "workspace-alice:/workspace", "/srv/paddock/secrets/tokens/alice.token:/run/secrets/ws-token:ro"],
    NetworkMode: "paddock-u-alice",
    RestartPolicy: { Name: "unless-stopped" },
    CapDrop: ["ALL"],
    SecurityOpt: ["no-new-privileges:true"],
    Memory: 4 * 1024 ** 3,
    NanoCpus: 2e9,
    PidsLimit: 1024,
  });
  assert.deepEqual(b.NetworkingConfig, { EndpointsConfig: { "paddock-u-alice": { Aliases: ["harness-alice"] } } });
});

test("containerCreateBody: user env passes, cannot override the proxy; seed goes in env", () => {
  const { cfg } = base({ LLM_PROVIDER_NAME: "corp", LLM_BASE_URL: "https://llm.example/v1" });
  const b = containerCreateBody("alice", { ...cfg, hostTokensDir: "/h" }, { LLM_API_KEY: "sk-1", HTTPS_PROXY: "http://evil:1" });
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
  assert.equal(idOfNetwork({ Name: "paddock-u-alice", Labels: L("alice") }), "alice");
  assert.equal(idOfNetwork({ Name: "paddock-u-bob", Labels: L("alice") }), null);
  assert.equal(idOfNetwork({ Name: "paddock-u-alice", Labels: L("alice", "someone") }), null);
  assert.equal(idOfNetwork({ Name: "paddock-u-../x", Labels: L("../x") }), null);
  assert.equal(idOfNetwork({ Name: "bridge" }), null);
  assert.equal(idOfNetwork(null), null);
});
