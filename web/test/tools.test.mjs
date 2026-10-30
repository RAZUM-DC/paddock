// Paddock tools installed through the harness fs API (lib/tools.ts), against an in-memory fake of fs/* and skills/list.
import { test } from "node:test";
import assert from "node:assert/strict";

const SKILL = "---\nname: x\n---\nrun {{BIN}}\n";
const registry = [
  { id: "agents", name: "Agents", description: "", bin: "paddock-agents.mjs", skill: "paddock-agents", script: "agents v1", skillText: SKILL },
  { id: "secrets", name: "Secrets", description: "", bin: "paddock-secret.mjs", skill: "paddock-secrets", default: true, script: "secrets v1", skillText: SKILL },
];
globalThis.fetch = async () => ({ json: async () => ({ tools: registry }) });
const { installTool, refreshTools, removeTool, toolState, toolDir } = await import("../lib/tools.ts");

function fakeHarness() {
  const files = new Map();
  const b = (s) => Buffer.from(s, "base64").toString("utf8");
  const request = async (method, p) => {
    if (method === "fs/readFile") {
      if (!files.has(p.path)) throw new Error("ENOENT");
      return { dataBase64: Buffer.from(files.get(p.path)).toString("base64") };
    }
    if (method === "fs/writeFile") return void files.set(p.path, b(p.dataBase64));
    if (method === "fs/remove") {
      for (const k of [...files.keys()]) if (k === p.path || k.startsWith(p.path + "/")) files.delete(k);
      return;
    }
    if (method === "fs/createDirectory" || method === "skills/list") return {};
    throw new Error(`unexpected ${method}`);
  };
  return { files, request };
}

test("a default tool is installed on connect, others are not", async () => {
  const h = fakeHarness();
  await refreshTools(h.request);
  assert.equal((await toolState(h.request, registry[1])).installed, true);
  assert.equal((await toolState(h.request, registry[0])).installed, false);
  assert.ok(h.files.get("/home/codex/.codex/skills/paddock-secrets/SKILL.md").includes(`${toolDir(registry[1])}/paddock-secret.mjs`));
});

test("a default tool the user removed stays removed; installing it again clears that", async () => {
  const h = fakeHarness();
  await refreshTools(h.request);
  await removeTool(h.request, registry[1]);
  const st = await toolState(h.request, registry[1]);
  assert.deepEqual([st.installed, st.removed], [false, true]);
  await refreshTools(h.request);
  assert.equal((await toolState(h.request, registry[1])).installed, false);
  await installTool(h.request, registry[1], {});
  assert.deepEqual(await toolState(h.request, registry[1]).then((s) => [s.installed, s.removed]), [true, false]);
  await removeTool(h.request, registry[0]);
  await refreshTools(h.request);
  assert.equal((await toolState(h.request, registry[0])).installed, false);
});

test("installed tools are updated with their settings kept; uninstalled non-default ones left alone", async () => {
  const h = fakeHarness();
  await installTool(h.request, registry[0], { keep: 1 });
  registry[0].script = "agents v2";
  try {
    assert.equal((await toolState(h.request, registry[0])).outdated, true);
    await refreshTools(h.request);
    const st = await toolState(h.request, registry[0]);
    assert.deepEqual([st.installed, st.outdated, st.settings], [true, false, { keep: 1 }]);
  } finally {
    registry[0].script = "agents v1";
  }
});
