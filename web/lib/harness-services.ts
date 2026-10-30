// Server-side singletons for git accounts and secret requests. The secret request store lives on globalThis: server.ts
// (the /api/harness/* handler) and Next's route handlers (/api/secret-requests) are separate module graphs in one
// process and must see the same requests.
import { auth, db, harnessIdOf } from "./auth";
import { gitAccountStore, type GitAccountStore } from "./git-accounts";
import { secretsKeyFrom } from "./secret-box";
import { secretRequestStore, type SecretRequestStore } from "./secret-requests";

const g = globalThis as { __paddockSecretRequests?: SecretRequestStore; __paddockGitAccounts?: GitAccountStore; __paddockSecretsKey?: Buffer };

export const secretRequests = (): SecretRequestStore => (g.__paddockSecretRequests ??= secretRequestStore());
export const secretsKey = (): Buffer => (g.__paddockSecretsKey ??= secretsKeyFrom(process.env));
export const gitAccounts = (): GitAccountStore => (g.__paddockGitAccounts ??= gitAccountStore(db, secretsKey));

// PADDOCK_HARNESS_API=0 switches off everything harnesses call (git credentials, secret requests).
export const harnessApiEnabled = () => process.env.PADDOCK_HARNESS_API !== "0";

const publicUrl = () => process.env.PUBLIC_URL ?? "http://localhost:3000";

// Any signed-in user, for their own data. Mutations only from our own origin (the same rule as requireAdmin).
export async function requireUser(req: Request): Promise<{ userId: string; harnessId: string } | Response> {
  const session = await auth.api.getSession({ headers: req.headers }).catch(() => null);
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (req.method !== "GET" && req.method !== "HEAD" && req.headers.get("origin") !== publicUrl()) return Response.json({ error: "bad origin" }, { status: 403 });
  let harnessId: string;
  try {
    harnessId = harnessIdOf(session.user);
  } catch {
    return Response.json({ error: "no harness for this account" }, { status: 403 });
  }
  return { userId: session.user.id, harnessId };
}

export const noStore = { "cache-control": "no-store" };
