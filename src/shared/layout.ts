/**
 * Companion window geometry, shared by the main process (window size, keeping
 * Clawd on screen) and the companion renderer (where to draw). Both sides must
 * agree exactly, so it lives in one pure function.
 *
 * The character is drawn horizontally centered in a transparent window, with
 * room above it for the speech bubble and a strip below it for the inline chat
 * input. There is no label or other decoration.
 */
import { BUBBLE_AREA_HEIGHT, COMPANION_MIN_WIDTH, INPUT_AREA_HEIGHT } from "./constants";
import type { Rect, Size } from "./movement";

export interface LayoutInput {
  frameWidth: number;
  frameHeight: number;
  /** Standing body bounds in frame pixels [x, y, w, h]. */
  bodyBox: readonly [number, number, number, number];
  /** Requested integer sprite scale (art pixels → CSS pixels). */
  scale: number;
  /** Device pixels per CSS pixel of the display the window is on. */
  scaleFactor: number;
}

export interface CompanionLayout {
  window: Size;
  /** CSS pixels per art pixel. Chosen so each art pixel covers a whole number of device pixels (crisp, even pixels). */
  pixelScale: number;
  /** Device pixels per art pixel (an integer). */
  devicePixelsPerArtPixel: number;
  /** Where the sprite frame sits inside the window (CSS px). */
  character: Rect;
  /** Where Clawd's standing body sits inside the window (CSS px). */
  body: Rect;
  /** The inline chat input's slot, right under Clawd's feet (CSS px). */
  input: Rect;
}

export function companionLayout(args: LayoutInput): CompanionLayout {
  const sf = args.scaleFactor > 0 ? args.scaleFactor : 1;
  const device = Math.max(1, Math.round(args.scale * sf));
  const pixelScale = device / sf;
  const cw = Math.round(args.frameWidth * pixelScale);
  const ch = Math.round(args.frameHeight * pixelScale);
  const width = Math.max(COMPANION_MIN_WIDTH, cw + 40);
  const height = BUBBLE_AREA_HEIGHT + ch + INPUT_AREA_HEIGHT;
  const character = { x: Math.round((width - cw) / 2), y: BUBBLE_AREA_HEIGHT, width: cw, height: ch };
  const [bx, by, bw, bh] = args.bodyBox;
  const body = {
    x: character.x + Math.round(bx * pixelScale),
    y: character.y + Math.round(by * pixelScale),
    width: Math.round(bw * pixelScale),
    height: Math.round(bh * pixelScale),
  };
  const feet = body.y + body.height;
  const input = { x: 8, y: feet + 6, width: width - 16, height: INPUT_AREA_HEIGHT - 8 };
  return { window: { width, height }, pixelScale, devicePixelsPerArtPixel: device, character, body, input };
}
