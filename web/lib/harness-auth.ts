// Calls from a harness container to web (git credential helper, secret requests): the caller proves which harness it
// is with that harness's own capability token (the file mounted at /run/secrets/ws-token, the same as in TOKENS_DIR).
// Pure node:fs/crypto, unit-tested in test/harness-auth.test.mjs.
import type Database from "better-sqlite3";
import { createHash, timingSafeEqual } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
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

// The harness id whose token file holds this token, or null. Every file is compared (constant time on sha256
// digests), so the answer time does not depend on where in the directory the match is.
export function harnessIdForToken(tokensDir: string, token: string | null): string | null {
  if (!token || token.length < MIN_TOKEN) return null;
  const want = digest(token);
  let found: string | null = null;
  let entries: string[] = [];
  try {
    entries = readdirSync(tokensDir);
  } catch {
    return null;
  }
  for (const f of entries) {
    const id = f.endsWith(".token") ? f.slice(0, -".token".length) : "";
    if (!isValidHarnessId(id)) continue;
    let have: string;
    try {
      have = readFileSync(join(tokensDir, f), "utf8").trim();
    } catch {
      continue;
    }
    if (have.length < MIN_TOKEN) continue;
    if (timingSafeEqual(digest(have), want) && found === null) found = id;
  }
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
export function rateLimiter(max: number, windowMs = 60_000, now: () => number = Date.now) {
  const hits = new Map<string, { start: number; n: number }>();
  return (key: string): boolean => {
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
}
