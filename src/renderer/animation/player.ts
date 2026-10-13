import { resolveFallback } from "../../shared/sprite-manifest";
import type { AnimationName, Facing, ResolvedAnimation, SpritePackInfo } from "../../shared/types";

interface LoadedAnimation {
  def: ResolvedAnimation;
  images: HTMLImageElement[];
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image failed"));
    img.src = url;
  });
}

/**
 * Plays sprite animations on a canvas with exactly one frame timer at a time.
 * Missing animations resolve to fallbacks (ultimately idle); if nothing at all
 * is available, `onEmpty` lets the page show a CSS fallback shape.
 */
export class SpritePlayer {
  private readonly ctx: CanvasRenderingContext2D;
  private loaded = new Map<AnimationName, LoadedAnimation>();
  private pack: SpritePackInfo | null = null;
  private current: AnimationName | null = null;
  private frame = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private scale = 3;
  private facing: Facing = "right";
  private generation = 0;
  status = "not loaded";

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onEmpty: (empty: boolean) => void,
  ) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D not available");
    this.ctx = ctx;
  }

  /** Loads all images of a pack. Animations whose images fail are treated as missing. */
  async setPack(pack: SpritePackInfo): Promise<void> {
    const gen = ++this.generation;
    this.stop();
    this.pack = pack;
    const loaded = new Map<AnimationName, LoadedAnimation>();
    const failures: string[] = [];
    await Promise.all(
      Object.entries(pack.animations).map(async ([name, def]) => {
        if (!def) return;
        try {
          const urls = def.frames ?? (def.sheet ? [def.sheet] : []);
          const images = await Promise.all(urls.map(loadImage));
          loaded.set(name as AnimationName, { def, images });
        } catch {
          failures.push(name);
        }
      }),
    );
    if (gen !== this.generation) return; // a newer pack replaced this one
    this.loaded = loaded;
    const empty = !loaded.has("idle");
    this.status = empty
      ? "no usable idle animation"
      : `${loaded.size} animations loaded${failures.length ? `, failed: ${failures.join(", ")}` : ""}`;
    this.onEmpty(empty);
    this.resize();
    const anim = this.current ?? "idle";
    this.current = null;
    this.play(anim);
  }

  get ready(): boolean {
    return this.loaded.has("idle");
  }

  setScale(scale: number): void {
    this.scale = scale;
    this.resize();
    this.draw();
  }

  setFacing(facing: Facing): void {
    this.facing = facing;
    this.canvas.style.transform = facing === "left" ? "scaleX(-1)" : "none";
  }

  get cssSize(): { width: number; height: number } {
    const w = (this.pack?.frameWidth ?? 32) * this.scale;
    const h = (this.pack?.frameHeight ?? 32) * this.scale;
    return { width: w, height: h };
  }

  private resize(): void {
    const { width, height } = this.cssSize;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.ctx.imageSmoothingEnabled = false;
  }

  play(name: AnimationName): void {
    const resolved = resolveFallback(name, new Set(this.loaded.keys()));
    this.setFacing(this.facing);
    if (resolved === this.current) return; // already playing; don't restart
    this.stop();
    this.current = resolved;
    this.frame = 0;
    if (!resolved) return;
    this.draw();
    this.schedule();
  }

  private schedule(): void {
    const anim = this.current ? this.loaded.get(this.current) : undefined;
    if (!anim || anim.def.frameCount <= 1) return;
    const delay = 1000 / anim.def.fps;
    this.timer = setTimeout(() => {
      this.timer = null;
      const last = anim.def.frameCount - 1;
      if (this.frame >= last && !anim.def.loop) return; // hold the final frame
      this.frame = this.frame >= last ? 0 : this.frame + 1;
      this.draw();
      this.schedule();
    }, delay);
  }

  private draw(): void {
    const anim = this.current ? this.loaded.get(this.current) : undefined;
    const { width, height } = this.canvas;
    this.ctx.clearRect(0, 0, width, height);
    if (!anim || !this.pack) return;
    this.ctx.imageSmoothingEnabled = false;
    const fw = this.pack.frameWidth;
    const fh = this.pack.frameHeight;
    if (anim.def.frames) {
      const img = anim.images[this.frame % anim.images.length];
      if (img) this.ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, 0, 0, width, height);
    } else {
      const sheet = anim.images[0];
      if (sheet) this.ctx.drawImage(sheet, this.frame * fw, 0, fw, fh, 0, 0, width, height);
    }
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
