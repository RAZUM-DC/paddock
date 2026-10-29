// Картинки end-to-end + скриншоты для README: включить инструмент «Картинки» в настройках, попросить нарисовать,
// дождаться миниатюры, открыть крупно; затем 1 и 4 окна с реальными чатами.
// Запуск: HUB_PASS=… node tests/images-and-screens.mjs [папка-для-скриншотов]
// Тратит одну генерацию NeuralDeep. Создаёт чат «Нарисуй логотип Paddock…» (оставляет как пример).
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";

const URL_ = process.env.HUB_URL ?? "http://localhost:8088";
const out = (process.argv[2] ?? "/tmp/paddock-screens").replace(/\/$/, "") + "/";
mkdirSync(out, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  defaultViewport: { width: 1600, height: 1000, deviceScaleFactor: 2 },
  protocolTimeout: 300000,
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const step = async (name, fn) => {
  try {
    if ((await fn()) === false) throw new Error("проверка не прошла");
    console.log(`PASS  ${name}`);
  } catch (e) {
    fails++;
    console.log(`FAIL  ${name} — ${e.message.split("\n")[0].slice(0, 160)}`);
    await page.screenshot({ path: `${out}FAIL-${fails}.png` }).catch(() => {});
  }
};
const clickText = (sel, t) => page.evaluate((s, t) => { const el = [...document.querySelectorAll(s)].find((e) => e.innerText.includes(t)); el?.click(); return !!el; }, sel, t);
// Чаты с личным содержимым на публичных скриншотах не показываем.
const hidePrivate = () => page.evaluate(() => document.querySelectorAll("nav .group\\/t").forEach((r) => { if (/тупой/i.test(r.innerText)) r.style.display = "none"; }));

await page.goto(`${URL_}/login`, { waitUntil: "networkidle0" });
await page.evaluate(() => localStorage.clear());
await page.type("input[name=email]", process.env.HUB_EMAIL ?? "valera@hub.local");
await page.type("input[name=password]", process.env.HUB_PASS);
await Promise.all([page.waitForNavigation({ waitUntil: "networkidle0" }), page.click("button")]);
await page.waitForFunction(() => document.body.innerText.includes("Лимиты Codex"), { timeout: 20000 });

await step("настройки: инструмент «Картинки» включён и свежий, правка разрешена", async () => {
  await page.click('[title="Настройки"]');
  await page.evaluate(() => [...document.querySelectorAll(".fixed.inset-0 button")].find((b) => b.innerText.trim() === "Инструменты").click());
  await page.waitForFunction(() => /установлен|выключен|есть обновление/.test(document.querySelector(".fixed.inset-0").innerText), { timeout: 15000 });
  await page.waitForFunction(() => /скиллы в харнессе/i.test(document.querySelector(".fixed.inset-0").innerText) && !document.querySelector(".fixed.inset-0").innerText.includes("читаю скиллы"), { timeout: 15000 });
  // Карточка инструмента: 1-й чекбокс — включить, 2-й — правка.
  const card = ".fixed.inset-0 section:first-of-type .rounded-xl";
  const [enabled, edit] = await page.$$eval(`${card} input[type=checkbox]`, (els) => els.map((e) => e.checked));
  if (!enabled) await page.click(`${card} input[type=checkbox]`);
  if (!edit) await page.evaluate((c) => document.querySelectorAll(`${c} input[type=checkbox]`)[1].click(), card);
  const btn = await page.$$eval(`${card} button`, (bs) => bs.map((b) => [b.innerText, b.disabled]));
  if (btn.some(([t, d]) => /Применить|Обновить/.test(t) && !d)) {
    await page.evaluate((c) => [...document.querySelectorAll(`${c} button`)].find((b) => /Применить|Обновить/.test(b.innerText)).click(), card);
    await page.waitForFunction(() => /Готово|Выключено|сначала/.test(document.querySelector(".fixed.inset-0").innerText), { timeout: 30000 });
  }
  await sleep(500);
  await page.screenshot({ path: `${out}settings-tools.png` });
  const text = await page.$eval(".fixed.inset-0", (e) => e.innerText);
  await page.keyboard.press("Escape");
  return !text.includes("сначала подключи") && /paddock-images/.test(text);
});

await step("чат: нарисовать — миниатюра в ответе", async () => {
  await page.click('[title="Новый чат в папке"]');
  await page.waitForFunction(() => document.body.innerText.includes("sandbox"), { timeout: 10000 });
  await clickText("button", "sandbox");
  await page.click("main textarea");
  await page.keyboard.type("Нарисуй логотип Paddock: оранжево-коралловая неоновая подкова над деревянным загоном, тёмный графитовый фон, минимализм. Покажи картинку в ответе.");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector('[title="Остановить"]'), { timeout: 20000 });
  await page.waitForFunction(() => !document.querySelector('[title="Остановить"]'), { timeout: 240000 });
  await page.waitForFunction(() => [...document.querySelectorAll("main img")].some((i) => i.src.startsWith("data:image") && i.naturalWidth > 0), { timeout: 30000 });
  await sleep(800);
  await hidePrivate();
  await page.screenshot({ path: `${out}paddock-1-image.png` });
});

await step("статус-бар: скиллы и cli этого чата, картинки отмечены как использованные", async () => {
  await page.waitForFunction(() => [...document.querySelectorAll("main button")].some((b) => /skills · \d+ cli/.test(b.innerText)), { timeout: 15000 });
  await clickText("main button", "skills ·");
  await sleep(400);
  const txt = await page.evaluate(() => [...document.querySelectorAll("main button")].find((b) => /skills ·/.test(b.innerText)).parentElement.innerText);
  await page.screenshot({ path: `${out}session-tools.png` });
  await clickText("main button", "skills ·");
  return /used/.test(txt) && /paddock-images/.test(txt);
});

await step("скорость генерации под ответом", async () => page.evaluate(() => /\d+ tok\/s/.test(document.querySelector("main").innerText)));

await step("картинка открывается крупно", async () => {
  await page.click("main button.group\\/img");
  await sleep(500);
  await page.screenshot({ path: `${out}image-lightbox.png` });
  const big = await page.$eval(".fixed.inset-0 img", (i) => i.naturalWidth);
  await page.keyboard.press("Escape");
  return big >= 512;
});

await step("4 окна с реальными чатами", async () => {
  await page.click('[title="Сколько чатов на экране"] button:nth-child(3)');
  await sleep(500);
  const open = async (pane, title) => {
    await page.click(`[data-pane="${pane}"] textarea`);
    if (!(await clickText("nav button", title))) throw new Error(`нет чата «${title}»`);
    await sleep(1800);
  };
  await open(1, "Давай нейдем сколько весит слон");
  await open(2, "Как разработать ракету");
  await open(3, "Через apply_patch");
  await page.click('[data-pane="0"] textarea');
  await sleep(500);
  await hidePrivate();
  await page.screenshot({ path: `${out}paddock-4.png` });
});

console.log(errors.length ? "JS errors: " + errors.join(" | ") : "без ошибок JS");
console.log(fails ? `${fails} FAIL` : `всё зелёное, скриншоты: ${out}`);
await page.evaluate(() => localStorage.setItem("paddock.panes", JSON.stringify({ layout: 1, threads: [] })));
await browser.close();
process.exit(fails ? 1 : 0);
