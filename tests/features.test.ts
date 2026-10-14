import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sanitizeSavedChat } from "../src/main/chat-service";
import { CompanionController, type CompanionPort } from "../src/main/companion-controller";
import { OfflineBrain } from "../src/main/offline-brain";
import { ReminderStore } from "../src/main/reminders";
import { TodoStore } from "../src/main/todos";
import { MOTION } from "../src/shared/constants";
import { dayLabel, describeDue, parseReminder } from "../src/shared/reminders";
import { sanitizeSettings, validateSettingsPatch } from "../src/shared/settings-schema";

const NOW = new Date(2026, 9, 14, 10, 0, 0).getTime(); // 10:00 local time

describe("reminder parsing", () => {
  it("understands durations", () => {
    expect(parseReminder("10m stretch", NOW)).toEqual({ ok: true, dueAt: NOW + 600_000, text: "stretch" });
    expect(parseReminder("1h30m check the oven", NOW)).toEqual({ ok: true, dueAt: NOW + 5_400_000, text: "check the oven" });
    expect(parseReminder("in 2 hours call back", NOW)).toEqual({ ok: true, dueAt: NOW + 7_200_000, text: "call back" });
    expect(parseReminder("45 sec tea", NOW)).toEqual({ ok: true, dueAt: NOW + 45_000, text: "tea" });
    expect(parseReminder("15 to drink water", NOW)).toEqual({ ok: true, dueAt: NOW + 900_000, text: "drink water" });
  });
  it("understands clock times, rolling over to tomorrow", () => {
    const at = parseReminder("at 15:30 standup", NOW);
    expect(at.ok && new Date(at.dueAt).getHours()).toBe(15);
    expect(at.ok && at.text).toBe("standup");
    const early = parseReminder("at 9am gym", NOW);
    expect(early.ok && early.dueAt - NOW).toBe(23 * 3600_000);
    const pm = parseReminder("7:05pm dinner", NOW);
    expect(pm.ok && new Date(pm.dueAt).getHours()).toBe(19);
  });
  it("explains what's wrong", () => {
    expect(parseReminder("", NOW).ok).toBe(false);
    expect(parseReminder("stretch", NOW).ok).toBe(false);
    expect(parseReminder("10m", NOW).ok).toBe(false);
    expect(parseReminder("at 25:00 nope", NOW).ok).toBe(false);
    expect(parseReminder("400 days later", NOW).ok).toBe(false);
  });
  it("describes when it's due", () => {
    expect(describeDue(NOW + 30_000, NOW)).toBe("in 30 s");
    expect(describeDue(NOW + 600_000, NOW)).toBe("in 10 min");
    expect(describeDue(new Date(2026, 9, 14, 15, 30).getTime(), NOW)).toBe("at 15:30");
    expect(describeDue(new Date(2026, 9, 15, 9, 0).getTime(), NOW)).toBe("tomorrow at 09:00");
  });
});

describe("reminder store", () => {
  let dir: string;
  let now = NOW;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    now = NOW;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-rem-"));
  });
  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("fires once when due, survives a restart, and can be dismissed and deleted", () => {
    const fired: string[] = [];
    const store = new ReminderStore(dir, () => now);
    store.start((r) => fired.push(r.text));
    store.add("tea", NOW + 60_000);
    store.add("later", NOW + 3_600_000);
    now += 61_000;
    vi.advanceTimersByTime(61_000);
    expect(fired).toEqual(["tea"]);
    expect(store.list().map((r) => r.status)).toEqual(["fired", "pending"]);
    store.stop();

    // Restart: the pending one comes back; one that came due while closed fires at startup.
    now += 3_600_000;
    const again = new ReminderStore(dir, () => now);
    again.start((r) => fired.push(r.text));
    expect(fired).toEqual(["tea", "later"]);
    const [tea, later] = again.list();
    expect(again.dismiss(tea!.id)).toBe(true);
    expect(again.remove(later!.id)).toBe(true);
    expect(again.list()).toEqual([]);
    again.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects empty and absurd reminders and ignores a corrupt file", () => {
    fs.writeFileSync(path.join(dir, "reminders.json"), "{ not json");
    const store = new ReminderStore(dir, () => now);
    expect(store.list()).toEqual([]);
    expect(store.add("  ", NOW + 1000).ok).toBe(false);
    expect(store.add("x", Number.NaN).ok).toBe(false);
    expect(store.add("x", NOW + 10 * 365 * 86_400_000).ok).toBe(false);
  });
});

describe("chat history", () => {
  it("restores only well-formed entries, capped", () => {
    const saved = sanitizeSavedChat({
      history: [{ role: "assistant", content: "orphan" }, { role: "user", content: "hi" }, { role: "assistant", content: "hello" }, { role: "system", content: "x" }],
      log: [{ role: "user", text: "hi" }, { role: "hacker", text: "nope" }, { role: "assistant", text: "hello", source: "claude" }, ...Array(300).fill({ role: "system", text: "x" })],
    });
    expect(saved!.history).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    expect(saved!.log.length).toBeLessThanOrEqual(100);
    expect(saved!.log.every((e) => ["user", "assistant", "error", "system"].includes(e.role))).toBe(true);
    expect(sanitizeSavedChat("garbage")).toBeNull();
  });
});

describe("settings for the new features", () => {
  it("validates chatter and intensity", () => {
    expect(validateSettingsPatch({ idleChatter: "chatty", animationIntensity: "lively", keepChatHistory: false, readAloud: true }).ok).toBe(true);
    expect(validateSettingsPatch({ idleChatter: "loud" }).ok).toBe(false);
    expect(validateSettingsPatch({ animationIntensity: 11 }).ok).toBe(false);
  });
  it("migrates the old 'occasional comments' switch", () => {
    expect(sanitizeSettings({ ambientComments: false }).idleChatter).toBe("off");
    expect(sanitizeSettings({ ambientComments: true }).idleChatter).toBe("quiet");
    expect(sanitizeSettings({}).idleChatter).toBe("quiet");
  });
});

describe("jokes and petting", () => {
  it("never tells the same joke twice in a row", () => {
    let i = 0;
    const brain = new OfflineBrain(() => [0, 0, 0.5, 0.5][i++ % 4] as number);
    const a = brain.joke();
    const b = brain.joke();
    expect(a).not.toEqual(b);
    expect(a[0].length).toBeGreaterThan(5);
    expect(a[1].length).toBeGreaterThan(3);
  });

  it("petting reacts happily, with a cooldown against repeated triggers", () => {
    vi.useFakeTimers();
    let now = 0;
    const sounds: string[] = [];
    const port: CompanionPort = {
      getPosition: () => ({ x: 0, y: 0 }),
      setPosition: () => {},
      getSize: () => ({ width: 280, height: 246 }),
      bodyRect: () => ({ x: 100, y: 180, width: 80, height: 60 }),
      isVisible: () => true,
      workAreas: () => [{ x: 0, y: 0, width: 1920, height: 1080 }],
      workAreaNear: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
      cursorPoint: () => ({ x: 0, y: 0 }),
      sendView: () => {},
      sendSpeech: () => {},
      sendSound: (s) => void sounds.push(s),
    };
    const c = new CompanionController(port, { wandering: false, movementSpeed: "normal", idleChatter: "off", animationIntensity: "normal" }, () => "", {
      now: () => now,
    });
    c.start();
    expect(c.pet()).toBe(true);
    expect(c.state).toBe("happy");
    now += 500;
    expect(c.pet()).toBe(false);
    now += MOTION.petCooldownMs;
    vi.advanceTimersByTime(5000);
    expect(c.pet()).toBe(true);
    expect(sounds.filter((s) => s === "pop")).toHaveLength(2);
    c.dispose();
    vi.useRealTimers();
  });
});

describe("to-dos", () => {
  it("adds, ticks off, reorders, deletes, clears finished, and survives a restart", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-todo-"));
    try {
      let changes = 0;
      const store = new TodoStore(dir, () => NOW);
      store.watch(() => changes++);
      const a = store.add("buy milk");
      const b = store.add("  water\u0007 plants  ");
      expect(a.ok && b.ok).toBe(true);
      expect(store.add("   ").ok).toBe(false);
      if (!a.ok || !b.ok) return;
      expect(b.todo.text).toBe("water  plants");
      store.setDone(a.todo.id, true);
      expect(store.list().map((t) => t.text)).toEqual(["water  plants", "buy milk"]); // open first
      const again = new TodoStore(dir, () => NOW);
      expect(again.list().find((t) => t.text === "buy milk")?.done).toBe(true);
      expect(again.clearDone()).toBe(1);
      expect(again.remove(b.todo.id)).toBe(true);
      expect(again.list()).toEqual([]);
      expect(changes).toBe(3);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("reminder agenda", () => {
  it("groups by day", () => {
    expect(dayLabel(NOW + 3600_000, NOW)).toBe("Today");
    expect(dayLabel(new Date(2026, 9, 15, 9, 0).getTime(), NOW)).toBe("Tomorrow");
    expect(dayLabel(NOW - 86_400_000 * 2, NOW)).toBe("Earlier");
    expect(dayLabel(new Date(2026, 9, 20, 9, 0).getTime(), NOW)).toMatch(/20/);
  });
});
