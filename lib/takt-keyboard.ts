import { Key, matchesKey } from "@earendil-works/pi-tui";

export type TaktKeyboardPlatform = "darwin" | "win32" | "other";
export type TaktKeyboardAction = "cycle-input-mode";

/**
 * Normalize the host platform for keyboard policy and presentation.
 *
 * The terminal, not the operating system, ultimately decides which bytes
 * arrive here. Keeping this normalization at the adapter boundary prevents
 * platform checks from leaking into the input-mode state machine.
 */
export function normalizeTaktKeyboardPlatform(platform: NodeJS.Platform | string = process.platform): TaktKeyboardPlatform {
  if (platform === "darwin" || platform === "win32") {
    return platform;
  }
  return "other";
}

export function getTaktModeShortcutLabel(platform: NodeJS.Platform | string = process.platform): string {
  return normalizeTaktKeyboardPlatform(platform) === "darwin" ? "F6 / Fn+F6" : "F6";
}

export function getTaktModeCompatibilityShortcutLabel(platform: NodeJS.Platform | string = process.platform): string {
  return normalizeTaktKeyboardPlatform(platform) === "darwin" ? "Ctrl+Option+T" : "Ctrl+Alt+T";
}

/**
 * Raw terminal encodings observed for Ctrl+Alt+T / Ctrl+Option+T.
 *
 * `matchesKey` covers the canonical encoding. These explicit forms keep the
 * interceptor compatible with terminals using modifyOtherKeys or Kitty CSI-u.
 */
export function isCtrlAltTSequence(data: string): boolean {
  if (data === "\u001b\u0014") {
    return true;
  }
  return /^\u001b\[(?:27;7t|20;7t|27;7u|20;7u)$/.test(data);
}

export function isF6Sequence(data: string): boolean {
  return matchesKey(data, Key.f6);
}

export interface TaktKeyboardAdapter {
  readonly platform: TaktKeyboardPlatform;
  readonly cycleModeShortcut: string;
  readonly compatibilityShortcut: string;
  match(data: string): TaktKeyboardAction | undefined;
}

/**
 * Build the terminal-input policy used by Pi's raw-input interceptor.
 *
 * F6 is the portable primary shortcut on every platform. macOS only changes
 * the displayed hint (`Fn+F6` when function keys are media keys); Option/Ctrl
 * remains a compatibility alias and is never the primary path.
 */
export function createTaktKeyboardAdapter(
  platform: NodeJS.Platform | string = process.platform,
): TaktKeyboardAdapter {
  const normalizedPlatform = normalizeTaktKeyboardPlatform(platform);
  return {
    platform: normalizedPlatform,
    cycleModeShortcut: getTaktModeShortcutLabel(normalizedPlatform),
    compatibilityShortcut: getTaktModeCompatibilityShortcutLabel(normalizedPlatform),
    match(data: string): TaktKeyboardAction | undefined {
      if (isF6Sequence(data) || matchesKey(data, Key.ctrlAlt("t")) || isCtrlAltTSequence(data)) {
        return "cycle-input-mode";
      }
      return undefined;
    },
  };
}

export function isTaktModeCycleSequence(
  data: string,
  platform: NodeJS.Platform | string = process.platform,
): boolean {
  return createTaktKeyboardAdapter(platform).match(data) === "cycle-input-mode";
}
