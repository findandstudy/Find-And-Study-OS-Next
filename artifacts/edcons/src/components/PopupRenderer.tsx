import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { useAuth } from "@/hooks/use-auth";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ExternalLink } from "lucide-react";

interface Popup {
  id: number;
  title: string;
  content: string;
  imageUrl: string | null;
  linkUrl: string | null;
  linkText: string | null;
  frequency: string;
  targetAudience: string;
  targetAgentIds: number[];
  status: string;
  startsAt: string | null;
  expiresAt: string | null;
}

import { AGENT_ROLES as _AG } from "@workspace/roles";
const AGENT_ROLES = _AG;
const SESSION_KEY = "popups_seen_session";
const LOGIN_KEY = "popups_seen_login";

function getSeenSet(key: string, storage: Storage): Set<number> {
  try {
    const raw = storage.getItem(key);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as number[]);
  } catch {
    return new Set();
  }
}

function addToSeenSet(key: string, storage: Storage, id: number) {
  const set = getSeenSet(key, storage);
  set.add(id);
  storage.setItem(key, JSON.stringify(Array.from(set)));
}

function clearLoginSeenIfNewSession(userId: number) {
  const clearedKey = `popups_login_cleared_${userId}`;
  if (!sessionStorage.getItem(clearedKey)) {
    localStorage.removeItem(LOGIN_KEY);
    sessionStorage.setItem(clearedKey, "1");
  }
}

export function PopupRenderer() {
  const { user } = useAuth();
  const [location] = useLocation();
  const queryClient = useQueryClient();
  const [currentPopup, setCurrentPopup] = useState<Popup | null>(null);
  const [dontShow, setDontShow] = useState(false);

  const isAgent = !!user && AGENT_ROLES.includes(user.role);
  const isAdminOrStaff = !!user && !AGENT_ROLES.includes(user.role) && user.role !== "student";
  const isAgentPath = location === "/agent";

  useEffect(() => {
    if (user?.id && isAgent) {
      clearLoginSeenIfNewSession(user.id);
    }
  }, [user?.id, isAgent]);

  const { data } = useQuery({
    queryKey: ["popups-active"],
    queryFn: () => customFetch<{ data: Popup[] }>("/api/popups/active"),
    enabled: isAgent && isAgentPath && !isAdminOrStaff,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (!data?.data || !isAgent) return;

    const sessionSeen = getSeenSet(SESSION_KEY, sessionStorage);
    const loginSeen = getSeenSet(LOGIN_KEY, localStorage);

    for (const popup of data.data) {
      if (sessionSeen.has(popup.id)) continue;

      if (popup.frequency === "every_login" && loginSeen.has(popup.id)) continue;

      setCurrentPopup(popup);
      setDontShow(false);
      break;
    }
  }, [data, isAgent]);

  async function handleClose() {
    if (!currentPopup) return;

    addToSeenSet(SESSION_KEY, sessionStorage, currentPopup.id);

    if (currentPopup.frequency === "every_login" || dontShow) {
      addToSeenSet(LOGIN_KEY, localStorage, currentPopup.id);
    }

    const permanent = dontShow || currentPopup.frequency === "once_per_user";

    try {
      await customFetch(`/api/popups/${currentPopup.id}/dismiss`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ permanent }),
      });
    } catch {
    }

    setCurrentPopup(null);
    queryClient.invalidateQueries({ queryKey: ["popups-active"] });
  }

  if (!currentPopup || isAdminOrStaff || !isAgent || !isAgentPath) {
    return null;
  }

  const hasImage = !!currentPopup.imageUrl;

  return (
    <Dialog open={true} onOpenChange={(open) => { if (!open) handleClose(); }}>
      <DialogContent
        className={`p-0 overflow-hidden gap-0 ${hasImage ? "max-w-4xl sm:max-w-4xl md:max-w-5xl" : "max-w-2xl"} w-[95vw] max-h-[90vh]`}
        data-testid="popup-dialog"
      >
        <div className={`grid ${hasImage ? "md:grid-cols-2" : "grid-cols-1"} max-h-[90vh]`}>
          {hasImage && (
            <div className="relative bg-muted hidden md:block">
              <img
                src={currentPopup.imageUrl as string}
                alt=""
                className="absolute inset-0 w-full h-full object-cover"
                onError={e => { (e.target as HTMLImageElement).style.display = "none"; }}
              />
            </div>
          )}

          <div className="flex flex-col max-h-[90vh] overflow-hidden">
            <DialogHeader className="px-6 pt-6 pb-3 shrink-0">
              <DialogTitle className="text-xl md:text-2xl font-bold leading-tight pr-8" data-testid="popup-title">
                {currentPopup.title}
              </DialogTitle>
            </DialogHeader>

            {hasImage && (
              <div className="md:hidden px-6 pb-3 shrink-0">
                <img
                  src={currentPopup.imageUrl as string}
                  alt=""
                  className="w-full max-h-56 object-cover rounded-lg"
                  onError={e => { (e.target as HTMLImageElement).style.display = "none"; }}
                />
              </div>
            )}

            <div className="px-6 flex-1 overflow-y-auto">
              <p
                className="text-sm md:text-base text-foreground/80 whitespace-pre-wrap leading-relaxed"
                data-testid="popup-content"
              >
                {currentPopup.content}
              </p>

              {currentPopup.linkUrl && (
                <div className="mt-5">
                  <a
                    href={currentPopup.linkUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex"
                  >
                    <Button type="button" variant="default" size="default" data-testid="popup-link-btn">
                      <ExternalLink className="w-4 h-4 mr-2" />
                      {currentPopup.linkText || "Learn more"}
                    </Button>
                  </a>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between gap-3 px-6 py-4 mt-4 border-t bg-muted/30 shrink-0">
              {currentPopup.frequency !== "once_per_user" ? (
                <label className="flex items-center gap-2 cursor-pointer text-sm text-muted-foreground" data-testid="popup-dont-show-label">
                  <Checkbox
                    checked={dontShow}
                    onCheckedChange={(checked) => setDontShow(!!checked)}
                    data-testid="popup-dont-show-checkbox"
                  />
                  Don&apos;t show again
                </label>
              ) : <span />}
              <Button onClick={handleClose} size="default" data-testid="popup-close-btn">
                Close
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
