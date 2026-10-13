import type { PackSummary, SettingsInit } from "../../shared/api";
import { SUGGESTED_MODELS } from "../../shared/constants";
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
        h("li", {}, h("b", {}, "Double-click"), ` ${name} to open the chat.`),
        h("li", {}, h("b", {}, "Right-click"), " for the menu: talk, fun facts, wandering, speed, sounds, hide, quit."),
        h("li", {}, h("b", {}, "Drag"), ` ${name} anywhere — they'll remember the spot.`),
        h("li", {}, h("b", {}, "Single-click"), " for a friendly poke."),
        h(
          "li",
          {},
          "Lost them? Use the ",
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
        "Without an API key, the companion runs in offline mode with simple scripted replies (always labeled as offline). " +
          "With your own Anthropic API key, conversations are answered by Claude. API usage is billed to your Anthropic account.",
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
      "Official Clawd artwork isn't bundled because it isn't licensed for redistribution. Until you add sprites you're permitted to use, an original placeholder character is shown (labeled “placeholder art”).",
    ),
    h("div", { class: "buttons" }, h("button", { onclick: () => show("character") }, "Sprite setup")),
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
      row("Occasional comments", "A rare, quiet remark (every 25–50 min) when you're at the computer.", toggle("ambientComments")),
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
      row("Show “placeholder art” label", "Shown under the character while the placeholder sprites are in use.", toggle("showPlaceholderLabel")),
    ),
    h("h2", {}, "Windows & startup"),
    h(
      "div",
      { class: "group" },
      row("Open chat on startup", null, toggle("openChatOnStartup")),
      row("Keep chat window on top", null, toggle("chatAlwaysOnTop")),
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

  return h(
    "section",
    { "data-section": "ai" },
    h("h1", {}, "AI (Claude)"),
    h(
      "p",
      { class: "lead" },
      "Optional. Connect your own Anthropic API key to chat with Claude. Without it, the companion stays in offline mode.",
    ),
    h(
      "div",
      { class: "callout accent" },
      h("p", {}, h("b", {}, "Before you start")),
      h(
        "ul",
        { class: "steps" },
        h("li", {}, "API usage is billed to your Anthropic account. ", h("a", { href: "#", onclick: (e: Event) => (e.preventDefault(), clawd.app.openLink("pricing")) }, "See pricing"), "."),
        h(
          "li",
          {},
          "Only your chat messages (plus any memory items you approved) are sent — directly to Anthropic's API, nowhere else.",
        ),
        h("li", {}, "Your key stays in the app's background process and is never shown to web pages or written to logs."),
      ),
    ),
    h("h2", {}, "Connection"),
    h(
      "div",
      { class: "group" },
      row("Enable Claude", "Use Claude for chat replies when a key is configured.", toggle("aiEnabled")),
      row(
        "API key",
        h("span", {}, keyState, " ", h("a", { href: "#", onclick: (e: Event) => (e.preventDefault(), clawd.app.openLink("console")) }, "Get a key")),
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
      row("Model", "Which Claude model answers. Change only if you know you need to.", h("span", { class: "control" }, model)),
    ),
    h("datalist", { id: "models" }, ...SUGGESTED_MODELS.map((m) => h("option", { value: m }))),
    h(
      "div",
      { class: "buttons" },
      h(
        "button",
        {
          disabled: !a.hasKey,
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
      confirmButton("Remove key", "Click again to remove", async () => {
        await clawd.ai.clearKey();
        toast("API key removed.");
      }),
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
            pack.official ? h("span", { class: "badge" }, "declared official (unverified)") : null,
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
        h("p", {}, h("b", {}, "Adding Clawd sprites")),
        h(
          "p",
          { class: "muted" },
          "Official Clawd artwork belongs to Anthropic and isn't bundled with this app. If you have artwork you're permitted to use, add it as a sprite pack:",
        ),
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

const BUILDERS: Record<SettingsSection, () => HTMLElement> = { welcome, behavior, ai, memory, character, about };

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
