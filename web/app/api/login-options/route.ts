// What the login page shows: the SSO button (OIDC_ISSUER) and/or the password form (LOCAL_LOGIN). No secrets.
import { loginOptions } from "@/lib/oidc";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(loginOptions());
}
