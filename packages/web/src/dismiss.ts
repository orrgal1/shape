/**
 * Dismiss an open pop-up on outside pointerdown or Escape. The trigger button
 * lives inside the returned ref's subtree, so its own click never counts as
 * "outside" — no close-then-reopen double-toggle on the same click.
 */
import { useEffect, useRef, type RefObject } from "react";

export function useDismissable(open: boolean, setOpen: (open: boolean) => void): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const root = ref.current;
      if (root !== null && event.target instanceof Node && root.contains(event.target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, setOpen]);
  return ref;
}
