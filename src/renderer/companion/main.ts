import type { CompanionConfig } from "../../shared/api";
import { MOTION } from "../../shared/constants";
import type { CompanionLayout } from "../../shared/layout";
import type { AnimationName, CompanionView, SpeechPayload, SpritePackInfo } from "../../shared/types";
import { SpritePlayer } from "../animation/player";
import { Bounce } from "../animation/bounce";
import { Squash } from "../animation/squash";
import { $, api } from "../common/dom";
import { playSound } from "./sound";

const canvas = $("#sprite") as HTMLCanvasElement;
const character = $("#character");
const bubble = $("#bubble");
const bubbleText = $("#bubble-text");
const bubbleSource = $("#bubble-source");
const fallbackShape = $("#fallback-shape");
const inputbar = $("#inputbar") as HTMLFormElement;
const say = $("#say") as HTMLInputElement;

const clawd = api();
let config: CompanionConfig = { scale: 3, chatBoxColor: "#4a5345", reducedMotion: false, animationIntensity: "normal", soundEnabled: true, name: "Clawd" };

/** Colors the chat box and speech bubble borders. Only well-formed #rrggbb values are applied. */
function applyChatBoxColor(color: string): void {
  if (/^#[0-9a-fA-F]{6}$/.test(color)) document.documentElement.style.setProperty("--term-edge", color);
}
let pack: SpritePackInfo | null = null;
let layout: CompanionLayout | null = null;
let view: CompanionView | null = null;

const player = new SpritePlayer(canvas, (empty) => {
  fallbackShape.hidden = !empty;
  updateDiagnostics();
});
const squash = new Squash({ stiffness: MOTION.squash.stiffness, damping: MOTION.squash.damping });
/** How much the current animation intensity scales decorative motion. */
const intensityScale = (): number => MOTION.intensity[config.animationIntensity]?.squash ?? 1;
// Each touch-down of the drop bounce squashes him a little, harder for the bigger bounces.
const bounce = new Bounce(MOTION.dropBounce, (strength) => {
  const k = MOTION.squash.land;
  const s = Math.max(0.25, strength) * 0.8 * intensityScale();
  squash.kick({ scaleX: 1 + (k.scaleX - 1) * s, scaleY: 1 + (k.scaleY - 1) * s });
});

const osReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const reducedMotion = (): boolean => config.reducedMotion || osReducedMotion.matches;

function updateDiagnostics(): void {
  document.body.dataset.spriteReady = String(player.ready);
  document.body.dataset.spriteStatus = player.status;
  document.body.dataset.pack = pack?.id ?? "";
}

// ---- layout ----------------------------------------------------------------------------

function applyLayout(next: CompanionLayout): void {
  layout = next;
  const c = next.character;
  character.style.left = `${c.x}px`;
  character.style.top = `${c.y}px`;
  character.style.width = `${c.width}px`;
  character.style.height = `${c.height}px`;
  player.setLayout(next);
  placeInput();
  placeBubble();
}

/**
 * Keeps the bubble inside the part of the window that is actually on screen
 * (the transparent margins of the window may hang off a screen edge) and
 * points its tail at Clawd.
 */
/** The part of the window that is on screen (window coordinates). */
function visibleArea(): { left: number; right: number; top: number; bottom: number } {
  const W = window.innerWidth;
  const s = window.screen as Screen & { availLeft?: number; availTop?: number };
  const availLeft = s.availLeft ?? 0;
  const availTop = s.availTop ?? 0;
  return {
    left: Math.max(0, availLeft - window.screenX),
    right: Math.min(W, availLeft + s.availWidth - window.screenX),
    top: Math.max(0, availTop - window.screenY),
    bottom: Math.min(window.innerHeight, availTop + s.availHeight - window.screenY),
  };
}

/** True when the inline input sits above Clawd (no room under him, e.g. he stands on the taskbar). */
let inputAbove = false;

/** Puts the inline input right under Clawd's feet, or just above his head if that would be off screen. */
function placeInput(): void {
  if (!layout) return;
  const vis = visibleArea();
  const r = layout.input;
  inputAbove = r.y + r.height > vis.bottom - 2;
  const top = inputAbove ? Math.max(vis.top + 4, layout.body.y - r.height - 10) : r.y;
  inputbar.style.left = `${Math.max(r.x, vis.left + 6)}px`;
  inputbar.style.width = `${Math.min(r.width, vis.right - vis.left - 12)}px`;
  inputbar.style.top = `${top}px`;
  inputbar.style.height = `${r.height}px`;
}

function placeBubble(): void {
  if (!layout) return;
  const W = window.innerWidth;
  const vis = visibleArea();
  const c = layout.character;
  // Above Clawd's frame; above the input instead when the input is shown over his head.
  const anchorTop = !inputbar.hidden && inputAbove ? inputbar.offsetTop - 8 : c.y + 4;
  bubble.style.left = `${vis.left + 8}px`;
  bubble.style.right = `${Math.max(0, W - vis.right) + 8}px`;
  bubble.style.bottom = `${window.innerHeight - anchorTop + 12}px`;
  const chrome = 6 + 6 + 6 + (bubbleSource.textContent ? 18 : 0); // padding, border, source line
  bubbleText.style.maxHeight = `${Math.max(40, anchorTop - 12 - vis.top - 8 - chrome)}px`;
  // Point the tail at the middle of Clawd's body.
  const r = bubble.getBoundingClientRect();
  const bodyCenter = layout.body.x + layout.body.width / 2;
  const tail = Math.min(Math.max(bodyCenter - r.left, 18), Math.max(18, r.width - 18));
  bubble.style.setProperty("--tail-x", `${Math.round(tail)}px`);
}

async function applyPack(next: SpritePackInfo): Promise<void> {
  pack = next;
  await player.setPack(next);
  if (layout) player.setLayout(layout);
  updateDiagnostics();
}

// ---- animation & squash ------------------------------------------------------------------

/** Squash-and-stretch cues for state changes. Sprite frames do the main work; this adds weight. */
function motionFor(prev: AnimationName | null, next: AnimationName): void {
  if (reducedMotion()) {
    squash.reset();
    bounce.stop();
    return;
  }
  const hasFrames = (name: AnimationName) => !!pack?.animations[name];
  const k = MOTION.squash;
  // When the pack has its own frames for a move, add only a light touch on top of them.
  const soften = (s: { scaleX: number; scaleY: number }, name: AnimationName) =>
    hasFrames(name) ? { scaleX: 1 + (s.scaleX - 1) * 0.5, scaleY: 1 + (s.scaleY - 1) * 0.5 } : s;
  switch (next) {
    case "pickup":
      bounce.stop();
      squash.kick(soften(k.pickup, "pickup"));
      squash.setRest(hasFrames("drag") ? { scaleX: 1, scaleY: 1 } : k.carry);
      break;
    case "drag":
      squash.setRest(hasFrames("drag") ? { scaleX: 1, scaleY: 1 } : k.carry);
      break;
    case "land":
      // Impact squash, then a little hop with diminishing bounces (all inside the window).
      squash.setRest({ scaleX: 1, scaleY: 1 });
      squash.kick(soften(k.land, "land"));
      bounce.start(Math.min(1.3, Math.max(0.6, intensityScale())));
      break;
    case "happy":
      squash.setRest({ scaleX: 1, scaleY: 1 });
      if (prev !== "happy") squash.kick(k.poke);
      break;
    default:
      squash.setRest({ scaleX: 1, scaleY: 1 });
  }
}

function applyView(next: CompanionView): void {
  const prev = view?.animation ?? null;
  const isNewState = !view || view.seq !== next.seq;
  view = next;
  player.play(next, performance.now());
  document.body.dataset.state = next.animation;
  document.body.dataset.playing = player.playing ?? "";
  if (isNewState) motionFor(prev, next.animation);
  // After a drop the window may be somewhere new: re-check whether the input fits under Clawd.
  if (!inputbar.hidden && (next.animation === "land" || next.animation === "idle")) {
    placeInput();
    placeBubble();
  }
}

let lastFrameTime = performance.now();
function frame(now: number): void {
  const dt = now - lastFrameTime;
  lastFrameTime = now;
  player.tick(now);
  const s = squash.update(dt);
  const y = bounce.update(dt);
  const parts: string[] = [];
  if (y !== 0) parts.push(`translateY(${y.toFixed(2)}px)`);
  if (s.scaleX !== 1 || s.scaleY !== 1) parts.push(`scale(${s.scaleX.toFixed(4)}, ${s.scaleY.toFixed(4)})`);
  character.style.transform = parts.join(" ");
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---- speech -----------------------------------------------------------------------------

let revealTimer: ReturnType<typeof setInterval> | null = null;

function applySpeech(speech: SpeechPayload | null): void {
  if (revealTimer) clearInterval(revealTimer);
  revealTimer = null;
  if (!speech) {
    bubble.hidden = true;
    bubble.classList.remove("streaming");
    return;
  }
  const wasVisible = !bubble.hidden;
  bubbleSource.textContent = speech.source === "claude" ? "[claude]" : speech.source === "offline" ? "[offline · scripted]" : "";
  bubble.classList.toggle("streaming", !!speech.streaming);
  bubble.classList.toggle("system", speech.source === "system");
  bubble.hidden = false;
  if (speech.streaming || reducedMotion() || (wasVisible && bubbleText.textContent && speech.text.startsWith(bubbleText.textContent))) {
    // Streaming text arrives piece by piece already; just show it and follow the end.
    bubbleText.textContent = speech.text;
    placeBubble();
    bubbleText.scrollTop = bubbleText.scrollHeight;
    return;
  }
  // A finished line types out like a terminal (about half a second, however long it is).
  const full = speech.text;
  const step = Math.max(1, Math.ceil(full.length / 30));
  let i = 0;
  bubbleText.textContent = "";
  bubble.classList.add("streaming");
  placeBubble();
  revealTimer = setInterval(() => {
    i = Math.min(full.length, i + step);
    bubbleText.textContent = full.slice(0, i);
    if (i === step) placeBubble();
    if (i >= full.length) {
      if (revealTimer) clearInterval(revealTimer);
      revealTimer = null;
      bubble.classList.remove("streaming");
      placeBubble();
    }
  }, 16);
}

// ---- inline chat input ----------------------------------------------------------------------

let chatBusy = false;

function openInput(): void {
  if (inputbar.hidden) clawd.companion.inputOpen(true);
  inputbar.hidden = false;
  placeInput();
  placeBubble();
  say.focus();
}

function closeInput(): void {
  if (!inputbar.hidden) clawd.companion.inputOpen(false);
  inputbar.hidden = true;
  say.blur();
  placeBubble();
}

inputbar.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = say.value.trim();
  if (!text || chatBusy) return;
  say.value = "";
  void clawd.companion.send(text);
});
say.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.stopPropagation();
    if (chatBusy) clawd.companion.cancel();
    else closeInput();
  }
});
say.addEventListener("focus", () => inputbar.classList.add("focused"));
say.addEventListener("blur", () => {
  inputbar.classList.remove("focused");
  // Clicking somewhere else closes an empty input; one with text stays until Esc.
  setTimeout(() => {
    if (!say.value.trim() && document.activeElement !== say && !inputbar.hidden && !chatBusy) closeInput();
  }, 150);
});
$("#expand").addEventListener("click", () => {
  closeInput();
  clawd.companion.command("open-chat-window");
});

function setChatState(state: "ready" | "thinking" | "typing"): void {
  chatBusy = state !== "ready";
  inputbar.classList.toggle("busy", chatBusy);
  say.placeholder = state === "thinking" ? "THINKING... (esc to stop)" : state === "typing" ? "TYPING... (esc to stop)" : "say something · /help";
}

function overInput(x: number, y: number): boolean {
  if (inputbar.hidden) return false;
  const r = inputbar.getBoundingClientRect();
  return x >= r.left - 3 && x <= r.right + 3 && y >= r.top - 3 && y <= r.bottom + 3;
}

// ---- pointer handling: click-through except over Clawd's pixels and the bubble -------------

let interactive = false;
function setInteractive(on: boolean): void {
  if (on === interactive) return;
  interactive = on;
  clawd.companion.setInteractive(on);
}

function overCharacter(x: number, y: number): boolean {
  if (!layout || character.hidden) return false;
  const c = layout.character;
  if (!fallbackShape.hidden) return x >= c.x && x <= c.x + c.width && y >= c.y && y <= c.y + c.height;
  return player.hitTest(x - c.x, y - c.y);
}

function overBubble(x: number, y: number): boolean {
  if (bubble.hidden) return false;
  const r = bubble.getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

// Rubbing the pointer back and forth over Clawd (without pressing) pets him.
const rub = { lastX: 0, dir: 0, turns: [] as number[] };
function trackRub(e: MouseEvent): void {
  const dx = e.clientX - rub.lastX;
  rub.lastX = e.clientX;
  if (Math.abs(dx) < 3) return;
  const dir = Math.sign(dx);
  if (dir !== rub.dir) {
    rub.dir = dir;
    const now = performance.now();
    rub.turns = rub.turns.filter((t) => now - t < 1200);
    rub.turns.push(now);
    if (rub.turns.length >= 5) {
      rub.turns = [];
      clawd.companion.command("pet"); // the main process applies a cooldown
    }
  }
}

window.addEventListener("mousemove", (e) => {
  if (press) return;
  const onClawd = overCharacter(e.clientX, e.clientY);
  setInteractive(onClawd || overBubble(e.clientX, e.clientY) || overInput(e.clientX, e.clientY));
  if (onClawd) trackRub(e);
});
document.documentElement.addEventListener("mouseleave", () => {
  if (!press) setInteractive(false);
});

// ---- press, drag, release, click ---------------------------------------------------------------
//
// Interaction state machine (renderer side):  idle → pressed → dragging → (release) → idle
// The renderer never computes window positions. It only reports press / drag start / pointer
// moved / release; the main process moves the window to the OS cursor (one position authority).

let press: { x: number; y: number; id: number } | null = null;
let dragging = false;

/** Ends the current press, whatever state it is in. Safe to call repeatedly. */
function endPress(isClick: boolean): void {
  if (!press) return;
  const id = press.id;
  const wasDragging = dragging;
  press = null;
  dragging = false;
  character.classList.remove("dragging");
  try {
    if (character.hasPointerCapture(id)) character.releasePointerCapture(id);
  } catch {
    /* the pointer may already be gone */
  }
  clawd.companion.release();
  // Dropping Clawd is never also a click.
  if (isClick && !wasDragging) clawd.companion.command("open-chat");
}

character.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  // A fresh press always wins over a stale one (e.g. a release we never heard about).
  if (press) endPress(false);
  if (!overCharacter(e.clientX, e.clientY)) {
    // A press on the transparent part of the frame: let it fall through next time.
    setInteractive(false);
    return;
  }
  press = { x: e.screenX, y: e.screenY, id: e.pointerId };
  dragging = false;
  try {
    character.setPointerCapture(e.pointerId);
  } catch {
    /* capture is a nicety; window-level listeners below still see the release */
  }
  clawd.companion.grab();
});

function onPointerMove(e: PointerEvent): void {
  if (!press || e.pointerId !== press.id) return;
  if (e.buttons === 0) {
    // The button came up somewhere we didn't hear about: that was the drop.
    endPress(false);
    return;
  }
  if (dragging) {
    clawd.companion.dragMove();
    return;
  }
  // Only the distance matters here; the window position always comes from the OS cursor in the main process.
  if (Math.hypot(e.screenX - press.x, e.screenY - press.y) > MOTION.drag.thresholdPx) {
    dragging = true;
    character.classList.add("dragging");
    clawd.companion.dragStart();
  }
}

// Listen on the window (not just the character) so moves and releases are seen even if
// pointer capture is lost while the window moves under the pointer.
window.addEventListener("pointermove", onPointerMove);
window.addEventListener("pointerup", (e) => {
  if (press && e.pointerId === press.id) endPress(true);
});
window.addEventListener("pointercancel", () => endPress(false));
// Losing capture is not a release: keep the drag alive; pointerup/buttons===0/blur/watchdog end it.
window.addEventListener("blur", () => endPress(false));
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && press) endPress(false);
});

character.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  if (overCharacter(e.clientX, e.clientY)) clawd.companion.contextMenu();
});
bubble.addEventListener("click", () => clawd.companion.dismissSpeech());
bubble.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  clawd.companion.contextMenu();
});

// Keyboard access when the window happens to have focus.
window.addEventListener("keydown", (e) => {
  if (document.activeElement === say) return;
  if (e.key === "Enter") clawd.companion.command("open-chat");
  if (e.key === "Escape") clawd.companion.dismissSpeech();
  if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) clawd.companion.contextMenu();
});

// ---- wiring --------------------------------------------------------------------------------

clawd.companion.onView(applyView);
clawd.companion.onSpeech(applySpeech);
clawd.companion.onInput((action) => {
  if (action === "open" || (action === "toggle" && inputbar.hidden)) openInput();
  else if (action === "close" || !say.value.trim()) closeInput();
  else say.focus();
});
clawd.companion.onChatState(setChatState);
clawd.companion.onSound((s) => {
  if (config.soundEnabled) playSound(s);
});
clawd.companion.onPack((p) => void applyPack(p));
clawd.companion.onLayout(applyLayout);
clawd.companion.onConfig((c) => {
  config = c;
  applyChatBoxColor(c.chatBoxColor);
  character.setAttribute("aria-label", c.name);
  if (reducedMotion()) {
    squash.reset();
    bounce.stop();
  }
});
osReducedMotion.addEventListener("change", () => {
  if (reducedMotion()) {
    squash.reset();
    bounce.stop();
  }
});
window.addEventListener("resize", () => placeBubble());

void (async () => {
  try {
    const init = await clawd.companion.ready();
    config = init.config;
    applyChatBoxColor(init.config.chatBoxColor);
    character.setAttribute("aria-label", init.config.name);
    applyLayout(init.layout);
    await applyPack(init.pack);
    applyView(init.view);
  } catch {
    // Even if initialization fails, show the fallback shape rather than nothing.
    fallbackShape.hidden = false;
    document.body.dataset.spriteStatus = "init failed";
  }
})();
