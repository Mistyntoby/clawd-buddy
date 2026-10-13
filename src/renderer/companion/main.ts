import type { CompanionConfig } from "../../shared/api";
import { LABEL_AREA_HEIGHT } from "../../shared/constants";
import type { CompanionView, SpeechPayload, SpritePackInfo } from "../../shared/types";
import { SpritePlayer } from "../animation/player";
import { $, api } from "../common/dom";
import { playSound } from "./sound";

const canvas = $("#sprite") as HTMLCanvasElement;
const character = $("#character");
const bubble = $("#bubble");
const bubbleText = $("#bubble-text");
const bubbleSource = $("#bubble-source");
const placeholderTag = $("#placeholder-tag");
const fallbackShape = $("#fallback-shape");

const clawd = api();
let config: CompanionConfig = { scale: 3, showPlaceholderLabel: true, soundEnabled: true, name: "Clawd" };
let pack: SpritePackInfo | null = null;

const player = new SpritePlayer(canvas, (empty) => {
  fallbackShape.hidden = !empty;
  updateDiagnostics();
});

function updateDiagnostics(): void {
  document.body.dataset.spriteReady = String(player.ready);
  document.body.dataset.spriteStatus = player.status;
  document.body.dataset.pack = pack?.id ?? "";
}

function layout(): void {
  player.setScale(config.scale);
  const { width, height } = player.cssSize;
  character.style.width = `${width}px`;
  character.style.height = `${height}px`;
  const bubbleBottom = height + LABEL_AREA_HEIGHT + 12;
  bubble.style.bottom = `${bubbleBottom}px`;
  // Never let the bubble extend past the top of the window (and therefore the screen):
  // clamp the number of text lines to the space available above the character.
  const available = window.innerHeight - bubbleBottom - 6;
  const lineHeight = parseFloat(getComputedStyle(bubbleText).lineHeight) || 19.6;
  const chrome = 9 + 8 + 4 + 18; // padding, border, source line
  bubbleText.style.webkitLineClamp = String(Math.max(2, Math.floor((available - chrome) / lineHeight)));
  placeholderTag.hidden = !(pack?.placeholder && config.showPlaceholderLabel);
  character.title = pack?.placeholder ? `${config.name} (placeholder artwork)` : config.name;
}

async function applyPack(next: SpritePackInfo): Promise<void> {
  pack = next;
  layout();
  await player.setPack(next);
  layout();
  updateDiagnostics();
}

function applyView(view: CompanionView): void {
  player.setFacing(view.facing);
  player.play(view.animation);
  document.body.dataset.state = view.animation;
}

function applySpeech(speech: SpeechPayload | null): void {
  if (!speech) {
    bubble.hidden = true;
    bubble.classList.remove("streaming");
    return;
  }
  bubbleText.textContent = speech.text;
  bubbleSource.textContent = speech.source === "claude" ? "via Claude" : speech.source === "offline" ? "offline mode" : "";
  bubble.classList.toggle("streaming", !!speech.streaming);
  bubble.hidden = false;
}

// ---- pointer handling: click-through except over the character/bubble ----------

let interactive = false;
function setInteractive(on: boolean): void {
  if (on === interactive) return;
  interactive = on;
  clawd.companion.setInteractive(on);
}

function isOverInteractive(x: number, y: number): boolean {
  const hit = (el: HTMLElement) => {
    if (el.hidden) return false;
    const r = el.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  };
  return hit(character) || hit(bubble);
}

window.addEventListener("mousemove", (e) => {
  if (!dragging) setInteractive(isOverInteractive(e.clientX, e.clientY));
});
document.documentElement.addEventListener("mouseleave", () => {
  if (!dragging) setInteractive(false);
});

// ---- dragging, clicking, double-clicking ---------------------------------------------

let pointerDown: { x: number; y: number; id: number } | null = null;
let dragging = false;
let clickTimer: ReturnType<typeof setTimeout> | null = null;
const DRAG_THRESHOLD = 4;

character.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  pointerDown = { x: e.screenX, y: e.screenY, id: e.pointerId };
  character.setPointerCapture(e.pointerId);
});

character.addEventListener("pointermove", (e) => {
  if (!pointerDown) return;
  if (!dragging && Math.hypot(e.screenX - pointerDown.x, e.screenY - pointerDown.y) > DRAG_THRESHOLD) {
    dragging = true;
    character.classList.add("dragging");
    clawd.companion.dragStart(pointerDown.x, pointerDown.y);
  }
  if (dragging) clawd.companion.dragMove(e.screenX, e.screenY);
});

function endPointer(e: PointerEvent): void {
  if (!pointerDown) return;
  if (character.hasPointerCapture(e.pointerId)) character.releasePointerCapture(e.pointerId);
  const wasDragging = dragging;
  pointerDown = null;
  dragging = false;
  character.classList.remove("dragging");
  if (wasDragging) {
    clawd.companion.dragEnd();
    return;
  }
  // Single click = poke (delayed so a double-click can cancel it).
  if (e.type === "pointerup") {
    if (clickTimer) {
      clearTimeout(clickTimer);
      clickTimer = null;
      clawd.companion.command("open-chat");
    } else {
      clickTimer = setTimeout(() => {
        clickTimer = null;
        clawd.companion.command("poke");
      }, 260);
    }
  }
}
character.addEventListener("pointerup", endPointer);
character.addEventListener("pointercancel", endPointer);

character.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  clawd.companion.contextMenu();
});
bubble.addEventListener("click", () => clawd.companion.dismissSpeech());
bubble.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  clawd.companion.contextMenu();
});

// Keyboard access when the window happens to have focus.
window.addEventListener("keydown", (e) => {
  if (e.key === "Enter") clawd.companion.command("open-chat");
  if (e.key === "Escape") clawd.companion.dismissSpeech();
  if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) clawd.companion.contextMenu();
});

// ---- wiring --------------------------------------------------------------------------------

clawd.companion.onView(applyView);
clawd.companion.onSpeech(applySpeech);
clawd.companion.onSound((s) => {
  if (config.soundEnabled) playSound(s);
});
clawd.companion.onPack((p) => void applyPack(p));
clawd.companion.onConfig((c) => {
  config = c;
  layout();
});
window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener("change", () => layout());
window.addEventListener("resize", () => layout());

void (async () => {
  try {
    const init = await clawd.companion.ready();
    config = init.config;
    await applyPack(init.pack);
    applyView(init.view);
  } catch {
    // Even if initialization fails, show the fallback shape rather than nothing.
    fallbackShape.hidden = false;
    document.body.dataset.spriteStatus = "init failed";
  }
})();
