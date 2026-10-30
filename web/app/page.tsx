import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { secondFactorStatus, sessionFromHeaders } from "@/lib/auth";
import { Chat } from "@/components/chat";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const h = await headers();
  const session = await sessionFromHeaders(h);
  if (!session) {
    // Signed in through SSO but without the second factor yet: that page, then back here.
    if ((await secondFactorStatus(h))?.pending) {
      const chat = (await searchParams).chat;
      const back = typeof chat === "string" ? `/?chat=${encodeURIComponent(chat)}` : "/";
      redirect(`/2fa?next=${encodeURIComponent(back)}`);
    }
    redirect("/login");
  }
  return <Chat email={session.user.email} />;
}
