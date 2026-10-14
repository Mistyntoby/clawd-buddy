import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { MAX_TODOS, MAX_TODO_TEXT, type Todo } from "../shared/todos";
import { readJson, writeJsonAtomic } from "./settings";

function isTodo(v: unknown): v is Todo {
  if (typeof v !== "object" || v === null) return false;
  const t = v as Record<string, unknown>;
  return typeof t.id === "string" && typeof t.text === "string" && typeof t.done === "boolean" && typeof t.createdAt === "number";
}

/** A tiny local to-do list (todos.json in the app's data folder). */
export class TodoStore {
  private items: Todo[];
  private readonly file: string;
  private onChange: () => void = () => {};

  constructor(
    dir: string,
    private readonly now: () => number = Date.now,
  ) {
    this.file = path.join(dir, "todos.json");
    const raw = readJson(this.file);
    this.items = Array.isArray(raw) ? raw.filter(isTodo).slice(0, MAX_TODOS) : [];
  }

  watch(onChange: () => void): void {
    this.onChange = onChange;
  }

  /** Open items first (oldest first), then finished ones. */
  list(): Todo[] {
    return [...this.items.filter((t) => !t.done), ...this.items.filter((t) => t.done)].map((t) => ({ ...t }));
  }

  add(text: string): { ok: true; todo: Todo } | { ok: false; error: string } {
    // eslint-disable-next-line no-control-regex -- deliberately stripping control characters
    const clean = (typeof text === "string" ? text : "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, MAX_TODO_TEXT);
    if (!clean) return { ok: false, error: "A to-do needs some text." };
    if (this.items.length >= MAX_TODOS) this.items = this.items.filter((t) => !t.done);
    if (this.items.length >= MAX_TODOS) return { ok: false, error: `You can have up to ${MAX_TODOS} to-dos.` };
    const todo: Todo = { id: randomUUID(), text: clean, done: false, createdAt: this.now() };
    this.items.push(todo);
    this.save();
    return { ok: true, todo: { ...todo } };
  }

  setDone(id: string, done: boolean): boolean {
    const t = this.items.find((x) => x.id === id);
    if (!t) return false;
    t.done = done;
    this.save();
    return true;
  }

  remove(id: string): boolean {
    const before = this.items.length;
    this.items = this.items.filter((t) => t.id !== id);
    if (this.items.length === before) return false;
    this.save();
    return true;
  }

  /** Removes finished items. Returns how many were removed. */
  clearDone(): number {
    const before = this.items.length;
    this.items = this.items.filter((t) => !t.done);
    const removed = before - this.items.length;
    if (removed) this.save();
    return removed;
  }

  private save(): void {
    try {
      writeJsonAtomic(this.file, this.items);
    } catch {
      console.warn("[todos] Could not save to-dos.");
    }
    this.onChange();
  }
}
