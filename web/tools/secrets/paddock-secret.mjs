#!/usr/bin/env node
// paddock-secret — ask the user for a secret (API key, password, token) through a masked form in Paddock and write
// it into a file in /workspace, so the value never appears in the chat or in the command's output.
// No dependencies. Talks to web directly (node:http, never through HTTP(S)_PROXY) with this harness's token.
//
//   node paddock-secret.mjs request NAME --file <path> [--reason "..."] [--timeout 900]
//   node paddock-secret.mjs list
//
// request waits until the user saves or declines the form (or the timeout), then writes NAME=value into the file
// (created if missing, an existing NAME line replaced, mode 600) and prints only: saved NAME to <file> (N chars).
import { request as httpRequest, Agent } from "node:http";
import { chmodSync, existsSync, lstatSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const NAME_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;
const POLL_MS = 2000;

// --- pure helpers (unit-tested in web/test/secrets-cli.test.mjs) ---

// An absolute path inside the workspace after following symlinks (the real path), or an Error. The directory must
// exist; the file may not (it is created).
export function resolveInWorkspace(file, { cwd = process.cwd(), root = process.env.PADDOCK_WORKSPACE || "/workspace" } = {}) {
  if (typeof file !== "string" || !file.trim()) return new Error("--file is required");
  if (/[\u0000-\u001f\u007f]/.test(file)) return new Error("the file name has control characters");
  const abs = resolve(isAbsolute(file) ? file : join(cwd, file));
  let realRoot, real;
  try {
    realRoot = realpathSync(root);
  } catch {
    return new Error(`${root} does not exist`);
  }
  try {
    real = join(realpathSync(dirname(abs)), basename(abs));
  } catch {
    return new Error(`the folder of ${file} does not exist`);
  }
  let st = null;
  try {
    st = lstatSync(real);
  } catch {}
  if (st?.isSymbolicLink()) {
    try {
      real = realpathSync(real);
      st = lstatSync(real);
    } catch {
      return new Error(`${file} is a dangling symlink`);
    }
  }
  if (!real.startsWith(realRoot + sep)) return new Error(`${file} is outside ${root}; secrets are written only inside the workspace`);
  if (st && !st.isFile()) return new Error(`${file} is not a regular file`);
  return real;
}

// How the value is written after NAME=: bare when it is plain, else single quotes (literal in dotenv, docker compose,
// python-dotenv and sh), else double quotes with \ " $ ` escaped.
export function quoteValue(v) {
  if (typeof v !== "string") throw new Error("value must be a string");
  if (/[\r\n\u0000]/.test(v)) throw new Error("the value has a line break; it cannot go into an .env line");
  if (/^[A-Za-z0-9_./:@%+,-]+$/.test(v)) return v;
  if (!v.includes("'")) return `'${v}'`;
  return `"${v.replace(/[\\"$`]/g, (c) => "\\" + c)}"`;
}

// The file's text with NAME set: the first NAME line (also `export NAME=`) replaced in place, later ones dropped,
// otherwise appended. Other lines, comments and line endings are kept.
export function upsertEnvLine(text, name, value) {
  if (!NAME_RE.test(name)) throw new Error(`bad name ${name}`);
  const line = `${name}=${quoteValue(value)}`;
  const re = new RegExp(`^(\\s*)(export\\s+)?${name}\\s*=`);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text === "" ? [] : text.split(/\r?\n/);
  const trailing = lines.length > 0 && lines[lines.length - 1] === "";
  if (trailing) lines.pop();
  let done = false;
  const out = [];
  for (const l of lines) {
    const m = re.exec(l);
    if (!m) out.push(l);
    else if (!done) {
      out.push(`${m[1]}${m[2] ?? ""}${line}`);
      done = true;
    }
  }
  if (!done) out.push(line);
  return out.join(eol) + eol;
}

export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = { cmd, name: null, file: null, reason: "", timeout: 900 };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--file") opts.file = rest[++i];
    else if (a === "--reason") opts.reason = rest[++i] ?? "";
    else if (a === "--timeout") opts.timeout = Number(rest[++i]);
    else if (!a.startsWith("--") && opts.name === null) opts.name = a;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!Number.isFinite(opts.timeout) || opts.timeout < 10 || opts.timeout > 900) throw new Error("--timeout: 10 to 900 seconds (requests expire after 15 minutes)");
  return opts;
}

// Write atomically with mode 600: a temp file next to the target, then rename.
export function writeSecretFile(path, name, value) {
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  const tmp = `${path}.paddock-${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmp, upsertEnvLine(before, name, value), { mode: 0o600, flag: "wx" });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

// --- talking to web ---

function api(method, path, body) {
  const base = process.env.PADDOCK_WEB_URL || "http://web:3000";
  const tokenFile = process.env.PADDOCK_WS_TOKEN_FILE || "/run/secrets/ws-token";
  let token = "";
  try {
    token = readFileSync(tokenFile, "utf8").trim();
  } catch {
    return Promise.reject(new Error(`cannot read the harness token (${tokenFile})`));
  }
  const url = new URL(path, base);
  const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((ok, fail) => {
    const req = httpRequest(url, {
      method,
      agent: new Agent({ keepAlive: false }),
      timeout: 15_000,
      headers: { authorization: `Bearer ${token}`, ...(data ? { "content-type": "application/json", "content-length": data.length } : {}) },
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (text += d));
      res.on("end", () => {
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {}
        ok({ status: res.statusCode ?? 0, json });
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => fail(new Error(`cannot reach Paddock at ${url.origin}: ${e.message}`)));
    req.end(data);
  });
}

const die = (msg, code = 1) => {
  console.error(`paddock-secret: ${msg}`);
  process.exit(code);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(opts) {
  if (!opts.name || !NAME_RE.test(opts.name)) die("NAME: A-Z, 0-9 and _, starting with a letter or _ (e.g. OPENAI_API_KEY)", 2);
  const file = resolveInWorkspace(opts.file);
  if (file instanceof Error) die(file.message, 2);
  if (opts.reason && (opts.reason.length > 300 || /[\u0000-\u001f]/.test(opts.reason))) die("--reason: one line, up to 300 characters", 2);
  const created = await api("POST", "/api/harness/secret-requests", { name: opts.name, file, reason: opts.reason, threadId: process.env.CODEX_THREAD_ID || null });
  if (created.status !== 201) die(created.json?.error ?? `Paddock answered ${created.status}`);
  const id = created.json.request.id;
  console.error(`paddock-secret: waiting for the user to fill in ${opts.name} in Paddock (up to ${Math.round(opts.timeout / 60)} min)…`);
  let cancelled = false;
  const cancel = async () => {
    if (cancelled) return;
    cancelled = true;
    await api("DELETE", `/api/harness/secret-requests/${id}`).catch(() => {});
  };
  process.on("SIGINT", () => cancel().finally(() => die("cancelled", 130)));
  process.on("SIGTERM", () => cancel().finally(() => die("cancelled", 143)));
  const deadline = Date.now() + opts.timeout * 1000;
  let errors = 0;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const r = await api("GET", `/api/harness/secret-requests/${id}`).catch(() => null);
    if (!r || r.status >= 500) {
      if (++errors > 15) die("lost contact with Paddock");
      continue;
    }
    errors = 0;
    if (r.status === 404) die("expired: the request is gone (Paddock restarted?)", 3);
    const st = r.json?.status;
    if (st === "fulfilled" && typeof r.json.value === "string") {
      const len = [...r.json.value].length;
      try {
        writeSecretFile(file, opts.name, r.json.value);
      } catch (e) {
        die(`could not write ${file}: ${e.message}`);
      }
      console.log(`saved ${opts.name} to ${file} (${len} chars)`);
      return;
    }
    if (st === "declined") die(`declined: the user did not provide ${opts.name}`, 3);
    if (st === "expired" || st === "consumed") die(`expired: ${opts.name} was not provided in time`, 3);
  }
  await cancel();
  die(`expired: ${opts.name} was not provided within ${opts.timeout} s`, 3);
}

async function list() {
  const r = await api("GET", "/api/harness/secret-requests");
  if (r.status !== 200) die(r.json?.error ?? `Paddock answered ${r.status}`);
  const reqs = r.json.requests ?? [];
  if (reqs.length === 0) return console.log("no pending requests");
  for (const q of reqs) console.log(`${q.name}\t${q.file}\twaiting ${Math.round((Date.now() - q.createdAt) / 1000)} s${q.reason ? `\t${q.reason}` : ""}`);
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    die(e.message, 2);
  }
  if (opts.cmd === "request") return request(opts);
  if (opts.cmd === "list") return list();
  die('usage: paddock-secret request NAME --file <path> [--reason "..."] [--timeout 900] | paddock-secret list', 2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main().catch((e) => die(e.message));
