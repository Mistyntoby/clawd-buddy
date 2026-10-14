import { MAX_USER_MESSAGE_CHARS } from "../../shared/constants";
import type { ChatEvent, TranscriptEntry } from "../../shared/types";
import { extractRememberRequest } from "../../shared/validation";
import { $, api, h } from "../common/dom";

/**
 * CLAWD://TERMINAL — the chat window as a tiny retro terminal.
 * Lines look like "> YOU: …" and "> CLAWD: …". Replies stream in as they
 * arrive; local lines (offline replies, command output) get a short
 * typewriter reveal unless reduced motion is on.
 */

const clawd = api();
const screen = $("#screen");
const form = $("#composer") as HTMLFormElement;
const input = $("#input") as HTMLTextAreaElement;
const sendBtn = $("#send") as HTMLButtonElement;
const statusEl = $("#status");
const modeEl = $("#mode");
const notice = $("#notice");

input.maxLength = MAX_USER_MESSAGE_CHARS;

type Status = "ready" | "thinking" | "typing" | "offline" | "error";
const STATUS_TEXT: Record<Status, string> = { ready: "READY", thinking: "THINKING...", typing: "TYPING...", offline: "OFFLINE", error: "ERROR" };

let busyRequest: string | null = null;
let live: { el: HTMLElement; body: HTMLElement; cursor: HTMLElement; requestId: string; content: string; source: "claude" | "offline" } | null = null;
let memoryEnabled = false;
let companionName = "Clawd";
let online = false;
let readAloud = false;
let reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function setStatus(s: Status): void {
  statusEl.className = `status ${s}`;
  statusEl.textContent = STATUS_TEXT[s];
}
const idleStatus = (): Status => (online ? "ready" : "offline");

function nearBottom(): boolean {
  return screen.scrollHeight - screen.scrollTop - screen.clientHeight < 40;
}
function scrollToEnd(force = false): void {
  if (force || nearBottom()) screen.scrollTop = screen.scrollHeight;
}

function clearEmptyState(): void {
  screen.querySelector(".empty")?.remove();
}

function showEmptyState(): void {
  if (screen.children.length > 0) return;
  screen.append(
    h(
      "div",
      { class: "line empty" },
      `${companionName.toUpperCase()} TERMINAL v1.0\nSay hi! Ask anything, or type /help for jokes, facts, and reminders.`,
    ),
  );
}

function who(entry: Pick<TranscriptEntry, "role">): string {
  switch (entry.role) {
    case "user":
      return "> YOU: ";
    case "assistant":
      return `> ${companionName.toUpperCase()}: `;
    case "error":
      return "! ERR: ";
    default:
      return "* ";
  }
}

const OFFLINE_TAG = "  [offline mode · scripted reply, not from Claude]";

function lineEl(entry: TranscriptEntry): { el: HTMLElement; body: HTMLElement } {
  const body = h("span", { class: "body" });
  const el = h("div", { class: `line ${entry.role}` }, h("span", { class: "who" }, who(entry)), body);
  return { el, body };
}

function addTag(el: HTMLElement, source: TranscriptEntry["source"]): void {
  if (source === "offline") el.append(h("span", { class: "tag msg-source" }, OFFLINE_TAG));
}

/** Prints a full line. `reveal` types it out quickly (local lines only; never slows down Claude's streaming). */
function print(entry: TranscriptEntry, reveal = false): HTMLElement {
  clearEmptyState();
  const { el, body } = lineEl(entry);
  screen.append(el);
  if (!reveal || reducedMotion || entry.text.length > 600) {
    body.textContent = entry.text;
    addTag(el, entry.source);
  } else {
    // ~0.5 s total regardless of length; click the screen to finish instantly.
    const step = Math.max(2, Math.ceil(entry.text.length / 30));
    let i = 0;
    const timer = setInterval(() => {
      i = Math.min(entry.text.length, i + step);
      body.textContent = entry.text.slice(0, i);
      scrollToEnd();
      if (i >= entry.text.length) {
        clearInterval(timer);
        addTag(el, entry.source);
      }
    }, 16);
    el.addEventListener("finish-reveal", () => {
      i = entry.text.length;
    });
  }
  scrollToEnd(true);
  return el;
}

function speak(text: string): void {
  if (!readAloud || !("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text.slice(0, 1200));
  u.rate = 1.05;
  window.speechSynthesis.speak(u);
}

function setBusy(requestId: string | null): void {
  busyRequest = requestId;
  sendBtn.textContent = requestId ? "STOP" : "SEND";
  sendBtn.classList.toggle("stop", !!requestId);
  sendBtn.type = requestId ? "button" : "submit";
}

function onEvent(event: ChatEvent): void {
  switch (event.type) {
    case "start": {
      print({ role: "user", text: event.prompt });
      const { el, body } = lineEl({ role: "assistant", text: "" });
      const cursor = h("span", { class: "cursor", "aria-hidden": "true" });
      el.append(cursor);
      clearEmptyState();
      screen.append(el);
      scrollToEnd(true);
      live = { el, body, cursor, requestId: event.requestId, content: "", source: event.source };
      if (event.source === "claude") {
        setBusy(event.requestId);
        setStatus("thinking");
      }
      break;
    }
    case "delta":
      if (live?.requestId === event.requestId) {
        if (!live.content) setStatus("typing");
        live.content += event.text;
        live.body.textContent = live.content;
        scrollToEnd();
      }
      break;
    case "done":
      if (live?.requestId === event.requestId) {
        live.body.textContent = event.text;
        live.cursor.remove();
        addTag(live.el, live.source);
      }
      live = null;
      setBusy(null);
      setStatus(idleStatus());
      speak(event.text);
      scrollToEnd();
      break;
    case "error":
      if (live?.requestId === event.requestId) live.el.remove();
      live = null;
      print({ role: "error", text: event.message });
      setBusy(null);
      setStatus("error");
      setTimeout(() => setStatus(idleStatus()), 4000);
      break;
    case "cancelled":
      // After "Clear" there is no live line; stay quiet in that case.
      if (live?.requestId === event.requestId) {
        live.cursor.remove();
        if (!live.content) live.el.remove();
        print({ role: "system", text: "Stopped." });
      }
      live = null;
      setBusy(null);
      setStatus(idleStatus());
      break;
    case "notice":
      print(event.entry, event.entry.role !== "user");
      if (event.entry.role === "assistant") speak(event.entry.text);
      break;
  }
}

/** Asks for explicit approval before anything is saved to memory. */
function rememberCard(fact: string): void {
  clearEmptyState();
  const card = h("div", { class: "card" });
  if (!memoryEnabled) {
    card.append(
      h("div", {}, "Memory is turned off, so nothing was saved."),
      h(
        "div",
        { class: "row" },
        h("button", { onclick: () => clawd.app.openSettings("memory") }, "SETTINGS"),
        h("button", { class: "ghost", onclick: () => card.remove() }, "OK"),
      ),
    );
  } else {
    card.append(
      h("div", {}, `Save to memory? "${fact}"`),
      h(
        "div",
        { class: "row" },
        h(
          "button",
          {
            onclick: async () => {
              const r = await clawd.memory.add(fact);
              card.replaceWith(print({ role: r.ok ? "system" : "error", text: r.ok ? "Saved to memory (Settings → Memory)." : r.error }));
            },
          },
          "SAVE",
        ),
        h("button", { class: "ghost", onclick: () => card.replaceWith(print({ role: "system", text: "Not saved." })) }, "DON'T"),
      ),
    );
  }
  screen.append(card);
  scrollToEnd(true);
}

async function submit(): Promise<void> {
  const text = input.value.trim();
  if (!text || busyRequest) return;
  input.value = "";
  autoGrow();

  const fact = extractRememberRequest(text);
  if (fact) {
    print({ role: "user", text });
    rememberCard(fact);
    return;
  }

  const result = await clawd.chat.send(text);
  if (!result.ok) print({ role: "error", text: result.error });
}

function autoGrow(): void {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 110)}px`;
}

async function refreshStatus(): Promise<void> {
  const s = await clawd.chat.status();
  companionName = s.name;
  memoryEnabled = s.memoryEnabled;
  readAloud = s.readAloud;
  reducedMotion = s.reducedMotion || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  online = s.ready;
  document.title = `${s.name.toUpperCase()}://TERMINAL`;
  modeEl.textContent = online ? `CLAUDE · ${s.model}${s.provider === "claude-code" ? " · SUB" : ""}` : "SCRIPTED REPLIES";
  if (!busyRequest) setStatus(idleStatus());
  notice.replaceChildren();
  if (!online) {
    notice.append(
      h(
        "div",
        {},
        s.enabled
          ? s.provider === "claude-code"
            ? "Claude Code wasn't found, so replies are scripted, not from Claude."
            : "No API key is set, so replies are scripted, not from Claude."
          : "Offline mode: replies are scripted, not from Claude.",
      ),
      h("button", { onclick: () => clawd.app.openSettings("ai") }, "CONNECT CLAUDE"),
    );
  }
  notice.hidden = online;
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  void submit();
});
sendBtn.addEventListener("click", (e) => {
  if (busyRequest) {
    e.preventDefault();
    void clawd.chat.cancel();
  }
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    form.requestSubmit();
  }
  if (e.key === "Escape") {
    if (busyRequest) void clawd.chat.cancel();
    else if (!input.value) clawd.chat.windowControl("minimize");
  }
});
input.addEventListener("input", autoGrow);
screen.addEventListener("click", () => {
  for (const el of screen.querySelectorAll(".line")) el.dispatchEvent(new Event("finish-reveal"));
  if (!window.getSelection()?.toString()) input.focus();
});

function resetScreen(): void {
  screen.replaceChildren();
  live = null;
  setBusy(null);
  setStatus(idleStatus());
  showEmptyState();
}
$("#clear").addEventListener("click", async () => {
  await clawd.chat.clear();
  resetScreen();
});
$("#open-settings").addEventListener("click", () => clawd.app.openSettings("ai"));
$("#win-min").addEventListener("click", () => clawd.chat.windowControl("minimize"));
$("#win-close").addEventListener("click", () => clawd.chat.windowControl("close"));

clawd.chat.onEvent(onEvent);
clawd.chat.onStatus(() => void refreshStatus());
clawd.chat.onFocusInput(() => input.focus());
clawd.chat.onCleared(resetScreen);

void (async () => {
  await refreshStatus();
  for (const entry of await clawd.chat.transcript()) print(entry);
  showEmptyState();
  input.focus();
  document.body.dataset.ready = "true";
})();
