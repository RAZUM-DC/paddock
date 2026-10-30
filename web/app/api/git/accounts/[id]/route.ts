// DELETE /api/git/accounts/<id>: remove one of the signed-in user's git accounts.
import { gitAccounts, requireUser } from "@/lib/harness-services";

export const dynamic = "force-dynamic";

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const u = await requireUser(req);
  if (u instanceof Response) return u;
  const { id } = await params;
  if (!/^[0-9a-f]{24}$/.test(id) || !gitAccounts().remove(u.userId, id)) return Response.json({ error: "no such account" }, { status: 404 });
  return Response.json({ ok: true });
}
