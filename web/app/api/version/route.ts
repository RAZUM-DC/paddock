// Какая сборка сейчас отдаёт морду: супервизор запускает её из /build/b-<время>.
// Клиент сравнивает с той, что загрузил, и предлагает обновиться после выкатки.
import { realpathSync } from "node:fs";
import { basename } from "node:path";

export const dynamic = "force-dynamic";

const build = basename(realpathSync(process.cwd()));

export function GET() {
  return Response.json({ build });
}
