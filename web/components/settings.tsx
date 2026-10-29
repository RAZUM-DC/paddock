// Настройки: вход в ChatGPT через device code прямо из морды, настройки Codex (config.toml в контейнере), пароль морды.
import { useEffect, useState } from "react";
import { createAuthClient } from "better-auth/react";
import { maskEmail, type AccountInfo } from "./account";
import { Icon } from "./icons";
import { ToolsTab } from "./tools";
import type { Model } from "./model-picker";

type Request = (method: string, params: unknown) => Promise<any>;
export type LoginEvent = { loginId: string | null; success: boolean; error: string | null };

const field = "w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]/50";
const primary = "rounded-lg bg-gradient-to-r from-[var(--accent)] to-[var(--accent-2)] px-3 py-1.5 text-sm font-medium text-black disabled:opacity-40";
const secondary = "rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-[var(--panel-2)] disabled:opacity-40";

export function Settings({ email, account, models, ndModels, reloadNeuralDeep, request, loginEvent, onClose }: {
  email: string;
  account: AccountInfo | null;
  models: Model[];
  ndModels: Model[];
  reloadNeuralDeep: () => Promise<number>;
  request: Request;
  loginEvent: LoginEvent | null;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"account" | "neuraldeep" | "tools" | "codex" | "proxy" | "web">("account");

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);

  const tabs = [
    ["account", "Аккаунт ChatGPT"],
    ["neuraldeep", "NeuralDeep"],
    ["tools", "Инструменты"],
    ["codex", "Codex"],
    ["proxy", "Прокси"],
    ["web", "Вход в морду"],
  ] as const;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="flex max-h-[90dvh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--panel)] shadow-2xl shadow-black/60">
        <div className="flex items-center gap-3 border-b border-[var(--border)] px-5 py-3.5">
          <span className="font-semibold">Настройки</span>
          <span className="flex-1" />
          <button onClick={onClose} className="rounded-md p-1.5 text-[var(--muted)] hover:bg-[var(--panel-2)]" title="Закрыть">
            <Icon name="plus" size={16} className="rotate-45" />
          </button>
        </div>
        <div className="flex gap-1 border-b border-[var(--border)] px-4">
          {tabs.map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)}
              className={`-mb-px border-b-2 px-3 py-2.5 text-sm ${tab === id ? "border-[var(--accent)] text-[var(--fg)]" : "border-transparent text-[var(--muted)] hover:text-[var(--fg)]"}`}>
              {label}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {tab === "account" && <AccountTab account={account} request={request} loginEvent={loginEvent} />}
          {tab === "neuraldeep" && <NeuralDeepTab request={request} models={ndModels} reload={reloadNeuralDeep} />}
          {tab === "tools" && <ToolsTab request={request} />}
          {tab === "codex" && <CodexTab models={models} request={request} />}
          {tab === "proxy" && <ProxyTab />}
          {tab === "web" && <WebTab email={email} />}
        </div>
      </div>
    </div>
  );
}

function AccountTab({ account, request, loginEvent }: { account: AccountInfo | null; request: Request; loginEvent: LoginEvent | null }) {
  const [flow, setFlow] = useState<{ loginId: string; url: string; code: string } | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!flow || !loginEvent || (loginEvent.loginId && loginEvent.loginId !== flow.loginId)) return;
    setFlow(null);
    setStatus(loginEvent.success ? { ok: true, text: "Вход выполнен" } : { ok: false, text: loginEvent.error ?? "Вход не удался" });
  }, [loginEvent, flow]);

  const startDevice = async () => {
    setStatus(null);
    try {
      const r = await request("account/login/start", { type: "chatgptDeviceCode" });
      setFlow({ loginId: r.loginId, url: r.verificationUrl, code: r.userCode });
    } catch (e) {
      setStatus({ ok: false, text: e instanceof Error ? e.message : "не удалось начать вход" });
    }
  };

  const cancel = async () => {
    if (flow) await request("account/login/cancel", { loginId: flow.loginId }).catch(() => {});
    setFlow(null);
  };

  const useKey = async () => {
    try {
      await request("account/login/start", { type: "apiKey", apiKey: apiKey.trim() });
      setApiKey("");
      setStatus({ ok: true, text: "API-ключ сохранён" });
    } catch (e) {
      setStatus({ ok: false, text: e instanceof Error ? e.message : "ключ не принят" });
    }
  };

  const logout = async () => {
    await request("account/logout", undefined);
    setConfirmLogout(false);
    setStatus({ ok: true, text: "Вышли из аккаунта" });
  };

  return (
    <div className="space-y-6">
      <section className="flex items-center gap-3 rounded-xl bg-[var(--panel-2)] p-4">
        <span className={`h-2 w-2 shrink-0 rounded-full ${account?.email || account?.plan ? "bg-[var(--green)]" : "bg-[var(--red)]"}`} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-sm">{account?.email ? maskEmail(account.email) : account?.plan ? "аккаунт подключён" : "не подключён"}</div>
          {account?.plan && <div className="text-xs text-[var(--muted)]">план <span className="font-mono text-[var(--accent)]">{account.plan}</span></div>}
        </div>
        {(account?.email || account?.plan) && !confirmLogout && <button onClick={() => setConfirmLogout(true)} className={secondary}>Выйти</button>}
        {confirmLogout && (
          <div className="flex items-center gap-1.5 text-xs">
            <span className="text-[var(--muted)]">Codex перестанет отвечать до нового входа.</span>
            <button onClick={logout} className="rounded-lg bg-[var(--red)] px-2.5 py-1 font-medium text-black">Выйти</button>
            <button onClick={() => setConfirmLogout(false)} className="rounded-lg px-2 py-1 text-[var(--muted)] hover:bg-[var(--panel)]">Нет</button>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div>
          <h3 className="font-medium">Вход через ChatGPT</h3>
          <p className="text-sm text-[var(--muted)]">Код устройства: откроешь ссылку, войдёшь в ChatGPT и введёшь код. Терминал не нужен.</p>
        </div>
        {!flow ? (
          <button onClick={startDevice} className={primary}>{account?.email ? "Войти в другой аккаунт" : "Получить код"}</button>
        ) : (
          <div className="space-y-3 rounded-xl border border-[var(--accent)]/40 bg-[var(--accent)]/[0.05] p-4">
            <div className="text-sm">
              1. Открой{" "}
              <a href={flow.url} target="_blank" rel="noreferrer noopener" className="font-mono text-[var(--accent)] underline underline-offset-2">{flow.url}</a>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-sm">
              2. Введи код
              <span className="rounded-lg bg-[var(--bg)] px-3 py-1.5 font-mono text-xl tracking-[0.2em] text-[var(--fg)]">{flow.code}</span>
              <button onClick={async () => { await navigator.clipboard.writeText(flow.code); setCopied(true); setTimeout(() => setCopied(false), 1500); }} className={secondary}>
                {copied ? "скопирован" : "копировать"}
              </button>
            </div>
            <div className="flex items-center gap-2 text-xs text-[var(--muted)]">
              <span className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-[var(--faint)] border-t-[var(--accent)]" />
              жду подтверждения…
              <span className="flex-1" />
              <button onClick={cancel} className="rounded-md px-2 py-1 hover:bg-[var(--panel-2)]">Отменить</button>
            </div>
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="font-medium">Или API-ключ OpenAI</h3>
        <div className="flex gap-2">
          <input type="password" name="openai-api-key" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-…" autoComplete="off" className={field} />
          <button onClick={useKey} disabled={!apiKey.trim().startsWith("sk-")} className={secondary}>Сохранить</button>
        </div>
        <p className="text-xs text-[var(--faint)]">Ключ уходит прямо в Codex (в его auth.json в контейнере), морда его не хранит.</p>
      </section>

      {status && <div className={`text-sm ${status.ok ? "text-[var(--green)]" : "text-[var(--red)]"}`}>{status.text}</div>}
    </div>
  );
}

type CodexConfig = {
  model: string;
  model_reasoning_effort: string;
  approval_policy: string;
  sandbox_mode: string;
  web_search: string;
  developer_instructions: string;
};

const options = {
  approval_policy: [
    ["on-request", "по запросу модели"],
    ["untrusted", "всё, кроме безопасных команд"],
    ["never", "никогда не спрашивать"],
  ],
  sandbox_mode: [
    ["danger-full-access", "полный доступ (контейнер и есть песочница)"],
    ["workspace-write", "запись только в workspace"],
    ["read-only", "только чтение"],
  ],
  web_search: [
    ["live", "живой поиск"],
    ["cached", "кеш OpenAI"],
    ["disabled", "выключен"],
  ],
} as const;

function CodexTab({ models, request }: { models: Model[]; request: Request }) {
  const [cfg, setCfg] = useState<CodexConfig | null>(null);
  const [initial, setInitial] = useState<CodexConfig | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    request("config/read", {}).then((r) => {
      const c = r.config;
      const v: CodexConfig = {
        model: c.model ?? "",
        model_reasoning_effort: c.model_reasoning_effort ?? "",
        approval_policy: typeof c.approval_policy === "string" ? c.approval_policy : "on-request",
        sandbox_mode: c.sandbox_mode ?? "danger-full-access",
        web_search: c.web_search ?? "live",
        developer_instructions: c.developer_instructions ?? "",
      };
      setCfg(v);
      setInitial(v);
    }).catch((e) => setStatus({ ok: false, text: e.message }));
  }, [request]);

  if (!cfg || !initial) return <p className="text-sm text-[var(--faint)]">{status?.text ?? "читаю config.toml…"}</p>;

  const set = (k: keyof CodexConfig, v: string) => { setCfg({ ...cfg, [k]: v }); setStatus(null); };
  const model = models.find((m) => m.model === cfg.model);
  const changed = (Object.keys(cfg) as (keyof CodexConfig)[]).filter((k) => cfg[k] !== initial[k]);

  const save = async () => {
    try {
      await request("config/batchWrite", {
        edits: changed.map((k) => ({ keyPath: k, value: cfg[k] === "" ? null : cfg[k], mergeStrategy: "replace" })),
        reloadUserConfig: true,
      });
      setInitial(cfg);
      setStatus({ ok: true, text: "Сохранено. Действует для новых чатов." });
    } catch (e) {
      setStatus({ ok: false, text: e instanceof Error ? e.message : "не сохранилось" });
    }
  };

  const select = (k: keyof CodexConfig, items: readonly (readonly [string, string])[]) => (
    <select value={cfg[k]} onChange={(e) => set(k, e.target.value)} className={field}>
      {items.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
    </select>
  );

  return (
    <div className="space-y-5">
      <p className="text-sm text-[var(--muted)]">Это <span className="font-mono">~/.codex/config.toml</span> твоего контейнера: значения по умолчанию для новых чатов. Модель в шапке переопределяет их на ходу.</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-1.5">
          <span className="text-xs text-[var(--muted)]">Модель по умолчанию</span>
          {select("model", [["", "по умолчанию Codex"], ...models.map((m) => [m.model, m.displayName] as const)])}
        </label>
        <label className="space-y-1.5">
          <span className="text-xs text-[var(--muted)]">Усилие рассуждения</span>
          {select("model_reasoning_effort", [["", "как у модели"], ...(model?.supportedReasoningEfforts ?? models[0]?.supportedReasoningEfforts ?? []).map((e) => [e.reasoningEffort, e.reasoningEffort] as const)])}
        </label>
        <label className="space-y-1.5">
          <span className="text-xs text-[var(--muted)]">Когда спрашивать разрешение</span>
          {select("approval_policy", options.approval_policy)}
        </label>
        <label className="space-y-1.5">
          <span className="text-xs text-[var(--muted)]">Песочница</span>
          {select("sandbox_mode", options.sandbox_mode)}
        </label>
        <label className="space-y-1.5">
          <span className="text-xs text-[var(--muted)]">Веб-поиск</span>
          {select("web_search", options.web_search)}
        </label>
      </div>
      <label className="block space-y-1.5">
        <span className="text-xs text-[var(--muted)]">Свои инструкции (добавляются к системному промпту)</span>
        <textarea value={cfg.developer_instructions} onChange={(e) => set("developer_instructions", e.target.value)} rows={5}
          placeholder="Например: отвечай по-русски, коротко; код — с комментариями на русском." className={`${field} resize-y font-mono text-[13px]`} />
      </label>
      <div className="flex items-center gap-3">
        <button onClick={save} disabled={changed.length === 0} className={primary}>Сохранить</button>
        {status && <span className={`text-sm ${status.ok ? "text-[var(--green)]" : "text-[var(--red)]"}`}>{status.text}</span>}
      </div>
    </div>
  );
}

function WebTab({ email }: { email: string }) {
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  const change = async (e: React.FormEvent) => {
    e.preventDefault();
    const { error } = await createAuthClient().changePassword({ currentPassword: cur, newPassword: next, revokeOtherSessions: true });
    if (error) return setStatus({ ok: false, text: error.message ?? "не получилось" });
    setCur("");
    setNext("");
    setStatus({ ok: true, text: "Пароль сменён, остальные сессии разлогинены" });
  };

  return (
    <form onSubmit={change} className="max-w-sm space-y-3" autoComplete="on">
      <h3 className="font-medium">Пароль морды</h3>
      {/* Логин для менеджера паролей: без него Chrome вписывает почту в первое попавшееся поле страницы — в поиск по чатам. */}
      <input type="text" name="username" autoComplete="username" value={email} readOnly hidden />
      <input type="password" value={cur} onChange={(e) => setCur(e.target.value)} placeholder="текущий пароль" autoComplete="current-password" className={field} />
      <input type="password" value={next} onChange={(e) => setNext(e.target.value)} placeholder="новый пароль, 12+ символов" autoComplete="new-password" className={field} />
      <button disabled={!cur || next.length < 12} className={primary}>Сменить</button>
      {status && <div className={`text-sm ${status.ok ? "text-[var(--green)]" : "text-[var(--red)]"}`}>{status.text}</div>}
    </form>
  );
}

// 203.0.113.42 → 203.***.***.42 (порт и доменные имена не трогаем)
const maskIp = (v: string) => v.replace(/\b(\d{1,3})\.\d{1,3}\.\d{1,3}\.(\d{1,3})\b/g, "$1.***.***.$2");

type Node = { name: string; addr: string; username: string; password: string; hasPassword: boolean };
type Exit = { ip: string; country: string | null; org: string | null; ms: number };

// Цепочка внешних прокси, через которую Codex и морда ходят в интернет. Сверху вниз = приоритет: следующий берётся,
// когда предыдущий не отвечает. Меняется на лету, без рестарта.
function ProxyTab() {
  const [nodes, setNodes] = useState<Node[] | null>(null);
  const [saved, setSaved] = useState<string>("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [exit, setExit] = useState<Exit | { error: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reveal, setReveal] = useState(false);

  const apply = (r: { nodes: Omit<Node, "password">[] }) => {
    const list = r.nodes.map((n) => ({ ...n, password: "" }));
    setNodes(list);
    setSaved(JSON.stringify(list));
  };

  useEffect(() => {
    fetch("/api/proxy").then(async (r) => {
      const j = await r.json();
      if (!r.ok) return setError(r.status === 403 ? "Прокси настраивает только админ." : j.error ?? `ошибка ${r.status}`);
      apply(j);
    }).catch((e) => setError(e.message));
  }, []);

  const check = async () => {
    setChecking(true);
    const r = await fetch("/api/proxy/check", { method: "POST" });
    setExit(await r.json());
    setChecking(false);
  };

  if (error) return <p className="text-sm text-[var(--muted)]">{error}</p>;
  if (!nodes) return <p className="text-sm text-[var(--faint)]">читаю цепочку…</p>;

  const dirty = JSON.stringify(nodes) !== saved;
  const upd = (i: number, patch: Partial<Node>) => { setNodes(nodes.map((n, j) => (j === i ? { ...n, ...patch } : n))); setStatus(null); };
  const move = (i: number, d: number) => {
    const next = [...nodes];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    setNodes(next);
  };
  const activeIp = exit && "ip" in exit ? exit.ip : null;

  const save = async () => {
    setBusy(true);
    const r = await fetch("/api/proxy", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodes: nodes.map(({ name, addr, username, password }) => ({ name, addr, username, password })) }),
    });
    const j = await r.json();
    setBusy(false);
    if (!r.ok) return setStatus({ ok: false, text: j.error ?? "не сохранилось" });
    apply(j);
    setStatus({ ok: true, text: "Применено и сохранено в gost.yaml" });
    check();
  };

  return (
    <div className="space-y-5">
      <p className="text-sm text-[var(--muted)]">
        Через эти прокси Codex и морда ходят в интернет — напрямую им нельзя. Порядок = приоритет: если верхний не отвечает, берётся следующий.
      </p>

      <div className="flex flex-wrap items-center gap-3 rounded-xl bg-[var(--panel-2)] p-3 text-sm">
        <button onClick={check} disabled={checking} className={secondary}>{checking ? "проверяю…" : "Проверить выход"}</button>
        <button onClick={() => setReveal((r) => !r)} className="order-last ml-auto text-xs text-[var(--muted)] hover:text-[var(--fg)]">{reveal ? "скрыть IP" : "показать IP"}</button>
        {exit && ("error" in exit
          ? <span className="text-[var(--red)]">{exit.error}</span>
          : <span className="font-mono text-[13px]">
              <span className="text-[var(--green)]">●</span> {reveal ? exit.ip : maskIp(exit.ip)} <span className="text-[var(--muted)]">{[exit.country, exit.org].filter(Boolean).join(" · ")}</span>{" "}
              <span className="text-[var(--faint)]">{exit.ms} мс</span>
            </span>)}
      </div>

      <div className="flex gap-2">
        {/* Подпись снизу вверх: чем выше узел, тем выше приоритет */}
        <div className="flex w-5 shrink-0 flex-col items-center gap-1 py-1" title="Сверху — самый приоритетный, вниз — запасные">
          <Icon name="arrowUp" size={13} className="text-[var(--accent)]" />
          <div className="w-px flex-1 bg-gradient-to-b from-[var(--accent)] to-[var(--border)]" />
          <span className="rotate-180 text-[10.5px] uppercase tracking-[0.18em] text-[var(--faint)] [writing-mode:vertical-rl]">приоритет</span>
        </div>
      <div className="min-w-0 flex-1 space-y-2">
        {nodes.map((n, i) => {
          const isActive = activeIp && n.addr.split(":")[0] === activeIp;
          return (
            <div key={i} className={`grid grid-cols-[auto_1fr_auto] items-start gap-2 rounded-xl border p-3 ${isActive ? "border-[var(--green)]/40" : "border-[var(--border)]"}`}>
              <div className="flex flex-col items-center gap-0.5 pt-1">
                <span className="font-mono text-xs text-[var(--faint)]">{i + 1}</span>
                <button disabled={i === 0} onClick={() => move(i, -1)} className="text-[var(--faint)] hover:text-[var(--fg)] disabled:opacity-20" title="Выше"><Icon name="chevron" size={14} className="rotate-180" /></button>
                <button disabled={i === nodes.length - 1} onClick={() => move(i, 1)} className="text-[var(--faint)] hover:text-[var(--fg)] disabled:opacity-20" title="Ниже"><Icon name="chevron" size={14} /></button>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <input value={n.name} onChange={(e) => upd(i, { name: e.target.value })} placeholder="имя" className={field} />
                <input value={reveal ? n.addr : maskIp(n.addr)} readOnly={!reveal} onFocus={() => !reveal && n.addr && setReveal(true)}
                  onChange={(e) => upd(i, { addr: e.target.value })} placeholder="host:port" className={`${field} font-mono`} />
                <input value={n.username} onChange={(e) => upd(i, { username: e.target.value })} placeholder="логин (если нужен)" autoComplete="off" className={field} />
                <input type="password" value={n.password} onChange={(e) => upd(i, { password: e.target.value })} autoComplete="new-password"
                  placeholder={n.hasPassword ? "пароль сохранён — пусто = не менять" : "пароль"} className={field} />
              </div>
              <div className="flex flex-col items-end gap-1 pt-1">
                <button onClick={() => setNodes(nodes.filter((_, j) => j !== i))} disabled={nodes.length === 1} title="Удалить"
                  className="rounded-md p-1 text-[var(--faint)] hover:bg-[var(--panel-2)] hover:text-[var(--red)] disabled:opacity-20">
                  <Icon name="plus" size={15} className="rotate-45" />
                </button>
                {isActive && <span className="text-[10px] uppercase tracking-wide text-[var(--green)]">выход</span>}
              </div>
            </div>
          );
        })}
        <button onClick={() => setNodes([...nodes, { name: `proxy-${nodes.length + 1}`, addr: "", username: "", password: "", hasPassword: false }])}
          className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm text-[var(--accent)] hover:bg-[var(--panel-2)]">
          <Icon name="plus" size={14} /> Добавить прокси
        </button>
      </div>
      </div>

      <div className="flex items-center gap-3">
        <button onClick={save} disabled={!dirty || busy} className={primary}>{busy ? "…" : "Применить"}</button>
        {dirty && <button onClick={() => setNodes(JSON.parse(saved))} className="text-sm text-[var(--muted)] hover:text-[var(--fg)]">Отменить правки</button>}
        {status && <span className={`text-sm ${status.ok ? "text-[var(--green)]" : "text-[var(--red)]"}`}>{status.text}</span>}
      </div>
      <p className="text-xs text-[var(--faint)]">Поддерживаются HTTP-прокси. Пароли хранятся только в egress и в браузер не отдаются.</p>
    </div>
  );
}

// Свой провайдер в codex: model_providers.neuraldeep с wire_api = "responses" (как в доке neuraldeep.ru/docs).
function NeuralDeepTab({ request, models, reload }: { request: Request; models: Model[]; reload: () => Promise<number> }) {
  const [current, setCurrent] = useState<string | null | undefined>(undefined);
  const [key, setKey] = useState("");
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const readKey = () =>
    request("config/read", {}).then((r) => setCurrent(r.config?.model_providers?.neuraldeep?.experimental_bearer_token ?? null));
  useEffect(() => { readKey().catch(() => setCurrent(null)); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const write = async (value: unknown) =>
    request("config/batchWrite", { edits: [{ keyPath: "model_providers.neuraldeep", value, mergeStrategy: "replace" }], reloadUserConfig: true });

  const save = async () => {
    setBusy(true);
    setStatus(null);
    try {
      await write({ name: "NeuralDeep Hub", base_url: "https://api.neuraldeep.ru/v1", wire_api: "responses", experimental_bearer_token: key.trim() });
      setKey("");
      await readKey();
      const n = await reload();
      setStatus({ ok: true, text: `Подключено: ${n} чат-моделей в выборе модели` });
    } catch (e) {
      setStatus({ ok: false, text: e instanceof Error ? e.message : "не получилось" });
    }
    setBusy(false);
  };

  const remove = async () => {
    setBusy(true);
    await write(null).catch(() => {});
    await readKey();
    await reload().catch(() => 0);
    setStatus({ ok: true, text: "Ключ удалён" });
    setBusy(false);
  };

  return (
    <div className="space-y-5">
      <p className="text-sm text-[var(--muted)]">
        Модели <a href="https://neuraldeep.ru/docs" target="_blank" rel="noreferrer noopener" className="text-[var(--accent)] underline underline-offset-2">neuraldeep.ru</a> через
        Responses API. Ключ уходит в <span className="font-mono">config.toml</span> твоего Codex, морда его не хранит. Чатовые модели ключа появятся в выборе модели группой «NeuralDeep».
      </p>

      <div className="flex items-center gap-3 rounded-xl bg-[var(--panel-2)] p-3 text-sm">
        <span className={`h-2 w-2 rounded-full ${current ? "bg-[var(--green)]" : "bg-[var(--faint)]"}`} />
        <span className="flex-1 font-mono text-[13px]">
          {current === undefined ? "читаю…" : current ? `${current.slice(0, 5)}…${current.slice(-4)}` : "ключ не задан"}
        </span>
        {current && <button onClick={() => reload().then((n) => setStatus({ ok: true, text: `${n} чат-моделей` })).catch((e) => setStatus({ ok: false, text: e.message }))} className={secondary}>Обновить модели</button>}
        {current && <button onClick={remove} disabled={busy} className={secondary}>Удалить</button>}
      </div>

      <div className="flex gap-2">
        <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-… из hub.neuraldeep.ru/app/keys" autoComplete="off" className={field} />
        <button onClick={save} disabled={busy || !/^sk-[\w-]{10,}$/.test(key.trim())} className={primary}>{busy ? "…" : current ? "Заменить" : "Подключить"}</button>
      </div>

      {status && <div className={`text-sm ${status.ok ? "text-[var(--green)]" : "text-[var(--red)]"}`}>{status.text}</div>}

      {models.length > 0 && (
        <div>
          <div className="mb-2 text-xs text-[var(--muted)]">Модели ключа</div>
          <div className="flex flex-wrap gap-1.5">
            {models.map((m) => (
              <span key={m.id} className="rounded-md bg-[var(--panel-2)] px-2 py-1 font-mono text-xs" title={m.description}>
                {m.id}{m.context ? <span className="text-[var(--faint)]"> {Math.round(m.context / 1000)}k</span> : null}
              </span>
            ))}
          </div>
          <p className="mt-2 text-xs text-[var(--faint)]">Провайдер задаётся на весь чат: при выборе модели NeuralDeep в чате с ChatGPT-моделью следующий вопрос уйдёт в новый чат.</p>
        </div>
      )}
    </div>
  );
}
