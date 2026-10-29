"use client";

import { useState } from "react";
import { createAuthClient } from "better-auth/react";

const authClient = createAuthClient();

export default function Login() {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    const { error } = await authClient.signIn.email({
      email: String(f.get("email")),
      password: String(f.get("password")),
    });
    setBusy(false);
    if (error) setError(error.status === 401 ? "Неверная почта или пароль" : error.status === 429 ? "Слишком много попыток, подожди минуту" : error.message ?? "Не получилось войти");
    else window.location.href = "/";
  }

  return (
    <main className="glow flex min-h-full items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-3 rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-6 shadow-2xl shadow-black/40">
        <div className="mb-2 flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-[var(--accent)] to-[var(--accent-2)] font-mono text-sm font-bold text-black">{">_"}</span>
          <h1 className="text-lg font-semibold">Paddock</h1>
        </div>
        <input name="email" type="email" autoComplete="username" placeholder="email" required
          className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 outline-none focus:border-[var(--accent)]/50" />
        <input name="password" type="password" autoComplete="current-password" placeholder="пароль" required
          className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 outline-none focus:border-[var(--accent)]/50" />
        {error && <p className="text-sm text-red-500">{error}</p>}
        <button disabled={busy} className="w-full rounded-lg bg-gradient-to-r from-[var(--accent)] to-[var(--accent-2)] px-3 py-2 font-medium text-black disabled:opacity-50">
          {busy ? "…" : "Войти"}
        </button>
      </form>
    </main>
  );
}
