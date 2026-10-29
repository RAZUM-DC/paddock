// Who is who: web UI user → harness id, group policy for OIDC logins, admin check.
// Pure functions only (node:crypto at most), so they run under `node --test` without a build (see test/).
import { createHash } from "node:crypto";

// Harness ids are container/volume/network name parts: harness-<id>, workspace-<id>, paddock-u-<id>.
// OIDC users get u-<12 hex>; users created by scripts/create-user.ts keep the part of their email before "@".
export const HARNESS_ID_RE = /^u-[0-9a-f]{12}$|^[a-z0-9-]{1,32}$/;
export const isValidHarnessId = (id: unknown): id is string => typeof id === "string" && HARNESS_ID_RE.test(id);

// Legacy rule: "alice@hub.local" works with harness-alice (add-user.sh creates it).
export function legacyHarnessId(email: string): string {
  const name = email.split("@")[0];
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`bad codex user: ${name}`);
  return name;
}

export const normalizeIssuer = (issuer: string) => issuer.trim().replace(/\/+$/, "");
export const discoveryUrl = (issuer: string) => `${normalizeIssuer(issuer)}/.well-known/openid-configuration`;

// Stable and not guessable without the salt: the same person (issuer + sub) always lands in the same harness,
// even if their email changes at the IdP.
export function deriveHarnessId(salt: string, issuer: string, sub: string): string {
  if (!sub) throw new Error("empty OIDC subject");
  return "u-" + createHash("sha256").update(`${salt}:${normalizeIssuer(issuer)}:${sub}`).digest("hex").slice(0, 12);
}

// Which harness a user gets, decided once and then stored (so changing the salt or the issuer later moves nobody).
// A user who has a password account keeps the legacy name even after also signing in with OIDC.
export function chooseHarnessId(u: { stored?: string | null; email: string; hasCredential: boolean; oidcSub?: string | null; issuer?: string; salt?: string }): { id: string; store: boolean } {
  if (u.stored) return { id: u.stored, store: false };
  if (!u.hasCredential && u.oidcSub && u.issuer) return { id: deriveHarnessId(u.salt ?? "", u.issuer, u.oidcSub), store: true };
  return { id: legacyHarnessId(u.email), store: true };
}

// "a, b c" → ["a", "b", "c"]
export const parseList = (s: string | undefined | null) => (s ?? "").split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);

// The groups claim: usually an array of names, some IdPs send one string.
export function groupsOf(claims: Record<string, unknown> | null | undefined, claim = "groups"): string[] {
  const v = claims?.[claim];
  if (Array.isArray(v)) return v.filter((g): g is string => typeof g === "string" && g.length > 0);
  if (typeof v === "string") return parseList(v);
  return [];
}

// Empty allow-list = any authenticated user of the IdP. Group names compare exactly (case matters at most IdPs).
export function checkGroups(groups: string[], allowed: string[], adminGroups: string[]): { allowed: boolean; admin: boolean } {
  const has = (list: string[]) => list.some((g) => groups.includes(g));
  return { allowed: allowed.length === 0 || has(allowed), admin: has(adminGroups) };
}

// ADMIN_USERS lists harness ids (legacy names) or emails; OIDC admins come from their groups at the last login.
export function isAdmin(u: { harnessId: string; email: string; adminUsers: string[]; oidcAdmin: boolean }): boolean {
  if (u.oidcAdmin) return true;
  const email = u.email.toLowerCase();
  return u.adminUsers.some((a) => a !== "" && (a === u.harnessId || a.toLowerCase() === email));
}
