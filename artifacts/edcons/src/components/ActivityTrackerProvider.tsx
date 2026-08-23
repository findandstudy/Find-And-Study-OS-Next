import { useAuth } from "@/hooks/use-auth";
import { useActivityTracker } from "@/hooks/use-activity-tracker";

export function ActivityTrackerProvider({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuth();
  useActivityTracker(isAuthenticated);
  return <>{children}</>;
}
