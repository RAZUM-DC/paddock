"use client";

// The second step after a single sign-on login: the code from the authenticator app (or a backup code), or — the first
// time — setting the app up. Until this succeeds the session works nowhere else (lib/second-factor.ts).
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { authClient } from "@/lib/auth-client";
import { getLang, setLang, t } from "@/lib/i18n";

type Setup = { qr: string; secret: string };

const call = async (path: string, body?: unknown) => {
  const r = await fetch(`/api/auth/second-factor/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, code: (j as { code?: string }).code ?? "", data: j as Record<string, unknown> };
};

function errorText(status: number, code: string) {
  if (code === "LOCKED" || status === 429) return t("Too many attempts. Try again in 15 minutes.");
  if (code === "SESSION_REVOKED") return t("Too many wrong codes. Sign in again.");
  if (code === "INVALID_CODE") return t("Invalid code");
  if (code === "NOT_PENDING") return t("Already verified.");
  return t("Something went wrong ({code})", { code: code || String(status) });
}

export function SecondFactor({ enrolled, email, next }: { enrolled: boolean; email: string; next: string }) {
  const [mounted, setMounted] = useState(false);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [backup, setBackup] = useState<string[] | null>(null);
  const [revoked, setRevoked] = useState(false);

  useEffect(() => {
    setMounted(true);
    if (enrolled) return;
    call("enrol").then(async (r) => {
      if (!r.ok) return setError(errorText(r.status, r.code));
      setSetup({ qr: await QRCode.toDataURL(String(r.data.totpURI), { margin: 1, width: 200 }), secret: String(r.data.secret ?? "") });
    });
  }, [enrolled]);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get("code") ?? "").replace(/\s+/g, "");
    setBusy(true);
    setError("");
    const r = await call("verify", { code });
    setBusy(false);
    if (!r.ok) {
      if (r.code === "SESSION_REVOKED") setRevoked(true);
      return setError(errorText(r.status, r.code));
    }
    const codes = r.data.backupCodes;
    if (Array.isArray(codes) && codes.length) setBackup(codes.map(String));
    else window.location.href = next;
  }

  const signOut = async () => {
    await authClient.signOut().catch(() => {});
    window.location.href = "/login";
  };

  if (!mounted) return <main className="glow flex min-h-full items-center justify-center p-4" />;
  const field = "w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-center font-mono text-lg tracking-[0.3em] outline-none focus:border-[var(--accent)]/50";
  const primary = "w-full rounded-lg bg-gradient-to-r from-[var(--accent)] to-[var(--accent-2)] px-3 py-2 font-medium text-black disabled:opacity-50";

  return (
    <main className="glow flex min-h-full flex-col items-center justify-center gap-3 p-4">
      <div className="w-full max-w-sm space-y-3 rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-6 shadow-2xl shadow-black/40" data-second-factor>
        <div className="mb-2 flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-[var(--accent)] to-[var(--accent-2)] font-mono text-sm font-bold text-black">{">_"}</span>
          <h1 className="text-lg font-semibold">{t("Second factor")}</h1>
        </div>
        {email && <p className="truncate font-mono text-xs text-[var(--faint)]">{email}</p>}

        {backup ? (
          <>
            <p className="text-sm text-[var(--muted)]">{t("Done. Save these backup codes somewhere safe: each one replaces the app code once, if you lose your phone. They are shown only now.")}</p>
            <div className="grid grid-cols-2 gap-1 rounded-lg bg-[var(--bg)] p-3 font-mono text-sm" data-backup-codes>
              {backup.map((c) => <span key={c}>{c}</span>)}
            </div>
            <button onClick={() => (window.location.href = next)} className={primary}>{t("Continue")}</button>
          </>
        ) : revoked ? (
          <button onClick={signOut} className={primary}>{t("Sign in again")}</button>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            {enrolled ? (
              <p className="text-sm text-[var(--muted)]">{t("Paddock runs code on your behalf, so after single sign-on it also asks for the code from your authenticator app (or a backup code).")}</p>
            ) : (
              <>
                <p className="text-sm text-[var(--muted)]">{t("Paddock runs code on your behalf, so single sign-on needs a second factor. Scan this code with an authenticator app (Authy, Google Authenticator, 1Password), then enter the 6-digit code it shows.")}</p>
                {setup ? (
                  <div className="flex flex-col items-center gap-2">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={setup.qr} alt={t("QR code for the authenticator app")} width={200} height={200} className="rounded-lg bg-white p-1" />
                    <p className="text-center text-xs text-[var(--faint)]">{t("Or enter this key by hand:")} <span className="break-all font-mono text-[var(--muted)]">{setup.secret}</span></p>
                  </div>
                ) : !error && <p className="text-center text-sm text-[var(--faint)]">…</p>}
              </>
            )}
            <input name="code" defaultValue="" inputMode={enrolled ? "text" : "numeric"} autoComplete="one-time-code" placeholder="123 456" required autoFocus className={field} />
            {error && <p className="text-sm text-red-500">{error}</p>}
            <button disabled={busy || (!enrolled && !setup)} className={primary}>{busy ? "…" : t("Verify")}</button>
          </form>
        )}
        {!backup && (
          <button type="button" onClick={signOut} className="w-full text-center text-xs text-[var(--faint)] hover:text-[var(--fg)]">{t("Sign out")}</button>
        )}
      </div>
      <div className="flex gap-1 font-mono text-xs">
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
