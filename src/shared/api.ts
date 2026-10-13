import type {
  AiStatus,
  CapabilityInfo,
  ChatEvent,
  CompanionView,
  MemoryItem,
  Settings,
  SpeechPayload,
  SpritePackInfo,
  TranscriptEntry,
} from "./types";
import type { CompanionCommand, SettingsSection } from "./validation";

export type Unsubscribe = () => void;

export interface CompanionConfig {
  scale: number;
  showPlaceholderLabel: boolean;
  soundEnabled: boolean;
  name: string;
}

export interface CompanionInit {
  pack: SpritePackInfo;
  view: CompanionView;
  config: CompanionConfig;
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

export type LinkKey = "console" | "pricing" | "docs" | "privacy";

export type OpResult = { ok: true } | { ok: false; error: string };

/** The complete API exposed to renderers as `window.clawd`. Main enforces which window may call what. */
export interface ClawdApi {
  companion: {
    ready(): Promise<CompanionInit>;
    setInteractive(on: boolean): void;
    dragStart(screenX: number, screenY: number): void;
    dragMove(screenX: number, screenY: number): void;
    dragEnd(): void;
    contextMenu(): void;
    command(cmd: CompanionCommand): void;
    dismissSpeech(): void;
    onView(cb: (view: CompanionView) => void): Unsubscribe;
    onSpeech(cb: (speech: SpeechPayload | null) => void): Unsubscribe;
    onSound(cb: (sound: "pop" | "chime" | "blip" | "error") => void): Unsubscribe;
    onPack(cb: (pack: SpritePackInfo) => void): Unsubscribe;
    onConfig(cb: (config: CompanionConfig) => void): Unsubscribe;
  };
  chat: {
    send(text: string): Promise<{ ok: true; requestId: string } | { ok: false; error: string }>;
    cancel(): Promise<boolean>;
    clear(): Promise<void>;
    status(): Promise<AiStatus & { name: string; memoryEnabled: boolean }>;
    transcript(): Promise<TranscriptEntry[]>;
    onEvent(cb: (event: ChatEvent) => void): Unsubscribe;
    onStatus(cb: () => void): Unsubscribe;
    onFocusInput(cb: () => void): Unsubscribe;
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
  assets: {
    info(): Promise<{ pack: SpritePackInfo; packs: PackSummary[] }>;
    reload(): Promise<{ pack: SpritePackInfo; packs: PackSummary[] }>;
    openFolder(): Promise<void>;
  };
  app: {
    openSettings(section?: SettingsSection): void;
    openChat(): void;
    openLink(key: LinkKey): void;
    quit(): void;
  };
}
