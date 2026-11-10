import { useCallback, useLayoutEffect, useRef } from "react";

/** Wait for the non-loading view to paint before presenting a native share sheet. */
export function useSharePresentation(presenting: boolean) {
  const ready = useRef<() => void>(undefined);

  useLayoutEffect(() => {
    if (!presenting || !ready.current) return;
    let nextFrame: number | undefined;
    const frame = requestAnimationFrame(() => {
      nextFrame = requestAnimationFrame(() => {
        const resolve = ready.current;
        ready.current = undefined;
        resolve?.();
      });
    });
    return () => {
      cancelAnimationFrame(frame);
      if (nextFrame !== undefined) cancelAnimationFrame(nextFrame);
    };
  }, [presenting]);

  useLayoutEffect(() => () => {
    const resolve = ready.current;
    ready.current = undefined;
    resolve?.();
  }, []);

  return useCallback(() => new Promise<void>((resolve) => { ready.current = resolve; }), []);
}
