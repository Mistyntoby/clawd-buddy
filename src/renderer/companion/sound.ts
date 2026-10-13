/**
 * Tiny synthesized sound effects (no audio files to license). Kept quiet on purpose.
 */
export type SoundName = "pop" | "chime" | "blip" | "error";

let ctx: AudioContext | null = null;

function tone(start: number, freqFrom: number, freqTo: number, duration: number, type: OscillatorType, volume: number): void {
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freqFrom, start);
  osc.frequency.exponentialRampToValueAtTime(freqTo, start + duration);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start(start);
  osc.stop(start + duration + 0.02);
}

export function playSound(name: SoundName): void {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    const t = ctx.currentTime;
    switch (name) {
      case "pop":
        tone(t, 380, 760, 0.09, "sine", 0.08);
        break;
      case "blip":
        tone(t, 620, 660, 0.05, "square", 0.025);
        tone(t + 0.06, 700, 740, 0.05, "square", 0.02);
        break;
      case "chime":
        tone(t, 660, 660, 0.15, "triangle", 0.07);
        tone(t + 0.12, 990, 990, 0.22, "triangle", 0.06);
        break;
      case "error":
        tone(t, 300, 180, 0.18, "sawtooth", 0.03);
        break;
    }
  } catch {
    /* audio is optional */
  }
}
