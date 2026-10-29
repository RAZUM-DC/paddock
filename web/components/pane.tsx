"use client";

// Одно окно чата: свой тред, своя модель, свои ходы и одобрения. Окон на экране до четырёх,
// соединение с codex у них общее — события сюда приносит рабочая область (chat.tsx), окно само фильтрует по threadId.
import { memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type AppendMessage,
} from "@assistant-ui/react";
import type { ServerRequest } from "@/lib/codex-client";
import { changedFiles, itemToPart, toThreadMessage, turnsToMessages, userText, type ChangedFile, type Msg, type Part, type TurnMeta } from "@/lib/messages";
import { store } from "@/lib/store";
import { Icon } from "./icons";
import { ImageReader, makeReader } from "./local-image";
import { Approval, AssistantMessage, UserEditComposer, UserMessage } from "./messages";
import { ModelPicker, type Model, type Selection } from "./model-picker";
import { SessionTools } from "./tools";
import { StatusBar, type RateLimits, type TokenUsage } from "./status-bar";

export const CWD = "/workspace";

export type PaneCommand = { type: "open"; threadId: string; n: number } | { type: "new"; cwd: string; n: number };
export type PaneHandle = {
  threadId: () => string | null;
  notify: (method: string, p: any) => void;
  serverRequest: (req: ServerRequest) => void;
  reconnected: () => void;
};
export type PaneState = { threadId: string | null; running: boolean; files: ChangedFile[]; cwd: string | null };

type Api = {
  request: (method: string, params: unknown) => Promise<any>;
  respond: (id: number | string, result: unknown) => void;
};

// Модель, усилие, скорость в истории Codex не хранятся — запоминаем сами, общий словарь на все окна.
// Источник правды — таблица turn_meta морды (/api/turns), localStorage — кеш, чтобы не ждать сеть.
const meta: { current: Record<string, TurnMeta> } = { current: {} };
let metaLoaded = false;
let unsent: Record<string, TurnMeta> = {};
let flushTimer: ReturnType<typeof setTimeout> | null = null;
function patchMetaStore(tId: string, patch: TurnMeta) {
  meta.current[tId] = { ...meta.current[tId], ...patch };
  const keys = Object.keys(meta.current);
  if (keys.length > 500) for (const k of keys.slice(0, keys.length - 500)) delete meta.current[k];
  store.set("paddock.turnMeta", meta.current);
  unsent[tId] = { ...unsent[tId], ...patch };
  flushTimer ??= setTimeout(() => {
    const turns = unsent;
    unsent = {};
    flushTimer = null;
    fetch("/api/turns", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ turns }) }).catch(() => {});
  }, 1000);
}
// Подтянуть с сервера то, чего нет в локальном кеше (ходы из другого браузера).
async function loadServerMeta(ids: string[]) {
  const missing = ids.filter((id) => !meta.current[id]?.model);
  if (missing.length === 0) return;
  const r = await fetch(`/api/turns?ids=${missing.slice(-300).join(",")}`).then((x) => x.json()).catch(() => null);
  for (const [id, m] of Object.entries((r?.turns ?? {}) as Record<string, TurnMeta>)) meta.current[id] = { ...m, ...meta.current[id] };
}

export const Pane = memo(function Pane({ handleRef, api, connected, models, ndModels, defaultSel, limits, command, title, active, compact, closable,
  onFocus, onClose, onState, onThreadsChanged, onGrip }: {
  handleRef: Ref<PaneHandle>;
  api: Api;
  connected: boolean;
  models: Model[];
  ndModels: Model[];
  defaultSel: Selection | null;
  limits: RateLimits | null;
  command: PaneCommand | null;
  title: string | null;
  active: boolean;
  compact: boolean;
  closable: boolean;
  onFocus: () => void;
  onClose: () => void;
  onState: (s: PaneState) => void;
  onThreadsChanged: () => void;
  onGrip: (e: React.PointerEvent) => void;
}) {
  if (!metaLoaded && typeof window !== "undefined") {
    meta.current = store.get("paddock.turnMeta", {});
    metaLoaded = true;
  }
  const [threadId, setThreadId] = useState<string | null>(null);
  const threadIdRef = useRef<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  // Команды shell этого чата — по ним поповер в статус-баре отмечает, какие скиллы и CLI агент реально использовал.
  const commands = useMemo(() => messages.flatMap((m) => m.parts.flatMap((p) => (p.type === "tool-call" && p.argsText ? [p.argsText] : []))), [messages]);
  const [turnId, setTurnId] = useState<string | null>(null);
  const finished = useRef(new Set<string>());
  const [approvals, setApprovals] = useState<ServerRequest[]>([]);
  const [sel, setSel] = useState<Selection | null>(null);
  const selRef = useRef<Selection | null>(null);
  const threadProvider = useRef<string>("openai");
  const [ctx, setCtx] = useState<{ cwd: string | null; branch: string | null }>({ cwd: CWD, branch: null });
  const [usage, setUsage] = useState<TokenUsage | null>(null);
  const newCwd = useRef(CWD);
  const done = useRef(0);
  const files = useMemo(() => changedFiles(messages), [messages]);
  // Наверх сообщаем только когда список файлов реально поменялся, а не на каждый кусок стрима.
  const filesKey = files.map((f) => `${f.path}:${f.edits}:${f.kind}`).join("|");
  const filesRef = useRef(files);
  filesRef.current = files;

  threadIdRef.current = threadId;
  selRef.current = sel ?? defaultSel;

  const choose = useCallback((s: Selection) => {
    setSel(s);
    store.set("paddock.selection", s);
  }, []);

  const patchMeta = useCallback((tId: string, patch: TurnMeta) => {
    patchMetaStore(tId, patch);
    setMessages((ms) => ms.map((m) => (m.id === `a-${tId}` ? { ...m, meta: { ...m.meta, ...patch } } : m)));
  }, []);
  // TTFT — длительность, а не отметка: в истории startedAt серверный, а часы браузера с ним не сверены.
  const firstToken = useCallback((tId: string) => {
    const m = meta.current[tId];
    if (m && m.ttftMs == null && m.startedAt) patchMeta(tId, { ttftMs: Date.now() - m.startedAt });
  }, [patchMeta]);

  // Пара сообщений хода появляется по первому сигналу — ответу turn/start или событию userMessage, что раньше.
  const ensureTurn = useCallback((tId: string, text: string) => {
    setMessages((ms) =>
      ms.some((m) => m.id === `a-${tId}`)
        ? ms
        : [
            ...ms.filter((m) => m.id !== "u-pending"),
            { id: `u-${tId}`, role: "user", turnId: tId, parts: [{ type: "text", itemId: `u-${tId}`, text }] },
            { id: `a-${tId}`, role: "assistant", turnId: tId, parts: [], running: !finished.current.has(tId), meta: meta.current[tId] },
          ],
    );
  }, []);

  const updatePart = useCallback((tId: string, itemId: string, fn: (p: Part | undefined) => Part | null) => {
    setMessages((ms) =>
      ms.map((m) => {
        if (m.id !== `a-${tId}`) return m;
        const i = m.parts.findIndex((p) => p.itemId === itemId);
        const next = fn(i >= 0 ? m.parts[i] : undefined);
        if (!next) return m;
        const parts = [...m.parts];
        if (i >= 0) parts[i] = next;
        else parts.push(next);
        return { ...m, parts };
      }),
    );
  }, []);

  // Подписка на тред + история ходов. И при открытии, и после переподключения:
  // всё, что пришло, пока связи не было, берём из истории, а не из потерянных событий.
  const hydrate = useCallback(async (id: string) => {
    const r = await api.request("thread/resume", { threadId: id, excludeTurns: true });
    const page = await api.request("thread/turns/list", { threadId: id, limit: 100, sortDirection: "desc", itemsView: "full" });
    const turns = [...page.data].reverse();
    await loadServerMeta(turns.map((t: any) => t.id));
    if (threadIdRef.current !== id) return;
    const threadModel = { model: r.model as string, effort: (r.reasoningEffort as string | null) ?? null };
    for (const t of turns) if (t.status !== "inProgress") finished.current.add(t.id);
    setMessages(turnsToMessages(turns, (t) => ({ ...threadModel, ...meta.current[t] })));
    // Статус-бар (контекст, кеш) — из последнего хода, где расход известен; после перезагрузки событий ещё не было.
    const lastUsage = [...turns].reverse().map((t: any) => meta.current[t.id]?.usage).find(Boolean);
    if (lastUsage) setUsage((u) => u ?? (lastUsage as TokenUsage));
    setTurnId(turns.find((t: any) => t.status === "inProgress")?.id ?? null);
    setCtx({ cwd: r.cwd, branch: r.thread.gitInfo?.branch ?? null });
    threadProvider.current = r.modelProvider ?? "openai";
    const provider = threadProvider.current === "openai" ? undefined : threadProvider.current;
    if (r.model) choose({ model: r.model, effort: r.reasoningEffort ?? (provider ? "" : selRef.current?.effort ?? "medium"), provider });
  }, [api, choose]);

  const notify = useCallback((method: string, p: any) => {
    if (!p?.threadId || p.threadId !== threadIdRef.current) return;
    switch (method) {
      case "turn/started":
        if (!finished.current.has(p.turn.id)) setTurnId(p.turn.id);
        break;
      case "item/started":
      case "item/completed": {
        if (p.item.type === "userMessage") {
          ensureTurn(p.turnId, userText(p.item));
          break;
        }
        firstToken(p.turnId);
        const part = itemToPart(p.item);
        if (part) updatePart(p.turnId, p.item.id, () => part);
        break;
      }
      case "item/agentMessage/delta":
        firstToken(p.turnId);
        updatePart(p.turnId, p.itemId, (old) => ({ type: "text", itemId: p.itemId, text: (old && "text" in old ? old.text : "") + p.delta }));
        break;
      case "item/reasoning/summaryTextDelta":
        firstToken(p.turnId);
        updatePart(p.turnId, p.itemId, (old) => ({ type: "reasoning", itemId: p.itemId, text: (old && "text" in old ? old.text : "") + p.delta }));
        break;
      case "item/commandExecution/outputDelta":
        updatePart(p.turnId, p.itemId, (old) => (old?.type === "tool-call" ? { ...old, result: (old.result ?? "") + p.delta } : null));
        break;
      case "thread/tokenUsage/updated":
        setUsage(p.tokenUsage);
        // Каждое обновление — один вызов модели; last — его расход.
        if (p.turnId && p.tokenUsage?.last)
          patchMeta(p.turnId, { outTokens: (meta.current[p.turnId]?.outTokens ?? 0) + p.tokenUsage.last.outputTokens, usage: { last: p.tokenUsage.last, total: p.tokenUsage.total, modelContextWindow: p.tokenUsage.modelContextWindow } });
        break;
      case "model/rerouted":
        patchMeta(p.turnId, { model: p.toModel });
        break;
      case "turn/completed":
        finished.current.add(p.turn.id);
        setTurnId((t) => (t === p.turn.id ? null : t));
        setMessages((ms) => ms.map((m) => (m.id === `a-${p.turn.id}` ? { ...m, running: false } : m)));
        patchMeta(p.turn.id, { durationMs: p.turn.durationMs });
        if (p.turn.error) updatePart(p.turn.id, `err-${p.turn.id}`, () => ({ type: "text", itemId: `err-${p.turn.id}`, text: `⚠️ ${p.turn.error.message ?? "ошибка хода"}` }));
        onThreadsChanged();
        break;
      case "error":
        if (!p.willRetry) updatePart(p.turnId, `err-${p.turnId}`, () => ({ type: "text", itemId: `err-${p.turnId}`, text: `⚠️ ${p.error?.message ?? "ошибка"}` }));
        break;
    }
  }, [ensureTurn, updatePart, patchMeta, firstToken, onThreadsChanged]);

  useImperativeHandle(handleRef, () => ({
    threadId: () => threadIdRef.current,
    notify,
    serverRequest: (req) => setApprovals((a) => [...a, req]),
    reconnected: () => void (threadIdRef.current && hydrate(threadIdRef.current).catch(() => {})),
  }), [notify, hydrate]);

  // Автопрокрутка assistant-ui едет за ответом, только если окно уже внизу. После открытия чата высота
  // дорастает (markdown, подсветка, картинки) уже после первой прокрутки, и окно остаётся выше низа —
  // новое сообщение и ответ уходят за край. Поэтому сами прижимаем вниз: после открытия и при отправке.
  const viewport = useRef<HTMLDivElement>(null);
  const toBottom = useCallback(() => {
    for (const ms of [0, 150, 500, 1200]) setTimeout(() => {
      const el = viewport.current;
      if (el) el.scrollTop = el.scrollHeight;
    }, ms);
  }, []);

  const openThread = useCallback(async (id: string) => {
    setThreadId(id);
    threadIdRef.current = id;
    setMessages([]);
    setUsage(null);
    setApprovals([]);
    await hydrate(id).catch(() => {});
    toBottom();
  }, [hydrate, toBottom]);

  const newThread = useCallback((cwd: string) => {
    setThreadId(null);
    threadIdRef.current = null;
    setMessages([]);
    setTurnId(null);
    setUsage(null);
    setApprovals([]);
    newCwd.current = cwd;
    setCtx({ cwd, branch: null });
  }, []);

  // Команды от рабочей области (открыть тред из сайдбара, новый чат в папке) — когда есть связь.
  useEffect(() => {
    if (!command || !connected || command.n === done.current) return;
    done.current = command.n;
    if (command.type === "open") openThread(command.threadId);
    else newThread(command.cwd);
  }, [command, connected, openThread, newThread]);

  useEffect(() => {
    onState({ threadId, running: turnId !== null, files: filesRef.current, cwd: ctx.cwd });
  }, [threadId, turnId, filesKey, ctx.cwd, onState]);

  const startTurn = async (text: string) => {
    // Пузырь сообщения сразу, не дожидаясь thread/start и turn/start (в новом чате это секунды); ensureTurn заменит его настоящим.
    setMessages((ms) => [...ms.filter((m) => m.id !== "u-pending"), { id: "u-pending", role: "user", turnId: "", parts: [{ type: "text", itemId: "u-pending", text }] }]);
    toBottom();
    try {
      await startTurnNow(text);
    } catch (e) {
      setMessages((ms) => ms.filter((m) => m.id !== "u-pending"));
      throw e;
    }
  };

  const startTurnNow = async (text: string) => {
    const s = selRef.current;
    const provider = s?.provider ?? "openai";
    let tid = threadIdRef.current;
    // Провайдер у Codex задаётся на весь тред — модель другого провайдера продолжает в новом чате той же папки.
    if (tid && threadProvider.current !== provider) {
      newThread(ctx.cwd ?? CWD);
      tid = null;
    }
    if (!tid) {
      const nd = ndModels.find((m) => m.model === s?.model && provider === "neuraldeep");
      const r = await api.request("thread/start", {
        cwd: newCwd.current,
        model: s?.model,
        modelProvider: provider,
        config: nd?.context ? { model_context_window: nd.context } : null,
      });
      tid = r.thread.id as string;
      threadIdRef.current = tid;
      threadProvider.current = r.modelProvider ?? provider;
      setThreadId(tid);
      setCtx({ cwd: r.cwd, branch: r.thread.gitInfo?.branch ?? null });
    }
    const startedAt = Date.now();
    const res = await api.request("turn/start", {
      threadId: tid,
      input: [{ type: "text", text, text_elements: [] }],
      model: s?.model,
      effort: s?.effort || null,
    });
    const id = res.turn.id as string;
    patchMeta(id, { model: s?.model, effort: s?.effort, startedAt });
    ensureTurn(id, text);
    toBottom();
    if (!finished.current.has(id)) setTurnId(id);
    onThreadsChanged();
  };

  const textOf = (m: AppendMessage) => m.content.map((c) => (c.type === "text" ? c.text : "")).join("\n").trim();

  // Правка и «ответить заново»: откатываем тред до хода с этим сообщением и запускаем ход заново.
  const rerun = async (userMsgId: string, text: string) => {
    const tid = threadIdRef.current;
    const msg = messages.find((m) => m.id === userMsgId);
    if (!tid || !msg) return;
    await api.request("thread/revert", { threadId: tid, beforeTurnId: msg.turnId });
    setMessages((ms) => ms.slice(0, ms.findIndex((m) => m.id === userMsgId)));
    await startTurn(text);
  };

  const runtime = useExternalStoreRuntime<Msg>({
    messages,
    isRunning: turnId !== null,
    convertMessage: toThreadMessage,
    onNew: async (m) => { const t = textOf(m); if (t) await startTurn(t); },
    onEdit: async (m) => { const t = textOf(m); if (t && m.sourceId) await rerun(m.sourceId, t); },
    onReload: async (parentId) => {
      const m = messages.find((x) => x.id === parentId);
      const text = m?.parts.map((p) => ("text" in p ? p.text : "")).join("\n");
      if (m && text) await rerun(m.id, text);
    },
    onCancel: async () => { if (threadId && turnId) await api.request("turn/interrupt", { threadId, turnId }); },
  });

  const answer = (req: ServerRequest, result: unknown) => {
    api.respond(req.id, result);
    setApprovals((a) => a.filter((r) => r.id !== req.id));
  };

  const readImage = useMemo(() => makeReader(api.request), [api]);
  const shown = sel ?? defaultSel;
  const running = turnId !== null;
  const empty = messages.length === 0;
  const width = compact ? "max-w-none" : "max-w-3xl";

  const composer = (
    <div className="space-y-2">
      {approvals.map((req) => <Approval key={req.id} req={req} onAnswer={answer} />)}
      <ComposerPrimitive.Root className="composer rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-2 transition-colors focus-within:border-[var(--accent)]/40">
        <ComposerPrimitive.Input
          autoFocus={active}
          placeholder={connected ? "Что делаем?" : "Нет связи с codex…"}
          className={`${compact ? "max-h-40 min-h-9" : "max-h-60 min-h-11"} w-full resize-none bg-transparent px-2.5 py-2 leading-relaxed outline-none placeholder:text-[var(--faint)]`}
        />
        <div className="flex items-center gap-2 px-1">
          <span className="flex min-w-0 items-center gap-1.5 truncate rounded-lg border border-[var(--border)] px-2.5 py-1 font-mono text-xs text-[var(--muted)]" title="Рабочая папка Codex">
            <Icon name="folder" size={13} className="shrink-0 text-[var(--blue)]" />
            <span className="truncate">{ctx.cwd ?? CWD}</span>
            {ctx.branch && (
              <>
                <Icon name="branch" size={12} className="ml-1 shrink-0 text-[var(--teal)]" />
                {ctx.branch}
              </>
            )}
          </span>
          <span className="flex-1" />
          <ThreadPrimitive.If running={false}>
            <ComposerPrimitive.Send className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-gradient-to-br from-[var(--accent)] to-[var(--accent-2)] text-black shadow-[0_0_18px_-4px_var(--accent)] transition-opacity disabled:opacity-30 disabled:shadow-none">
              <Icon name="arrowUp" size={18} strokeWidth={2.25} />
            </ComposerPrimitive.Send>
          </ThreadPrimitive.If>
          <ThreadPrimitive.If running>
            <ComposerPrimitive.Cancel className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-[var(--accent)]/50 text-[var(--accent)]" title="Остановить">
              <Icon name="stop" size={14} fill="currentColor" />
            </ComposerPrimitive.Cancel>
          </ThreadPrimitive.If>
        </div>
      </ComposerPrimitive.Root>
      <StatusBar model={shown?.model ?? null} effort={shown?.effort ?? null} cwd={ctx.cwd} branch={ctx.branch} usage={usage} limits={limits} connected={connected}
        extra={connected && ctx.cwd ? <SessionTools request={api.request} cwd={ctx.cwd} commands={commands} /> : null} />
    </div>
  );

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ImageReader.Provider value={readImage}>
      <section onMouseDown={onFocus} onFocusCapture={onFocus}
        className={`flex min-h-0 min-w-0 flex-1 flex-col ${compact ? `border-t-2 ${active ? "border-[var(--accent)]" : "border-transparent"}` : ""}`}>
        <header className="flex h-12 shrink-0 items-center gap-1 border-b border-[var(--border)]/60 px-2">
          {compact && (
            <button onPointerDown={onGrip} title="Перетащи, чтобы поменять окна местами" data-grip
              className="cursor-grab touch-none rounded-md p-1 text-[var(--faint)] hover:bg-[var(--panel)] hover:text-[var(--fg)] active:cursor-grabbing">
              <Icon name="grip" size={14} strokeWidth={3} />
            </button>
          )}
          {compact && (
            <span className="flex min-w-0 items-center gap-2 pl-1 pr-1">
              <span title={running ? "работает" : "готов"}
                className={`h-2 w-2 shrink-0 rounded-full ${running ? "animate-pulse bg-[var(--accent)] shadow-[0_0_8px_var(--accent)]" : threadId ? "bg-[var(--green)]" : "bg-[var(--faint)]"}`} />
              <span className="max-w-[16rem] truncate text-sm text-[var(--muted)]">{title ?? "Новый чат"}</span>
            </span>
          )}
          <ModelPicker models={[...models, ...ndModels]} value={shown} onChange={choose} />
          <span className="flex-1" />
          {closable && (
            <button onClick={(e) => { e.stopPropagation(); onClose(); }} title="Закрыть окно"
              className="rounded-md p-1.5 text-[var(--faint)] hover:bg-[var(--panel)] hover:text-[var(--fg)]">
              <Icon name="plus" size={15} className="rotate-45" />
            </button>
          )}
        </header>

        <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col">
          {empty && compact ? (
            // В сетке поле ввода всегда внизу — чтобы в ряду окон оно стояло на одной высоте.
            <>
              <div className="glow flex flex-1 items-center justify-center px-4">
                <h1 className="text-center text-xl font-semibold tracking-tight">Чем займёмся?</h1>
              </div>
              <div className="w-full px-3 pb-3">{composer}</div>
            </>
          ) : empty ? (
            <div className={`glow flex flex-1 flex-col items-center justify-center px-4 ${compact ? "pb-6" : "pb-24"}`}>
              <h1 className={`mb-5 text-center font-semibold tracking-tight ${compact ? "text-xl" : "text-2xl md:text-[28px]"}`}>Чем займёмся?</h1>
              <div className={`w-full ${compact ? "max-w-xl" : "max-w-3xl"}`}>{composer}</div>
            </div>
          ) : (
            <>
              <ThreadPrimitive.Viewport ref={viewport} className={`flex-1 overflow-y-auto px-4 ${compact ? "py-4" : "py-8"}`}>
                <div className={`mx-auto ${width} ${compact ? "space-y-5" : "space-y-7"}`}>
                  <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage, UserEditComposer }} />
                </div>
              </ThreadPrimitive.Viewport>
              <div className={`mx-auto w-full ${width} px-3 pb-3`}>{composer}</div>
            </>
          )}
        </ThreadPrimitive.Root>
      </section>
      </ImageReader.Provider>
    </AssistantRuntimeProvider>
  );
});
