// Is this user's harness there? GET → {state: "ready" | "preparing" | "failed" | "unmanaged"}; POST → the same, and
// retries a failed preparation. Only meaningful with PROVISIONER_URL; otherwise always "unmanaged".
import { harnessIdOf, sessionFromHeaders } from "@/lib/auth";
import { harnessState } from "@/lib/provision";

export const dynamic = "force-dynamic";

async function answer(req: Request, retry: boolean) {
  const session = await sessionFromHeaders(req.headers);
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (retry && req.headers.get("origin") !== process.env.PUBLIC_URL) return Response.json({ error: "bad origin" }, { status: 403 });
  let id: string;
  try {
    id = harnessIdOf(session.user);
  } catch {
    return Response.json({ state: "failed", error: "no harness for this account" });
  }
  return Response.json(await harnessState({ id, email: session.user.email, name: session.user.name }, retry));
}

export const GET = (req: Request) => answer(req, false);
export const POST = (req: Request) => answer(req, true);
