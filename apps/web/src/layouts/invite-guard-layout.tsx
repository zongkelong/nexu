import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import "@/lib/api";
import { getApiV1Me } from "../../lib/api/sdk.gen";

export function InviteGuardLayout() {
  const location = useLocation();

  const { data: profile, isLoading } = useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      const { data } = await getApiV1Me();
      return data;
    },
  });

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-text-muted" />
      </div>
    );
  }

  if (profile && !profile.inviteAccepted) {
    return <Navigate to="/invite" replace />;
  }

  // Onboarding guard: if invite accepted but onboarding not completed,
  // and user is NOT already on the onboarding page, redirect there
  if (
    profile &&
    !profile.onboardingCompleted &&
    !location.pathname.startsWith("/onboarding")
  ) {
    const returnTo = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/onboarding?returnTo=${returnTo}`} replace />;
  }

  return <Outlet />;
}
