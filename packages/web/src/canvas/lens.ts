/**
 * The lens grows a bubble so its whole summary fits; the viewport then zooms
 * onto the grown box (see motion.ts).
 *
 * Zooming alone scaled a clamped card: bigger type, still two lines and an
 * ellipsis. Growing alone showed every line at a type size nobody had asked to
 * read at. So both: the bubble's own box grows — around its centre, to reading
 * width, by exactly the height its clamped summary was hiding — and the
 * viewport zooms in on that box, so the words are larger AND all there.
 *
 * The extra height is measured against the real stylesheet rather than guessed
 * from a character count: a hidden card of the lens width, the summary in it,
 * and the difference between its clamped and unclamped heights.
 */
import type { Box, BoxMap } from "../layout.ts";

/** reading width for a lensed bubble — the same width the layout gives a solo card */
export const LENS_W = 420;

/** the box a lensed bubble takes: reading width, room for the whole summary, same centre */
export function lensBox(box: Box, extra: number): Box {
  const w = Math.max(box.w, LENS_W);
  const h = box.h + extra;
  return { x: box.x + box.w / 2 - w / 2, y: box.y + box.h / 2 - h / 2, w, h };
}

/** one hidden card reused across calls: a fresh node per measurement would thrash layout */
let measurer: { card: HTMLDivElement; text: HTMLParagraphElement } | null = null;

function card(): { card: HTMLDivElement; text: HTMLParagraphElement } {
  if (measurer !== null) return measurer;
  const host = document.createElement("div");
  host.style.cssText =
    "position:absolute; left:-9999px; top:0; visibility:hidden; pointer-events:none; font-family: var(--font-ui);";
  // the real classes, so the stylesheet's padding, box sizing and clamp all apply
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.dataset.lens = "true";
  bubble.style.height = "auto";
  const text = document.createElement("p");
  text.className = "bubble-summary";
  bubble.appendChild(text);
  host.appendChild(bubble);
  document.body.appendChild(host);
  measurer = { card: bubble, text };
  return measurer;
}

/**
 * How much taller a bubble has to be for its whole summary to show at `width`.
 *
 * The clamped height is asked for explicitly: the stylesheet unclamps a summary
 * inside a lensed card, which is what the second measurement wants and what the
 * first must not have.
 */
export function measureLensExtra(summary: string, width: number): number {
  const { card: bubble, text } = card();
  bubble.style.width = `${width}px`;
  text.textContent = summary;
  text.style.setProperty("-webkit-line-clamp", "2");
  const clamped = bubble.scrollHeight;
  text.style.setProperty("-webkit-line-clamp", "unset");
  const full = bubble.scrollHeight;
  text.style.removeProperty("-webkit-line-clamp");
  return Math.max(0, full - clamped);
}

/**
 * Layout targets with the lensed bubble's box grown in place. Everything else
 * keeps the size and the position the layout gave it — the lens draws on top and
 * may overlap its neighbours, which is what makes it read as the one thing being
 * looked at.
 *
 * `summaryOf` returns null for a bubble with nothing to reveal (a solo card is
 * already unclamped), and the lens then only widens to reading width.
 */
export function withLens(target: BoxMap, lens: string | null, summaryOf: (id: string) => string | null): BoxMap {
  if (lens === null) return target;
  const box = target[lens];
  if (box === undefined) return target;
  const summary = summaryOf(lens);
  const extra = summary === null || summary.length === 0 ? 0 : measureLensExtra(summary, Math.max(box.w, LENS_W));
  return { ...target, [lens]: lensBox(box, extra) };
}
