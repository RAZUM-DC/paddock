// Second factor after a single sign-on login (OIDC_REQUIRE_TOTP): enter the authenticator code, or set one up first.
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { secondFactorStatus } from "@/lib/auth";
import { safeNext } from "@/lib/second-factor-core";
import { SecondFactor } from "@/components/second-factor";

export const dynamic = "force-dynamic";

export default async function SecondFactorPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const next = safeNext((await searchParams).next);
  const st = await secondFactorStatus(await headers());
  if (!st?.signedIn) redirect("/login");
  if (!st.pending) redirect(next);
  return <SecondFactor enrolled={st.enrolled} email={st.email ?? ""} next={next} />;
}
