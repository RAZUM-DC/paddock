// Метаданные ходов, которых нет в истории Codex: модель, усилие, скорость генерации (выходные токены, первый токен).
// Раньше жили только в localStorage браузера — в другом браузере под старыми ответами было пусто.
import { db } from "./auth";

db.exec(`CREATE TABLE IF NOT EXISTS turn_meta (
  user TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  meta TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user, turn_id)
)`);

const upsert = db.prepare(`INSERT INTO turn_meta (user, turn_id, meta, updated_at) VALUES (?, ?, ?, ?)
  ON CONFLICT (user, turn_id) DO UPDATE SET meta = json_patch(turn_meta.meta, excluded.meta), updated_at = excluded.updated_at`);

export const saveTurnMeta = db.transaction((user: string, turns: Record<string, object>) => {
  const now = Date.now();
  for (const [id, meta] of Object.entries(turns)) upsert.run(user, id, JSON.stringify(meta), now);
});

export function loadTurnMeta(user: string, ids: string[]): Record<string, object> {
  if (ids.length === 0) return {};
  const rows = db.prepare(`SELECT turn_id, meta FROM turn_meta WHERE user = ? AND turn_id IN (${ids.map(() => "?").join(",")})`).all(user, ...ids) as { turn_id: string; meta: string }[];
  return Object.fromEntries(rows.map((r) => [r.turn_id, JSON.parse(r.meta)]));
}
