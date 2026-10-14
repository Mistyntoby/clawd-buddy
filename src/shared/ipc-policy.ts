/**
 * Which window may use which IPC channel. Anything not listed is rejected.
 * Enforced in the main process for every message.
 */

export type Role = "companion" | "chat" | "settings";

export const IPC_POLICY: Readonly<Record<string, readonly Role[]>> = Object.freeze({
  "companion:ready": ["companion"],
  "companion:set-interactive": ["companion"],
  "companion:grab": ["companion"],
  "companion:drag-start": ["companion"],
  "companion:drag-move": ["companion"],
  "companion:release": ["companion"],
  "companion:context-menu": ["companion"],
  "companion:send": ["companion"],
  "companion:cancel": ["companion"],
  "companion:input-open": ["companion"],
  "companion:command": ["companion"],
  "companion:dismiss-speech": ["companion"],

  "chat:send": ["chat"],
  "chat:cancel": ["chat"],
  "chat:clear": ["chat", "settings"],
  "chat:status": ["chat"],
  "chat:transcript": ["chat"],
  "chat:window": ["chat"],

  "settings:get": ["settings"],
  "settings:set": ["settings"],
  "settings:reset": ["settings"],

  "ai:set-key": ["settings"],
  "ai:clear-key": ["settings"],
  "ai:test": ["settings"],

  "memory:list": ["settings"],
  "memory:add": ["settings", "chat"],
  "memory:edit": ["settings"],
  "memory:remove": ["settings"],
  "memory:clear": ["settings"],

  "reminders:list": ["settings", "chat"],
  "reminders:add": ["settings", "chat"],
  "reminders:dismiss": ["settings", "chat"],
  "reminders:remove": ["settings", "chat"],
  "assets:info": ["settings"],
  "assets:reload": ["settings"],
  "assets:open-folder": ["settings"],
  "assets:import-clawd": ["settings"],

  "app:open-settings": ["companion", "chat", "settings"],
  "app:open-chat": ["companion", "settings"],
  "app:open-link": ["chat", "settings"],
  "app:quit": ["settings"],
});

export function isAllowed(channel: string, role: Role | null): boolean {
  if (role === null) return false;
  const roles = Object.prototype.hasOwnProperty.call(IPC_POLICY, channel) ? IPC_POLICY[channel] : undefined;
  return !!roles && roles.includes(role);
}

/** Only pages loaded from the app's own bundled files may use IPC. */
export function isTrustedSenderUrl(url: string | undefined, rendererRootFileUrl: string): boolean {
  if (!url) return false;
  const root = rendererRootFileUrl.endsWith("/") ? rendererRootFileUrl : `${rendererRootFileUrl}/`;
  return url.toLowerCase().startsWith(root.toLowerCase());
}
