// Harness on demand: when PROVISIONER_URL is set and a user's harness is missing (no token file) or does not answer,
// web asks the provisioner (provisioner/) to create it and waits until it is ready. Without PROVISIONER_URL nothing
// here does anything: harnesses come from add-user.sh as before.
import { request as httpRequest, Agent } from "node:http";
import { request as httpsRequest, Agent as HttpsAgent } from "node:https";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { OIDC_ID_RE } from "./identity";

export type HarnessState =
  | { state: "ready" }
  | { state: "preparing"; since: number }
  | { state: "failed"; error: string }
  | { state: "unmanaged" }; // no provisioner: whatever add-user.sh made is all there is

const provisionerUrl = () => (process.env.PROVISIONER_URL ?? "").replace(/\/+$/, "");
export const provisioningEnabled = () => provisionerUrl() !== "";
// Only SSO users' harnesses (u-<12 hex>) are provisioned. A legacy harness (add-user.sh, on core) is "unmanaged":
// web never asks the provisioner about it, whatever happens to its container.
export const isProvisionedId = (id: unknown): id is string => typeof id === "string" && OIDC_ID_RE.test(id);
export const managedHarness = (id: unknown): id is string => provisioningEnabled() && isProvisionedId(id);
const tokensDir = () => process.env.TOKENS_DIR ?? "/run/secrets/tokens";
const codexHost = () => process.env.CODEX_HOST_TEMPLATE ?? "harness-{user}:4500";
const timeoutMs = () => Number(process.env.PROVISION_TIMEOUT_MS) > 0 ? Number(process.env.PROVISION_TIMEOUT_MS) : 120_000;

export const tokenFile = (id: string) => `${tokensDir()}/${id}.token`;
export const harnessAddress = (id: string) => codexHost().replace("{user}", id);

// Own agents: with NODE_USE_ENV_PROXY=1 (needed when the IdP is reachable only through egress) the global agent
// would send these internal calls to the proxy.
const agents = { http: new Agent({ keepAlive: false }), https: new HttpsAgent({ keepAlive: false }) };

function call(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const url = new URL(provisionerUrl() + path);
  const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const req = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const r = req(url, {
      method,
      agent: url.protocol === "https:" ? agents.https : agents.http,
      timeout: 10_000,
      headers: { authorization: `Bearer ${process.env.PROVISIONER_TOKEN ?? ""}`, "content-type": "application/json", ...(data ? { "content-length": data.length } : {}) },
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (text += c));
      res.on("end", () => {
        let json: any = null;
        try {
          json = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    r.on("timeout", () => r.destroy(new Error("provisioner timeout")));
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

// Does something accept connections on the harness port? (Auth is checked later by the WS bridge.)
export function harnessReachable(id: string, ms = 1500): Promise<boolean> {
  const [host, port] = harnessAddress(id).split(":");
  return new Promise((resolve) => {
    const s = connect({ host, port: Number(port) || 4500 });
    const done = (ok: boolean) => { s.destroy(); resolve(ok); };
    s.setTimeout(ms, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

// One run per harness id across the whole process: route handlers and server.ts get separate module instances.
type Run = { since: number; result: Promise<void>; error?: string; done?: boolean };
const runs: Map<string, Run> = ((globalThis as any).__paddockProvisionRuns ??= new Map());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function provision(id: string, email: string, name: string): Promise<void> {
  const started = Date.now();
  const r = await call("POST", "/harness/ensure", { id, email, name });
  if (r.status >= 400) throw new Error(`provisioner answered ${r.status}${r.json?.error ? `: ${r.json.error}` : ""}`);
  while (Date.now() - started < timeoutMs()) {
    const s = await call("GET", `/harness/${id}`).catch(() => null);
    // Ready per the provisioner, the token is visible here and the port answers: the WS bridge can connect.
    if (s?.json?.ready === true && existsSync(tokenFile(id)) && (await harnessReachable(id))) return;
    await sleep(2000);
  }
  throw new Error(`the workspace was not ready after ${Math.round(timeoutMs() / 1000)} s`);
}

// Start (or join) provisioning for a user; never throws. A failed run can be retried by calling again.
export function ensureHarness(user: { id: string; email: string; name?: string | null }): Run | null {
  if (!managedHarness(user.id)) return null;
  const cur = runs.get(user.id);
  if (cur && !cur.error) return cur;
  const run: Run = { since: Date.now(), result: Promise.resolve() };
  run.result = provision(user.id, user.email, user.name ?? "").then(
    () => {
      run.done = true;
      runs.delete(user.id);
    },
    (e: Error) => {
      run.error = e.message;
      console.error(`harness-${user.id}: provisioning failed: ${e.message}`);
    },
  );
  runs.set(user.id, run);
  return run;
}

// What the UI should show for this user right now. Starts provisioning when the harness is missing or silent;
// after a failure it reports the error until the user asks to retry.
export async function harnessState(user: { id: string; email: string; name?: string | null }, retry = false): Promise<HarnessState> {
  if (!managedHarness(user.id)) return { state: "unmanaged" };
  const cur = runs.get(user.id);
  if (cur?.error && !retry) return { state: "failed", error: cur.error };
  if (cur?.error) runs.delete(user.id);
  else if (cur) return { state: "preparing", since: cur.since };
  if (existsSync(tokenFile(user.id)) && (await harnessReachable(user.id))) return { state: "ready" };
  const run = ensureHarness(user);
  return run ? { state: "preparing", since: run.since } : { state: "failed", error: "bad harness id" };
}
