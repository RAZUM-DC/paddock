// Поле ввода: длинная вставка сворачивается в чип и уходит полным текстом; «Ответить на выделенное» кладёт цитату
// и копирует её; вставка картинки открывает редактор (стрелка, обрезка, поворот, отмена) → файл в .paddock/uploads →
// миниатюра в сообщении → модель с vision её видит. Архивирует свои чаты.
// Запуск: HUB_URL=… HUB_EMAIL=test@hub.local HUB_PASS=… HUB_SELECTION='{"model":"qwen3.8-27b","provider":"neuraldeep","effort":""}' node tests/composer.mjs
import puppeteer from "puppeteer-core";
const LANG = process.env.HUB_LANG ?? "ru";

const URL_ = process.env.HUB_URL ?? "http://localhost:8088";
const browser = await puppeteer.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, defaultViewport: { width: 1500, height: 950 } });
const ctx = browser.defaultBrowserContext();
await ctx.overridePermissions(new URL(URL_).origin, ["clipboard-read", "clipboard-write", "clipboard-sanitized-write"]);
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, extra = "") => { if (!ok) fails++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); };
const main = () => page.$eval('[data-pane="0"]', (e) => e.innerText);
const waitDone = async () => {
  await page.waitForFunction(() => document.querySelector('[data-pane="0"] [title="Остановить"]'), { timeout: 30000 });
  await page.waitForFunction(() => !document.querySelector('[data-pane="0"] [title="Остановить"]'), { timeout: 180000 });
  await sleep(800);
};

await page.goto(`${URL_}/login`, { waitUntil: "networkidle0" });
await page.evaluate((lang, sel) => {
  localStorage.clear();
  localStorage.setItem("paddock.lang", JSON.stringify(lang));
  if (sel) localStorage.setItem("paddock.selection", sel);
}, LANG, process.env.HUB_SELECTION ?? null);
await page.reload({ waitUntil: "networkidle0" });
await page.type("input[name=email]", process.env.HUB_EMAIL ?? "test@hub.local");
await page.type("input[name=password]", process.env.HUB_PASS);
await Promise.all([page.waitForNavigation({ waitUntil: "networkidle0" }), page.click("form button:last-of-type")]);
await page.waitForSelector("[data-side-toggle]", { timeout: 20000 });
await sleep(1500);

// 1. Длинная вставка → чип, в ход уходит полный текст.
await page.click('[data-pane="0"] textarea');
const long = Array.from({ length: 30 }, (_, i) => `строка лога ${i + 1}`).join("\n");
await page.evaluate((text) => {
  const dt = new DataTransfer();
  dt.setData("text/plain", text);
  if (document.activeElement.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }))) document.execCommand("insertText", false, text);
}, long);
await sleep(300);
const ta = await page.$eval('[data-pane="0"] textarea', (e) => e.value);
check("вставка 30 строк → токен в поле", ta.includes("[Pasted text #1 +30 lines]") && !ta.includes("строка лога 30"), JSON.stringify(ta.slice(0, 60)));
check("вставка → чип над полем", !!(await page.$("[data-paste-chip]")));
await page.keyboard.type(" Сколько строк в логе выше? Ответь одним числом.");
await page.keyboard.press("Enter");
await sleep(1500);
const bubble = await main();
check("в сообщении полный текст, а не токен", bubble.includes("строка лога 30") && !bubble.includes("[Pasted text #1"));
check("чип очищен после отправки", !(await page.$("[data-paste-chip]")));
await waitDone();

// 2. Ответить на выделенное.
await page.evaluate(() => {
  const msgs = [...document.querySelectorAll('[data-pane="0"] .prose, [data-pane="0"] [class*="markdown"]')];
  const el = msgs.at(-1) ?? [...document.querySelectorAll('[data-pane="0"] p')].at(-1);
  const r = document.createRange();
  r.selectNodeContents(el);
  const s = window.getSelection();
  s.removeAllRanges();
  s.addRange(r);
  el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
});
await sleep(300);
check("выделение → кнопка «Ответить на выделенное»", !!(await page.$("[data-quote-reply]")));
await page.click("[data-quote-reply]");
await sleep(300);
const q = await page.$eval('[data-pane="0"] textarea', (e) => e.value);
const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ""));
check("цитата «> …» в поле ввода", q.startsWith("> "), JSON.stringify(q.slice(0, 40)));
check("выделение скопировано в буфер", clip.length > 0 && q.includes(clip.split("\n")[0].trim()));
await page.$eval('[data-pane="0"] textarea', (e) => { e.focus(); e.select(); });
await page.keyboard.press("Backspace");

// 3. Вставка картинки → редактор → файл → модель видит.
await page.click('[data-pane="0"] textarea');
await page.evaluate(async () => {
  const c = document.createElement("canvas");
  c.width = 640; c.height = 400;
  const x = c.getContext("2d");
  x.fillStyle = "#1e88e5"; x.fillRect(0, 0, 640, 400);
  x.fillStyle = "#ffeb3b"; x.beginPath(); x.arc(320, 200, 120, 0, Math.PI * 2); x.fill();
  const blob = await new Promise((r) => c.toBlob(r, "image/png"));
  const dt = new DataTransfer();
  dt.items.add(new File([blob], "paste.png", { type: "image/png" }));
  document.activeElement.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
});
await page.waitForSelector("[data-image-editor] canvas", { timeout: 5000 });
await sleep(500);
check("вставка картинки открывает редактор", true);
const cv = await page.$("[data-image-editor] canvas");
const box = await cv.boundingBox();
const drag = async (x1, y1, x2, y2) => { await page.mouse.move(box.x + box.width * x1, box.y + box.height * y1); await page.mouse.down(); await page.mouse.move(box.x + box.width * x2, box.y + box.height * y2, { steps: 6 }); await page.mouse.up(); await sleep(150); };
await page.click('[data-tool="arrow"]'); await drag(0.1, 0.1, 0.4, 0.4);
await page.click('[data-tool="rect"]'); await drag(0.55, 0.55, 0.9, 0.9);
const size0 = await cv.evaluate((c) => [c.width, c.height]);
await page.click('[data-tool="crop"]'); await drag(0.05, 0.05, 0.95, 0.95);
const size1 = await cv.evaluate((c) => [c.width, c.height]);
check("обрезка уменьшает картинку", size1[0] < size0[0] && size1[1] < size0[1], `${size0} → ${size1}`);
await page.click('[title="Повернуть"]'); await sleep(150);
const size2 = await cv.evaluate((c) => [c.width, c.height]);
check("поворот меняет стороны", size2[0] === size1[1] && size2[1] === size1[0], `${size1} → ${size2}`);
await page.click('[title="Отменить (⌘Z)"]'); await sleep(150);
const size3 = await cv.evaluate((c) => [c.width, c.height]);
check("отмена возвращает поворот", size3[0] === size1[0] && size3[1] === size1[1]);
await page.click("[data-editor-done]");
await page.waitForFunction(() => document.querySelector("[data-attachments] img"), { timeout: 15000 });
check("миниатюра в поле ввода после «Готово»", true);
await page.keyboard.type("Какого цвета круг на картинке? Ответь одним словом.");
await page.keyboard.press("Enter");
await sleep(2000);
const imgInBubble = await page.$$eval('[data-pane="0"] img', (is) => is.some((i) => i.src.startsWith("data:image") && i.naturalWidth > 0));
check("картинка в сообщении пользователя", imgInBubble);
await waitDone();
const answer = (await main()).toLowerCase();
check("модель увидела картинку (жёлтый)", /жёлт|желт|yellow/.test(answer), answer.slice(-120).replace(/\n/g, " "));

// уборка
await page.evaluate(() => [...document.querySelectorAll("nav .group\\/t")].find((r) => r.innerText.includes("Pasted") || r.innerText.includes("строка лога"))?.querySelector("[data-archive]")?.click());
await sleep(800);
check("без ошибок JS", errors.length === 0, errors.join(" | "));
console.log(fails ? `\n${fails} FAIL` : "\nвсё зелёное");
await browser.close();
process.exit(fails ? 1 : 0);
