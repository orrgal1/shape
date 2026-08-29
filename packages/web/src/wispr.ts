/**
 * Wispr Flow tier 2: press-and-hold a bubble to drive the user's desktop Wispr
 * install through its URI scheme. Navigating a hidden iframe is the only way to
 * fire a custom scheme without a visible tab flash, and it must stay a silent
 * no-op when nothing on the machine handles `wispr-flow://`.
 */
import { useCallback, useEffect, useRef, useState } from "react";

const HOLD_MS = 350;
/** long enough for the browser to start the hand-off, short enough to not litter */
const SINK_TTL_MS = 1500;

/**
 * A fresh iframe per call, on purpose: Chrome detaches a frame once it has been
 * navigated to an unregistered external scheme, so a cached one would swallow
 * the `stop` that ends dictation and leave the user's mic hot.
 */
function fire(action: "start-hands-free" | "stop-hands-free"): void {
  try {
    const sink = document.createElement("iframe");
    sink.setAttribute("aria-hidden", "true");
    sink.setAttribute("tabindex", "-1");
    sink.style.display = "none";
    sink.src = `wispr-flow://${action}`;
    document.body.appendChild(sink);
    window.setTimeout(() => sink.remove(), SINK_TTL_MS);
  } catch {
    // unhandled scheme, blocked navigation, sandboxed frame: all fine, ignore
  }
}

export interface HoldHandlers {
  onPointerDown: () => void;
}

/**
 * Returns whether capture is currently held (for the node's listening state)
 * and the pointer handler to spread onto the bubble.
 *
 * The end of the gesture is watched on `window`, not on the bubble: starting
 * hands-free capture hands focus to another application, and a pointerup that
 * arrives after that hand-off — or outside the bubble the press started on —
 * must still stop dictation. Leaving the bubble mid-sentence must not.
 */
export function useVoiceHold(): { holding: boolean; handlers: HoldHandlers } {
  const [holding, setHolding] = useState(false);
  const timer = useRef<number | null>(null);
  const started = useRef(false);

  const release = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    if (!started.current) return;
    started.current = false;
    setHolding(false);
    fire("stop-hands-free");
  }, []);

  const press = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      started.current = true;
      setHolding(true);
      fire("start-hands-free");
    }, HOLD_MS);
  }, []);

  useEffect(() => {
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      release();
    };
  }, [release]);

  return { holding, handlers: { onPointerDown: press } };
}
