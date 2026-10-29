// README screenshots from real sessions, English UI. Runs as a test user on a NeuralDeep model:
// enables the image tool, starts four English chats in a 2×2 grid (image, code + tests, an explanation,
// a folder overview), waits for every answer and checks it worked, then shoots the grid, the image chat,
// the side panel (actions, network), the session popover and Settings → Tools.
// Run: HUB_URL=https://… HUB_EMAIL=test@hub.local HUB_PASS=… HUB_SELECTION='{"model":"qwen3.8-27b","provider":"neuraldeep","effort":""}' node tests/readme-screens.mjs docs/img
// Spends one NeuralDeep image generation and four model turns; archives nothing (the chats are the demo).
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";
const LANG = process.env.HUB_LANG ?? "en";

const URL_ = process.env.HUB_URL ?? "http://localhost:8088";
const out = (process.argv[2] ?? "docs/img").replace(/\/$/, "") + "/";
mkdirSync(out, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  defaultViewport: { width: 1600, height: 1000, deviceScaleFactor: 2 },
  protocolTimeout: 600000,
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, extra = "") => { if (!ok) fails++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); };
const clickText = (sel, t) => page.evaluate((s, t) => { const el = [...document.querySelectorAll(s)].find((e) => e.innerText.trim() === t || e.innerText.includes(t)); el?.click(); return !!el; }, sel, t);
const shot = async (name) => { await sleep(500); await page.screenshot({ path: `${out}${name}.png` }); console.log("saved", `${out}${name}.png`); };
const paneText = (i) => page.$eval(`[data-pane="${i}"]`, (e) => e.innerText);

await page.goto(`${URL_}/login`, { waitUntil: "networkidle0" });
await page.evaluate((lang, sel) => {
  localStorage.clear();
  localStorage.setItem("paddock.lang", JSON.stringify(lang));
  if (sel) localStorage.setItem("paddock.selection", sel);
}, LANG, process.env.HUB_SELECTION ?? null);
await page.reload({ waitUntil: "networkidle0" });
await page.type("input[name=email]", process.env.HUB_EMAIL ?? "test@hub.local");
await page.type("input[name=password]", process.env.HUB_PASS);
await Promise.all([page.waitForNavigation({ waitUntil: "networkidle0" }), page.click("form button[type=submit], form button:last-of-type")]);
await page.waitForSelector("[data-side-toggle]", { timeout: 20000 });
await sleep(2000);

// 0. Clean slate for the demo account only: archive old chats so the sidebar shows just this run.
if ((process.env.HUB_EMAIL ?? "").startsWith("test@")) {
  for (let i = 0; i < 40; i++) {
    const done = await page.evaluate(() => { const b = document.querySelector("nav [data-archive]"); b?.click(); return !b; });
    if (done) break;
    await sleep(700);
  }
}

// 1. Settings → Tools: image tool on, editing allowed.
await page.click('[title="Settings"]');
await clickText(".fixed.inset-0 button", "Tools");
await page.waitForFunction(() => /installed|off|update available/i.test(document.querySelector(".fixed.inset-0").innerText) && !/reading skills/.test(document.querySelector(".fixed.inset-0").innerText), { timeout: 20000 });
const card = ".fixed.inset-0 section:first-of-type .rounded-xl";
const [enabled, edit] = await page.$$eval(`${card} input[type=checkbox]`, (els) => els.map((e) => e.checked));
if (!enabled) await page.click(`${card} input[type=checkbox]`);
if (!edit) await page.evaluate((c) => document.querySelectorAll(`${c} input[type=checkbox]`)[1].click(), card);
if (await page.evaluate((c) => [...document.querySelectorAll(`${c} button`)].some((b) => /Apply|Update/.test(b.innerText) && !b.disabled), card)) {
  await page.evaluate((c) => [...document.querySelectorAll(`${c} button`)].find((b) => /Apply|Update/.test(b.innerText)).click(), card);
  await page.waitForFunction(() => /Done|Off|first connect/i.test(document.querySelector(".fixed.inset-0").innerText), { timeout: 30000 });
}
await sleep(800);
check("tools: image tool installed", /installed/.test(await page.$eval(".fixed.inset-0", (e) => e.innerText)));
await shot("settings-tools");
await page.keyboard.press("Escape");

// 2. Four real chats in a 2×2 grid.
await page.click('[title="Chats on screen"] button:nth-child(3)');
await sleep(600);
const prompts = [
  "Draw a minimal logo for Paddock: a glowing orange neon horseshoe above a small wooden fence, dark graphite background. Show the image in your answer.",
  "Create hello.py with a greet(name) function and a test_hello.py pytest test for it, then run the test and tell me the result.",
  "In three short paragraphs: what do TTFT and tokens per second tell me about a coding agent, and which one matters more in a chat?",
  "Look at /workspace and give me a short overview of what is there, as a bullet list.",
];
for (const [i, p] of prompts.entries()) {
  await page.click(`[data-pane="${i}"] textarea`);
  await page.keyboard.type(p);
  await page.keyboard.press("Enter");
  await sleep(1500);
}
// Агент спрашивает разрешение на shell (pytest и т. п.): снимаем карточку один раз для README и разрешаем на сессию.
let approvalShot = false;
for (let i = 0; i < 210 && (await page.$('[title="Stop"]')); i++) {
  const has = await page.evaluate(() => [...document.querySelectorAll("button")].some((b) => b.innerText.trim() === "For this session"));
  if (has) {
    if (!approvalShot) { await shot("approval"); approvalShot = true; }
    await clickText("button", "For this session");
  }
  await sleep(2000);
}
await sleep(2000);
for (const i of [0, 1, 2, 3]) {
  const txt = await paneText(i);
  check(`pane ${i + 1}: answered without errors`, !/⚠️/.test(txt) && /tok\/s|TTFT|\d+(\.\d+)? s/.test(txt), txt.slice(-120).replace(/\n/g, " "));
}
check("pane 1: image thumbnail rendered", await page.$$eval('[data-pane="0"] img', (is) => is.some((i) => i.src.startsWith("data:image") && i.naturalWidth > 0)));
check("pane 2: test run shown", /pass|passed/i.test(await paneText(1)));
await page.click('[data-pane="0"] textarea');
await shot("paddock-4");

// 3. One pane with the image chat + side panel.
await page.click('[title="Chats on screen"] button:nth-child(1)');
await sleep(800);
await shot("paddock-image");
await page.click("[data-side-toggle]");
await page.click('[data-side-tab="net"]');
await page.waitForFunction(() => /chain/.test(document.querySelector("aside:last-of-type")?.innerText ?? ""), { timeout: 60000 });
check("network: chain reaches the APIs", !/chain\s+dead/.test(await page.$eval("aside:last-of-type", (e) => e.innerText)));
await shot("side-network");
await page.click('[data-pane="0"] textarea');
await page.keyboard.down("Alt"); await page.keyboard.press("Digit2"); await page.keyboard.up("Alt");
await sleep(1000);
await page.click('[data-side-tab="actions"]');
await sleep(800);
check("actions: feed has entries", /all [1-9]/.test(await page.$eval("aside:last-of-type", (e) => e.innerText)));
await shot("side-actions");
await page.click("[data-side-toggle]");

// 4. What this chat can use.
await page.keyboard.down("Alt"); await page.keyboard.press("Digit1"); await page.keyboard.up("Alt");
await sleep(800);
await clickText("main button", "skills ·");
await sleep(600);
check("session popover: image CLI marked as used", /used/.test(await page.evaluate(() => [...document.querySelectorAll("main button")].find((b) => /skills ·/.test(b.innerText))?.parentElement.innerText ?? "")));
await shot("session-tools");
await clickText("main button", "skills ·");

check("no JS errors", errors.length === 0, errors.join(" | "));
console.log(fails ? `\n${fails} FAIL` : "\nall green");
await browser.close();
process.exit(fails ? 1 : 0);
