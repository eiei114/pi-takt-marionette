import { t } from "./takt-i18n.ts";
import {
  getTaktModeCompatibilityShortcutLabel,
  getTaktModeShortcutLabel,
} from "./takt-keyboard.ts";

export {
  createTaktKeyboardAdapter,
  getTaktModeCompatibilityShortcutLabel,
  getTaktModeShortcutLabel,
  isCtrlAltTSequence,
  isF6Sequence,
  isTaktModeCycleSequence,
  normalizeTaktKeyboardPlatform,
  type TaktKeyboardAction,
  type TaktKeyboardAdapter,
  type TaktKeyboardPlatform,
} from "./takt-keyboard.ts";

export const TAKT_INPUT_MODES = ["pi", "takt", "pi-auto"] as const;

export type TaktInputMode = (typeof TAKT_INPUT_MODES)[number];

const DESTRUCTIVE_AUTO_INPUT =
  /(?:^|\s)(?:\/(?:clear|stop|abort|cancel|quit|exit)\b|takt\s+clear\b|rm\s+-rf\b|del\s+\/[sq]\b)/i;

/** Move one step around the dual-input cycle. */
export function cycleTaktInputMode(mode: TaktInputMode): TaktInputMode {
  const index = TAKT_INPUT_MODES.indexOf(mode);
  return TAKT_INPUT_MODES[(index + 1) % TAKT_INPUT_MODES.length] ?? "pi";
}

/** Parse a mode token from `/takt:mode` args. */
export function parseTaktInputMode(value: string | undefined): TaktInputMode | "cycle" | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return "cycle";
  }
  if (normalized === "cycle" || normalized === "next") {
    return "cycle";
  }
  if ((TAKT_INPUT_MODES as readonly string[]).includes(normalized)) {
    return normalized as TaktInputMode;
  }
  return undefined;
}

/** Compact widget/status label for the three-state cycle. */
export function formatTaktInputModeLine(
  mode: TaktInputMode,
  platform: NodeJS.Platform | string = process.platform,
): string {
  // Zero jargon: the line must answer "who is typing right now?" by itself.
  const message = (() => {
    switch (mode) {
      case "pi":
        return t("modePi");
      case "takt":
        return t("modeTakt");
      case "pi-auto":
        return t("modeAuto");
    }
  })();
  return `${message} · ${t("modeCycleHint", { shortcut: getTaktModeShortcutLabel(platform) })}`;
}

/** Human-readable mode description for notifications. */
export function describeTaktInputMode(
  mode: TaktInputMode,
  platform: NodeJS.Platform | string = process.platform,
): string {
  const cycleShortcut = getTaktModeShortcutLabel(platform);
  const compatibilityShortcut = getTaktModeCompatibilityShortcutLabel(platform);
  switch (mode) {
    case "pi":
      return "Pi editor focus; TAKT input only via /takt:send or tools";
    case "takt":
      return `TAKT fullscreen focus; keys go to the pinned bridge-owned PTY (Esc returns to Pi; switch back with ${cycleShortcut}, /takt:mode, or ${compatibilityShortcut})`;
    case "pi-auto":
      return "Pi-auto; Pi may send allowed follow-ups to the active bridge-owned PTY";
  }
}

/**
 * Detect auto-input that should keep a human confirmation gate even in
 * pi-auto mode. This is intentionally conservative.
 */
export function isDestructiveTaktAutoInput(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.includes("\u0003")) {
    return true;
  }
  return DESTRUCTIVE_AUTO_INPUT.test(trimmed);
}
