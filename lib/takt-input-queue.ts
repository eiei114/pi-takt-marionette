import { isDestructiveTaktAutoInput } from "./takt-input-mode.ts";

export interface TaktQueuedInput {
  readonly text: string;
  readonly queuedAt: string;
}

export interface TaktQueueFlushResult {
  /** Non-destructive queued lines joined in original order; undefined when nothing was sendable. */
  batch?: string;
  /** Destructive entries held back instead of sent; they stay in the queue. */
  heldDestructive: number;
  sentCount: number;
}

/**
 * Per-project buffer for input typed while the bridge-owned TAKT session
 * cannot accept it. Order is preserved; destructive lines are never auto-sent.
 */
export function createTaktInputQueue(
  initialItems: readonly TaktQueuedInput[] = [],
  onChange?: (items: readonly TaktQueuedInput[]) => void,
) {
  const items: TaktQueuedInput[] = initialItems.map((item) => ({ ...item }));
  const changed = (): void => onChange?.(items.map((item) => ({ ...item })));
  return {
    depth(): number {
      return items.length;
    },
    enqueue(text: string): number {
      const normalized = text.length > 0 ? text : "";
      if (normalized.length === 0) {
        return items.length;
      }
      items.push({ text: normalized, queuedAt: new Date().toISOString() });
      changed();
      return items.length;
    },
    /**
     * Remove all sendable entries and join them in order. Destructive entries
     * stay queued so a human can confirm or clear them explicitly.
     */
    takeBatch(): TaktQueueFlushResult {
      const sendable = items.filter((item) => !isDestructiveTaktAutoInput(item.text));
      const held = items.filter((item) => isDestructiveTaktAutoInput(item.text));
      items.length = 0;
      items.push(...held);
      changed();
      const batch = sendable.length > 0 ? sendable.map((item) => item.text).join("\n") : undefined;
      return {
        ...(batch !== undefined ? { batch } : {}),
        heldDestructive: held.length,
        sentCount: sendable.length,
      };
    },
    clearAll(): void {
      items.length = 0;
      changed();
    },
    snapshot(): readonly TaktQueuedInput[] {
      return items.map((item) => ({ ...item }));
    },
    restore(nextItems: readonly TaktQueuedInput[]): void {
      items.length = 0;
      items.push(...nextItems.map((item) => ({ ...item })));
      changed();
    },
  };
}

export type TaktInputQueue = ReturnType<typeof createTaktInputQueue>;
