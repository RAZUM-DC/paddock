// Secret requests waiting for the signed-in user (made by the `secrets` tool in their harness). Never values.
import { noStore, requireUser, secretRequests } from "@/lib/harness-services";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const u = await requireUser(req);
  if (u instanceof Response) return u;
  return Response.json({ requests: secretRequests().pending(u.harnessId) }, { headers: noStore });
}
