// Сеть для правой панели: цепочка, которой ходят агенты, и каждый прокси × API агентов (задержка, блок, мёртв).
// Адресов и паролей прокси здесь нет — только имена. Кеш минута, ?force=1 — проверить заново.
import { auth } from "@/lib/auth";
import { netReport } from "@/lib/proxy";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await auth.api.getSession({ headers: req.headers }).catch(() => null);
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  try {
    return Response.json(await netReport(new URL(req.url).searchParams.get("force") === "1"));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
