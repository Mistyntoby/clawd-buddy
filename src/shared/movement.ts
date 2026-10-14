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

/**
 * Window-position bounds that keep an inner rectangle (Clawd's body, given
 * relative to the window) fully inside a work area. The transparent parts of
 * the window may hang off the screen edge.
 */
export function boundsForBody(area: Rect, body: Rect): Bounds {
  const minX = area.x - body.x;
  const minY = area.y - body.y;
  const maxX = Math.max(minX, area.x + area.width - body.x - body.width);
  const maxY = Math.max(minY, area.y + area.height - body.y - body.height);
  return { minX, maxX, minY, maxY };
}

/** Position after a drop: exactly the release position, moved only as far as needed to keep the body on a display. */
export function dropPosition(release: Point, body: Rect, areas: readonly Rect[]): Point {
  const bodyRect = { x: release.x + body.x, y: release.y + body.y, width: body.width, height: body.height };
  const area = findContainingArea(bodyRect, areas) ?? nearestArea(bodyRect, areas);
  if (!area) return { x: Math.round(release.x), y: Math.round(release.y) };
  return clampPosition(release, boundsForBody(area, body));
}

function nearestArea(r: Rect, areas: readonly Rect[]): Rect | null {
  let best: Rect | null = null;
  let bestDist = Infinity;
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  for (const a of areas) {
    const dx = Math.max(a.x - cx, 0, cx - (a.x + a.width));
    const dy = Math.max(a.y - cy, 0, cy - (a.y + a.height));
    const d = dx * dx + dy * dy;
    if (d < bestDist) {
      bestDist = d;
      best = a;
    }
  }
  return best;
}

export interface WalkState {
  x: number;
  /** Current speed, px/s (always >= 0; direction comes from the target). */
  v: number;
}

/**
 * One step of a walk with smooth acceleration and braking: speed ramps up to
 * `maxSpeed` at `accel` px/s², and ramps down early enough to stop exactly on
 * the target (v ≤ √(2·accel·remaining)).
 */
export function stepWalk(state: WalkState, target: number, maxSpeed: number, accel: number, dtMs: number): WalkState & { arrived: boolean } {
  const dt = Math.max(0, dtMs) / 1000;
  const remaining = Math.abs(target - state.x);
  if (remaining < 0.5) return { x: target, v: 0, arrived: true };
  const brake = Math.sqrt(2 * accel * remaining);
  const v = Math.min(maxSpeed, brake, state.v + accel * dt);
  const step = Math.max(v * dt, Math.min(remaining, 0.5));
  if (step >= remaining) return { x: target, v: 0, arrived: true };
  return { x: state.x + Math.sign(target - state.x) * step, v, arrived: false };
}
