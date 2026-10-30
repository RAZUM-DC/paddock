// Снимки раскладок: GET — список, POST { name, data } — сохранить, DELETE ?id= — удалить.
import { harnessIdOf, sessionFromHeaders } from "@/lib/auth";
import { deleteSnapshot, listSnapshots, saveSnapshot } from "@/lib/snapshots";

export const dynamic = "force-dynamic";

async function userOf(req: Request) {
  const session = await sessionFromHeaders(req.headers);
  if (!session) return null;
  try {
    return harnessIdOf(session.user);
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  const user = await userOf(req);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  return Response.json({ snapshots: listSnapshots(user) });
}

export async function POST(req: Request) {
  const user = await userOf(req);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => null);
  if (!body?.name || !body?.data || JSON.stringify(body.data).length > 4000) return Response.json({ error: "bad snapshot" }, { status: 400 });
  return Response.json({ id: saveSnapshot(user, String(body.name), body.data) });
}

export async function DELETE(req: Request) {
  const user = await userOf(req);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  return Response.json({ deleted: deleteSnapshot(user, new URL(req.url).searchParams.get("id") ?? "") });
}
