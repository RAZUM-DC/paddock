// Settings → Git: the commit identity (a file in the harness home, written through the harness fs API) and the user's
// git accounts (stored by web, token encrypted; the harness gets a token only through its git credential helper).
import { useEffect, useState } from "react";
import { GIT_IDENTITY_FILE, identityConfig, parseIdentity, validateIdentity } from "@/lib/git-identity";
import { b64, unb64 } from "@/lib/tools";
import { locale, t } from "@/lib/i18n";

type Request = (method: string, params: unknown) => Promise<any>;
type Account = { id: string; host: string; prefix: string; username: string; label: string; last4: string; createdAt: number };

const field = "w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]/50";
const primary = "rounded-lg bg-gradient-to-r from-[var(--accent)] to-[var(--accent-2)] px-3 py-1.5 text-sm font-medium text-black disabled:opacity-40";
const secondary = "rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-[var(--panel-2)] disabled:opacity-40";

const defaultUsername = (host: string) => (host.trim().toLowerCase() === "github.com" ? "x-access-token" : "oauth2");

export function GitTab({ request }: { request: Request }) {
  return (
    <div className="space-y-8">
      <IdentitySection request={request} />
      <AccountsSection />
    </div>
  );
}

function IdentitySection({ request }: { request: Request }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [loaded, setLoaded] = useState<{ name: string; email: string } | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    request("fs/readFile", { path: GIT_IDENTITY_FILE })
      .then((f) => parseIdentity(unb64(f.dataBase64)), () => ({ name: "", email: "" }))
      .then((id) => {
        setName(id.name);
        setEmail(id.email);
        setLoaded(id);
      });
  }, [request]);

  const err = validateIdentity({ name, email });
  const dirty = !!loaded && (name.trim() !== loaded.name || email.trim() !== loaded.email);
  const save = async () => {
    setStatus(null);
    try {
      await request("fs/createDirectory", { path: GIT_IDENTITY_FILE.replace(/\/[^/]+$/, ""), recursive: true });
      await request("fs/writeFile", { path: GIT_IDENTITY_FILE, dataBase64: b64(identityConfig({ name, email })) });
      setLoaded({ name: name.trim(), email: email.trim() });
      setStatus({ ok: true, text: t("Saved, applies to the next git command") });
    } catch (e) {
      setStatus({ ok: false, text: e instanceof Error ? e.message : t("failed") });
    }
  };

  return (
    <section className="space-y-3">
      <div>
        <h3 className="font-medium">{t("Commit identity")}</h3>
        <p className="text-sm text-[var(--muted)]">{t("Name and email the agent's commits are signed with (git user.name and user.email).")}</p>
      </div>
      {!loaded ? <p className="text-sm text-[var(--faint)]">{t("reading…")}</p> : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1.5">
              <span className="text-xs text-[var(--muted)]">{t("Name")}</span>
              <input value={name} onChange={(e) => { setName(e.target.value); setStatus(null); }} placeholder="Ada Lovelace" autoComplete="off" className={field} />
            </label>
            <label className="space-y-1.5">
              <span className="text-xs text-[var(--muted)]">{t("Email")}</span>
              <input value={email} onChange={(e) => { setEmail(e.target.value); setStatus(null); }} placeholder="ada@example.com" autoComplete="off" className={field} />
            </label>
          </div>
          <div className="flex items-center gap-3">
            <button onClick={save} disabled={!dirty || !!err} className={primary}>{t("Save")}</button>
            {dirty && err && <span className="text-sm text-[var(--red)]">{t(err)}</span>}
            {status && <span className={`text-sm ${status.ok ? "text-[var(--green)]" : "text-[var(--red)]"}`}>{status.text}</span>}
          </div>
        </>
      )}
    </section>
  );
}

function AccountsSection() {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [error, setError] = useState("");
  const [host, setHost] = useState("github.com");
  const [prefix, setPrefix] = useState("");
  const [username, setUsername] = useState("x-access-token");
  const [usernameTouched, setUsernameTouched] = useState(false);
  const [token, setToken] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);

  const load = () =>
    fetch("/api/git/accounts", { cache: "no-store" })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error ?? t("error {status}", { status: r.status }));
        setAccounts(j.accounts);
      })
      .catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const changeHost = (h: string) => {
    setHost(h);
    if (!usernameTouched) setUsername(defaultUsername(h));
    setStatus(null);
  };

  const add = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const r = await fetch("/api/git/accounts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ host, prefix, username, token, label }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? t("error {status}", { status: r.status }));
      setToken("");
      setLabel("");
      setPrefix("");
      setStatus({ ok: true, text: t("Account added") });
      await load();
    } catch (e) {
      setStatus({ ok: false, text: e instanceof Error ? e.message : t("failed") });
    }
    setBusy(false);
  };

  const remove = async (id: string) => {
    setConfirm(null);
    const r = await fetch(`/api/git/accounts/${id}`, { method: "DELETE" });
    if (!r.ok) setError((await r.json().catch(() => ({}))).error ?? t("error {status}", { status: r.status }));
    await load();
  };

  return (
    <section className="space-y-3">
      <div>
        <h3 className="font-medium">{t("Git accounts")}</h3>
        <p className="text-sm text-[var(--muted)]">
          {t("The agent's git gets these tokens for https remotes through a credential helper; they are not written into the container or the chat.")}
        </p>
        <p className="mt-1 text-xs text-[var(--yellow)]">
          {t("Use fine-grained tokens limited to the repositories the agent needs, with an expiry date. The agent can technically read a token it uses, so keep each token's scope narrow.")}
        </p>
      </div>
      {error && <p className="text-sm text-[var(--red)]">{error}</p>}
      {!accounts && !error && <p className="text-sm text-[var(--faint)]">{t("reading…")}</p>}
      {accounts && accounts.length === 0 && <p className="text-sm text-[var(--faint)]">{t("no accounts yet")}</p>}
      {accounts && accounts.length > 0 && (
        <div className="divide-y divide-[var(--border)] overflow-hidden rounded-xl border border-[var(--border)]">
          {accounts.map((a) => (
            <div key={a.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{a.label}</div>
                <div className="truncate font-mono text-[11px] text-[var(--muted)]">
                  {a.host}/{a.prefix ? `${a.prefix}/…` : "*"} · {a.username} · ••••{a.last4} · {new Date(a.createdAt).toLocaleDateString(locale())}
                </div>
              </div>
              {confirm === a.id ? (
                <span className="flex items-center gap-1.5 text-xs">
                  <button onClick={() => remove(a.id)} className="rounded-lg bg-[var(--red)] px-2.5 py-1 font-medium text-black">{t("Delete")}</button>
                  <button onClick={() => setConfirm(null)} className="rounded-lg px-2 py-1 text-[var(--muted)] hover:bg-[var(--panel)]">{t("No")}</button>
                </span>
              ) : (
                <button onClick={() => setConfirm(a.id)} className={secondary}>{t("Delete")}</button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="space-y-3 rounded-xl bg-[var(--panel-2)] p-3">
        <div className="text-sm font-medium">{t("Add an account")}</div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1.5">
            <span className="text-xs text-[var(--muted)]">{t("Host")}</span>
            <input value={host} onChange={(e) => changeHost(e.target.value)} placeholder="github.com" autoComplete="off" spellCheck={false} className={field} />
          </label>
          <label className="space-y-1.5">
            <span className="text-xs text-[var(--muted)]">{t("Path prefix (optional)")}</span>
            <input value={prefix} onChange={(e) => { setPrefix(e.target.value); setStatus(null); }} placeholder="my-org/" autoComplete="off" spellCheck={false} className={field} />
          </label>
          <label className="space-y-1.5">
            <span className="text-xs text-[var(--muted)]">{t("Username")}</span>
            <input value={username} onChange={(e) => { setUsername(e.target.value); setUsernameTouched(true); setStatus(null); }} autoComplete="off" spellCheck={false} className={field} />
          </label>
          <label className="space-y-1.5">
            <span className="text-xs text-[var(--muted)]">{t("Label (optional)")}</span>
            <input value={label} onChange={(e) => { setLabel(e.target.value); setStatus(null); }} placeholder={t("work GitHub")} autoComplete="off" className={field} />
          </label>
          <label className="space-y-1.5 sm:col-span-2">
            <span className="text-xs text-[var(--muted)]">{t("Token")}</span>
            <input type="password" name="git-token" value={token} onChange={(e) => { setToken(e.target.value); setStatus(null); }} autoComplete="new-password" spellCheck={false} className={field} />
          </label>
        </div>
        <p className="text-xs text-[var(--faint)]">
          {t("A prefix limits the account to repositories under it (my-org/ → github.com/my-org/*); without one it covers every repository on the host. The most specific prefix wins. The token is shown only as its last 4 characters.")}
        </p>
        <div className="flex items-center gap-3">
          <button onClick={add} disabled={busy || !host.trim() || !token.trim()} className={primary}>{busy ? "…" : t("Add")}</button>
          {status && <span className={`text-sm ${status.ok ? "text-[var(--green)]" : "text-[var(--red)]"}`}>{status.text}</span>}
        </div>
      </div>
    </section>
  );
}
