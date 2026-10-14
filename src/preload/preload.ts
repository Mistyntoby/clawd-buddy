import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { ClawdApi, Unsubscribe } from "../shared/api";

/**
 * The only bridge between renderers and the main process. It exposes a fixed
 * set of named operations — never raw ipcRenderer, Node APIs, or filesystem
 * access. The main process validates every payload and checks which window sent it.
 */

function on<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const listener = (_e: IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const api: ClawdApi = {
  companion: {
    ready: () => ipcRenderer.invoke("companion:ready"),
    setInteractive: (v) => ipcRenderer.send("companion:set-interactive", v),
    grab: () => ipcRenderer.send("companion:grab"),
    dragStart: () => ipcRenderer.send("companion:drag-start"),
    dragMove: () => ipcRenderer.send("companion:drag-move"),
    release: () => ipcRenderer.send("companion:release"),
    contextMenu: () => ipcRenderer.send("companion:context-menu"),
    command: (cmd) => ipcRenderer.send("companion:command", cmd),
    dismissSpeech: () => ipcRenderer.send("companion:dismiss-speech"),
    onView: (cb) => on("companion:view", cb),
    onSpeech: (cb) => on("companion:speech", cb),
    onSound: (cb) => on("companion:sound", cb),
    onPack: (cb) => on("companion:pack", cb),
    onConfig: (cb) => on("companion:config", cb),
    onLayout: (cb) => on("companion:layout", cb),
  },
  chat: {
    send: (text) => ipcRenderer.invoke("chat:send", text),
    cancel: () => ipcRenderer.invoke("chat:cancel"),
    clear: () => ipcRenderer.invoke("chat:clear"),
    status: () => ipcRenderer.invoke("chat:status"),
    transcript: () => ipcRenderer.invoke("chat:transcript"),
    onEvent: (cb) => on("chat:event", cb),
    onStatus: (cb) => on("chat:status-changed", () => cb()),
    onFocusInput: (cb) => on("chat:focus-input", () => cb()),
    onCleared: (cb) => on("chat:cleared", () => cb()),
    windowControl: (action) => ipcRenderer.send("chat:window", action),
  },
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    set: (patch) => ipcRenderer.invoke("settings:set", patch),
    reset: () => ipcRenderer.invoke("settings:reset"),
    onChanged: (cb) => on("settings:changed", cb),
    onNavigate: (cb) => on("settings:navigate", cb),
  },
  ai: {
    setKey: (key, persist) => ipcRenderer.invoke("ai:set-key", { key, persist }),
    clearKey: () => ipcRenderer.invoke("ai:clear-key"),
    test: () => ipcRenderer.invoke("ai:test"),
  },
  memory: {
    list: () => ipcRenderer.invoke("memory:list"),
    add: (text) => ipcRenderer.invoke("memory:add", text),
    edit: (id, text) => ipcRenderer.invoke("memory:edit", { id, text }),
    remove: (id) => ipcRenderer.invoke("memory:remove", id),
    clear: () => ipcRenderer.invoke("memory:clear"),
  },
  reminders: {
    list: () => ipcRenderer.invoke("reminders:list"),
    add: (spec) => ipcRenderer.invoke("reminders:add", spec),
    dismiss: (id) => ipcRenderer.invoke("reminders:dismiss", id),
    remove: (id) => ipcRenderer.invoke("reminders:remove", id),
    onChanged: (cb) => on("reminders:changed", cb),
  },
  assets: {
    info: () => ipcRenderer.invoke("assets:info"),
    reload: () => ipcRenderer.invoke("assets:reload"),
    openFolder: () => ipcRenderer.invoke("assets:open-folder"),
    importClawd: () => ipcRenderer.invoke("assets:import-clawd"),
  },
  app: {
    openSettings: (section) => ipcRenderer.send("app:open-settings", section),
    openChat: () => ipcRenderer.send("app:open-chat"),
    openLink: (key) => ipcRenderer.send("app:open-link", key),
    quit: () => ipcRenderer.send("app:quit"),
  },
};

contextBridge.exposeInMainWorld("clawd", api);
