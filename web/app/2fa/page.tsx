// Second factor after a single sign-on login (OIDC_REQUIRE_TOTP): enter the authenticator code, or set one up first.
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { secondFactorStatus } from "@/lib/auth";
import { secondFactorPageAction } from "@/lib/second-factor-core";
import { SecondFactor } from "@/components/second-factor";

export const dynamic = "force-dynamic";

export default async function SecondFactorPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const st = await secondFactorStatus(await headers());
  const action = secondFactorPageAction(st, (await searchParams).next);
  if ("redirect" in action) redirect(action.redirect);
  return <SecondFactor enrolled={st!.enrolled} email={st!.email ?? ""} next={action.next} />;
}
