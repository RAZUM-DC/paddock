// Offboarding, admins only (ADMIN_USERS / OIDC_ADMIN_GROUPS, same rule as the proxy settings):
//   GET    /api/admin/git-accounts?user=<email or harness id>  → {accounts: <count>}   (never tokens or hosts)
//   DELETE /api/admin/git-accounts?user=<email or harness id>  → {removed: <count>}   (Origin must be PUBLIC_URL)
import { db } from "@/lib/auth";
import { findUserId } from "@/lib/harness-auth";
import { gitAccounts } from "@/lib/harness-services";
import { requireAdmin } from "@/lib/proxy";

export const dynamic = "force-dynamic";

function target(req: Request): string | Response {
  const who = new URL(req.url).searchParams.get("user") ?? "";
  const userId = findUserId(db, who);
  return userId ?? Response.json({ error: "no such user" }, { status: 404 });
}

export async function GET(req: Request) {
  const denied = await requireAdmin(req);
  if (denied) return denied;
  const userId = target(req);
  if (userId instanceof Response) return userId;
  return Response.json({ accounts: gitAccounts().count(userId) });
}

export async function DELETE(req: Request) {
  const denied = await requireAdmin(req);
  if (denied) return denied;
  const userId = target(req);
  if (userId instanceof Response) return userId;
  const removed = gitAccounts().removeAll(userId);
  console.log(JSON.stringify({ event: "git-accounts-revoked", user: userId, removed }));
  return Response.json({ removed });
}
