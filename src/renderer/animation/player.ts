import type { CompanionLayout } from "../../shared/layout";
import { resolveFallback } from "../../shared/sprite-manifest";
import type { AnimationName, CompanionView, Facing, ResolvedSequence, SpritePackInfo } from "../../shared/types";

interface LoadedSequence {
  def: ResolvedSequence;
  images: HTMLImageElement[];
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    // Anonymous CORS keeps the canvas readable, so hit testing can check which pixels are opaque.
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image failed"));
    img.src = url;
  });
}

/** Frame to show `elapsedMs` into a sequence. Loops restart at loopStart; one-shots hold their last frame. */
export function frameAt(def: Pick<ResolvedSequence, "frameCount" | "fps" | "loop" | "loopStart">, elapsedMs: number): number {
  const n = Math.max(1, def.frameCount);
  const i = Math.floor((Math.max(0, elapsedMs) * def.fps) / 1000);
  if (i < n) return i;
  if (!def.loop) return n - 1;
  const start = def.loopStart > 0 && def.loopStart < n ? def.loopStart : 0;
  return start + ((i - start) % (n - start));
}

/**
 * Draws sprite animations on a canvas, driven by the shared
 * requestAnimationFrame loop. It holds no timers of its own; the page calls
 * `tick(now)` once per frame.
 *
 * Pixel art stays crisp: the canvas backing store is exactly
 * frame size × (integer device pixels per art pixel), drawn with smoothing off.
 * Missing animations resolve to fallbacks (ultimately idle); if nothing at all
 * is available, `onEmpty` lets the page show a CSS fallback shape.
 */
export class SpritePlayer {
  private readonly ctx: CanvasRenderingContext2D;
  private loaded = new Map<AnimationName, LoadedSequence[]>();
  private pack: SpritePackInfo | null = null;
  private current: { name: AnimationName | null; seq: LoadedSequence | null; viewSeq: number; started: number } = {
    name: null,
    seq: null,
    viewSeq: -1,
    started: 0,
  };
  private lastFrame = -1;
  private layout: CompanionLayout | null = null;
  private facing: Facing = "right";
  private generation = 0;
  private pendingView: CompanionView | null = null;
  status = "not loaded";

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onEmpty: (empty: boolean) => void,
  ) {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("Canvas 2D not available");
    this.ctx = ctx;
  }

  /** Loads all images of a pack. Sequences whose images fail are treated as missing. */
  async setPack(pack: SpritePackInfo): Promise<void> {
    const gen = ++this.generation;
    this.pack = pack;
    const loaded = new Map<AnimationName, LoadedSequence[]>();
    const failures: string[] = [];
    await Promise.all(
      Object.entries(pack.animations).map(async ([name, anim]) => {
        if (!anim) return;
        const seqs: LoadedSequence[] = [];
        for (const def of [anim, ...anim.variants]) {
          try {
            const urls = def.frames ?? (def.sheet ? [def.sheet] : []);
            seqs.push({ def, images: await Promise.all(urls.map(loadImage)) });
          } catch {
            failures.push(name);
          }
        }
        if (seqs.length > 0) loaded.set(name as AnimationName, seqs);
      }),
    );
    if (gen !== this.generation) return; // a newer pack replaced this one
    this.loaded = loaded;
    const empty = !loaded.has("idle");
    this.status = empty
      ? "no usable idle animation"
      : `${loaded.size} animations loaded${failures.length ? `, failed: ${[...new Set(failures)].join(", ")}` : ""}`;
    this.onEmpty(empty);
    this.resize();
    this.current = { name: null, seq: null, viewSeq: -1, started: 0 };
    if (this.pendingView) this.play(this.pendingView, performance.now());
  }

  get ready(): boolean {
    return this.loaded.has("idle");
  }

  /** Which animation is actually showing (after fallbacks). */
  get playing(): AnimationName | null {
    return this.current.name;
  }

  setLayout(layout: CompanionLayout): void {
    this.layout = layout;
    this.resize();
    this.lastFrame = -1;
  }

  private resize(): void {
    if (!this.layout || !this.pack) return;
    const { character, devicePixelsPerArtPixel } = this.layout;
    this.canvas.style.width = `${character.width}px`;
    this.canvas.style.height = `${character.height}px`;
    this.canvas.width = this.pack.frameWidth * devicePixelsPerArtPixel;
    this.canvas.height = this.pack.frameHeight * devicePixelsPerArtPixel;
    this.ctx.imageSmoothingEnabled = false;
    this.lastFrame = -1;
  }

  /** Starts the view's animation. A new `seq` restarts it even if the name is unchanged (e.g. a second poke). */
  play(view: CompanionView, now: number): void {
    this.pendingView = view;
    this.facing = view.facing;
    this.canvas.style.transform = view.facing === "left" ? "scaleX(-1)" : "";
    const resolved = resolveFallback(view.animation, new Set(this.loaded.keys()));
    const seqs = resolved ? this.loaded.get(resolved) : undefined;
    const seq = seqs ? (seqs[Math.min(view.variant, seqs.length - 1)] ?? seqs[0] ?? null) : null;
    const same = resolved === this.current.name && seq === this.current.seq;
    // Same state re-sent (e.g. only the facing changed): keep the animation running smoothly.
    if (same && view.seq === this.current.viewSeq) return;
    // A new state instance showing the same looping animation (e.g. a fallback): don't restart mid-cycle.
    if (same && seq?.def.loop) {
      this.current.viewSeq = view.seq;
      return;
    }
    this.current = { name: resolved, seq, viewSeq: view.seq, started: now };
    this.lastFrame = -1;
  }

  /** Draws the frame for `now`; cheap when the frame hasn't changed. */
  tick(now: number): void {
    const seq = this.current.seq;
    if (!seq || !this.pack) {
      if (this.lastFrame !== -2) {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.lastFrame = -2;
      }
      return;
    }
    const frame = frameAt(seq.def, now - this.current.started);
    if (frame === this.lastFrame) return;
    this.lastFrame = frame;
    this.draw(seq, frame);
  }

  private draw(seq: LoadedSequence, frame: number): void {
    const { width, height } = this.canvas;
    this.ctx.clearRect(0, 0, width, height);
    if (!this.pack) return;
    this.ctx.imageSmoothingEnabled = false;
    const fw = this.pack.frameWidth;
    const fh = this.pack.frameHeight;
    if (seq.def.frames) {
      const img = seq.images[frame % seq.images.length];
      if (img) this.ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, 0, 0, width, height);
    } else {
      const sheet = seq.images[0];
      if (sheet) this.ctx.drawImage(sheet, frame * fw, 0, fw, fh, 0, 0, width, height);
    }
  }

  /**
   * True if the point (CSS px relative to the canvas, before any transform)
   * lands on a visible sprite pixel. Used so only Clawd's actual pixels, not
   * the transparent frame, capture the mouse.
   */
  hitTest(x: number, y: number): boolean {
    const cssW = this.canvas.clientWidth;
    const cssH = this.canvas.clientHeight;
    if (cssW <= 0 || cssH <= 0 || x < 0 || y < 0 || x >= cssW || y >= cssH) return false;
    const fx = this.facing === "left" ? cssW - 1 - x : x;
    const px = Math.floor((fx / cssW) * this.canvas.width);
    const py = Math.floor((y / cssH) * this.canvas.height);
    // Check a small neighborhood so thin legs and gaps between them are still easy to grab.
    const r = Math.max(1, Math.round(this.canvas.width / Math.max(1, this.pack?.frameWidth ?? 32)));
    const x0 = Math.max(0, px - r);
    const y0 = Math.max(0, py - r);
    const w = Math.min(this.canvas.width - x0, r * 2 + 1);
    const h = Math.min(this.canvas.height - y0, r * 2 + 1);
    if (w <= 0 || h <= 0) return false;
    let data: Uint8ClampedArray;
    try {
      data = this.ctx.getImageData(x0, y0, w, h).data;
    } catch {
      // Pixels unreadable (e.g. a tainted canvas): never leave Clawd untouchable; use his body box instead.
      return this.inBodyBox(fx, y, cssW, cssH);
    }
    for (let i = 3; i < data.length; i += 4) if ((data[i] ?? 0) > 24) return true;
    return false;
  }

  private inBodyBox(x: number, y: number, cssW: number, cssH: number): boolean {
    if (!this.pack) return true;
    const [bx, by, bw, bh] = this.pack.bodyBox;
    const sx = cssW / this.pack.frameWidth;
    const sy = cssH / this.pack.frameHeight;
    return x >= bx * sx && x <= (bx + bw) * sx && y >= by * sy && y <= (by + bh) * sy;
  }
}
