import { useEffect, useRef } from "react";
import { useRecordEntityView } from "@workspace/api-client-react";
import { RecordEntityViewBodyEntityType } from "@workspace/api-client-react";

const DEBOUNCE_MS = 800;

export function useEntityViewTracker(
  entityType: RecordEntityViewBodyEntityType,
  entityId: number | null | undefined,
) {
  const mutation = useRecordEntityView();
  const lastFiredRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!entityId) return;
    const key = `${entityType}:${entityId}`;
    if (lastFiredRef.current === key) return;

    if (timerRef.current) clearTimeout(timerRef.current);

    timerRef.current = setTimeout(() => {
      lastFiredRef.current = key;
      mutation.mutate({ data: { entityType, entityId } });
    }, DEBOUNCE_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [entityType, entityId]);
}
