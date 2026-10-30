// Answer a secret request: {value} (one line, up to 8 KB) or {decline: true}. The value is held in memory until the
// waiting command collects it once, and is never logged.
import { noStore, requireUser, secretRequests } from "@/lib/harness-services";
import { isRequestId, isSecretRequestError } from "@/lib/secret-requests";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const u = await requireUser(req);
  if (u instanceof Response) return u;
  const { id } = await params;
  if (!isRequestId(id)) return Response.json({ error: "no such request" }, { status: 404 });
  const text = await req.text().catch(() => "");
  if (text.length > 64 * 1024) return Response.json({ error: "body too large" }, { status: 413 });
  let body: { value?: unknown; decline?: unknown } | null = null;
  try {
    body = JSON.parse(text);
  } catch {}
  if (!body || typeof body !== "object") return Response.json({ error: "body must be JSON" }, { status: 400 });
  try {
    if (body.decline === true) secretRequests().decline(u.harnessId, id);
    else secretRequests().fulfil(u.harnessId, id, body.value);
    return Response.json({ ok: true }, { headers: noStore });
  } catch (e) {
    if (isSecretRequestError(e)) return Response.json({ error: e.message }, { status: e.status });
    return Response.json({ error: "failed" }, { status: 500 });
  }
}
