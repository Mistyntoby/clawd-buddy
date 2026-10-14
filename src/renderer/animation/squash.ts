/**
 * Squash-and-stretch for the sprite, applied as a CSS scale inside the
 * transparent window. It never moves the window itself.
 *
 * Each axis is a damped spring pulled toward a rest scale (1 normally, a
 * slightly stretched "carried" pose while held). `kick` snaps the scale to a
 * squashed value; the spring then rebounds past rest once or twice with
 * diminishing amplitude and settles.
 */
export interface SpringConfig {
  /** Spring stiffness, 1/s². */
  stiffness: number;
  /** Damping ratio: < 1 overshoots (bouncy), 1 = no overshoot. */
  damping: number;
}

export interface Scale2 {
  scaleX: number;
  scaleY: number;
}

class Axis {
  value = 1;
  velocity = 0;
  rest = 1;

  step(dt: number, k: number, c: number): void {
    const accel = -k * (this.value - this.rest) - c * this.velocity;
    this.velocity += accel * dt;
    this.value += this.velocity * dt;
  }

  get settled(): boolean {
    return Math.abs(this.value - this.rest) < 0.0015 && Math.abs(this.velocity) < 0.01;
  }
}

export class Squash {
  private readonly x = new Axis();
  private readonly y = new Axis();

  constructor(private readonly config: SpringConfig) {}

  /** Snap to a squashed/stretched scale; the spring carries it back to rest. */
  kick(to: Scale2): void {
    this.x.value = to.scaleX;
    this.y.value = to.scaleY;
    this.x.velocity = 0;
    this.y.velocity = 0;
  }

  /** Changes the pose the spring settles into (e.g. the carried stretch while held). */
  setRest(rest: Scale2): void {
    this.x.rest = rest.scaleX;
    this.y.rest = rest.scaleY;
  }

  /** Immediately at rest, no motion (used for reduced motion). */
  reset(): void {
    for (const a of [this.x, this.y]) {
      a.rest = 1;
      a.value = 1;
      a.velocity = 0;
    }
  }

  /** Advances the simulation. Large gaps (a hidden window) are split into small fixed steps. */
  update(dtMs: number): Scale2 {
    const k = this.config.stiffness;
    const c = 2 * this.config.damping * Math.sqrt(k);
    let remaining = Math.min(Math.max(0, dtMs), 250) / 1000;
    while (remaining > 0) {
      const dt = Math.min(remaining, 1 / 240);
      this.x.step(dt, k, c);
      this.y.step(dt, k, c);
      remaining -= dt;
    }
    if (this.settled) {
      this.x.value = this.x.rest;
      this.y.value = this.y.rest;
    }
    return { scaleX: this.x.value, scaleY: this.y.value };
  }

  get settled(): boolean {
    return this.x.settled && this.y.settled;
  }

  get current(): Scale2 {
    return { scaleX: this.x.value, scaleY: this.y.value };
  }
}
