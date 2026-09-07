import { useEffect, useRef } from "react";

/**
 * Auto-refresh floor. Several holder panels each read the ICHOR mint (and
 * neighbours) on mount. Without a floor they re-fire whenever `passed` or
 * `connection` identity churns, and official-devnet HTTP answers 429.
 * A confirmed signature bypasses the floor so the page can show the write.
 */
export const LIVE_REFRESH_TTL_MS = 15_000;

export function useThrottledLiveRefresh(
  enabled: boolean,
  refresh: () => void,
  forceKey?: string | null,
): void {
  const lastAt = useRef(0);
  const lastForce = useRef<string | null>(null);
  const wasEnabled = useRef(false);
  useEffect(() => {
    if (!enabled) {
      wasEnabled.current = false;
      return;
    }
    const becameEnabled = !wasEnabled.current;
    wasEnabled.current = true;
    const forced = Boolean(forceKey) && forceKey !== lastForce.current;
    lastForce.current = forceKey ?? null;
    const now = Date.now();
    if (!forced && !becameEnabled && now - lastAt.current < LIVE_REFRESH_TTL_MS) {
      return;
    }
    lastAt.current = now;
    refresh();
  }, [enabled, forceKey, refresh]);
}
