/**
 * Where a dropdown list goes relative to the field that opened it.
 *
 * The list is rendered into a portal with `position: fixed`, so no modal,
 * drawer, table or `overflow-*` ancestor can clip it — the viewport is the only
 * boundary. This module decides the rest:
 *
 *   - open downward when the list fits below the field;
 *   - flip above when below is cramped AND above genuinely has more room;
 *   - size to whichever side was chosen, so the list is never cut off;
 *   - clamp horizontally, because a list widened to a readable minimum can
 *     otherwise run past the right edge for a field on the right of a modal.
 *
 * Pure geometry, so the behaviour is unit-tested rather than eyeballed.
 */

export interface PlacementInput {
  /** the field's viewport rect (getBoundingClientRect) */
  rect: { top: number; bottom: number; left: number; width: number };
  viewport: { width: number; height: number };
  /** the list is never narrower than this, for readability */
  minWidth?: number;
  /** the list never grows past this, however much room there is */
  maxHeight?: number;
  /** space between the field and the list */
  gap?: number;
  /** space kept clear at the viewport edges */
  margin?: number;
}

export interface Placement {
  /** true = the list sits ABOVE the field */
  flip: boolean;
  left: number;
  width: number;
  maxHeight: number;
}

export function computePlacement({
  rect,
  viewport,
  minWidth = 240,
  maxHeight = 256,
  gap = 4,
  margin = 8,
}: PlacementInput): Placement {
  const below = viewport.height - rect.bottom - gap - margin;
  const above = rect.top - gap - margin;

  // Flip only when it actually buys room. A field with 200px below and 150px
  // above stays downward even though 200 < maxHeight — flipping would make it
  // smaller, not bigger.
  const flip = below < Math.min(maxHeight, above) && above > below;

  const room = Math.max(0, flip ? above : below);
  const width = Math.max(rect.width, minWidth);
  // keep the list on screen without detaching it from its field
  const left = Math.max(margin, Math.min(rect.left, viewport.width - width - margin));

  return { flip, left, width, maxHeight: Math.min(maxHeight, room) };
}
