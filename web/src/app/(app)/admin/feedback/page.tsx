"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useSession } from "@/components/session";
import { FeedbackList } from "@/components/feedback-list";

/** Administration › Problem reports: every "Report a problem" report. Everyone else (and ?mine=true) sees their own. */
export default function FeedbackPage() {
  return <Suspense fallback={null}><Reports /></Suspense>;
}

function Reports() {
  const { me } = useSession();
  const params = useSearchParams();
  const mine = !me.user.isAdmin || params.get("mine") === "true";
  return <FeedbackList key={String(mine)} mine={mine} />;
}
