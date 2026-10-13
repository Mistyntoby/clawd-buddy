/** Pure desktop-movement math. No Electron imports, so it is fully unit-testable. */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** Height kept clear above the screen bottom when the OS reports no reserved taskbar area. */
export const AUTOHIDE_TASKBAR_MARGIN = 48;

/**
 * When the taskbar is set to auto-hide, the OS work area equals the full
 * display, and the taskbar would cover the companion whenever it pops up.
 * In that case keep a taskbar-sized margin at the bottom.
 */
export function effectiveWorkArea(bounds: Rect, workArea: Rect, margin = AUTOHIDE_TASKBAR_MARGIN): Rect {
  const reservesNothing =
    workArea.x === bounds.x && workArea.y === bounds.y && workArea.width === bounds.width && workArea.height === bounds.height;
  if (!reservesNothing || workArea.height <= margin * 4) return workArea;
  return { ...workArea, height: workArea.height - margin };
}

/** Safe window-position bounds so the whole window stays inside the work area. */
export function computeBounds(workArea: Rect, size: Size): Bounds {
  const maxX = workArea.x + Math.max(0, workArea.width - size.width);
  const maxY = workArea.y + Math.max(0, workArea.height - size.height);
  return { minX: workArea.x, maxX, minY: workArea.y, maxY };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function clampPosition(pos: Point, bounds: Bounds): Point {
  return {
    x: Math.round(clamp(pos.x, bounds.minX, bounds.maxX)),
    y: Math.round(clamp(pos.y, bounds.minY, bounds.maxY)),
  };
}

/** Default placement: bottom-right corner of the work area, with a small margin. */
export function defaultPosition(workArea: Rect, size: Size, margin = 24): Point {
  const bounds = computeBounds(workArea, size);
  return clampPosition({ x: bounds.maxX - margin, y: bounds.maxY }, bounds);
}

function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Picks the work area a window belongs to: the one it overlaps most, or null
 * if it is completely off every display (e.g. a monitor was unplugged).
 */
export function findContainingArea(windowRect: Rect, workAreas: readonly Rect[]): Rect | null {
  let best: Rect | null = null;
  let bestArea = 0;
  for (const area of workAreas) {
    const o = overlapArea(windowRect, area);
    if (o > bestArea) {
      bestArea = o;
      best = area;
    }
  }
  return best;
}

export type Rng = () => number;

/**
 * Chooses a horizontal wander target. Returns null when the available space is
 * too narrow to make a meaningful walk.
 */
export function pickWanderTarget(currentX: number, bounds: Bounds, rng: Rng, minDistance = 80, maxDistance = 420): number | null {
  const span = bounds.maxX - bounds.minX;
  if (span < minDistance) return null;
  const distance = minDistance + rng() * (maxDistance - minDistance);
  const canLeft = currentX - bounds.minX >= minDistance;
  const canRight = bounds.maxX - currentX >= minDistance;
  if (!canLeft && !canRight) return null;
  let goLeft: boolean;
  if (canLeft && canRight) goLeft = rng() < 0.5;
  else goLeft = canLeft;
  const target = goLeft ? currentX - distance : currentX + distance;
  return Math.round(clamp(target, bounds.minX, bounds.maxX));
}

/** Advances x toward target at speed px/s over dtMs. */
export function stepToward(x: number, target: number, speedPxPerSec: number, dtMs: number): { x: number; arrived: boolean } {
  const maxStep = (speedPxPerSec * Math.max(0, dtMs)) / 1000;
  const delta = target - x;
  if (Math.abs(delta) <= maxStep) return { x: target, arrived: true };
  return { x: x + Math.sign(delta) * maxStep, arrived: false };
}

/** Uniform random integer in [min, max]. */
export function randomBetween(rng: Rng, min: number, max: number): number {
  return Math.round(min + rng() * (max - min));
}
