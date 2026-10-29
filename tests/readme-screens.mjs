// Скриншоты для README с живых чатов (без новых генераций): 1 окно с картинкой, 4 окна, инструменты, поповер сессии.
// Запуск: HUB_URL=https://… HUB_PASS=… node tests/readme-screens.mjs docs/img
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";

const URL_ = process.env.HUB_URL ?? "http://localhost:8088";
const out = (process.argv[2] ?? "docs/img").replace(/\/$/, "") + "/";
mkdirSync(out, { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, defaultViewport: { width: 1600, height: 1000, deviceScaleFactor: 2 } });
const page = await browser.newPage();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clickText = (sel, t) => page.evaluate((s, t) => { const el = [...document.querySelectorAll(s)].find((e) => e.innerText.includes(t)); el?.click(); return !!el; }, sel, t);
// Личные чаты на публичных скриншотах не показываем.
const hidePrivate = () => page.evaluate(() => document.querySelectorAll("nav .group\\/t").forEach((r) => { if (/тупой/i.test(r.innerText)) r.style.display = "none"; }));
const shot = async (name) => { await hidePrivate(); await sleep(400); await page.screenshot({ path: `${out}${name}.png` }); console.log("saved", `${out}${name}.png`); };

await page.goto(`${URL_}/login`, { waitUntil: "networkidle0" });
await page.evaluate(() => localStorage.clear());
await page.type("input[name=email]", process.env.HUB_EMAIL ?? "valera@hub.local");
await page.type("input[name=password]", process.env.HUB_PASS);
await Promise.all([page.waitForNavigation({ waitUntil: "networkidle0" }), page.click("button")]);
await page.waitForFunction(() => document.body.innerText.includes("Лимиты Codex"), { timeout: 20000 });

await clickText("nav button", "Нарисуй логотип Paddock");
await page.waitForFunction(() => [...document.querySelectorAll("main img")].some((i) => i.src.startsWith("data:image") && i.naturalWidth > 0), { timeout: 30000 });
await sleep(1500);
await shot("paddock-image");

await page.click('[title="Сколько чатов на экране"] button:nth-child(3)');
await sleep(500);
for (const [pane, title] of [[1, "Как разработать ракету"], [2, "зачем нужен TTFT"], [3, "Ку ка кдела"]]) {
  await page.click(`[data-pane="${pane}"] textarea`);
  if (!(await clickText("nav button", title))) await clickText("nav button", "Через apply_patch");
  await sleep(1800);
}
await page.click('[data-pane="0"] textarea');
await sleep(800);
await shot("paddock-4");

await page.click('[title="Сколько чатов на экране"] button:nth-child(1)');
await sleep(500);
await clickText("main button", "skills ·");
await sleep(600);
await shot("session-tools");
await clickText("main button", "skills ·");

await page.click('[title="Настройки"]');
await clickText(".fixed.inset-0 button", "Инструменты");
await page.waitForFunction(() => !document.querySelector(".fixed.inset-0").innerText.includes("читаю скиллы"), { timeout: 15000 });
await sleep(800);
await shot("settings-tools");
await page.keyboard.press("Escape");

await page.evaluate(() => localStorage.setItem("paddock.panes", JSON.stringify({ layout: 1, threads: [] })));
await browser.close();
