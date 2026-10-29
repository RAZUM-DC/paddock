"use client";

import { useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { getLang, setLang, t } from "@/lib/i18n";

export default function Login() {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Второй шаг: пароль принят, ждём код из приложения-аутентификатора (Authy и т. п.) или резервный код.
  const [needCode, setNeedCode] = useState(false);
  // Одна галочка на оба шага: без неё сессия до закрытия браузера и код при каждом входе, с ней — 30 дней без пароля и кода.
  const [remember, setRemember] = useState(false);
  // Язык известен только в браузере — рисуем форму после монтирования, иначе разметка разойдётся с серверной.
  const [mounted, setMounted] = useState(false);
  // SSO button and/or password form, as configured on the server (OIDC_ISSUER, LOCAL_LOGIN).
  const [opts, setOpts] = useState<LoginOptions | null>(null);
  useEffect(() => {
    setMounted(true);
    fetch("/api/login-options").then((r) => r.json()).then(setOpts, () => setOpts({ oidc: null, local: true }));
    // A refused SSO login comes back here with ?error=…
    const err = new URLSearchParams(window.location.search).get("error");
    if (err) setError(ssoError(err));
  }, []);

  async function sso() {
    setBusy(true);
    setError("");
    const { error } = await authClient.signIn.social({ provider: "oidc", callbackURL: "/", errorCallbackURL: "/login" });
    if (error) {
      setBusy(false);
      setError(error.message ?? t("Couldn't sign in"));
    }
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    if (needCode) {
      const code = String(f.get("code")).replace(/\s+/g, "");
      const trustDevice = remember;
      // 6 цифр — код из приложения, иначе — резервный код.
      const { error } = /^\d{6}$/.test(code)
        ? await authClient.twoFactor.verifyTotp({ code, trustDevice })
        : await authClient.twoFactor.verifyBackupCode({ code, trustDevice });
      setBusy(false);
      if (error) setError(error.status === 429 ? t("Too many attempts, wait a minute") : t("Invalid code"));
      else window.location.href = "/";
      return;
    }
    const { data, error } = await authClient.signIn.email({
      email: String(f.get("email")),
      password: String(f.get("password")),
      rememberMe: remember,
    });
    setBusy(false);
    if (error) setError(error.status === 401 ? t("Wrong email or password") : error.status === 429 ? t("Too many attempts, wait a minute") : error.message ?? t("Couldn't sign in"));
    else if (data && "twoFactorRedirect" in data && data.twoFactorRedirect) setNeedCode(true);
    else window.location.href = "/";
  }

  if (!mounted || !opts) return <main className="glow flex min-h-full items-center justify-center p-4" />;
  const ssoLabel = opts.oidc?.label ? t("Sign in with {provider}", { provider: opts.oidc.label }) : t("Sign in with SSO");

  return (
    <main className="glow flex min-h-full flex-col items-center justify-center gap-3 p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-3 rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-6 shadow-2xl shadow-black/40">
        <div className="mb-2 flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-[var(--accent)] to-[var(--accent-2)] font-mono text-sm font-bold text-black">{">_"}</span>
          <h1 className="text-lg font-semibold">Paddock</h1>
        </div>
        {opts.oidc && !needCode && (
          <button type="button" onClick={sso} disabled={busy} data-sso
            className="w-full rounded-lg bg-gradient-to-r from-[var(--accent)] to-[var(--accent-2)] px-3 py-2 font-medium text-black disabled:opacity-50">
            {busy ? "…" : ssoLabel}
          </button>
        )}
        {opts.oidc && opts.local && !needCode && <div className="text-center text-xs text-[var(--faint)]">{t("or with a password")}</div>}
        {!opts.local && error && <p className="text-sm text-red-500">{error}</p>}
        {/* key у полей обязательны: без них React отдаёт поле пароля под код, и пароль виден открытым текстом. */}
        {!opts.local ? null : needCode ? (
          <>
            <p className="text-sm text-[var(--muted)]">{t("Code from your authenticator app (Authy) or a backup code.")}</p>
            <input key="code" name="code" defaultValue="" inputMode="numeric" autoComplete="one-time-code" placeholder="123 456" required autoFocus
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-center font-mono text-lg tracking-[0.3em] outline-none focus:border-[var(--accent)]/50" />
          </>
        ) : (
          <>
            <input key="email" name="email" type="email" autoComplete="username" placeholder={t("email")} required
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 outline-none focus:border-[var(--accent)]/50" />
            <input key="password" name="password" type="password" autoComplete="current-password" placeholder={t("password")} required
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 outline-none focus:border-[var(--accent)]/50" />
          </>
        )}
        {opts.local && !needCode && (
          <label className="flex items-center gap-2 text-sm text-[var(--muted)]">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="h-4 w-4 accent-[var(--accent)]" />
            {t("Remember this browser for 30 days")}
          </label>
        )}
        {opts.local && error && <p className="text-sm text-red-500">{error}</p>}
        {opts.local && <button disabled={busy} className="w-full rounded-lg bg-gradient-to-r from-[var(--accent)] to-[var(--accent-2)] px-3 py-2 font-medium text-black disabled:opacity-50">
          {busy ? "…" : needCode ? t("Verify") : t("Sign in")}
        </button>}
      </form>
      <div className="flex gap-1 font-mono text-xs" data-lang-toggle>
        {(["ru", "en"] as const).map((l) => (
          <button key={l} type="button" onClick={() => l !== getLang() && setLang(l)} title={t("Interface language")}
            className={`rounded-md px-2 py-1 ${l === getLang() ? "bg-[var(--panel)] text-[var(--fg)]" : "text-[var(--faint)] hover:text-[var(--fg)]"}`}>
            {l.toUpperCase()}
          </button>
        ))}
      </div>
    </main>
  );
}

type LoginOptions = { oidc: { label: string | null } | null; local: boolean };

// Reasons the server puts into /login?error=… after a refused SSO login (lib/oidc.ts, better-auth's OAuth callback).
function ssoError(code: string): string {
  if (code === "not_allowed") return t("Your account is not allowed to use Paddock. Ask an admin to add you to the right group.");
  if (code === "account_not_linked") return t("A password account with this email already exists. Ask an admin to link it.");
  if (code === "no_email" || code === "email_not_found") return t("The identity provider did not send an email address.");
  return t("Single sign-on failed ({code})", { code: code.slice(0, 60) });
}
