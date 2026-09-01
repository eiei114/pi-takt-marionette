# TAKT Marionette

A Pi extension that runs and monitors TAKT projects in stacked live terminal widgets inside Pi.

## Language

**Run outcome** (完了成績):
The terminal ✅/❌ state of a finished TAKT run — success or failure — surfaced in the live widget.
_Avoid_: result, 終了表示, exit state

**Run outcome retention** (完了行の保持):
The rule that a finished run's outcome row stays visible in the session-owned widget while its latest activity is within three days. Older non-running history is hidden from presentation surfaces, but its TAKT metadata remains available for explicit diagnostics.
_Avoid_: 完了表示の永続化, outcome persistence

**Session history visibility** (セッション履歴の表示範囲):
Presentation-only filtering shared by session completion, `/takt:live`, `/takt:sessions`, `/takt:inspect`, `@` completion, and the session-owned widget. Running, pending, and blocked work stays visible; completed, failed, stale, or aborted history expires after three days without activity. The bridge never deletes `.takt` tasks or run records.
_Avoid_: 履歴データの削除, automatic cleanup

**Session-owned widget** (セッション所有ウィジェット):
The stacked project widget whose contents are owned by the Pi session that launched the TAKT process; external activity is excluded.
_Avoid_: global status card

**Name elision** (名前の省略):
Width-aware `head…tail` shortening of long project labels, workflow names, and step names in live-widget rows, applied only after the row's fixed parts — status text and the elapsed/completion time — have been reserved. Names share the leftover width by priority: label > workflow > step.
_Avoid_: 末尾のぶった切り, right-edge clipping

**Mode-cycle terminal interceptor** (モード切替の端末境界インターセプター):
The raw-input listener that normalizes F6 and Ctrl+Option+T/Ctrl+Alt+T bytes before Pi's editor or the focused TAKT PTY receives them. It exists as a macOS terminal compatibility path; unknown bytes pass through unchanged.
_Avoid_: global input forwarding, PTY hijack
