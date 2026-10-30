// Calls from a harness container to web (git credential helper, secret requests): the caller proves which harness it
// is with that harness's own capability token (the file mounted at /run/secrets/ws-token, the same as in TOKENS_DIR).
// Pure node:fs/crypto, unit-tested in test/harness-auth.test.mjs.
import type Database from "better-sqlite3";
import { createHash, timingSafeEqual } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isValidHarnessId } from "./identity";

// add-user.sh and the provisioner both write 32 random bytes as hex; anything much shorter is not one of ours.
export const MIN_TOKEN = 32;

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

export function bearerOf(header: string | string[] | undefined | null): string | null {
  const h = Array.isArray(header) ? header[0] : header;
  const m = /^Bearer ([\x21-\x7e]+)$/.exec(h ?? "");
  return m ? m[1] : null;
}

// sha256 of every valid token file, cached per directory: re-read when the directory changes (a harness added or
// removed) or after ttlMs (a token rewritten in place), so callers cannot make web read every file on every request.
type TokenIndex = { mtimeMs: number; at: number; entries: { id: string; digest: Buffer }[] };
const indexes = new Map<string, TokenIndex>();
export const clearTokenCache = () => indexes.clear();

function tokenIndex(tokensDir: string, now: number, ttlMs: number): TokenIndex["entries"] | null {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(tokensDir).mtimeMs;
  } catch {
    indexes.delete(tokensDir);
    return null;
  }
  const cached = indexes.get(tokensDir);
  if (cached && cached.mtimeMs === mtimeMs && now - cached.at < ttlMs) return cached.entries;
  const entries: TokenIndex["entries"] = [];
  let names: string[] = [];
  try {
    names = readdirSync(tokensDir);
  } catch {
    return null;
  }
  for (const f of names) {
    const id = f.endsWith(".token") ? f.slice(0, -".token".length) : "";
    if (!isValidHarnessId(id)) continue;
    let have: string;
    try {
      have = readFileSync(join(tokensDir, f), "utf8").trim();
    } catch {
      continue;
    }
    if (have.length < MIN_TOKEN) continue;
    entries.push({ id, digest: digest(have) });
  }
  indexes.set(tokensDir, { mtimeMs, at: now, entries });
  return entries;
}

// The harness id whose token file holds this token, or null. Every entry is compared (constant time on sha256
// digests), so the answer time does not depend on where in the directory the match is.
export function harnessIdForToken(tokensDir: string, token: string | null, { now = Date.now(), ttlMs = 5_000 } = {}): string | null {
  if (!token || token.length < MIN_TOKEN) return null;
  const want = digest(token);
  let found: string | null = null;
  for (const e of tokenIndex(tokensDir, now, ttlMs) ?? []) if (timingSafeEqual(e.digest, want) && found === null) found = e.id;
  return found;
}

// harness id → web user id: the mapping lib/auth.ts stores on a user's first sign-in (harness_users, UNIQUE(harness_id)).
// A harness whose owner never signed in to web has no user, so no git accounts either.
export function userIdOfHarness(db: Database.Database, harnessId: string): string | null {
  try {
    const row = db.prepare("SELECT user_id FROM harness_users WHERE harness_id = ?").get(harnessId) as { user_id: string } | undefined;
    return row?.user_id ?? null;
  } catch {
    return null;
  }
}

// Fixed one-minute windows per key: enough to stop a runaway loop in a harness from hammering web.
// allow(key) counts a hit and says whether it is within the limit; blocked(key) only looks.
export function rateLimiter(max: number, windowMs = 60_000, now: () => number = Date.now) {
  const hits = new Map<string, { start: number; n: number }>();
  const allow = (key: string): boolean => {
    const t = now();
    const h = hits.get(key);
    if (!h || t - h.start >= windowMs) {
      hits.set(key, { start: t, n: 1 });
      if (hits.size > 10_000) for (const [k, v] of hits) if (t - v.start >= windowMs) hits.delete(k);
      return true;
    }
    h.n += 1;
    return h.n <= max;
  };
  const blocked = (key: string): boolean => {
    const h = hits.get(key);
    return !!h && now() - h.start < windowMs && h.n >= max;
  };
  return Object.assign(allow, { blocked });
}

// An admin names a user by email or harness id (offboarding): their web user id, or null.
export function findUserId(db: Database.Database, who: string): string | null {
  const w = who.trim();
  if (!w || w.length > 320) return null;
  try {
    const byHarness = isValidHarnessId(w) ? (db.prepare("SELECT user_id FROM harness_users WHERE harness_id = ?").get(w) as { user_id: string } | undefined) : undefined;
    if (byHarness) return byHarness.user_id;
    const byEmail = w.includes("@") ? (db.prepare(`SELECT "id" FROM "user" WHERE lower("email") = lower(?)`).get(w) as { id: string } | undefined) : undefined;
    return byEmail?.id ?? null;
  } catch {
    return null;
  }
}
