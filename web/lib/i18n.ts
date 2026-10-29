// Язык интерфейса без библиотек: ключ — русская строка, словари RU→EN по областям в lib/i18n/.
// Подстановки — {name}: t("действий {n}", { n: 3 }). Нет перевода — показываем русский.
// Язык: Настройки / переключатель в сайдбаре (localStorage paddock.lang), по умолчанию — язык браузера.
import { store } from "./store";
import chat from "./i18n/chat";
import panels from "./i18n/panels";
import settings from "./i18n/settings";

export type Lang = "ru" | "en";
const en: Record<string, string> = { ...chat, ...panels, ...settings };

function detect(): Lang {
  if (typeof window === "undefined") return "ru";
  const saved = store.get<Lang | null>("paddock.lang", null);
  if (saved === "ru" || saved === "en") return saved;
  return navigator.language?.toLowerCase().startsWith("ru") ? "ru" : "en";
}

let lang: Lang = detect();
export const getLang = () => lang;
export const locale = () => (lang === "en" ? "en-GB" : "ru");

// Смена языка перерисовывает всё приложение — проще перезагрузить, чем протаскивать язык через контекст.
export function setLang(l: Lang) {
  store.set("paddock.lang", l);
  lang = l;
  window.location.reload();
}

export function t(s: string, vars?: Record<string, string | number>): string {
  let out = lang === "en" ? (en[s] ?? s) : s;
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, String(v));
  return out;
}
