import { checkExit, requireAdmin } from "@/lib/proxy";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const denied = await requireAdmin(req);
  if (denied) return denied;
  try {
    return Response.json(await checkExit());
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
