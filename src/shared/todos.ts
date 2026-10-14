/** To-do item type and limits, shared by main and renderers. */
export interface Todo {
  id: string;
  text: string;
  done: boolean;
  createdAt: number;
}

export const MAX_TODOS = 200;
export const MAX_TODO_TEXT = 200;
