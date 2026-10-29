// "Preparing your workspace": shown while the harness is being created by the provisioner (PROVISIONER_URL),
// instead of a red "no connection". Asks /api/harness only while the WS connection is down.
import { useEffect, useState } from "react";
import { t } from "@/lib/i18n";

type State = { state: "ready" | "unmanaged" } | { state: "preparing"; since: number } | { state: "failed"; error: string };

export function WorkspaceStatus({ connected }: { connected: boolean }) {
  const [st, setSt] = useState<State | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [polls, setPolls] = useState(0);

  useEffect(() => {
    if (connected) return setSt(null);
    let stop = false;
    const poll = async () => {
      const r = await fetch("/api/harness").then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (stop) return;
      setSt(r);
      setNow(Date.now());
      // The WS bridge reconnects by itself every 2 s; this only drives the message.
      if (r?.state === "preparing") setTimeout(poll, 3000);
    };
    // Give a normal connect a moment before saying anything.
    const first = setTimeout(poll, 1500);
    return () => {
      stop = true;
      clearTimeout(first);
    };
  }, [connected, polls]);

  if (connected || !st || (st.state !== "preparing" && st.state !== "failed")) return null;

  const retry = async () => {
    const r = await fetch("/api/harness", { method: "POST" }).then((r) => r.json()).catch(() => null);
    setSt(r);
    setNow(Date.now());
    // Keep polling while it prepares again.
    if (r?.state === "preparing") setPolls((n) => n + 1);
  };

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/50 p-4" data-workspace-status={st.state}>
      <div className="w-full max-w-sm space-y-3 rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-6 text-center shadow-2xl shadow-black/40">
        {st.state === "preparing" ? (
          <>
            <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-[var(--border)] border-t-[var(--accent)]" />
            <h2 className="font-medium">{t("Preparing your workspace")}</h2>
            <p className="text-sm text-[var(--muted)]">{t("Your own agent container is being created. This takes up to two minutes the first time.")}</p>
            <p className="font-mono text-xs text-[var(--faint)]">{t("{n} s", { n: Math.max(0, Math.round((now - st.since) / 1000)) })}</p>
          </>
        ) : (
          <>
            <h2 className="font-medium text-[var(--red)]">{t("Could not prepare your workspace")}</h2>
            <p className="break-words text-sm text-[var(--muted)]">{st.error}</p>
            <button onClick={retry} className="rounded-lg bg-gradient-to-r from-[var(--accent)] to-[var(--accent-2)] px-3 py-1.5 text-sm font-medium text-black">{t("Try again")}</button>
          </>
        )}
      </div>
    </div>
  );
}
