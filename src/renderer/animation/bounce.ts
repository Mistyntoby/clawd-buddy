/**
 * The little hop when Clawd is dropped: a vertical offset applied as a CSS
 * transform to the sprite (never to the window). He pops up, falls back
 * under gravity, and bounces a couple of times, each bounce lower, then rests
 * exactly on the spot where he was dropped. Every time he touches down,
 * `onImpact` fires (used for a squash).
 */
export interface BounceConfig {
  /** Upward speed at the start, px/s. */
  launchSpeed: number;
  /** px/s². */
  gravity: number;
  /** Fraction of speed kept after each touch-down (0–1). */
  restitution: number;
  /** Below this speed a touch-down ends the bounce, px/s. */
  restSpeed: number;
}

export class Bounce {
  /** Vertical offset in px; negative is up. Always ≤ 0. */
  private y = 0;
  private vy = 0;
  private active = false;

  constructor(
    private readonly config: BounceConfig,
    private readonly onImpact: (strength: number) => void = () => {},
  ) {}

  /** Starts a hop. `intensity` scales the launch speed (e.g. 0.6 calm … 1.3 lively). */
  start(intensity = 1): void {
    this.y = 0;
    this.vy = -this.config.launchSpeed * intensity;
    this.active = true;
  }

  stop(): void {
    this.y = 0;
    this.vy = 0;
    this.active = false;
  }

  get running(): boolean {
    return this.active;
  }

  /** Advances the simulation and returns the offset in px (≤ 0). */
  update(dtMs: number): number {
    if (!this.active) return 0;
    let remaining = Math.min(Math.max(0, dtMs), 100) / 1000;
    while (remaining > 0 && this.active) {
      const dt = Math.min(remaining, 1 / 480);
      remaining -= dt;
      this.vy += this.config.gravity * dt;
      this.y += this.vy * dt;
      if (this.y >= 0 && this.vy > 0) {
        // Touch-down.
        const impact = this.vy;
        this.y = 0;
        this.vy = -impact * this.config.restitution;
        this.onImpact(Math.min(1, impact / this.config.launchSpeed));
        if (-this.vy < this.config.restSpeed) this.stop();
      }
    }
    return this.y;
  }
}
