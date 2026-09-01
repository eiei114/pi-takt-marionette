# TAKT Marionette

A Pi extension that runs and monitors TAKT projects in stacked live terminal widgets inside Pi.

## Language

**Run outcome** (完了成績):
The terminal ✅/❌ state of a finished TAKT run — success or failure — surfaced in the live widget.
_Avoid_: result, 終了表示, exit state

**Run outcome retention** (完了行の保持):
The rule that a finished run's outcome row stays visible in the session-owned widget until the project's next run starts or the Pi session ends.
_Avoid_: 完了表示の永続化, outcome persistence

**Session-owned widget** (セッション所有ウィジェット):
The stacked project widget whose contents are owned by the Pi session that launched the TAKT process; external activity is excluded.
_Avoid_: global status card

**Name elision** (名前の省略):
Width-aware `head…tail` shortening of long project labels, workflow names, and step names in live-widget rows, applied only after the row's fixed parts — status text and the elapsed/completion time — have been reserved. Names share the leftover width by priority: label > workflow > step.
_Avoid_: 末尾のぶった切り, right-edge clipping