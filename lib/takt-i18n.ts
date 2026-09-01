export type TaktLang = "en" | "ja";

let currentLang: TaktLang = "en";

/** Widget UI language; English by default, Japanese when configured. */
export function taktLang(): TaktLang {
  return currentLang;
}

export function setTaktLang(lang: TaktLang): TaktLang {
  currentLang = lang === "ja" ? "ja" : "en";
  return currentLang;
}

export function toggleTaktLang(): TaktLang {
  setTaktLang(currentLang === "ja" ? "en" : "ja");
  return currentLang;
}

export type MessageKey =
  | "modePi"
  | "modeTakt"
  | "modeAuto"
  | "modeCycleHint"
  | "noActiveSessions"
  | "headerSessions"
  | "runningCount"
  | "doneCount"
  | "startingCount"
  | "clearingStep"
  | "startingStep"
  | "waitingPromptStep"
  | "pastingPromptStep"
  | "sendingGoStep"
  | "staleState"
  | "workingState"
  | "doneState"
  | "failedState";

const MESSAGES: Record<TaktLang, Record<MessageKey, string>> = {
  en: {
    modePi: "⌨️ You are typing in Pi · TAKT runs beside you",
    modeTakt: "⌨️ You are typing into TAKT",
    modeAuto: "🤖 Autopilot on — Pi watches TAKT and answers follow-ups",
    modeCycleHint: "cycle: {shortcut} or /takt:mode",
    noActiveSessions: "🎭 TAKT · no active sessions",
    headerSessions: "🎭 TAKT · {count} session{plural} · {detail}",
    runningCount: "{n} running",
    doneCount: "{n} done",
    startingCount: "starting",
    clearingStep: "clearing previous session",
    startingStep: "starting…",
    waitingPromptStep: "waiting for prompt",
    pastingPromptStep: "pasting prompt ({chars} chars)",
    sendingGoStep: "sending /go",
    staleState: "stale",
    workingState: "working",
    doneState: "done",
    failedState: "failed",
  },
  ja: {
    modePi: "⌨️ Piに入力中 · TAKTは横で実行中",
    modeTakt: "⌨️ TAKTへ入力中",
    modeAuto: "🤖 自動操縦ON — PiがTAKTのフォローアップに応答",
    modeCycleHint: "サイクル: {shortcut} / /takt:mode",
    noActiveSessions: "🎭 TAKT · 動いているセッションなし",
    headerSessions: "🎭 TAKT · {count}セッション · {detail}",
    runningCount: "実行{n}",
    doneCount: "完了{n}",
    startingCount: "起動中",
    clearingStep: "前回セッション停止中",
    startingStep: "起動中…",
    waitingPromptStep: "プロンプト待ち",
    pastingPromptStep: "プロンプト貼付中 ({chars}文字)",
    sendingGoStep: "/go 送信中",
    staleState: "無応答",
    workingState: "処理中",
    doneState: "完了",
    failedState: "失敗",
  },
};

/** Format one widget message for the active language. `{placeholders}` interpolate params. */
export function t(key: MessageKey, params: Record<string, string | number> = {}): string {
  let message = MESSAGES[taktLang()][key];
  for (const [name, value] of Object.entries(params)) {
    message = message.replaceAll(`{${name}}`, String(value));
  }
  return message;
}
