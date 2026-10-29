#!/usr/bin/env node
// paddock-images — команда для генерации и правки картинок через NeuralDeep, без зависимостей.
// Морда кладёт её в дом харнесса (~/.codex/paddock/) вместе со скиллом; агент зовёт её из shell.
// Shell есть у любого харнесса и у любой модели, поэтому не MCP: тот у моделей NeuralDeep не работает.
//
//   node paddock-images.mjs generate --prompt "…" [--save-to /abs/dir] [--aspect 16:9] [--n 2] [--negative "…"]
//   node paddock-images.mjs edit --images /a.png,/b.png --prompt "…" [--save-to /abs/dir]
//
// Печатает «saved: /путь.png» на каждую картинку — морда превращает это в миниатюры.
// Ключ берётся из провайдера NeuralDeep в config.toml (или ND_API_KEY), настройки — из paddock/tools/images/settings.json.
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const HOME = process.env.CODEX_HOME ?? join(homedir(), ".codex");
const read = (p) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
};
const toml = read(join(HOME, "config.toml"));
const fromToml = (key) => toml.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m"))?.[1];
let settings = {};
try {
  settings = JSON.parse(read(join(HOME, "paddock", "tools", "images", "settings.json")) || "{}");
} catch {}

const BASE = process.env.ND_BASE ?? "https://api.neuraldeep.ru/v1";
const KEY = process.env.ND_API_KEY ?? fromToml("experimental_bearer_token") ?? "";
const ALLOW_EDIT = settings.allowEdit === true;
const ASPECT = settings.aspect ?? "1:1";
// Харнесс режет переменные прокси в окружении shell-команд — прокси задаём явно, иначе curl упрётся в изоляцию сети.
const PROXY = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? "http://egress:8080";

const curl = (args) =>
  new Promise((ok, fail) =>
    execFile("curl", ["-sS", "--max-time", "60", "--proxy", PROXY, "-H", `Authorization: Bearer ${KEY}`, ...args], { maxBuffer: 64 << 20 }, (e, out, err) =>
      e ? fail(new Error(err || e.message)) : ok(out),
    ),
  );
const json = async (args) => {
  const out = await curl(args);
  try {
    return JSON.parse(out);
  } catch {
    throw new Error(`NeuralDeep ответил не JSON: ${out.slice(0, 300)}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Задача → ждём finished → скачиваем PNG в saveTo. Возвращаем путь файла.
async function runTask(created, saveTo, prefix) {
  if (!created.task_uid) throw new Error(created.error?.message ?? created.detail ?? JSON.stringify(created).slice(0, 300));
  const uid = created.task_uid;
  for (let i = 0; i < 150; i++) {
    const st = await json([`${BASE}/images/tasks/${uid}`]);
    if (st.status === "failed") throw new Error(st.error ?? "генерация упала");
    if (st.status === "finished") break;
    await sleep(2000);
  }
  mkdirSync(saveTo, { recursive: true });
  const file = join(saveTo, `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${uid.slice(0, 6)}.png`);
  await curl(["-o", file, `${BASE}/images/tasks/${uid}/result`]);
  if (statSync(file).size < 100) throw new Error("результат пустой");
  return file;
}

async function generate(a) {
  const n = Math.min(4, Math.max(1, Number(a.n ?? 1)));
  const options = { aspect_ratio: a.aspect ?? ASPECT, ...(a.negative ? { negative_prompt: a.negative } : {}) };
  const files = [];
  for (let i = 0; i < n; i++) {
    const created = await json(["-H", "Content-Type: application/json", "-d", JSON.stringify({ prompt: a.prompt, options }), `${BASE}/images/generate`]);
    files.push(await runTask(created, a.saveTo, "gen"));
  }
  return files;
}

async function edit(a) {
  if (!ALLOW_EDIT) throw new Error("правка картинок выключена: её включают в морде, Настройки → Картинки");
  if (!a.images) throw new Error("нужен --images /абс/путь.png[,…]");
  const form = a.images.split(",").flatMap((p) => ["-F", `images[]=@${resolve(p)}`]);
  const created = await json([...form, "--form-string", `prompt=${a.prompt}`, `${BASE}/images/edit`]); // --form-string: «@» в промпте не читает файл
  return [await runTask(created, a.saveTo, "edit")];
}

const [cmd, ...rest] = process.argv.slice(2);
const a = {};
for (let i = 0; i < rest.length; i += 2) a[rest[i].replace(/^--/, "")] = rest[i + 1];
a.saveTo = resolve(a["save-to"] ?? join(process.cwd(), "images"));

const run = cmd === "generate" ? generate : cmd === "edit" ? edit : null;
if (!run) {
  console.error("использование: paddock-images.mjs generate|edit --prompt \"…\" [--save-to папка] [--aspect 16:9] [--n 2] [--images a.png,b.png]");
  process.exit(2);
}
if (!KEY) {
  console.error("ошибка: нет ключа NeuralDeep — подключи его в морде, Настройки → NeuralDeep");
  process.exit(1);
}
if (!a.prompt) {
  console.error("ошибка: нужен --prompt");
  process.exit(2);
}
run(a)
  .then((files) => console.log(files.map((f) => `saved: ${f}`).join("\n")))
  .catch((e) => {
    console.error(`ошибка: ${e.message}`);
    process.exit(1);
  });
