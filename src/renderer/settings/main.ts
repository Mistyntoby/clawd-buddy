import type { PackSummary, SettingsInit } from "../../shared/api";
import { dayLabel, describeDue, REMINDER_HELP } from "../../shared/reminders";
import { CHAT_BOX_COLORS, SUGGESTED_MODELS } from "../../shared/constants";
import { MAX_SCALE, MIN_SCALE } from "../../shared/settings-schema";
import { ANIMATION_NAMES, type MemoryItem, type Settings, type SpritePackInfo } from "../../shared/types";
import type { SettingsSection } from "../../shared/validation";
import { $, api, h } from "../common/dom";

const clawd = api();
const nav = $("#nav");
const content = $("#content");
const toastEl = $("#toast");

const SECTIONS: { id: SettingsSection; label: string }[] = [
  { id: "welcome", label: "Welcome" },
  { id: "behavior", label: "Behavior" },
  { id: "ai", label: "AI (Claude)" },
  { id: "reminders", label: "Reminders & to-dos" },
  { id: "memory", label: "Memory" },
  { id: "character", label: "Character & sprites" },
  { id: "about", label: "About" },
];

let state: SettingsInit;
let current: SettingsSection = "welcome";

// ---- helpers ---------------------------------------------------------------------

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function toast(message: string, error = false): void {
  toastEl.textContent = message;
  toastEl.className = error ? "err" : "";
  toastEl.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), 2600);
}

async function set(patch: Partial<Settings>): Promise<boolean> {
  const r = await clawd.settings.set(patch);
  if (!r.ok) toast(r.error, true);
  return r.ok;
}

function row(label: string, hint: string | Node | null, control: Node, opts: { disabled?: boolean; warn?: boolean } = {}): HTMLElement {
  return h(
    "div",
    { class: `row${opts.disabled ? " disabled" : ""}` },
    h("div", { class: "label" }, h("span", {}, label), hint ? h("span", { class: `hint${opts.warn ? " warn" : ""}` }, hint) : null),
    h("div", { class: "control" }, control),
  );
}

function toggle(key: keyof Settings, opts: { disabled?: boolean } = {}): HTMLInputElement {
  const input = h("input", {
    type: "checkbox",
    class: "switch",
    "aria-label": String(key),
    disabled: opts.disabled,
  }) as HTMLInputElement;
  input.checked = state.settings[key] === true;
  input.addEventListener("change", async () => {
    if (!(await set({ [key]: input.checked } as Partial<Settings>))) input.checked = !input.checked;
  });
  return input;
}

function select<T extends string>(key: keyof Settings, options: [T, string][]): HTMLSelectElement {
  const el = h("select", { "aria-label": String(key) }, ...options.map(([v, l]) => h("option", { value: v }, l))) as HTMLSelectElement;
  el.value = String(state.settings[key]);
  el.addEventListener("change", () => void set({ [key]: el.value } as Partial<Settings>));
  return el;
}

/** Two-step confirm without blocking dialogs. */
function confirmButton(label: string, confirmLabel: string, action: () => void | Promise<void>, cls = "danger"): HTMLButtonElement {
  const btn = h("button", { class: cls }, label) as HTMLButtonElement;
  let armed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  btn.addEventListener("click", async () => {
    if (!armed) {
      armed = true;
      btn.textContent = confirmLabel;
      timer = setTimeout(() => {
        armed = false;
        btn.textContent = label;
      }, 4000);
      return;
    }
    if (timer) clearTimeout(timer);
    armed = false;
    btn.textContent = label;
    await action();
  });
  return btn;
}

// ---- sections ------------------------------------------------------------------------

function welcome(): HTMLElement {
  const name = state.settings.companionName;
  return h(
    "section",
    { "data-section": "welcome" },
    h("h1", {}, `Meet ${name} 👋`),
    h("p", { class: "lead" }, `${name} is a small companion that lives on your desktop. Here's how to get along:`),
    h(
      "div",
      { class: "callout" },
      h(
        "ul",
        { class: "steps" },
        h("li", {}, h("b", {}, "Click"), ` ${name} to open the chat terminal. Type /help there for jokes, facts, and reminders.`),
        h("li", {}, h("b", {}, "Drag"), ` ${name} anywhere: he stays exactly where you drop him.`),
        h("li", {}, h("b", {}, "Rub"), " the pointer back and forth over him to pet him."),
        h("li", {}, h("b", {}, "Right-click"), " for quick actions: chat, joke, fun fact, pet, tricks, reminders, settings, hide, quit."),
        state.capabilities.platform === "darwin"
          ? h("li", {}, "Lost him? Click the speech-bubble icon in the ", h("b", {}, "menu bar"), " (top right) and choose Show.")
          : h(
              "li",
              {},
              "Lost him? Use the ",
              h("b", {}, "Clawd Buddy tray icon"),
              " in the notification area (bottom-right; check the ",
              h("kbd", {}, "^"),
              " overflow arrow). Click it to show or hide; right-click it for more.",
            ),
      ),
    ),
    h(
      "div",
      { class: "callout accent" },
      h("p", {}, h("b", {}, "Chatting with Claude is optional.")),
      h(
        "p",
        { class: "muted" },
        "Without Claude, the companion runs in offline mode with simple scripted replies (always labeled as offline). " +
          "To chat with Claude, use your Claude Pro or Max subscription through Claude Code, or your own Anthropic API key (billed per use).",
      ),
      h("div", { class: "buttons" }, h("button", { class: "primary", onclick: () => show("ai") }, "Set up Claude"), h("button", { onclick: () => window.close() }, "Maybe later")),
    ),
    state.settings.spritePack === "auto" ? characterNotice() : null,
    h(
      "p",
      { class: "muted small" },
      "Clawd Buddy is an unofficial fan project. It is not made, approved, or endorsed by Anthropic.",
    ),
  );
}

function characterNotice(): HTMLElement {
  return h(
    "div",
    { class: "callout" },
    h("p", {}, h("b", {}, "About the character art")),
    h(
      "p",
      { class: "muted" },
      "Clawd's artwork belongs to Anthropic, so it isn't shipped with this app. If the Claude desktop app is installed, Clawd Buddy can use the original Clawd animations from it, on this computer only. Until then, a simple stand-in character is shown.",
    ),
    h(
      "div",
      { class: "buttons" },
      h("button", { class: "primary", onclick: () => void importClawd() }, "Use Clawd from the Claude app"),
      h("button", { onclick: () => show("character") }, "Sprite setup"),
    ),
  );
}

async function importClawd(after?: () => void): Promise<void> {
  toast("Importing Clawd…");
  const r = await clawd.assets.importClawd();
  if (!r.ok) {
    toast(r.error, true);
    return;
  }
  toast(`Clawd imported: ${r.animations} animations.`);
  after?.();
}

/** Preset swatches plus a custom color picker for the chat box border. */
function chatBoxColorControl(): HTMLElement {
  const current = state.settings.chatBoxColor.toLowerCase();
  const custom = h("input", { type: "color", "aria-label": "Custom chat box color", title: "Custom color" }) as HTMLInputElement;
  custom.value = current;
  const choose = async (color: string) => {
    if (await set({ chatBoxColor: color })) custom.value = color;
  };
  custom.addEventListener("change", () => void choose(custom.value));
  return h(
    "span",
    { class: "control swatches", role: "radiogroup", "aria-label": "Chat box color" },
    ...CHAT_BOX_COLORS.map((p) => {
      const b = h("button", {
        class: `swatch${p.color === current ? " selected" : ""}`,
        role: "radio",
        "aria-checked": String(p.color === current),
        "aria-label": p.name,
        title: p.name,
        onclick: () => void choose(p.color),
      });
      // Set through CSSOM: the page's CSP doesn't allow inline style attributes.
      b.style.setProperty("--swatch", p.color);
      return b;
    }),
    custom,
  );
}

function behavior(): HTMLElement {
  const s = state.settings;
  const caps = state.capabilities;

  const nameInput = h("input", { type: "text", maxlength: 24, "aria-label": "Companion name" }) as HTMLInputElement;
  nameInput.value = s.companionName;
  nameInput.addEventListener("change", async () => {
    if (!(await set({ companionName: nameInput.value }))) nameInput.value = state.settings.companionName;
  });

  const scale = h("input", { type: "range", min: MIN_SCALE, max: MAX_SCALE, step: 1, "aria-label": "Character size" }) as HTMLInputElement;
  scale.value = String(s.characterScale);
  const scaleLabel = h("span", { class: "muted small" }, `${s.characterScale}×`);
  scale.addEventListener("input", () => (scaleLabel.textContent = `${scale.value}×`));
  scale.addEventListener("change", () => void set({ characterScale: Number(scale.value) }));

  return h(
    "section",
    { "data-section": "behavior" },
    h("h1", {}, "Behavior"),
    h("p", { class: "lead" }, "How your companion looks, moves, and talks."),
    h("h2", {}, "Personality"),
    h(
      "div",
      { class: "group" },
      row("Name", "What the companion calls itself.", nameInput),
      row(
        "Personality",
        "Affects the tone of Claude replies and greetings.",
        select("personality", [
          ["playful", "Playful"],
          ["calm", "Calm"],
          ["concise", "Concise"],
        ]),
      ),
      row(
        "Idle chatter",
        "Unprompted remarks while you're at the computer. Quiet: rare (every 25–50 min) and silent. Chatty: every 6–15 min, with a sound.",
        select("idleChatter", [
          ["off", "Off"],
          ["quiet", "Quiet"],
          ["chatty", "Chatty"],
        ]),
      ),
      row("Sounds", "Soft synthesized blips and pops.", toggle("soundEnabled")),
    ),
    h("h2", {}, "Movement & appearance"),
    h(
      "div",
      { class: "group" },
      row("Wander around", "Occasionally stroll along the screen, then rest.", toggle("wandering")),
      row(
        "Movement speed",
        null,
        select("movementSpeed", [
          ["slow", "Slow"],
          ["normal", "Normal"],
          ["fast", "Fast"],
        ]),
      ),
      row("Character size", "Pixel scale of the sprite.", h("span", { class: "control" }, scale, scaleLabel)),
      row("Always on top", "Stay above ordinary windows.", toggle("alwaysOnTop")),
      row(
        "Animation intensity",
        "How often Clawd does little idle animations, and how much he squashes and bounces.",
        select("animationIntensity", [
          ["calm", "Calm"],
          ["normal", "Normal"],
          ["lively", "Lively"],
        ]),
      ),
      row("Reduce motion", "Turn off squash, bounce, and the chat's typing effect. Your system's reduce-motion setting is also honored.", toggle("reducedMotion")),
    ),
    h("h2", {}, "Windows & startup"),
    h(
      "div",
      { class: "group" },
      row(
        "Chat style",
        "Inline: clicking Clawd opens a small terminal input right under him and he answers in his speech bubble. Window: clicking him opens the CLAWD://TERMINAL window. Either way, the window is always available from the right-click menu.",
        select("chatMode", [
          ["inline", "Inline, under Clawd"],
          ["window", "Terminal window"],
        ]),
      ),
      row("Chat box color", "Border color of the chat box under Clawd and of his speech bubble.", chatBoxColorControl()),
      row("Open chat window on startup", null, toggle("openChatOnStartup")),
      row("Keep chat window on top", null, toggle("chatAlwaysOnTop")),
      row("Keep chat history", "Remember the recent conversation (last 100 lines) on this computer between restarts.", toggle("keepChatHistory")),
      row("Read replies aloud", "Speak Clawd's chat replies with your system's voice.", toggle("readAloud")),
      row(
        "Launch at startup",
        caps.launchAtStartupReason ?? "Start Clawd Buddy when you sign in. Off by default.",
        toggle("launchAtStartup", { disabled: !caps.launchAtStartupSupported }),
        { disabled: !caps.launchAtStartupSupported, warn: !caps.launchAtStartupSupported },
      ),
    ),
    h(
      "div",
      { class: "buttons" },
      confirmButton("Reset all settings", "Click again to reset", async () => {
        await clawd.settings.reset();
        toast("Settings reset to defaults.");
      }),
    ),
  );
}

function ai(): HTMLElement {
  const s = state.settings;
  const a = state.ai;
  const status = h("div", { class: "status-line" });
  const viaClaudeCode = s.aiProvider === "claude-code";

  const keyInput = h("input", { type: "password", placeholder: "sk-ant-…", "aria-label": "Anthropic API key", autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
  const persist = h("input", { type: "checkbox", "aria-label": "Remember key", disabled: !a.secureStorageAvailable }) as HTMLInputElement;
  persist.checked = a.secureStorageAvailable;

  const keyState =
    a.keySource === "saved"
      ? "A key is saved (encrypted with your OS account)."
      : a.keySource === "session"
        ? "A key is set for this session only; it will be forgotten when you quit."
        : a.keySource === "environment"
          ? "Using the ANTHROPIC_API_KEY environment variable."
          : "No API key set.";

  const model = h("input", { type: "text", list: "models", "aria-label": "Model", spellcheck: "false" }) as HTMLInputElement;
  model.value = s.model;
  model.addEventListener("change", async () => {
    if (!(await set({ model: model.value.trim() }))) model.value = state.settings.model;
    else toast("Model updated.");
  });

  const link = (key: Parameters<typeof clawd.app.openLink>[0], text: string) =>
    h("a", { href: "#", onclick: (e: Event) => (e.preventDefault(), clawd.app.openLink(key)) }, text);

  const apiRows = [
    row(
      "API key",
      h("span", {}, keyState, " ", link("console", "Get a key")),
      h(
        "span",
        { class: "control" },
        keyInput,
        h(
          "button",
          {
            class: "primary",
            onclick: async () => {
              const r = await clawd.ai.setKey(keyInput.value, persist.checked);
              keyInput.value = "";
              if (!r.ok) {
                status.className = "status-line err";
                status.textContent = r.error;
                return;
              }
              if (!state.settings.aiEnabled) await set({ aiEnabled: true });
              toast(r.stored === "saved" ? "Key saved securely." : "Key set for this session.");
            },
          },
          "Save",
        ),
      ),
    ),
    row(
      "Remember key",
      a.secureStorageAvailable
        ? "Encrypt the key with your OS account (Windows DPAPI) so you don't have to re-enter it."
        : "OS encryption isn't available, so the key can only be kept for this session.",
      persist,
      { warn: !a.secureStorageAvailable },
    ),
  ];

  const claudeCodeRow = row(
    "Claude Code",
    a.claudeCodeFound
      ? h("span", {}, "Found on this computer. Make sure you've signed in by running ", h("code", {}, "claude"), " in a terminal once.")
      : h("span", {}, "Not found. Install Claude Code and sign in with your Claude account. ", link("claudeCode", "How to install")),
    h("span", {}),
    { warn: !a.claudeCodeFound },
  );

  const callout = viaClaudeCode
    ? [
        h("li", {}, "Uses the Claude Code app on this computer, signed in with your Claude Pro or Max plan. Chats count toward that plan's usage limits; no API key is needed."),
        h("li", {}, "Clawd Buddy never reads or stores your Claude sign-in. It only starts Claude Code, with no tools, files, or plugins, and reads the reply."),
        h("li", {}, "Only your chat messages (plus any memory items you approved) are sent, through Claude Code to Anthropic."),
      ]
    : [
        h("li", {}, "API usage is billed to your Anthropic account. ", link("pricing", "See pricing"), "."),
        h("li", {}, "Only your chat messages (plus any memory items you approved) are sent — directly to Anthropic's API, nowhere else."),
        h("li", {}, "Your key stays in the app's background process and is never shown to web pages or written to logs."),
      ];

  return h(
    "section",
    { "data-section": "ai" },
    h("h1", {}, "AI (Claude)"),
    h(
      "p",
      { class: "lead" },
      "Optional. Chat with Claude using your Claude subscription (through Claude Code) or your own Anthropic API key. Without either, the companion stays in offline mode.",
    ),
    h("div", { class: "callout accent" }, h("p", {}, h("b", {}, "Before you start")), h("ul", { class: "steps" }, ...callout)),
    h("h2", {}, "Connection"),
    h(
      "div",
      { class: "group" },
      row("Enable Claude", "Use Claude for chat replies when the connection below is set up.", toggle("aiEnabled")),
      row(
        "Connect with",
        "A Claude subscription uses Claude Code on this computer. An API key is billed per use.",
        select("aiProvider", [
          ["claude-code", "Claude subscription (Claude Code)"],
          ["api", "Anthropic API key"],
        ]),
      ),
      ...(viaClaudeCode ? [claudeCodeRow] : apiRows),
      row("Model", "Which Claude model answers. Change only if you know you need to.", h("span", { class: "control" }, model)),
    ),
    h("datalist", { id: "models" }, ...SUGGESTED_MODELS.map((m) => h("option", { value: m }))),
    h(
      "div",
      { class: "buttons" },
      h(
        "button",
        {
          disabled: viaClaudeCode ? false : !a.hasKey,
          onclick: async (e: Event) => {
            const btn = e.currentTarget as HTMLButtonElement;
            btn.disabled = true;
            status.className = "status-line";
            status.textContent = "Testing…";
            const r = await clawd.ai.test();
            btn.disabled = false;
            status.className = `status-line ${r.ok ? "ok" : "err"}`;
            status.textContent = r.ok ? (r.message ?? "Connected.") : r.error;
          },
        },
        "Test connection",
      ),
      ...(viaClaudeCode
        ? []
        : [
            confirmButton("Remove key", "Click again to remove", async () => {
              await clawd.ai.clearKey();
              toast("API key removed.");
            }),
          ]),
      confirmButton("Clear chat history", "Click again to clear", async () => {
        await clawd.chat.clear();
        toast("Chat history cleared.");
      }, ""),
    ),
    status,
  );
}

function memory(): HTMLElement {
  const list = h("div", { class: "group" });
  const addInput = h("input", { type: "text", maxlength: 300, placeholder: "e.g. I prefer short answers", "aria-label": "New memory" }) as HTMLInputElement;

  async function refresh(): Promise<void> {
    const items = await clawd.memory.list();
    list.replaceChildren(...(items.length ? items.map(itemRow) : [h("div", { class: "memory-empty" }, "Nothing saved yet.")]));
  }

  function itemRow(item: MemoryItem): HTMLElement {
    const el = h("div", { class: "memory-item" });
    const view = () => {
      el.replaceChildren(
        h("span", { class: "text" }, item.text),
        h("button", { class: "ghost", onclick: edit }, "Edit"),
        h(
          "button",
          {
            class: "ghost danger",
            onclick: async () => {
              await clawd.memory.remove(item.id);
              void refresh();
            },
          },
          "Delete",
        ),
      );
    };
    const edit = () => {
      const input = h("input", { type: "text", maxlength: 300, "aria-label": "Edit memory" }) as HTMLInputElement;
      input.value = item.text;
      el.replaceChildren(
        input,
        h(
          "button",
          {
            class: "primary",
            onclick: async () => {
              const r = await clawd.memory.edit(item.id, input.value);
              if (!r.ok) return toast(r.error, true);
              item.text = input.value.trim();
              view();
            },
          },
          "Save",
        ),
        h("button", { class: "ghost", onclick: view }, "Cancel"),
      );
      input.focus();
    };
    view();
    return el;
  }

  async function add(): Promise<void> {
    const r = await clawd.memory.add(addInput.value);
    if (!r.ok) return toast(r.error, true);
    addInput.value = "";
    void refresh();
  }
  addInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void add();
  });

  void refresh();
  return h(
    "section",
    { "data-section": "memory" },
    h("h1", {}, "Memory"),
    h(
      "p",
      { class: "lead" },
      "Things you explicitly approve can be remembered and shared with Claude as context. Nothing is collected automatically — no files, keystrokes, clipboard, browsing, or screen contents.",
    ),
    h(
      "div",
      { class: "group" },
      row("Use memory", "When on, saved items are included in Claude conversations.", toggle("memoryEnabled")),
    ),
    h("h2", {}, "Saved items"),
    list,
    h("div", { class: "add-memory" }, addInput, h("button", { onclick: () => void add() }, "Add")),
    h("p", { class: "muted small" }, "Tip: in the chat, type “remember that …” and you'll be asked before anything is saved."),
    h(
      "div",
      { class: "buttons" },
      confirmButton("Delete all memory", "Click again to delete all", async () => {
        await clawd.memory.clear();
        void refresh();
        toast("All memory deleted.");
      }),
    ),
    h("p", { class: "muted small" }, "Memory is stored only on this computer, in the app's settings folder."),
  );
}

function character(): HTMLElement {
  const wrap = h("section", { "data-section": "character" });

  async function render(data: { pack: SpritePackInfo; packs: PackSummary[] }): Promise<void> {
    const { pack, packs } = data;
    const selector = h(
      "select",
      { "aria-label": "Sprite pack" },
      h("option", { value: "auto" }, "Automatic (your packs first, then placeholder)"),
      ...packs.filter((p) => p.valid).map((p) => h("option", { value: p.id }, p.name)),
    ) as HTMLSelectElement;
    selector.value = state.settings.spritePack;
    selector.addEventListener("change", async () => {
      await set({ spritePack: selector.value });
      void render(await clawd.assets.info());
    });

    wrap.replaceChildren(
      h("h1", {}, "Character & sprites"),
      h("p", { class: "lead" }, "Diagnostics for the character artwork, and how to add sprites you're permitted to use."),
      h("h2", {}, "Active sprite pack"),
      h(
        "div",
        { class: "group" },
        h(
          "dl",
          { class: "kv" },
          h("dt", {}, "Name"),
          h(
            "dd",
            {},
            pack.name,
            pack.placeholder ? h("span", { class: "badge placeholder" }, "placeholder") : null,
            pack.official ? h("span", { class: "badge" }, pack.id === "clawd" ? "from your Claude app" : "declared official (unverified)") : null,
          ),
          h("dt", {}, "Author"),
          h("dd", {}, pack.author || "—"),
          h("dt", {}, "Source"),
          h("dd", {}, pack.source || "—"),
          h("dt", {}, "License"),
          h("dd", {}, pack.license || "—"),
          pack.attribution ? h("dt", {}, "Attribution") : null,
          pack.attribution ? h("dd", {}, pack.attribution) : null,
        ),
        h(
          "div",
          { class: "anim-grid" },
          ...ANIMATION_NAMES.map((name) => {
            const ok = !!pack.animations[name];
            return h("div", { class: `anim ${ok ? "ok" : "missing"}` }, name, h("span", { class: "state" }, ok ? "✓" : "fallback"));
          }),
        ),
        pack.warnings.length ? h("div", { class: "memory-empty" }, ...pack.warnings.map((w) => h("div", {}, `⚠ ${w}`))) : null,
      ),
      row("Use pack", null, selector),
      h("h2", {}, "Discovered packs"),
      h(
        "div",
        { class: "group" },
        ...packs.map((p) =>
          h(
            "div",
            { class: "row" },
            h(
              "div",
              { class: "label" },
              h("span", {}, p.name, p.active ? h("span", { class: "badge" }, "active") : null),
              h("span", { class: `hint${p.valid ? "" : " warn"}` }, p.valid ? (p.warnings.join(" ") || "OK") : p.errors.join(" ")),
            ),
            h("div", { class: "control" }, h("span", { class: "muted small" }, p.id)),
          ),
        ),
      ),
      h(
        "div",
        { class: "callout" },
        h("p", {}, h("b", {}, "Use the real Clawd")),
        h(
          "p",
          { class: "muted" },
          "Clawd's artwork belongs to Anthropic and isn't shipped with this app. If the Claude desktop app is installed on this computer, Clawd Buddy can read Clawd's original animations from it (read-only) and save them as a private sprite pack here. Nothing is uploaded or shared.",
        ),
        h(
          "div",
          { class: "buttons" },
          h(
            "button",
            { class: "primary", onclick: () => void importClawd(async () => void render(await clawd.assets.info())) },
            "Import Clawd from the Claude app",
          ),
        ),
        h("p", {}, h("b", {}, "Other artwork")),
        h("p", { class: "muted" }, "If you have other artwork you're permitted to use, add it as a sprite pack:"),
        h(
          "ol",
          { class: "steps" },
          h("li", {}, "Click ", h("b", {}, "Open sprite folder"), " and create a sub-folder, e.g. ", h("kbd", {}, "clawd"), "."),
          h("li", {}, "Put the frame images (PNG/GIF/WebP) and a ", h("kbd", {}, "manifest.json"), " in it — see manifest.example.json in the project docs."),
          h("li", {}, "Fill in author, source, and license honestly, then click ", h("b", {}, "Reload sprites"), "."),
        ),
        h("p", { class: "muted small" }, "Missing animations automatically fall back to idle, so a pack with only an idle animation works."),
      ),
      h(
        "div",
        { class: "buttons" },
        h("button", { onclick: () => void clawd.assets.openFolder() }, "Open sprite folder"),
        h(
          "button",
          {
            onclick: async () => {
              await render(await clawd.assets.reload());
              toast("Sprites reloaded.");
            },
          },
          "Reload sprites",
        ),
      ),
    );
  }

  void clawd.assets.info().then(render);
  return wrap;
}

function about(): HTMLElement {
  return h(
    "section",
    { "data-section": "about" },
    h("h1", {}, "About Clawd Buddy"),
    h("p", { class: "lead" }, `Version ${state.capabilities.version} · ${state.capabilities.platform}`),
    h(
      "div",
      { class: "callout accent" },
      h("p", {}, h("b", {}, "Unofficial fan project")),
      h(
        "p",
        { class: "muted" },
        "Clawd Buddy is an independent fan project inspired by classic desktop pets. It is not created, approved, or endorsed by Anthropic. “Claude” and the Clawd character belong to Anthropic.",
      ),
    ),
    h(
      "div",
      { class: "callout" },
      h("p", {}, h("b", {}, "Privacy")),
      h(
        "ul",
        { class: "steps" },
        h("li", {}, "Settings, memory, and your encrypted API key are stored only on this computer."),
        h("li", {}, "When Claude is enabled, chat messages and approved memory go directly to Anthropic's API — nowhere else."),
        h("li", {}, "No analytics, no telemetry, no monitoring of other apps, files, keystrokes, clipboard, or screen."),
      ),
      h("p", {}, h("a", { href: "#", onclick: (e: Event) => (e.preventDefault(), clawd.app.openLink("privacy")) }, "Anthropic privacy policy")),
    ),
    h(
      "div",
      { class: "callout" },
      h("p", {}, h("b", {}, "Licenses")),
      h("p", { class: "muted" }, "Source code: MIT License. The built-in placeholder character is original artwork made for this project (MIT). Any sprite packs you add keep their own licenses."),
    ),
    h("div", { class: "buttons" }, h("button", { class: "danger", onclick: () => clawd.app.quit() }, "Quit Clawd Buddy")),
  );
}

function reminders(): HTMLElement {
  const list = h("div", { class: "group" });
  const status = h("div", { class: "status-line" });
  const input = h("input", { type: "text", maxlength: 220, placeholder: "10m stretch   ·   at 15:30 standup", "aria-label": "New reminder" }) as HTMLInputElement;

  async function refresh(): Promise<void> {
    const items = await clawd.reminders.list();
    const now = Date.now();
    // Agenda: one heading per day.
    let lastDay = "";
    const withHeadings = (r: (typeof items)[number], el: HTMLElement): HTMLElement[] => {
      const day = r.status === "fired" ? "Due now" : dayLabel(r.dueAt, now);
      const out = day !== lastDay ? [h("div", { class: "agenda-day" }, day), el] : [el];
      lastDay = day;
      return out;
    };
    list.replaceChildren(
      ...(items.length === 0
        ? [h("div", { class: "memory-empty" }, "No reminders yet.")]
        : items.flatMap((r) => withHeadings(r,
            h(
              "div",
              { class: "row" },
              h(
                "div",
                { class: "label" },
                h("span", {}, r.text),
                h("span", { class: `hint${r.status === "fired" ? " warn" : ""}` }, r.status === "fired" ? "Due now" : describeDue(r.dueAt, now)),
              ),
              h(
                "div",
                { class: "control" },
                r.status === "fired" ? h("button", { onclick: async () => (await clawd.reminders.dismiss(r.id), void refresh()) }, "Done") : null,
                h("button", { class: "danger", onclick: async () => (await clawd.reminders.remove(r.id), void refresh()) }, "Delete"),
              ),
            ),
          ))),
    );
  }

  async function add(): Promise<void> {
    const r = await clawd.reminders.add(input.value);
    status.className = `status-line ${r.ok ? "ok" : "err"}`;
    status.textContent = r.ok ? r.message : r.error;
    if (r.ok) input.value = "";
    void refresh();
  }
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void add();
  });
  void refresh();
  clawd.reminders.onChanged(() => void refresh());

  return h(
    "section",
    { "data-section": "reminders" },
    h("h1", {}, "Reminders & to-dos"),
    h("p", { class: "lead" }, "Clawd pops up with a speech bubble when a reminder is due. Reminders are stored only on this computer."),
    h("div", { class: "add-memory" }, input, h("button", { class: "primary", onclick: () => void add() }, "Add")),
    status,
    h("p", { class: "muted small" }, REMINDER_HELP, " In the chat you can also type ", h("kbd", {}, "/remind 10m stretch"), "."),
    h("h2", {}, "Upcoming"),
    list,
    todoPanel(),
  );
}

function todoPanel(): HTMLElement {
  const list = h("div", { class: "group" });
  const input = h("input", { type: "text", maxlength: 200, placeholder: "e.g. water the plants", "aria-label": "New to-do" }) as HTMLInputElement;

  async function refresh(): Promise<void> {
    const items = await clawd.todos.list();
    list.replaceChildren(
      ...(items.length === 0
        ? [h("div", { class: "memory-empty" }, "Nothing to do. Nice!")]
        : items.map((t) => {
            const box = h("input", { type: "checkbox", "aria-label": `Done: ${t.text}` }) as HTMLInputElement;
            box.checked = t.done;
            box.addEventListener("change", async () => {
              await clawd.todos.setDone(t.id, box.checked);
              void refresh();
            });
            return h(
              "div",
              { class: `row todo${t.done ? " done" : ""}` },
              h("label", { class: "label todo-label" }, box, h("span", {}, t.text)),
              h("div", { class: "control" }, h("button", { class: "danger", onclick: async () => (await clawd.todos.remove(t.id), void refresh()) }, "Delete")),
            );
          })),
    );
  }
  async function add(): Promise<void> {
    const r = await clawd.todos.add(input.value);
    if (!r.ok) toast(r.error, true);
    else input.value = "";
    void refresh();
  }
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void add();
  });
  void refresh();
  clawd.todos.onChanged(() => void refresh());

  return h(
    "div",
    {},
    h("h2", {}, "To-dos"),
    h("div", { class: "add-memory" }, input, h("button", { class: "primary", onclick: () => void add() }, "Add")),
    list,
    h(
      "div",
      { class: "buttons" },
      h("button", { onclick: async () => (await clawd.todos.clearDone(), void refresh()) }, "Clear finished"),
    ),
    h("p", { class: "muted small" }, "In the chat: ", h("kbd", {}, "/todo buy milk"), ", ", h("kbd", {}, "/todo"), ", ", h("kbd", {}, "/todo done 1"), "."),
  );
}

const BUILDERS: Record<SettingsSection, () => HTMLElement> = { welcome, behavior, ai, reminders, memory, character, about };

function show(section: SettingsSection): void {
  current = section;
  for (const b of nav.querySelectorAll<HTMLButtonElement>("button[data-id]")) {
    if (b.dataset.id === section) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  }
  const scroll = content.scrollTop;
  const sameSection = content.firstElementChild?.getAttribute("data-section") === section;
  content.replaceChildren(BUILDERS[section]());
  if (sameSection) content.scrollTop = scroll;
}

function buildNav(): void {
  nav.replaceChildren(
    h("div", { class: "brand" }, h("span", { class: "dot", "aria-hidden": "true" }), "Clawd Buddy"),
    ...SECTIONS.map((s) => h("button", { "data-id": s.id, onclick: () => show(s.id) }, s.label)),
    h("div", { class: "spacer" }),
    h("button", { onclick: () => clawd.app.openChat() }, "Open chat →"),
  );
}

let initialized = false;
clawd.settings.onNavigate((section) => {
  if (initialized) show(section);
  else current = section;
});
clawd.settings.onChanged((next) => {
  state = next;
  if (!initialized) return;
  // Re-render to reflect changes made elsewhere (tray, context menu), keeping the scroll position.
  // Don't re-render while the user is typing in a text field.
  const active = document.activeElement;
  if (active instanceof HTMLInputElement && (active.type === "text" || active.type === "password")) return;
  show(current);
});

void (async () => {
  state = await clawd.settings.get();
  buildNav();
  initialized = true;
  show(current);
  document.body.dataset.ready = "true";
})();
