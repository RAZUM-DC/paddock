// localStorage может быть недоступен (приватный режим) — тогда просто живём без памяти.
// Ключи раньше назывались codexhub.* (до переименования в Paddock) — переносим один раз, чтобы раскладки не пропали.
try {
  for (const k of Object.keys(localStorage))
    if (k.startsWith("codexhub.")) {
      const nk = "paddock." + k.slice("codexhub.".length);
      if (localStorage.getItem(nk) == null) localStorage.setItem(nk, localStorage.getItem(k)!);
      localStorage.removeItem(k);
    }
} catch {}
export const store = {
  get<T>(key: string, fallback: T): T {
    try {
      const v = localStorage.getItem(key);
      return v ? (JSON.parse(v) as T) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
};
