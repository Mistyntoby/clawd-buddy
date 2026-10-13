import { MAX_USER_MESSAGE_CHARS } from "../../shared/constants";
import type { ChatEvent, TranscriptEntry } from "../../shared/types";
import { extractRememberRequest } from "../../shared/validation";
import { $, api, h } from "../common/dom";

const clawd = api();
const messages = $("#messages");
const form = $("#composer") as HTMLFormElement;
const input = $("#input") as HTMLTextAreaElement;
const sendBtn = $("#send") as HTMLButtonElement;
const nameEl = $("#name");
const modeEl = $("#mode");
const notice = $("#notice");

input.maxLength = MAX_USER_MESSAGE_CHARS;

let busyRequest: string | null = null;
let liveBubble: { el: HTMLElement; text: HTMLElement; requestId: string; content: string } | null = null;
let memoryEnabled = false;
let companionName = "Clawd";

function scrollToEnd(): void {
  messages.scrollTop = messages.scrollHeight;
}

function clearEmptyState(): void {
  messages.querySelector(".empty")?.remove();
}

function showEmptyState(): void {
  if (messages.children.length > 0) return;
  messages.append(
    h("div", { class: "empty" }, `Say hi to ${companionName}! Ask a question, or type "remember that …" to save something to memory.`),
  );
}

function sourceLabel(source: "claude" | "offline"): string {
  return source === "claude" ? "Claude" : "Offline mode · scripted reply, not from Claude";
}

function addMessage(entry: TranscriptEntry): HTMLElement {
  clearEmptyState();
  const el = h("div", { class: `msg ${entry.role}` }, entry.text);
  if (entry.role === "assistant" && entry.source) el.append(h("span", { class: "msg-source" }, sourceLabel(entry.source)));
  messages.append(el);
  scrollToEnd();
  return el;
}

function setBusy(requestId: string | null): void {
  busyRequest = requestId;
  sendBtn.textContent = requestId ? "Stop" : "Send";
  sendBtn.classList.toggle("primary", !requestId);
  sendBtn.type = requestId ? "button" : "submit";
}

function onEvent(event: ChatEvent): void {
  switch (event.type) {
    case "start": {
      addMessage({ role: "user", text: event.prompt });
      const text = h("span", {}, h("span", { class: "typing", "aria-label": "Thinking" }, h("span"), h("span"), h("span")));
      const el = h("div", { class: "msg assistant" }, text);
      el.append(h("span", { class: "msg-source" }, sourceLabel(event.source)));
      clearEmptyState();
      messages.append(el);
      scrollToEnd();
      liveBubble = { el, text, requestId: event.requestId, content: "" };
      if (event.source === "claude") setBusy(event.requestId);
      break;
    }
    case "delta":
      if (liveBubble?.requestId === event.requestId) {
        liveBubble.content += event.text;
        liveBubble.text.textContent = liveBubble.content;
        scrollToEnd();
      }
      break;
    case "done":
      if (liveBubble?.requestId === event.requestId) liveBubble.text.textContent = event.text;
      liveBubble = null;
      setBusy(null);
      scrollToEnd();
      break;
    case "error":
      if (liveBubble?.requestId === event.requestId) liveBubble.el.remove();
      liveBubble = null;
      addMessage({ role: "error", text: event.message });
      setBusy(null);
      break;
    case "cancelled":
      // After "Clear" there is no live bubble; stay quiet in that case.
      if (liveBubble?.requestId === event.requestId) {
        if (liveBubble.content) liveBubble.el.append(h("span", { class: "msg-source" }, "(stopped)"));
        else liveBubble.el.remove();
        addMessage({ role: "system", text: "Stopped." });
      }
      liveBubble = null;
      setBusy(null);
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
        h("button", { onclick: () => clawd.app.openSettings("memory") }, "Open memory settings"),
        h("button", { class: "ghost", onclick: () => card.remove() }, "Dismiss"),
      ),
    );
  } else {
    card.append(
      h("div", {}, "Save this to memory?"),
      h("div", { class: "muted small" }, `“${fact}”`),
      h(
        "div",
        { class: "row" },
        h(
          "button",
          {
            class: "primary",
            onclick: async () => {
              const r = await clawd.memory.add(fact);
              card.replaceWith(addMessage({ role: r.ok ? "system" : "error", text: r.ok ? "Saved to memory. You can edit it in Settings → Memory." : r.error }));
            },
          },
          "Save",
        ),
        h("button", { class: "ghost", onclick: () => card.replaceWith(addMessage({ role: "system", text: "Not saved." })) }, "Don't save"),
      ),
    );
  }
  messages.append(card);
  scrollToEnd();
}

async function submit(): Promise<void> {
  const text = input.value.trim();
  if (!text || busyRequest) return;
  input.value = "";
  autoGrow();

  const fact = extractRememberRequest(text);
  if (fact) {
    addMessage({ role: "user", text });
    rememberCard(fact);
    return;
  }

  const result = await clawd.chat.send(text);
  if (!result.ok) addMessage({ role: "error", text: result.error });
}

function autoGrow(): void {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
}

async function refreshStatus(): Promise<void> {
  const s = await clawd.chat.status();
  companionName = s.name;
  memoryEnabled = s.memoryEnabled;
  nameEl.textContent = s.name;
  document.title = `Chat with ${s.name} — Clawd Buddy`;
  const online = s.enabled && s.hasKey;
  modeEl.className = `mode ${online ? "claude" : "offline"}`;
  modeEl.textContent = online ? `Claude · ${s.model}` : "Offline mode";
  notice.replaceChildren();
  if (!online) {
    notice.append(
      h(
        "div",
        {},
        s.enabled
          ? "AI is enabled but no API key is set, so replies are scripted and do not come from Claude."
          : "Offline mode: replies are simple scripted responses, not from Claude.",
      ),
      h("button", { onclick: () => clawd.app.openSettings("ai") }, "Set up Claude"),
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
  if (e.key === "Escape" && busyRequest) void clawd.chat.cancel();
});
input.addEventListener("input", autoGrow);
$("#clear").addEventListener("click", async () => {
  await clawd.chat.clear();
  messages.replaceChildren();
  liveBubble = null;
  setBusy(null);
  showEmptyState();
});
$("#open-settings").addEventListener("click", () => clawd.app.openSettings("ai"));

clawd.chat.onEvent(onEvent);
clawd.chat.onStatus(() => void refreshStatus());
clawd.chat.onFocusInput(() => input.focus());

void (async () => {
  await refreshStatus();
  for (const entry of await clawd.chat.transcript()) addMessage(entry);
  showEmptyState();
  input.focus();
  document.body.dataset.ready = "true";
})();
