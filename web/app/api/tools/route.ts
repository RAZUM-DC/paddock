// Реестр инструментов Paddock (web/tools/<id>/): браузер берёт отсюда манифесты и файлы и ставит их в дом харнесса через его fs API.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sessionFromHeaders } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await sessionFromHeaders(req.headers);
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const root = join(process.cwd(), "tools");
  const tools = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const dir = join(root, d.name);
      const manifest = JSON.parse(readFileSync(join(dir, "tool.json"), "utf8"));
      return { ...manifest, script: readFileSync(join(dir, manifest.bin), "utf8"), skillText: readFileSync(join(dir, "SKILL.md"), "utf8") };
    });
  return Response.json({ tools });
}
