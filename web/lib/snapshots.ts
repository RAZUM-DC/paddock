// Снимки раскладок окон (как window snapshots в agentbelt): сколько окон, какие треды, где границы. На пользователя, в SQLite морды.
import { randomUUID } from "node:crypto";
import { db } from "./auth";

db.exec(`CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  user TEXT NOT NULL,
  name TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`);

export type Snapshot = { id: string; name: string; data: unknown; createdAt: number };

export function listSnapshots(user: string): Snapshot[] {
  return (db.prepare("SELECT id, name, data, created_at FROM snapshots WHERE user = ? ORDER BY created_at DESC LIMIT 50").all(user) as any[])
    .map((r) => ({ id: r.id, name: r.name, data: JSON.parse(r.data), createdAt: r.created_at }));
}

export function saveSnapshot(user: string, name: string, data: unknown): string {
  const id = randomUUID();
  db.prepare("INSERT INTO snapshots (id, user, name, data, created_at) VALUES (?, ?, ?, ?, ?)").run(id, user, name.slice(0, 80), JSON.stringify(data), Date.now());
  return id;
}

export const deleteSnapshot = (user: string, id: string) => db.prepare("DELETE FROM snapshots WHERE user = ? AND id = ?").run(user, id).changes;
