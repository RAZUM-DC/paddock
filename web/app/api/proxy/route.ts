import { listNodes, requireAdmin, saveNodes, type ProxyInput } from "@/lib/proxy";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = await requireAdmin(req);
  if (denied) return denied;
  try {
    return Response.json(await listNodes());
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}

export async function PUT(req: Request) {
  const denied = await requireAdmin(req);
  if (denied) return denied;
  try {
    const { nodes } = (await req.json()) as { nodes: ProxyInput[] };
    await saveNodes(nodes);
    return Response.json(await listNodes());
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
