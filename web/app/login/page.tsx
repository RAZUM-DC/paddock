"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth-client";

export default function Login() {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Второй шаг: пароль принят, ждём код из приложения-аутентификатора (Authy и т. п.) или резервный код.
  const [needCode, setNeedCode] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    if (needCode) {
      const code = String(f.get("code")).replace(/\s+/g, "");
      const trustDevice = f.get("trust") === "on";
      // 6 цифр — код из приложения, иначе — резервный код.
      const { error } = /^\d{6}$/.test(code)
        ? await authClient.twoFactor.verifyTotp({ code, trustDevice })
        : await authClient.twoFactor.verifyBackupCode({ code, trustDevice });
      setBusy(false);
      if (error) setError(error.status === 429 ? "Слишком много попыток, подожди минуту" : "Код не подошёл");
      else window.location.href = "/";
      return;
    }
    const { data, error } = await authClient.signIn.email({
      email: String(f.get("email")),
      password: String(f.get("password")),
    });
    setBusy(false);
    if (error) setError(error.status === 401 ? "Неверная почта или пароль" : error.status === 429 ? "Слишком много попыток, подожди минуту" : error.message ?? "Не получилось войти");
    else if (data && "twoFactorRedirect" in data && data.twoFactorRedirect) setNeedCode(true);
    else window.location.href = "/";
  }

  return (
    <main className="glow flex min-h-full items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-3 rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-6 shadow-2xl shadow-black/40">
        <div className="mb-2 flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-[var(--accent)] to-[var(--accent-2)] font-mono text-sm font-bold text-black">{">_"}</span>
          <h1 className="text-lg font-semibold">Paddock</h1>
        </div>
        {/* key у полей обязательны: без них React отдаёт поле пароля под код, и пароль виден открытым текстом. */}
        {needCode ? (
          <>
            <p className="text-sm text-[var(--muted)]">Код из приложения-аутентификатора (Authy) или резервный код.</p>
            <input key="code" name="code" defaultValue="" inputMode="numeric" autoComplete="one-time-code" placeholder="123 456" required autoFocus
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-center font-mono text-lg tracking-[0.3em] outline-none focus:border-[var(--accent)]/50" />
            <label className="flex items-center gap-2 text-sm text-[var(--muted)]">
              <input name="trust" type="checkbox" className="h-4 w-4 accent-[var(--accent)]" /> Доверять этому браузеру 30 дней
            </label>
          </>
        ) : (
          <>
            <input key="email" name="email" type="email" autoComplete="username" placeholder="email" required
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 outline-none focus:border-[var(--accent)]/50" />
            <input key="password" name="password" type="password" autoComplete="current-password" placeholder="пароль" required
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 outline-none focus:border-[var(--accent)]/50" />
          </>
        )}
        {error && <p className="text-sm text-red-500">{error}</p>}
        <button disabled={busy} className="w-full rounded-lg bg-gradient-to-r from-[var(--accent)] to-[var(--accent-2)] px-3 py-2 font-medium text-black disabled:opacity-50">
          {busy ? "…" : needCode ? "Подтвердить" : "Войти"}
        </button>
      </form>
    </main>
  );
}
