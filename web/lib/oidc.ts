// Corporate single sign-on (OpenID Connect) through better-auth's genericOAuth plugin.
// Off unless OIDC_ISSUER is set; password login keeps working unless LOCAL_LOGIN=0.
//
// Every login: the id_token is verified against the issuer's JWKS (with nonce and PKCE S256), userinfo is read,
// and the group policy is applied (OIDC_ALLOWED_GROUPS). A user removed from the groups is refused and their
// existing sessions are revoked. Users are created on their first OIDC login; that is the only way to sign up.
import type Database from "better-sqlite3";
import { APIError } from "better-auth/api";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import { decideOidcLogin, decodeJwtClaims, discoveryUrl, normalizeIssuer, parseList } from "./identity";

export const OIDC_PROVIDER_ID = "oidc";

export type OidcEnv = {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  scopes: string[];
  allowedGroups: string[];
  adminGroups: string[];
  groupsClaim: string;
  label: string | null;
  linkByEmail: boolean;
};

export function oidcEnv(env: NodeJS.ProcessEnv = process.env): OidcEnv | null {
  if (!env.OIDC_ISSUER || !env.OIDC_CLIENT_ID) return null;
  return {
    issuer: normalizeIssuer(env.OIDC_ISSUER),
    clientId: env.OIDC_CLIENT_ID,
    clientSecret: env.OIDC_CLIENT_SECRET || undefined,
    scopes: parseList(env.OIDC_SCOPES ?? "openid profile email groups"),
    allowedGroups: parseList(env.OIDC_ALLOWED_GROUPS),
    adminGroups: parseList(env.OIDC_ADMIN_GROUPS),
    groupsClaim: env.OIDC_GROUPS_CLAIM || "groups",
    label: env.OIDC_PROVIDER_LABEL || null,
    linkByEmail: env.OIDC_LINK_BY_EMAIL === "1",
  };
}

// LOCAL_LOGIN=0: no password form and no email/password sign-in on the server (SSO only).
export const localLoginEnabled = (env: NodeJS.ProcessEnv = process.env) => env.LOCAL_LOGIN !== "0";

// What the login page needs to know (no secrets).
export function loginOptions() {
  const o = oidcEnv();
  return { oidc: o ? { label: o.label } : null, local: localLoginEnabled() || !o };
}

export function setupOidcTables(db: Database.Database) {
  // The last thing the IdP said about a person: admin rights follow OIDC_ADMIN_GROUPS at every login.
  db.exec(`CREATE TABLE IF NOT EXISTS oidc_identities (
    issuer TEXT NOT NULL,
    sub TEXT NOT NULL,
    admin INTEGER NOT NULL,
    groups TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (issuer, sub)
  )`);
}

export function oidcPlugin(db: Database.Database, o: OidcEnv, publicUrl: string) {
  // Prepared on first use: better-auth's own tables (session, account) only exist after ensureDb() has run.
  const saveIdentity = (sub: string, admin: boolean, groups: string[]) =>
    (setupOidcTables(db), db).prepare(`INSERT INTO oidc_identities (issuer, sub, admin, groups, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (issuer, sub) DO UPDATE SET admin = excluded.admin, groups = excluded.groups, updated_at = excluded.updated_at`)
      .run(o.issuer, sub, admin ? 1 : 0, JSON.stringify(groups), Date.now());
  // Removed from the groups: every session of that person ends now, and admin rights with them.
  const shutOut = (sub: string) => {
    setupOidcTables(db);
    db.prepare(`DELETE FROM "session" WHERE "userId" IN (SELECT "userId" FROM "account" WHERE "providerId" = ? AND "accountId" = ?)`).run(OIDC_PROVIDER_ID, sub);
    db.prepare(`UPDATE oidc_identities SET admin = 0, groups = '[]', updated_at = ? WHERE issuer = ? AND sub = ?`).run(Date.now(), o.issuer, sub);
  };

  let userinfoEndpoint: Promise<string | null> | null = null;
  const userinfoUrl = () => {
    userinfoEndpoint ??= fetch(discoveryUrl(o.issuer), { signal: AbortSignal.timeout(10_000) })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => (typeof d?.userinfo_endpoint === "string" ? d.userinfo_endpoint : null))
      .catch(() => null)
      .then((u) => (u ?? (userinfoEndpoint = null, null)));
    return userinfoEndpoint;
  };

  // A redirect back to the login page with a reason the page can show.
  const refuse = (reason: string) => new APIError("FOUND", undefined, new Headers({ location: `${publicUrl}/login?error=${encodeURIComponent(reason)}` }));

  return genericOAuth({
    config: [
      {
        providerId: OIDC_PROVIDER_ID,
        name: o.label ?? "SSO",
        discoveryUrl: discoveryUrl(o.issuer),
        // Identity comes from id_token claims, so they must be verified: no JWKS in discovery = provider disabled.
        requireIdTokenVerification: true,
        clientId: o.clientId,
        clientSecret: o.clientSecret,
        scopes: o.scopes,
        pkce: true,
        // Signing out of Paddock does not sign the person out of the whole company.
        disableProviderLogout: true,
        overrideUserInfo: true,
        accountSubject: ({ profile }) => String(profile.sub ?? ""),
        // Runs after better-auth has verified the id_token (signature, issuer, audience, nonce).
        async getUserInfo(tokens) {
          const claims = decodeJwtClaims(tokens.idToken);
          let userinfo: Record<string, unknown> | null = null;
          const url = tokens.accessToken ? await userinfoUrl() : null;
          if (url) {
            const r = await fetch(url, { headers: { authorization: `Bearer ${tokens.accessToken}` }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
            if (r?.ok) userinfo = await r.json().catch(() => null);
          }
          const d = decideOidcLogin(claims, userinfo, o);
          if (!d.ok) {
            console.warn(`oidc: login refused (${d.reason})${d.sub ? ` for sub ${d.sub}` : ""}`);
            if (d.sub && d.reason === "not_allowed") shutOut(d.sub);
            throw refuse(d.reason);
          }
          saveIdentity(d.sub, d.admin, d.groups);
          return { ...d.profile, id: d.sub, sub: d.sub, email: d.email, emailVerified: d.emailVerified, name: d.name, image: d.image };
        },
      },
    ],
  });
}
