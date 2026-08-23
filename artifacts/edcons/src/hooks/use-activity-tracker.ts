import { useEffect, useRef, useCallback } from "react";
import { customFetch } from "@workspace/api-client-react";

const IDLE_THRESHOLD_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const INTERACTION_EVENTS = ["mousedown", "mousemove", "keydown", "scroll", "touchstart", "click"];
const DEBOUNCE_MS = 2000;

export function useActivityTracker(isAuthenticated: boolean) {
  const sessionIdRef = useRef<number | null>(null);
  const currentVisitIdRef = useRef<number | null>(null);
  const currentRouteRef = useRef<string>("");
  const isActiveRef = useRef(true);
  const lastInteractionRef = useRef(Date.now());
  const heartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pageActiveStartRef = useRef(Date.now());
  const pageIdleAccumRef = useRef(0);
  const pageActiveAccumRef = useRef(0);
  const mountedRef = useRef(true);

  const post = useCallback(async (url: string, body?: any) => {
    try {
      await customFetch(`/api${url}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {}
  }, []);

  const startSession = useCallback(async () => {
    try {
      const res: any = await customFetch("/api/activity/session/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      sessionIdRef.current = res.sessionId;
    } catch {}
  }, []);

  const endSession = useCallback(async () => {
    if (!sessionIdRef.current) return;
    const sid = sessionIdRef.current;
    sessionIdRef.current = null;

    if (currentVisitIdRef.current) {
      await post("/activity/page-leave", {
        visitId: currentVisitIdRef.current,
        activeDuration: pageActiveAccumRef.current / 1000,
        idleDuration: pageIdleAccumRef.current / 1000,
      });
      currentVisitIdRef.current = null;
    }

    await post("/activity/session/end", { sessionId: sid, reason: "manual_logout" });
  }, [post]);

  const markActive = useCallback(() => {
    if (!isActiveRef.current) {
      isActiveRef.current = true;
      const now = Date.now();
      pageIdleAccumRef.current += now - pageActiveStartRef.current;
      pageActiveStartRef.current = now;
      post("/activity/event", {
        sessionId: sessionIdRef.current,
        eventType: "became_active",
        route: currentRouteRef.current,
      });
    }
    lastInteractionRef.current = Date.now();
  }, [post]);

  const markIdle = useCallback(() => {
    if (isActiveRef.current) {
      isActiveRef.current = false;
      const now = Date.now();
      pageActiveAccumRef.current += now - pageActiveStartRef.current;
      pageActiveStartRef.current = now;
      post("/activity/event", {
        sessionId: sessionIdRef.current,
        eventType: "became_idle",
        route: currentRouteRef.current,
      });
    }
  }, [post]);

  const resetIdleTimer = useCallback(() => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => {
      markIdle();
    }, IDLE_THRESHOLD_MS);
    markActive();
  }, [markActive, markIdle]);

  const recordPageVisit = useCallback(async (route: string) => {
    if (!sessionIdRef.current) return;

    if (currentVisitIdRef.current) {
      await post("/activity/page-leave", {
        visitId: currentVisitIdRef.current,
        activeDuration: pageActiveAccumRef.current / 1000,
        idleDuration: pageIdleAccumRef.current / 1000,
      });
    }

    pageActiveAccumRef.current = 0;
    pageIdleAccumRef.current = 0;
    pageActiveStartRef.current = Date.now();
    currentRouteRef.current = route;

    try {
      const res: any = await customFetch("/api/activity/page-visit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: sessionIdRef.current, route }),
      });
      currentVisitIdRef.current = res.visitId;
    } catch {}
  }, [post]);

  const sendHeartbeat = useCallback(() => {
    if (!sessionIdRef.current || document.hidden) return;

    post("/activity/heartbeat", {
      sessionId: sessionIdRef.current,
      status: isActiveRef.current ? "active" : "idle",
      route: currentRouteRef.current,
    });
  }, [post]);

  useEffect(() => {
    mountedRef.current = true;
    if (!isAuthenticated) return;

    startSession().then(() => {
      if (!mountedRef.current) return;
      const route = window.location.pathname;
      recordPageVisit(route);
    });

    const debouncedReset = debounce(resetIdleTimer, DEBOUNCE_MS);

    INTERACTION_EVENTS.forEach(evt =>
      document.addEventListener(evt, debouncedReset, { passive: true })
    );

    const handleVisibilityChange = () => {
      if (document.hidden) {
        post("/activity/event", { sessionId: sessionIdRef.current, eventType: "app_hidden", route: currentRouteRef.current });
        markIdle();
      } else {
        post("/activity/event", { sessionId: sessionIdRef.current, eventType: "app_visible", route: currentRouteRef.current });
        resetIdleTimer();
        // Mark the visible tab active before refreshing presence. The server
        // derives elapsed time from its own last_seen_at and caps sleep gaps.
        sendHeartbeat();
      }
    };

    const handleFocus = () => {
      post("/activity/event", { sessionId: sessionIdRef.current, eventType: "window_focus", route: currentRouteRef.current });
      resetIdleTimer();
      sendHeartbeat();
    };

    const handleBlur = () => {
      post("/activity/event", { sessionId: sessionIdRef.current, eventType: "window_blur", route: currentRouteRef.current });
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleFocus);
    window.addEventListener("blur", handleBlur);

    heartbeatTimerRef.current = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
    idleTimerRef.current = setTimeout(markIdle, IDLE_THRESHOLD_MS);

    let lastPath = window.location.pathname;
    const routeObserver = setInterval(() => {
      const currentPath = window.location.pathname;
      if (currentPath !== lastPath) {
        lastPath = currentPath;
        recordPageVisit(currentPath);
      }
    }, 500);

    return () => {
      mountedRef.current = false;
      INTERACTION_EVENTS.forEach(evt => document.removeEventListener(evt, debouncedReset));
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("blur", handleBlur);
      if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current);
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      clearInterval(routeObserver);
    };
  }, [isAuthenticated]);

  return { endSession };
}

function debounce(fn: () => void, ms: number) {
  let timer: ReturnType<typeof setTimeout>;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}
