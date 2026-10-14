import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { MAX_REMINDER_TEXT, MAX_REMINDERS, MAX_REMINDER_AHEAD_MS, type Reminder } from "../shared/reminders";
import { readJson, writeJsonAtomic } from "./settings";

/** setTimeout can't wait longer than ~24.8 days; longer waits re-arm in steps. */
const MAX_TIMER_MS = 24 * 3600_000;

function isReminder(v: unknown): v is Reminder {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.text === "string" &&
    typeof r.dueAt === "number" &&
    Number.isFinite(r.dueAt) &&
    typeof r.createdAt === "number" &&
    (r.status === "pending" || r.status === "fired" || r.status === "dismissed")
  );
}

/**
 * Local reminders (reminders.json in the app's data folder) with exactly one
 * timer, armed for the next pending reminder. Reminders that came due while
 * the app was closed fire as soon as it starts.
 */
export class ReminderStore {
  private items: Reminder[];
  private readonly file: string;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private onDue: (r: Reminder) => void = () => {};
  private onChange: () => void = () => {};

  constructor(
    dir: string,
    private readonly now: () => number = Date.now,
  ) {
    this.file = path.join(dir, "reminders.json");
    const raw = readJson(this.file);
    this.items = Array.isArray(raw) ? raw.filter(isReminder).slice(-MAX_REMINDERS) : [];
  }

  /** Starts scheduling. `onDue` runs once per reminder when it comes due. */
  start(onDue: (r: Reminder) => void, onChange: () => void = () => {}): void {
    this.onDue = onDue;
    this.onChange = onChange;
    this.arm();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  list(): Reminder[] {
    return this.items
      .filter((r) => r.status !== "dismissed")
      .sort((a, b) => a.dueAt - b.dueAt)
      .map((r) => ({ ...r }));
  }

  add(text: string, dueAt: number): { ok: true; reminder: Reminder } | { ok: false; error: string } {
    const clean = text.trim().slice(0, MAX_REMINDER_TEXT);
    if (!clean) return { ok: false, error: "A reminder needs some text." };
    if (!Number.isFinite(dueAt) || dueAt - this.now() > MAX_REMINDER_AHEAD_MS) return { ok: false, error: "That time is out of range." };
    // Drop old dismissed ones first if the list is full.
    if (this.items.length >= MAX_REMINDERS) this.items = this.items.filter((r) => r.status !== "dismissed");
    if (this.items.length >= MAX_REMINDERS) return { ok: false, error: `You can have up to ${MAX_REMINDERS} reminders.` };
    const reminder: Reminder = { id: randomUUID(), text: clean, dueAt: Math.round(dueAt), createdAt: this.now(), status: "pending" };
    this.items.push(reminder);
    this.save();
    this.arm();
    return { ok: true, reminder: { ...reminder } };
  }

  dismiss(id: string): boolean {
    const r = this.items.find((x) => x.id === id);
    if (!r) return false;
    r.status = "dismissed";
    this.save();
    this.arm();
    return true;
  }

  remove(id: string): boolean {
    const before = this.items.length;
    this.items = this.items.filter((r) => r.id !== id);
    if (this.items.length === before) return false;
    this.save();
    this.arm();
    return true;
  }

  /** Fires everything that is due, then arms one timer for the next pending reminder. */
  private arm(): void {
    this.stop();
    const now = this.now();
    for (const r of this.items) {
      if (r.status === "pending" && r.dueAt <= now) {
        r.status = "fired";
        this.save();
        this.onDue({ ...r });
      }
    }
    const next = this.items.filter((r) => r.status === "pending").sort((a, b) => a.dueAt - b.dueAt)[0];
    if (next) this.timer = setTimeout(() => this.arm(), Math.min(MAX_TIMER_MS, Math.max(0, next.dueAt - now)));
  }

  private save(): void {
    try {
      writeJsonAtomic(this.file, this.items);
    } catch {
      console.warn("[reminders] Could not save reminders.");
    }
    this.onChange();
  }
}
