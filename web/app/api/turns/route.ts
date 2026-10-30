// Метаданные ходов пользователя: GET ?ids=a,b — прочитать, POST { turns: { id: meta } } — дописать (слияние полей).
import { harnessIdOf, sessionFromHeaders } from "@/lib/auth";
import { loadTurnMeta, saveTurnMeta } from "@/lib/turn-meta";

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

const ID = /^[\w-]{1,80}$/;

export async function GET(req: Request) {
  const user = await userOf(req);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  const ids = (new URL(req.url).searchParams.get("ids") ?? "").split(",").filter((i) => ID.test(i)).slice(0, 300);
  return Response.json({ turns: loadTurnMeta(user, ids) });
}

export async function POST(req: Request) {
  const user = await userOf(req);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => null);
  const turns = Object.fromEntries(
    Object.entries((body?.turns ?? {}) as Record<string, unknown>)
      .filter(([id, m]) => ID.test(id) && m && typeof m === "object" && JSON.stringify(m).length < 2000)
      .slice(0, 100),
  ) as Record<string, object>;
  saveTurnMeta(user, turns);
  return Response.json({ ok: Object.keys(turns).length });
}
