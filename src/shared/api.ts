import type {
  AiStatus,
  AnimationIntensity,
  CapabilityInfo,
  ChatEvent,
  CompanionView,
  MemoryItem,
  Settings,
  SpeechPayload,
  SpritePackInfo,
  TranscriptEntry,
} from "./types";
import type { CompanionLayout } from "./layout";
import type { Reminder } from "./reminders";
import type { CompanionCommand, SettingsSection } from "./validation";

export type Unsubscribe = () => void;

export interface CompanionConfig {
  scale: number;
  reducedMotion: boolean;
  animationIntensity: AnimationIntensity;
  soundEnabled: boolean;
  name: string;
}

export interface CompanionInit {
  pack: SpritePackInfo;
  view: CompanionView;
  config: CompanionConfig;
  layout: CompanionLayout;
}

export interface PackSummary {
  id: string;
  name: string;
  valid: boolean;
  errors: string[];
  warnings: string[];
  active: boolean;
}

export interface SettingsInit {
  settings: Settings;
  capabilities: CapabilityInfo;
  ai: AiStatus;
}

export type LinkKey = "console" | "claudeCode" | "pricing" | "docs" | "privacy";

export type OpResult = { ok: true } | { ok: false; error: string };

/** The complete API exposed to renderers as `window.clawd`. Main enforces which window may call what. */
export interface ClawdApi {
  companion: {
    ready(): Promise<CompanionInit>;
    setInteractive(on: boolean): void;
    /** Pointer pressed on Clawd (movement stops). */
    grab(): void;
    /** The press became a drag (the window follows the OS cursor). */
    dragStart(): void;
    /** The pointer moved during a drag; the main process moves the window to the OS cursor. */
    dragMove(): void;
    /** Pointer released or cancelled (drop, or end of a click). */
    release(): void;
    contextMenu(): void;
    /** Sends a message typed into the inline input under Clawd. */
    send(text: string): Promise<{ ok: true } | { ok: false; error: string }>;
    /** Stops the reply in progress. */
    cancel(): void;
    /** The inline input opened/closed (Clawd stays put while it's open). */
    inputOpen(open: boolean): void;
    /** "toggle" | "open" | "close" the inline input. */
    onInput(cb: (action: "toggle" | "open" | "close") => void): Unsubscribe;
    onChatState(cb: (state: "ready" | "thinking" | "typing") => void): Unsubscribe;
    command(cmd: CompanionCommand): void;
    dismissSpeech(): void;
    onView(cb: (view: CompanionView) => void): Unsubscribe;
    onSpeech(cb: (speech: SpeechPayload | null) => void): Unsubscribe;
    onSound(cb: (sound: "pop" | "chime" | "blip" | "error") => void): Unsubscribe;
    onPack(cb: (pack: SpritePackInfo) => void): Unsubscribe;
    onConfig(cb: (config: CompanionConfig) => void): Unsubscribe;
    onLayout(cb: (layout: CompanionLayout) => void): Unsubscribe;
  };
  chat: {
    send(text: string): Promise<{ ok: true; requestId: string } | { ok: false; error: string }>;
    cancel(): Promise<boolean>;
    clear(): Promise<void>;
    status(): Promise<AiStatus & { name: string; memoryEnabled: boolean; readAloud: boolean; reducedMotion: boolean }>;
    transcript(): Promise<TranscriptEntry[]>;
    onEvent(cb: (event: ChatEvent) => void): Unsubscribe;
    onStatus(cb: () => void): Unsubscribe;
    onFocusInput(cb: () => void): Unsubscribe;
    onCleared(cb: () => void): Unsubscribe;
    /** Submit this text as if typed (used to continue a "remember that…" request from the inline input). */
    onSubmit(cb: (text: string) => void): Unsubscribe;
    /** Minimize or close this (frameless) chat window. */
    windowControl(action: "minimize" | "close"): void;
  };
  settings: {
    get(): Promise<SettingsInit>;
    set(patch: Partial<Settings>): Promise<OpResult>;
    reset(): Promise<void>;
    onChanged(cb: (init: SettingsInit) => void): Unsubscribe;
    onNavigate(cb: (section: SettingsSection) => void): Unsubscribe;
  };
  ai: {
    setKey(key: string, persist: boolean): Promise<OpResult & { stored?: "saved" | "session" }>;
    clearKey(): Promise<void>;
    test(): Promise<OpResult & { message?: string }>;
  };
  memory: {
    list(): Promise<MemoryItem[]>;
    add(text: string): Promise<OpResult>;
    edit(id: string, text: string): Promise<OpResult>;
    remove(id: string): Promise<boolean>;
    clear(): Promise<void>;
  };
  reminders: {
    list(): Promise<Reminder[]>;
    /** Parses "10m stretch", "at 15:30 standup", … and adds it. */
    add(spec: string): Promise<{ ok: true; message: string } | { ok: false; error: string }>;
    dismiss(id: string): Promise<boolean>;
    remove(id: string): Promise<boolean>;
    onChanged(cb: () => void): Unsubscribe;
  };
  assets: {
    info(): Promise<{ pack: SpritePackInfo; packs: PackSummary[] }>;
    reload(): Promise<{ pack: SpritePackInfo; packs: PackSummary[] }>;
    openFolder(): Promise<void>;
    /** Builds a local Clawd pack from the Claude desktop app installed on this computer. */
    importClawd(): Promise<{ ok: true; animations: number; skipped: string[] } | { ok: false; error: string }>;
  };
  app: {
    openSettings(section?: SettingsSection): void;
    openChat(): void;
    openLink(key: LinkKey): void;
    quit(): void;
  };
}
