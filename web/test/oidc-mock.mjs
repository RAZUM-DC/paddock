// A minimal OpenID provider for tests (not a test file itself): discovery, JWKS, authorize (redirects at once with
// code, state and iss, like django-oauth-toolkit), token (PKCE S256 checked, client_secret_post or basic), userinfo.
// id_tokens are RS256 with the nonce of the authorization request. Plus a cookie jar and the whole login dance.
import { createServer } from "node:http";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";

export const PUBLIC = "http://localhost:3999";
// better-auth rate-limits sign-in per client address (3 per 10 s); tests are many clients.
let ip = 0;
export const clientIp = () => `198.51.100.${(ip = (ip % 250) + 1)}`;
const b64u = (b) => Buffer.from(b).toString("base64url");

export async function startMockIdp() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
  const codes = new Map();
  const tokens = new Map();
  const idp = { nextClaims: {}, requests: [], issuer: "", close: () => srv.close() };
  const jwt = (claims) => {
    const head = b64u(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "k1" }));
    const body = b64u(JSON.stringify(claims));
    return `${head}.${body}.${b64u(sign("sha256", Buffer.from(`${head}.${body}`), privateKey))}`;
  };
  const srv = createServer(async (req, res) => {
    const url = new URL(req.url, idp.issuer);
    let body = "";
    for await (const c of req) body += c;
    const json = (code, v) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
    idp.requests.push(`${req.method} ${url.pathname}`);
    const base = idp.issuer;
    if (url.pathname === "/o/.well-known/openid-configuration") return json(200, {
      issuer: base, authorization_endpoint: `${base}/authorize/`, token_endpoint: `${base}/token/`, userinfo_endpoint: `${base}/userinfo/`, jwks_uri: `${base}/.well-known/jwks.json`,
      response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"], code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"], scopes_supported: ["openid", "profile", "email", "groups"], authorization_response_iss_parameter_supported: true,
    });
    if (url.pathname === "/o/.well-known/jwks.json") return json(200, { keys: [jwk] });
    if (url.pathname === "/o/authorize/") {
      const p = url.searchParams;
      if (p.get("code_challenge_method") !== "S256" || !p.get("code_challenge") || !p.get("nonce")) return json(400, { error: "pkce_and_nonce_required" });
      const code = b64u(randomBytes(16));
      codes.set(code, { challenge: p.get("code_challenge"), nonce: p.get("nonce"), redirect: p.get("redirect_uri"), claims: { ...idp.nextClaims } });
      const to = new URL(p.get("redirect_uri"));
      to.searchParams.set("code", code);
      to.searchParams.set("state", p.get("state"));
      to.searchParams.set("iss", base);
      res.writeHead(302, { location: to.toString() });
      return res.end();
    }
    if (url.pathname === "/o/token/") {
      const f = new URLSearchParams(body);
      const basic = req.headers.authorization?.startsWith("Basic ") ? Buffer.from(req.headers.authorization.slice(6), "base64").toString() : "";
      const [cid, csec] = basic ? basic.split(":").map(decodeURIComponent) : [f.get("client_id"), f.get("client_secret")];
      if (cid !== "paddock" || csec !== "client-secret") return json(401, { error: "invalid_client" });
      const c = codes.get(f.get("code"));
      codes.delete(f.get("code"));
      if (!c || f.get("redirect_uri") !== c.redirect) return json(400, { error: "invalid_grant" });
      if (b64u(createHash("sha256").update(f.get("code_verifier") ?? "").digest()) !== c.challenge) return json(400, { error: "invalid_grant", error_description: "pkce" });
      const now = Math.floor(Date.now() / 1000);
      const claims = { iss: base, aud: "paddock", iat: now, exp: now + 300, nonce: c.nonce, email_verified: true, name: "Test User", groups: ["paddock-users"], ...c.claims };
      const at = b64u(randomBytes(16));
      tokens.set(at, claims);
      return json(200, { access_token: at, token_type: "Bearer", expires_in: 300, scope: "openid profile email groups", id_token: jwt(claims) });
    }
    if (url.pathname === "/o/userinfo/") {
      const c = tokens.get((req.headers.authorization ?? "").replace(/^Bearer /, ""));
      if (!c) return json(401, { error: "invalid_token" });
      const { iss, aud, iat, exp, nonce, ...info } = c;
      return json(200, info);
    }
    json(404, { error: "not found" });
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  idp.issuer = `http://127.0.0.1:${srv.address().port}/o`;
  // A signed id_token as the IdP would issue it (for better-auth's /sign-in/social id_token branch).
  idp.mint = (claims) => {
    const now = Math.floor(Date.now() / 1000);
    return jwt({ iss: idp.issuer, aud: "paddock", iat: now, exp: now + 300, email_verified: true, name: "Test User", groups: ["paddock-users"], ...claims });
  };
  return idp;
}

export function cookieJar() {
  const jar = new Map();
  return {
    take(res) {
      for (const c of res.headers.getSetCookie?.() ?? []) {
        const [pair, ...attrs] = c.split(";");
        const i = pair.indexOf("=");
        const name = pair.slice(0, i).trim();
        const value = pair.slice(i + 1).trim();
        const expired = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a)) || value === "";
        if (expired) jar.delete(name);
        else jar.set(name, value);
      }
    },
    header: () => [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
    sessionToken: () => {
      const v = jar.get("better-auth.session_token");
      return v ? decodeURIComponent(v).split(".")[0] : null;
    },
    location: null,
  };
}

// SSO from the login page to the callback: sign-in/social → IdP authorize → /api/auth/callback/oidc.
export async function oidcLogin(A, idp, claims, { expectSession = true } = {}) {
  const jar = cookieJar();
  const start = await A.auth.handler(new Request(`${PUBLIC}/api/auth/sign-in/social`, {
    method: "POST",
    headers: { origin: PUBLIC, "content-type": "application/json", "x-forwarded-for": clientIp() },
    body: JSON.stringify({ provider: "oidc", callbackURL: "/", errorCallbackURL: "/login" }),
  }));
  jar.take(start);
  const { url } = await start.json();
  if (!url) throw new Error(`sign-in/social: ${start.status}`);
  idp.nextClaims = claims;
  const auth = await fetch(url, { redirect: "manual" });
  const back = auth.headers.get("location");
  if (!back) throw new Error(`authorize: ${auth.status} ${await auth.text()}`);
  const cb = await A.auth.handler(new Request(back, { headers: { cookie: jar.header(), "x-forwarded-for": clientIp() } }));
  jar.take(cb);
  jar.location = cb.headers.get("location");
  if (expectSession && !jar.sessionToken()) throw new Error(`callback did not sign in: ${cb.status} ${jar.location}`);
  return jar;
}
