/**
 * One choreography per change.
 *
 * Node positions and the viewport used to animate on separate clocks — a JS
 * position tween plus a React Flow `fitView` with its own duration — which read
 * as two uncoordinated motions and a visible correction jump at the end. Here a
 * single rAF loop drives both: it interpolates every box AND the viewport from
 * the same start time, with the same easing, toward a viewport computed from the
 * *target* boxes. Nothing measures a half-finished animation, so there is no
 * race to lose and no second correction to see.
 *
 * `prefers-reduced-motion` snaps instead of animating.
 */
import { getViewportForBounds, useReactFlow, useStore, type Viewport } from "@xyflow/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { LayerNode } from "../layer.ts";
import { computeLayout, type Box, type BoxMap, type LayoutInput } from "../layout.ts";
import { useApp } from "../store.ts";

/** @xyflow/system is not a direct dependency, so take the shape from the util */
type Padding = Parameters<typeof getViewportForBounds>[5];

/**
 * The one duration scale every part of a change shares. Departing bubbles fade
 * over 200ms in CSS, comfortably inside this, so they are gone before the clock
 * removes them.
 */
export const MOTION_MS = 380;
/** a layer swap dissolves the outgoing layer before the new one arrives */
export const SWAP_OUT_MS = 150;
/** a bubble under the lens fills this much of the pane's shorter dimension, at most this zoom */
const LENS_FILL = 0.62;
const LENS_MAX_ZOOM = 2.2;

/** exponential ease-out; the same family as --ease in the stylesheet */
const ease = (t: number): number => 1 - Math.pow(1 - t, 3);

export type SwapPhase = "none" | "out" | "in";

export interface MotionState {
  /** interpolated boxes for everything currently rendered */
  boxes: BoxMap;
  /** bubbles that just appeared and should fade and scale in */
  entering: ReadonlySet<string>;
  /** bubbles that have left the layer but are still fading out */
  leaving: LayerNode[];
  /** whole-layer dissolve, for a drill or an up-navigation */
  swap: SwapPhase;
  /** wired to React Flow's move handlers: a user's viewport wins while they drag */
  setInteracting: (interacting: boolean) => void;
  /**
   * Centre and enlarge one bubble, or, for the bubble already under the lens,
   * put the viewport back exactly where it was. Automatic framing is held off
   * while the lens is on; a layer change lifts it.
   */
  toggleZoom: (id: string) => void;
  /** the bubble under the lens, if any */
  zoomed: string | null;
}


export interface MotionOptions {
  input: LayoutInput;
  /** ids to frame; undefined frames everything laid out */
  scope: string[] | undefined;
  padding: Padding;
  minZoom: number;
  maxZoom: number;
}

function boundsOf(boxes: BoxMap, ids: string[] | undefined): Box | null {
  const keys = ids ?? Object.keys(boxes);
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const id of keys) {
    const box = boxes[id];
    if (box === undefined) continue;
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.w);
    maxY = Math.max(maxY, box.y + box.h);
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function useMotion({ input, scope, padding, minZoom, maxZoom }: MotionOptions): MotionState {
  const [boxes, setBoxes] = useState<BoxMap>({});
  const [entering, setEntering] = useState<ReadonlySet<string>>(new Set<string>());
  const [leaving, setLeaving] = useState<LayerNode[]>([]);
  const [swap, setSwap] = useState<SwapPhase>("none");

  const { setViewport, getViewport } = useReactFlow();
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);

  const current = useRef<BoxMap>({});
  const frame = useRef<number | null>(null);
  /** the layer we last showed, so departures can be rendered while they fade */
  const shown = useRef<LayerNode[]>([]);
  const lastFocus = useRef<string | null | undefined>(undefined);
  /** deadline the layer dissolve runs until; survives effect re-runs */
  const swapUntil = useRef(0);
  /** the user is panning or zooming: their viewport wins until content changes */
  const interacting = useRef(false);
  /** viewport we owe once the user lets go */
  const owed = useRef<Viewport | null>(null);
  /** the bubble under the lens and the viewport to give back when it lifts */
  const lens = useRef<{ id: string; previous: Viewport } | null>(null);
  const [zoomed, setZoomed] = useState<string | null>(null);

  const setInteracting = useCallback((value: boolean) => {
    interacting.current = value;
    if (value || owed.current === null) return;
    const target = owed.current;
    owed.current = null;
    void setViewport(target, { duration: MOTION_MS });
  }, [setViewport]);

  const toggleZoom = useCallback(
    (id: string) => {
      const held = lens.current;
      if (held !== null && held.id === id) {
        lens.current = null;
        setZoomed(null);
        interacting.current = false;
        // content moved on underneath the lens: the fresh framing wins over a
        // viewport that was framing something else
        const back = owed.current ?? held.previous;
        owed.current = null;
        void setViewport(back, { duration: MOTION_MS });
        return;
      }
      const box = current.current[id];
      if (box === undefined || width === 0 || height === 0) return;
      // the first lens remembers where the user was; hopping lens to lens
      // keeps that first place, so the way back is always to before any lens
      const previous = held?.previous ?? getViewport();
      const zoom = Math.min(LENS_MAX_ZOOM, (width * LENS_FILL) / box.w, (height * LENS_FILL) / box.h);
      lens.current = { id, previous };
      setZoomed(id);
      interacting.current = true;
      void setViewport(
        { x: width / 2 - (box.x + box.w / 2) * zoom, y: height / 2 - (box.y + box.h / 2) * zoom, zoom },
        { duration: MOTION_MS },
      );
    },
    [width, height, setViewport, getViewport],
  );

  useEffect(() => {
    let cancelled = false;

    computeLayout(input)
      .then((target) => {
        if (cancelled) return;

        const layerIds = input.layer.nodes.map((entry) => entry.node.id);
        const known = new Set(Object.keys(current.current));
        const arriving = new Set(layerIds.filter((id) => !known.has(id)));

        const focusChanged = lastFocus.current !== undefined && lastFocus.current !== (input.layer.focus?.id ?? null);
        lastFocus.current = input.layer.focus?.id ?? null;
        // a different layer is a different picture: the lens lifts with nothing to give back to
        if (lens.current !== null && (focusChanged || !layerIds.includes(lens.current.id))) {
          lens.current = null;
          setZoomed(null);
          interacting.current = false;
          owed.current = null;
        }

        // bubbles that were on screen a moment ago and are not in the new layer
        const survivors = new Set(layerIds);
        const departed = focusChanged ? [] : shown.current.filter((entry) => !survivors.has(entry.node.id));
        shown.current = input.layer.nodes;

        const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

        const origin: BoxMap = {};
        const ids = Object.keys(target);
        for (const id of ids) {
          const landing = target[id];
          if (landing === undefined) continue;
          // an arriving bubble starts where it lands and fades in instead of sliding
          origin[id] = current.current[id] ?? landing;
        }
        // departing bubbles hold their last position while they fade
        for (const entry of departed) {
          const last = current.current[entry.node.id];
          if (last !== undefined) origin[entry.node.id] = last;
        }

        const rect = boundsOf(target, scope);
        const wanted =
          rect === null || width === 0 || height === 0
            ? null
            : getViewportForBounds(
                { x: rect.x, y: rect.y, width: rect.w, height: rect.h },
                width,
                height,
                minZoom,
                maxZoom,
                padding,
              );

        if (frame.current !== null) {
          cancelAnimationFrame(frame.current);
          frame.current = null;
        }

        setEntering(arriving);
        setLeaving(departed);

        const land = (): void => {
          current.current = target;
          setBoxes(target);
          if (wanted === null) return;
          if (interacting.current) {
            owed.current = wanted;
            return;
          }
          void setViewport(wanted, { duration: 0 });
        };

        // Reduced motion or a hidden tab (rAF never fires there): land at once.
        if (reduced || document.hidden) {
          swapUntil.current = 0;
          setSwap("none");
          land();
          return;
        }

        // The dissolve is a section of the same clock, not a separate timer.
        // Drilling resizes the pane (the focus card takes a row), which re-runs
        // this effect a frame later; a timer-driven phase would be cancelled by
        // that and the swap would never finish. A deadline survives it.
        const now0 = performance.now();
        if (focusChanged) swapUntil.current = now0 + SWAP_OUT_MS;
        const hold = Math.max(0, swapUntil.current - now0);

        const startFrom = getViewport();
        const start = now0;
        let phase: SwapPhase = hold > 0 ? "out" : "none";
        setSwap(phase);

        const step = (nowMs: number): void => {
          const elapsed = nowMs - start;
          if (phase === "out" && elapsed >= hold) {
            phase = "in";
            setSwap("in");
          }
          const t = Math.min(1, Math.max(0, (elapsed - hold) / MOTION_MS));
          const k = ease(t);
          const next: BoxMap = {};
          for (const id of Object.keys(origin)) {
            const a = origin[id];
            const b = target[id] ?? a;
            if (a === undefined || b === undefined) continue;
            next[id] =
              t === 1
                ? b
                : {
                    x: a.x + (b.x - a.x) * k,
                    y: a.y + (b.y - a.y) * k,
                    w: a.w + (b.w - a.w) * k,
                    h: a.h + (b.h - a.h) * k,
                  };
          }
          current.current = next;
          setBoxes(next);

          // the viewport rides the same clock, so there is never a second
          // correcting animation for the eye to catch
          if (wanted !== null && !interacting.current) {
            void setViewport(
              {
                x: startFrom.x + (wanted.x - startFrom.x) * k,
                y: startFrom.y + (wanted.y - startFrom.y) * k,
                zoom: startFrom.zoom + (wanted.zoom - startFrom.zoom) * k,
              },
              { duration: 0 },
            );
          }

          if (t < 1) {
            frame.current = requestAnimationFrame(step);
            return;
          }
          frame.current = null;
          current.current = target;
          swapUntil.current = 0;
          if (wanted !== null && interacting.current) owed.current = wanted;
          setEntering(new Set<string>());
          setLeaving([]);
        };

        frame.current = requestAnimationFrame(step);
      })
      .catch((error: unknown) => {
        // a blank canvas with no explanation is the worst possible failure here
        useApp.getState().pushError(`layout failed: ${error instanceof Error ? error.message : String(error)}`);
      });

    return () => {
      cancelled = true;
    };
  }, [input, scope, padding, minZoom, maxZoom, width, height, setViewport, getViewport]);

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  return { boxes, entering, leaving, swap, setInteracting, toggleZoom, zoomed };
}
