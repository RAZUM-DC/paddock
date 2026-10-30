// Secret requests from the agent (the `secrets` tool): a masked form in the pane of the chat that asked, so the value
// goes from the browser to web and on into a file in the workspace, never through the chat.
// useSecretRequests polls /api/secret-requests every 4 s while the page is visible.
import { useCallback, useEffect, useState } from "react";
import { t } from "@/lib/i18n";
import { Icon } from "./icons";

export type SecretRequest = { id: string; name: string; file: string; reason: string; threadId: string | null; createdAt: number; expiresAt: number };

const POLL_MS = 4000;

export function useSecretRequests(enabled: boolean) {
  const [requests, setRequests] = useState<SecretRequest[]>([]);
  // Answered here: hidden at once, even before the next poll confirms it.
  const [answered, setAnswered] = useState<Set<string>>(() => new Set());

  const poll = useCallback(async () => {
    const r = await fetch("/api/secret-requests", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (r?.requests) setRequests(r.requests);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer || document.visibilityState !== "visible") return;
      void poll();
      timer = setInterval(poll, POLL_MS);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => (document.visibilityState === "visible" ? start() : stop());
    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, poll]);

  const done = useCallback((id: string) => setAnswered((s) => new Set(s).add(id)), []);
  return { requests: requests.filter((r) => !answered.has(r.id)), done, refresh: poll };
}

export function SecretRequestCards({ requests, titleOf, onDone }: { requests: SecretRequest[]; titleOf: (threadId: string | null) => string | null; onDone: (id: string) => void }) {
  if (requests.length === 0) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-14 z-20 flex flex-col items-center gap-2 px-3">
      {requests.map((r) => <SecretRequestCard key={r.id} req={r} who={titleOf(r.threadId)} onDone={() => onDone(r.id)} />)}
    </div>
  );
}

function SecretRequestCard({ req, who, onDone }: { req: SecretRequest; who: string | null; onDone: () => void }) {
  const [value, setValue] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(i);
  }, []);
  const minutes = Math.max(0, Math.ceil((req.expiresAt - now) / 60_000));

  const answer = async (body: { value: string } | { decline: true }) => {
    setBusy(true);
    setResult(null);
    try {
      const r = await fetch(`/api/secret-requests/${req.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? t("error {status}", { status: r.status }));
      setValue("");
      setResult({ ok: true, text: "value" in body ? t("Saved. The agent writes it to the file and continues.") : t("Declined. The agent has been told.") });
      setTimeout(onDone, 2500);
    } catch (e) {
      setResult({ ok: false, text: e instanceof Error ? e.message : t("failed") });
    }
    setBusy(false);
  };

  const finished = result?.ok === true;
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); if (value && !busy && !finished) void answer({ value }); }}
      className="pointer-events-auto w-full max-w-md space-y-2.5 rounded-xl border border-[var(--yellow)]/50 bg-[var(--panel)] p-3 text-sm shadow-2xl shadow-black/60"
      data-secret-request={req.name}
    >
      <div className="flex items-start gap-2">
        <Icon name="lock" size={15} className="mt-0.5 shrink-0 text-[var(--yellow)]" />
        <div className="min-w-0 flex-1">
          <div className="font-medium">{t("The agent asks for a secret")}</div>
          <div className="truncate text-xs text-[var(--muted)]">{who ? t("from the chat “{title}”", { title: who }) : t("from a chat of yours")} · {t("{n} min left", { n: minutes })}</div>
        </div>
      </div>
      <div className="space-y-0.5 rounded-lg bg-[var(--panel-2)] px-2.5 py-2 font-mono text-xs">
        <div><span className="text-[var(--faint)]">{t("name")} </span>{req.name}</div>
        <div className="truncate" title={req.file}><span className="text-[var(--faint)]">{t("file")} </span>{req.file}</div>
        {req.reason && (
          <div className="whitespace-pre-wrap break-words pt-1 font-sans text-[var(--muted)]">
            <span className="text-[var(--faint)]">{t("The agent says:")} </span>“{req.reason}”
          </div>
        )}
      </div>
      {/* Fixed text, not the agent's: the request itself is written by the agent and could ask for anything. */}
      <p className="rounded-lg border border-[var(--red)]/40 bg-[var(--red)]/[0.06] px-2.5 py-1.5 text-xs text-[var(--red)]">
        {t("Never enter your Paddock, SSO or corporate account password here. This form hands the value to the agent.")}
      </p>
      {!finished && (
        <div className="flex gap-2">
          {/* A hidden username field keeps password managers from filling in the user's Paddock login here. */}
          <input type="text" name="username" autoComplete="off" value={req.name} readOnly hidden />
          <input type={show ? "text" : "password"} value={value} onChange={(e) => { setValue(e.target.value); setResult(null); }} autoFocus autoComplete="new-password" spellCheck={false}
            placeholder={t("value")} className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-1.5 font-mono text-sm outline-none focus:border-[var(--accent)]/50" />
          <button type="button" onClick={() => setShow((s) => !s)} className="shrink-0 rounded-lg border border-[var(--border)] px-2 text-xs text-[var(--muted)] hover:bg-[var(--panel-2)]" title={show ? t("Hide") : t("Show")}>
            {show ? t("Hide") : t("Show")}
          </button>
        </div>
      )}
      <div className="flex items-center gap-2">
        {!finished && (
          <>
            <button type="submit" disabled={!value || busy} className="rounded-lg bg-gradient-to-r from-[var(--accent)] to-[var(--accent-2)] px-3 py-1.5 text-sm font-medium text-black disabled:opacity-40">{busy ? "…" : t("Save")}</button>
            <button type="button" disabled={busy} onClick={() => answer({ decline: true })} className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-[var(--panel-2)] disabled:opacity-40">{t("Decline")}</button>
          </>
        )}
        {result && <span className={`text-xs ${result.ok ? "text-[var(--green)]" : "text-[var(--red)]"}`}>{result.text}</span>}
      </div>
      {!finished && <p className="text-[11px] text-[var(--faint)]">{t("The value goes into the file only, not into the chat. It is not stored by Paddock.")}</p>}
    </form>
  );
}
