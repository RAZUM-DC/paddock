// Git accounts of the signed-in user (Settings → Git). GET lists them (never the token: only its last 4 characters),
// POST adds one {host, prefix, username, token, label}. The harness gets a token only through the credential helper.
import { isGitAccountError } from "@/lib/git-accounts";
import { gitAccounts, noStore, requireUser } from "@/lib/harness-services";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const u = await requireUser(req);
  if (u instanceof Response) return u;
  return Response.json({ accounts: gitAccounts().list(u.userId) }, { headers: noStore });
}

export async function POST(req: Request) {
  const u = await requireUser(req);
  if (u instanceof Response) return u;
  const body = await req.json().catch(() => null);
  try {
    return Response.json({ account: gitAccounts().add(u.userId, body) }, { status: 201, headers: noStore });
  } catch (e) {
    if (isGitAccountError(e)) return Response.json({ error: e.message }, { status: 400 });
    console.error(`git accounts: ${e instanceof Error ? e.message : "error"}`);
    return Response.json({ error: "could not save the account" }, { status: 500 });
  }
}
