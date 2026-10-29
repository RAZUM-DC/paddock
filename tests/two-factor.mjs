// 2FA end-to-end: включить TOTP в настройках (QR сразу, без ввода кода; код как Authy считаем сами из секрета), выйти,
// войти с кодом, затем выключить обратно. Аккаунт остаётся как был.
// Запуск: HUB_PASS=… node tests/two-factor.mjs
import puppeteer from "puppeteer-core";
import { createHmac } from "node:crypto";

const URL_ = process.env.HUB_URL ?? "http://localhost:8088";
const PASS = process.env.HUB_PASS;
const EMAIL = process.env.HUB_EMAIL ?? "valera@hub.local";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// RFC 6238: base32-секрет → 6 цифр на текущие 30 с.
function totp(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of secret.replace(/[\s=]/g, "").toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = createHmac("sha1", key).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, "0");
}

const browser = await puppeteer.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, defaultViewport: { width: 1400, height: 1000 } });
const page = await browser.newPage();
let fails = 0;
const check = (name, ok, extra = "") => { if (!ok) fails++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); };
const clickText = (sel, t) => page.evaluate((s, t) => { const el = [...document.querySelectorAll(s)].find((e) => e.innerText.trim() === t); el?.click(); return !!el; }, sel, t);
const openWebTab = async () => {
  await page.click('[title="Настройки"]');
  await clickText(".fixed.inset-0 button", "Вход в морду");
  await page.waitForFunction(() => /Двухфакторный вход/.test(document.querySelector(".fixed.inset-0").innerText), { timeout: 10000 });
};
const login = async () => {
  await page.goto(`${URL_}/login`, { waitUntil: "networkidle0" });
  await page.evaluate(() => localStorage.setItem("paddock.lang", JSON.stringify("ru")));
  await page.reload({ waitUntil: "networkidle0" });
  await page.type("input[name=email]", EMAIL);
  await page.type("input[name=password]", PASS);
  await page.click("button");
};
let secret = "";
try {
  await login();
  await page.waitForFunction(() => document.body.innerText.includes("Лимиты Codex"), { timeout: 20000 });
  await openWebTab();
  const fa = '.fixed.inset-0 input[placeholder="подтверди паролем от морды"]';
  await page.type(fa, PASS);
  await clickText(".fixed.inset-0 button", "Включить 2FA");
  await page.waitForSelector('.fixed.inset-0 img[alt^="QR"]', { timeout: 10000 });
  secret = (await page.$eval(".fixed.inset-0 code", (e) => e.innerText)).replace(/\s/g, "");
  const backup = await page.$$eval(".fixed.inset-0 .grid-cols-2 span", (s) => s.map((x) => x.innerText));
  check("включение: QR, ключ и резервные коды", secret.length >= 16 && backup.length >= 8, `коды: ${backup.length}`);
  const on = await page.waitForFunction(() => [...document.querySelectorAll(".fixed.inset-0 h3")].some((h) => /Двухфакторный вход\s*включён/.test(h.innerText)), { timeout: 10000 }).then(() => true, () => false);
  check("включено сразу, без ввода кода в настройках", on && !(await page.$('.fixed.inset-0 input[autocomplete="one-time-code"]')));
  await page.keyboard.press("Escape");

  // выход и вход: после пароля просит код
  await page.evaluate(() => fetch("/api/auth/sign-out", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }));
  await login();
  await page.waitForSelector('input[name="code"]', { timeout: 10000 });
  check("вход: после пароля просит код, поле кода пустое", (await page.$eval('input[name="code"]', (e) => e.value)) === "");
  await page.type('input[name="code"]', "000000");
  await page.click("button");
  await page.waitForFunction(() => /Код не подошёл/.test(document.body.innerText), { timeout: 10000 });
  check("вход: неверный код отбивается", true);
  await page.$eval('input[name="code"]', (e) => (e.value = ""));
  await page.type('input[name="code"]', totp(secret));
  await Promise.all([page.waitForNavigation({ waitUntil: "networkidle0" }), page.click("button")]);
  await page.waitForFunction(() => document.body.innerText.includes("Лимиты Codex"), { timeout: 20000 });
  check("вход: верный код пускает", true);
} catch (e) {
  check("сценарий", false, e.message.split("\n")[0]);
  await page.screenshot({ path: "/tmp/two-factor-fail.png" });
}
// Уборка: выключить 2FA через API, чтобы аккаунт остался как был (и при упавшем сценарии тоже).
// Через интерфейс ненадёжно: если вход сломался посередине, до настроек можно не дойти.
try {
  if (!(await page.$('[title="Настройки"]'))) {
    await login();
    if (await page.waitForSelector('input[name="code"]', { timeout: 5000 }).catch(() => null)) {
      await page.type('input[name="code"]', totp(secret));
      await Promise.all([page.waitForNavigation({ waitUntil: "networkidle0" }), page.click("button")]);
    }
  }
  const r = await page.evaluate((password) => fetch("/api/auth/two-factor/disable", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) }).then((x) => x.status), PASS);
  const s = await page.evaluate(() => fetch("/api/auth/get-session").then((x) => x.json()));
  check("уборка: 2FA выключена обратно", s?.user?.twoFactorEnabled === false, `disable ${r}`);
} catch (e) {
  check("уборка: 2FA выключена обратно", false, e.message.split("\n")[0]);
}
console.log(fails ? `\n${fails} FAIL` : "\nвсё зелёное");
await browser.close();
process.exit(fails ? 1 : 0);
