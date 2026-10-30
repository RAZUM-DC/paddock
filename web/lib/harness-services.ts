// Server-side singletons for git accounts and secret requests. The secret request store lives on globalThis: server.ts
// (the /api/harness/* handler) and Next's route handlers (/api/secret-requests) are separate module graphs in one
// process and must see the same requests.
import { db, harnessIdOf, sessionFromHeaders } from "./auth";
import { gitAccountStore, type GitAccountStore } from "./git-accounts";
import { secretsKeyFrom } from "./secret-box";
import { secretRequestStore, type SecretRequestStore } from "./secret-requests";

const g = globalThis as { __paddockSecretRequests?: SecretRequestStore; __paddockGitAccounts?: GitAccountStore; __paddockSecretsKey?: Buffer };

export const secretRequests = (): SecretRequestStore => (g.__paddockSecretRequests ??= secretRequestStore());
export const secretsKey = (): Buffer => (g.__paddockSecretsKey ??= secretsKeyFrom(process.env));
export const gitAccounts = (): GitAccountStore => (g.__paddockGitAccounts ??= gitAccountStore(db, secretsKey));

// PADDOCK_HARNESS_API=0 switches off everything harnesses call (git credentials, secret requests).
export const harnessApiEnabled = () => process.env.PADDOCK_HARNESS_API !== "0";

// Any signed-in user, for their own data. Mutations only from our own origin: exactly the rule of requireAdmin
// (lib/proxy.ts) and /api/harness, so with PUBLIC_URL unset no mutation is accepted at all.
export async function requireUser(req: Request): Promise<{ userId: string; harnessId: string } | Response> {
  const session = await sessionFromHeaders(req.headers);
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (req.method !== "GET" && req.headers.get("origin") !== process.env.PUBLIC_URL) return Response.json({ error: "bad origin" }, { status: 403 });
  let harnessId: string;
  try {
    harnessId = harnessIdOf(session.user);
  } catch {
    return Response.json({ error: "no harness for this account" }, { status: 403 });
  }
  return { userId: session.user.id, harnessId };
}

export const noStore = { "cache-control": "no-store" };
