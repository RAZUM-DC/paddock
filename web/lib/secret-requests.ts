// Secret requests: an agent needs an API key or a password for a project. Instead of asking for it in the chat (where
// it would stay in the transcript), the `secrets` tool (web/tools/secrets) asks web for it; the user fills a masked
// form in Paddock; the tool collects the value once and writes it into a file in /workspace.
// In memory only: nothing survives a restart of web, values are dropped when collected, declined or expired, and are
// never logged. Pure (the clock is a parameter), unit-tested in test/secret-requests.test.mjs.
import { randomBytes } from "node:crypto";

export const TTL_MS = 15 * 60_000;
// Finished requests stay visible to the waiting command for this long, so it can tell "declined" from "unknown".
export const KEEP_DONE_MS = 5 * 60_000;
export const MAX_PENDING = 5;
export const MAX_VALUE_BYTES = 8 * 1024;
export const MAX_REASON = 300;
export const NAME_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;
const THREAD_RE = /^[0-9A-Za-z-]{1,80}$/;
const ID_RE = /^[0-9a-f]{32}$/;
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f]/;

export type Status = "pending" | "fulfilled" | "declined" | "expired" | "consumed";
export type SecretRequestPublic = { id: string; name: string; file: string; reason: string; threadId: string | null; createdAt: number; expiresAt: number };
type Entry = SecretRequestPublic & { owner: string; status: Status; value: string | null; doneAt: number | null };

export class SecretRequestError extends Error {
  readonly name = "SecretRequestError";
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}
// By name, not instanceof: the store lives on globalThis and is shared by server.ts and Next's route handlers, which
// load this module separately, so an error may come from the other copy of the class.
export const isSecretRequestError = (e: unknown): e is SecretRequestError => e instanceof Error && e.name === "SecretRequestError" && typeof (e as SecretRequestError).status === "number";

export const isRequestId = (id: unknown): id is string => typeof id === "string" && ID_RE.test(id);

// The file is shown to the user and must be inside /workspace; the command checks it again against the real
// file system (symlinks) before it writes anything.
export function validFile(file: unknown, root = "/workspace"): file is string {
  if (typeof file !== "string" || file.length > 1024 || CONTROL.test(file) || file.includes("\t")) return false;
  if (!file.startsWith(root + "/")) return false;
  // Normalised already (the command resolves it): no empty, "." or ".." segments, not a directory.
  return !file.slice(1).split("/").some((s) => s === "" || s === ".." || s === ".");
}

export function validateValue(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new SecretRequestError("the value is empty");
  if (Buffer.byteLength(value, "utf8") > MAX_VALUE_BYTES) throw new SecretRequestError("the value is longer than 8 KB");
  // One line in an .env file: a line break would let the value write extra variables.
  if (/[\r\n\u0000]/.test(value)) throw new SecretRequestError("the value must be a single line");
  return value;
}

export function secretRequestStore(opts: { ttlMs?: number; keepDoneMs?: number; maxPending?: number; workspace?: string } = {}) {
  const workspace = opts.workspace ?? "/workspace";
  const ttl = opts.ttlMs ?? TTL_MS;
  const keep = opts.keepDoneMs ?? KEEP_DONE_MS;
  const maxPending = opts.maxPending ?? MAX_PENDING;
  const all = new Map<string, Entry>();

  const finish = (e: Entry, status: Status, now: number) => {
    e.status = status;
    e.value = null;
    e.doneAt = now;
  };
  // Expire what is due, forget what finished long enough ago.
  const sweep = (now: number) => {
    for (const [id, e] of all) {
      if (e.status === "pending" && now >= e.expiresAt) finish(e, "expired", now);
      // A filled-in value nobody collected is dropped at the deadline too.
      if (e.status === "fulfilled" && now >= e.expiresAt) finish(e, "expired", now);
      if (e.doneAt !== null && e.status !== "pending" && e.status !== "fulfilled" && now - e.doneAt >= keep) all.delete(id);
    }
  };
  const own = (owner: string, id: string, now: number): Entry => {
    sweep(now);
    const e = isRequestId(id) ? all.get(id) : undefined;
    // Someone else's request looks exactly like a missing one.
    if (!e || e.owner !== owner) throw new SecretRequestError("no such request", 404);
    return e;
  };
  const pub = (e: Entry): SecretRequestPublic => ({ id: e.id, name: e.name, file: e.file, reason: e.reason, threadId: e.threadId, createdAt: e.createdAt, expiresAt: e.expiresAt });

  return {
    create(owner: string, input: unknown, now = Date.now()): SecretRequestPublic {
      sweep(now);
      const b = (input && typeof input === "object" && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
      if (typeof b.name !== "string" || !NAME_RE.test(b.name)) throw new SecretRequestError("name: A-Z, 0-9 and _, starting with a letter or _, up to 64 characters");
      if (!validFile(b.file, workspace)) throw new SecretRequestError(`file: an absolute path inside ${workspace}`);
      const reason = b.reason === undefined || b.reason === null ? "" : b.reason;
      if (typeof reason !== "string" || reason.length > MAX_REASON || CONTROL.test(reason)) throw new SecretRequestError(`reason: one line, up to ${MAX_REASON} characters`);
      const threadId = typeof b.threadId === "string" && THREAD_RE.test(b.threadId) ? b.threadId : null;
      const pending = [...all.values()].filter((e) => e.owner === owner && e.status === "pending").length;
      if (pending >= maxPending) throw new SecretRequestError(`at most ${maxPending} open requests; answer or wait for the others first`, 429);
      const e: Entry = { id: randomBytes(16).toString("hex"), owner, name: b.name, file: b.file, reason: reason.trim(), threadId, createdAt: now, expiresAt: now + ttl, status: "pending", value: null, doneAt: null };
      all.set(e.id, e);
      return pub(e);
    },

    pending(owner: string, now = Date.now()): SecretRequestPublic[] {
      sweep(now);
      return [...all.values()].filter((e) => e.owner === owner && e.status === "pending").sort((a, b) => a.createdAt - b.createdAt).map(pub);
    },

    fulfil(owner: string, id: string, value: unknown, now = Date.now()) {
      const e = own(owner, id, now);
      if (e.status !== "pending") throw new SecretRequestError(`the request is ${e.status}`, 409);
      e.value = validateValue(value);
      e.status = "fulfilled";
    },

    decline(owner: string, id: string, now = Date.now()) {
      const e = own(owner, id, now);
      if (e.status !== "pending") throw new SecretRequestError(`the request is ${e.status}`, 409);
      finish(e, "declined", now);
    },

    // The waiting command withdraws its request (timeout, Ctrl-C).
    cancel(owner: string, id: string, now = Date.now()) {
      const e = own(owner, id, now);
      if (e.status === "pending" || e.status === "fulfilled") finish(e, "expired", now);
    },

    // What the waiting command sees. The value is handed out exactly once, then forgotten.
    collect(owner: string, id: string, now = Date.now()): { status: Status; value?: string } {
      const e = own(owner, id, now);
      if (e.status !== "fulfilled") return { status: e.status };
      const value = e.value!;
      finish(e, "consumed", now);
      return { status: "fulfilled", value };
    },

    // For tests and diagnostics: how many entries still hold a value.
    heldValues: () => [...all.values()].filter((e) => e.value !== null).length,
    size: () => all.size,
  };
}
export type SecretRequestStore = ReturnType<typeof secretRequestStore>;
