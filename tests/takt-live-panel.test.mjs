import assert from "node:assert/strict";
import test from "node:test";

const xterm = await import("@xterm/headless");
const { visibleWidth } = await import("@earendil-works/pi-tui");
const { createTaktLiveWidget, createTaktProjectStackWidget, renderTaktProjectStack, renderTaktTerminal } = await import("../lib/takt-live-panel.ts");
const { renderTaktWorkflowProgress } = await import("../lib/takt-progress.ts");
const Terminal = xterm.default?.Terminal ?? xterm.Terminal;

test("workflow progress renders an ASCII bar with the current step and phase", () => {
  const line = renderTaktWorkflowProgress({
    run: {
      slug: "run",
      task: "task",
      workflow: "default",
      workflowSteps: ["plan", "implement", "review"],
      status: "running",
      sessionStatus: "live",
      currentStep: "implement",
      phase: 1,
      currentIteration: 2,
    },
  });

  assert.match(line ?? "", /flow default \[[#>-]+\]/);
  assert.match(line ?? "", /2\/3 step: implement/);
  assert.match(line ?? "", /p1\/3 execute/);
});

test("workflow progress falls back to bridge lifecycle before run metadata exists", () => {
  const line = renderTaktWorkflowProgress({ bridgeStage: "waiting_prompt" });
  assert.match(line ?? "", /bridge \[[#>-]+\]/);
  assert.match(line ?? "", /stage waiting prompt/);
});

test("live widget renders the PTY screen instead of raw cursor escapes", async () => {
  const terminal = new Terminal({ cols: 24, rows: 4, allowProposedApi: true });
  await new Promise((resolve) => {
    terminal.write("\u001b[31mRED\u001b[0m\r\nplain\u001b[2;5Hcursor", resolve);
  });

  const lines = renderTaktTerminal(terminal);
  assert.match(lines[0], /RED/);
  assert.match(lines[1], /plai/);
  assert.ok(lines.some((line) => line.includes("\u001b[")));
  assert.ok(!lines.some((line) => line.includes("\u001b[2;5H")));
  terminal.dispose();
});

test("normal buffer with scrollback renders the current bottom viewport, not row zero", async () => {
  const terminal = new Terminal({ cols: 12, rows: 3, scrollback: 100, allowProposedApi: true });
  await new Promise((resolve) => {
    terminal.write("line-01\r\nline-02\r\nline-03\r\nline-04", resolve);
  });

  // Buffer holds four lines but only three visible rows: the viewport must
  // show the bottom page (lines 02-04), never stale top-of-scrollback line-01.
  const lines = renderTaktTerminal(terminal);
  assert.ok(lines.some((line) => line.includes("line-02")), String(lines));
  assert.ok(lines.some((line) => line.includes("line-03")));
  assert.ok(lines.some((line) => line.includes("line-04")));
  assert.ok(lines.every((line) => !line.includes("line-01")), String(lines));
  assert.equal(lines.length, 3);
  terminal.dispose();
});

test("cursor marker stays on the correct rendered row after normal-buffer scrollback", async () => {
  const { CURSOR_MARKER } = await import("@earendil-works/pi-tui");
  const terminal = new Terminal({ cols: 12, rows: 3, scrollback: 100, allowProposedApi: true });
  await new Promise((resolve) => {
    terminal.write("row-one\r\nrow-two\r\nrow-three\r\nlast", resolve);
  });

  const lines = renderTaktTerminal(terminal, { showCursor: true });
  // Cursor sits after "last" on the absolute buffer row rendered as index 2.
  const cursorLine = lines.findIndex((line) => line.includes(CURSOR_MARKER));
  assert.ok(cursorLine >= 0, "cursor marker missing");
  assert.equal(cursorLine, 2);
  assert.match(lines[cursorLine].replace(CURSOR_MARKER, ""), /last/);
  terminal.dispose();
});

test("alternate-screen output keeps rendering from its own screen origin", async () => {
  const terminal = new Terminal({ cols: 12, rows: 3, scrollback: 100, allowProposedApi: true });
  await new Promise((resolve) => {
    terminal.write("scroll-a\r\nscroll-b\r\nscroll-c\r\nscroll-d", resolve);
  });
  await new Promise((resolve) => {
    terminal.write("\u001b[?1049h\u001b[HALT-TOP\r\nALT-MID\r\nALT-BOT", resolve);
  });

  const lines = renderTaktTerminal(terminal);
  assert.match(lines[0] ?? "", /ALT-TOP/);
  assert.match(lines[1] ?? "", /ALT-MID/);
  assert.match(lines[2] ?? "", /ALT-BOT/);
  assert.ok(lines.every((line) => !line.includes("scroll-")), String(lines));

  // Full-screen TUI redraw at home position still lands on row zero.
  await new Promise((resolve) => terminal.write("\u001b[HREDRAWN", resolve));
  const redrawn = renderTaktTerminal(terminal);
  assert.match(redrawn[0] ?? "", /^REDRAWN|REDRAWN/);

  await new Promise((resolve) => terminal.write("\u001b[?1049l", resolve));
  assert.ok(renderTaktTerminal(terminal).some((line) => line.includes("scroll-d")));
  terminal.dispose();
});

test("live widget keeps Pi focus and shows the current TAKT screen", async () => {
  const terminal = new Terminal({ cols: 24, rows: 20, allowProposedApi: true });
  await new Promise((resolve) => terminal.write("first\r\nsecond", resolve));
  let listener;
  const runner = {
    terminal,
    subscribe(callback) {
      listener = callback;
      return () => {
        listener = undefined;
      };
    },
    resize() {},
  };
  const widget = createTaktLiveWidget(runner, { requestRender() {} });

  const lines = widget.render(24);
  assert.ok(lines.some((line) => line.includes("first")));
  assert.ok(lines.some((line) => line.includes("second")));
  assert.ok(!lines.some((line) => line.includes("\u001b_pi:c\u0007")));
  assert.equal(typeof listener, "function");
  widget.dispose();
  terminal.dispose();
});

test("project stack shows session-owned rows with spinner and hides raw output", async () => {
  const liveTerminal = new Terminal({ cols: 30, rows: 8, allowProposedApi: true });
  await new Promise((resolve) => liveTerminal.write("repo-a live output", resolve));
  const liveRunner = {
    terminal: liveTerminal,
    hasSession: true,
    isRunning: true,
    resize() {},
  };
  const observedSummary = {
    cwd: "C:/repo-b",
    status: "live",
    running: 1,
    pending: 0,
    blocked: 0,
    failed: 0,
    completed: 0,
    stale: 0,
    runs: [{ slug: "run-b", task: "repo-b task", workflow: "default", status: "running", sessionStatus: "live" }],
  };

  const lines = renderTaktProjectStack([
    { id: "b", label: "repo-b", cwd: "C:/repo-b", summary: observedSummary },
    { id: "a", label: "repo-a", cwd: "C:/repo-a", runner: liveRunner },
  ], 60, "pi", { now: Date.parse("2026-08-20T00:00:00.000Z") });

  assert.ok(lines[0]?.includes("typing in Pi"), String(lines[0]));
  // Marionette header with the owned-session count.
  assert.ok(lines.some((line) => line.includes("🎭 TAKT · 1 session")));
  // Externally started projects never render here...
  assert.ok(lines.every((line) => !line.includes("repo-b")));
  // ...and raw PTY output stays out of the default widget.
  assert.ok(lines.every((line) => !line.includes("live output")));
  // The owned session shows as a spinner row.
  const { taktSpinnerFrame } = await import("../lib/takt-live-panel.ts");
  assert.ok(lines.some((line) => line.includes(taktSpinnerFrame(Date.parse("2026-08-20T00:00:00.000Z"))) && line.includes("🟢 repo-a")));

  const autoLines = renderTaktProjectStack([
    { id: "a", label: "repo-a", cwd: "C:/repo-a", runner: liveRunner },
  ], 30, "pi-auto");
  assert.ok(autoLines[0]?.includes("Autopilot"));
  liveTerminal.dispose();
});

test("project stack keeps requesting renders while a live PTY screen changes", async () => {
  const terminal = new Terminal({ cols: 30, rows: 8, allowProposedApi: true });
  const runner = {
    terminal,
    hasSession: true,
    isRunning: true,
    resize() {},
    subscribe() {
      return () => {};
    },
  };
  const source = {
    getProjects() {
      return [{ id: "live", label: "live", cwd: "C:/live", runner, stage: "running" }];
    },
    getInputMode() {
      return "pi-auto";
    },
    subscribe() {
      return () => {};
    },
  };
  let renders = 0;
  let widget;
  const frames = [];
  widget = createTaktProjectStackWidget(source, {
    requestRender() {
      renders += 1;
      frames.push(widget.render(30));
    },
  });

  await new Promise((resolve) => terminal.write("live output", resolve));
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.ok(renders > 0);
  // Raw output no longer appears in the stack; frames still render the row.
  assert.ok(frames.every((frame) => frame.every((line) => !line.includes("live output"))));
  assert.ok(frames.some((frame) => frame.some((line) => line.includes("🟢 live"))));

  widget.dispose();
  const rendersAfterDispose = renders;
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(renders, rendersAfterDispose);
  terminal.dispose();
});

test("project stack shows input mode even with no active sessions", () => {
  const lines = renderTaktProjectStack([], 40, "takt");
  assert.match(lines[0] ?? "", /typing into TAKT/);
  assert.ok(lines.some((line) => line.includes("no active sessions")));
});

test("project stack hides quiet observed pending activity after the inactivity TTL", () => {
  const now = Date.parse("2026-08-14T01:00:00.000Z");
  const project = {
    id: "pending",
    label: "pending",
    cwd: "C:/pending",
    summary: {
      cwd: "C:/pending",
      status: "completed",
      running: 0,
      pending: 1,
      blocked: 0,
      failed: 0,
      completed: 0,
      stale: 0,
      activityAt: "2026-08-14T00:00:00.000Z",
      runs: [],
    },
  };

  const lines = renderTaktProjectStack([project], 80, "pi", { now });
  assert.ok(lines.every((line) => !line.includes("[pending]")));
  assert.ok(lines.some((line) => line.includes("no active sessions")));
});

test("project stack hides observed pending activity entirely; use /takt:status instead", () => {
  const now = Date.parse("2026-08-14T01:00:00.000Z");
  const lines = renderTaktProjectStack([{
    id: "pending",
    label: "pending",
    cwd: "C:/pending",
    summary: {
      cwd: "C:/pending",
      status: "completed",
      running: 0,
      pending: 1,
      blocked: 0,
      failed: 0,
      completed: 0,
      stale: 0,
      activityAt: "2026-08-14T00:45:00.000Z",
      runs: [],
    },
  }], 80, "pi", { now });

  assert.ok(lines.every((line) => !line.includes("[pending]")));
  assert.ok(lines.every((line) => !line.includes("1 pending")));
  assert.ok(lines.some((line) => line.includes("no active sessions")));
});

test("project stack retains run outcomes: stopped hides, completed and failed stay", () => {
  const runner = {
    terminal: undefined,
    hasSession: true,
    isRunning: false,
    resize() {},
  };

  // A manually stopped session is never rendered as success.
  const stopped = renderTaktProjectStack([
    { id: "finished", label: "finished", cwd: "C:/finished", runner, stage: "stopped" },
  ], 40);
  assert.ok(stopped.every((line) => !line.includes("[finished]")));
  assert.ok(stopped.some((line) => line.includes("no active sessions")));

  // A finished run stays visible as a ✅ outcome row until the next run.
  const completed = renderTaktProjectStack([
    { id: "done", label: "done", cwd: "C:/done", runner, stage: "completed",
      summary: {
        cwd: "C:/done", status: "completed", running: 0, pending: 0, blocked: 0,
        failed: 0, completed: 1, stale: 0,
        runs: [{ slug: "r1", task: "t", workflow: "w", status: "completed", sessionStatus: "completed" }],
      } },
  ], 60);
  assert.ok(completed.some((line) => line.includes("✅ done")), String(completed));
  assert.ok(completed.every((line) => !line.includes("no active sessions")));

  // A failed run stays visible as a conclusion-only 🔴 row (no reason detail).
  const failed = renderTaktProjectStack([
    { id: "bad", label: "bad", cwd: "C:/bad", runner, stage: "failed",
      summary: {
        cwd: "C:/bad", status: "failed", running: 0, pending: 0, blocked: 0,
        failed: 1, completed: 0, stale: 0,
        runs: [{ slug: "r2", task: "t", workflow: "w", status: "failed", sessionStatus: "completed",
          failure: "some long failure reason that must stay out of the row" }],
      } },
  ], 80);
  assert.ok(failed.some((line) => line.includes("🔴 bad") && line.includes("❌")), String(failed));
  assert.ok(failed.every((line) => !line.includes("failure reason")), String(failed));
});

test("project stack shows the completion duration on the retained success row", () => {
  const now = Date.parse("2026-08-20T00:12:00.000Z");
  const lines = renderTaktProjectStack([{
    id: "finished",
    label: "finished",
    cwd: "C:/finished",
    runner: { terminal: undefined, hasSession: true, isRunning: false, resize() {} },
    stage: "completed",
    summary: {
      cwd: "C:/finished",
      status: "completed",
      running: 0, pending: 0, blocked: 0, failed: 0, completed: 1, stale: 0,
      runs: [{
        slug: "finished-run", task: "finished task", workflow: "default",
        status: "completed", sessionStatus: "completed",
        startTime: new Date(now - 720_000).toISOString(),
        endTime: new Date(now - 180_000).toISOString(),
      }],
    },
  }], 80, "pi", { now });

  assert.ok(lines.some((line) => line.includes("✅ finished") && line.includes("9m")), String(lines));
});

test("project stack keeps multiple retained outcome rows, newest first", () => {
  const runner = {
    terminal: undefined,
    hasSession: true,
    isRunning: false,
    resize() {},
  };
  const makeSummary = (endTime) => ({
    cwd: "C:/p", status: "completed", running: 0, pending: 0, blocked: 0,
    failed: 0, completed: 1, stale: 0,
    runs: [{ slug: "r", task: "t", workflow: "w", status: "completed",
      sessionStatus: "completed", endTime }],
  });
  const lines = renderTaktProjectStack([
    { id: "older", label: "older", cwd: "C:/older", runner, stage: "completed",
      summary: makeSummary("2026-08-20T00:10:00.000Z") },
    { id: "newer", label: "newer", cwd: "C:/newer", runner, stage: "completed",
      summary: makeSummary("2026-08-20T00:20:00.000Z") },
  ], 60);

  assert.ok(lines.some((line) => line.includes("✅ older")), String(lines));
  assert.ok(lines.some((line) => line.includes("✅ newer")), String(lines));
  const newerIndex = lines.findIndex((line) => line.includes("✅ newer"));
  const olderIndex = lines.findIndex((line) => line.includes("✅ older"));
  assert.ok(newerIndex >= 0 && olderIndex >= 0);
  assert.ok(newerIndex < olderIndex, `expected newer outcome above older: ${String(lines)}`);
});

test("project stack replaces the retained outcome row once the next run starts", () => {
  const runner = {
    terminal: undefined,
    hasSession: true,
    isRunning: true,
    resize() {},
  };
  const lines = renderTaktProjectStack([{
    id: "again",
    label: "again",
    cwd: "C:/again",
    runner,
    stage: "running",
    summary: {
      cwd: "C:/again", status: "live", running: 1, pending: 0, blocked: 0,
      failed: 0, completed: 1, stale: 0,
      runs: [{
        slug: "next", task: "t", workflow: "w",
        status: "running", sessionStatus: "live", currentStep: "plan",
      }],
    },
  }], 60, "pi", { now: Date.parse("2026-08-20T00:00:00.000Z") });

  assert.ok(lines.some((line) => line.includes("🟢 again")), String(lines));
  assert.ok(lines.every((line) => !line.includes("✅ again")), String(lines));
});

test("project stack keeps a live PTY when only a historical run is completed", () => {
  const lines = renderTaktProjectStack([
    {
      id: "finished",
      label: "finished",
      cwd: "C:/finished",
      runner: {
        terminal: undefined,
        hasSession: true,
        isRunning: true,
        resize() {},
      },
      stage: "running",
      summary: {
        cwd: "C:/finished",
        status: "completed",
        running: 0,
        pending: 0,
        blocked: 0,
        failed: 0,
        completed: 1,
        stale: 0,
        runs: [{
          slug: "finished-run",
          task: "finished task",
          workflow: "default",
          status: "completed",
          sessionStatus: "completed",
        }],
      },
    },
  ], 40);

  // The PTY is still owned and alive, so the session stays visible as an
  // actively operated string even though the last recorded run completed.
  assert.ok(lines.some((line) => line.includes("🟢 finished")));
});

test("project stack shows only the current project while TAKT is preparing", () => {
  const runner = {
    terminal: undefined,
    hasSession: true,
    isRunning: true,
    resize() {},
  };
  const lines = renderTaktProjectStack([
    { id: "other", label: "other", cwd: "C:/other", runner },
    { id: "current", label: "current", cwd: "C:/current", isCurrent: true, runner },
  ], 60);

  assert.ok(lines.some((line) => line.includes("⏳ current")));
  assert.ok(lines.some((line) => line.includes("starting…")));
  assert.ok(lines.every((line) => !line.includes("other · ")));
});

test("project stack collapses pasting into one compact line without the prompt body", async () => {
  const liveTerminal = new Terminal({ cols: 40, rows: 8, allowProposedApi: true });
  await new Promise((resolve) => liveTerminal.write("HUGE PASTED BODY SHOULD BE HIDDEN", resolve));
  const liveRunner = {
    terminal: liveTerminal,
    hasSession: true,
    isRunning: true,
    resize() {},
  };
  const lines = renderTaktProjectStack([
    {
      id: "a",
      label: "takt",
      cwd: "C:/repo",
      runner: liveRunner,
      stage: "pasting",
      promptPreview: "## Issue #1331\n…(12 more lines, 900 chars)\n## Done",
    },
  ], 60, "pi", { now: Date.parse("2026-08-20T00:00:00.000Z") });
  assert.ok(lines.some((line) => line.includes("📋 takt")));
  assert.ok(lines.some((line) => line.includes("pasting prompt (50 chars)")));
  assert.ok(!lines.some((line) => line.includes("Issue #1331")));
  assert.ok(!lines.some((line) => line.includes("HUGE PASTED BODY SHOULD BE HIDDEN")));
  liveTerminal.dispose();
});

test("project stack truncates long paths to the Pi widget width", () => {
  const width = 51;
  const lines = renderTaktProjectStack([
    {
      id: "long-path",
      label: "pi-docs",
      cwd: "C:/Users/Keisu/Projects/OSS/takt",
      runner: {
        terminal: undefined,
        hasSession: true,
        isRunning: true,
        resize() {},
      },
      stage: "running",
    },
  ], width);

  assert.ok(lines.length > 0);
  for (const [index, line] of lines.entries()) {
    assert.ok(visibleWidth(line) <= width, `line ${index} exceeds ${width}: ${visibleWidth(line)} columns`);
  }
});

test("auto-generated exec workflow names are hidden from session rows", () => {
  const lines = renderTaktProjectStack([{
    id: "a",
    label: "pg",
    cwd: "C:/pg",
    runner: { terminal: undefined, hasSession: true, isRunning: true, resize() {} },
    stage: "running",
    summary: {
      cwd: "C:/pg",
      status: "live",
      running: 1,
      pending: 0,
      blocked: 0,
      failed: 0,
      completed: 0,
      stale: 0,
      runs: [{
        slug: "r",
        task: "t",
        workflow: "exec-20260822-025402-use-the-trial-marionette-workf-fs36gxyz",
        status: "running",
        sessionStatus: "live",
        currentStep: "plan",
      }],
    },
  }], 90, "pi", { now: Date.parse("2026-08-20T00:00:00.000Z") });

  const row = lines.at(-1) ?? "";
  assert.ok(row.includes("🟢 pg"), row);
  assert.ok(!row.includes("exec"), row);
});




test("heartbeat spinner slows on stale activity and flags possible stalls", async () => {
  const { renderTaktProjectStack } = await import("../lib/takt-live-panel.ts");
  const now = Date.parse("2026-08-20T00:01:00.000Z");
  const baseRunner = {
    terminal: undefined,
    hasSession: true,
    isRunning: true,
    resize() {},
  };
  const makeSummary = (updatedAt) => ({
    cwd: "C:/pg",
    status: "live",
    running: 1,
    pending: 0,
    blocked: 0,
    failed: 0,
    completed: 0,
    stale: 0,
    runs: [{
      slug: "r",
      task: "t",
      workflow: "trial",
      status: "running",
      sessionStatus: "live",
      currentStep: "implement",
      updatedAt,
    }],
  });

  // Fresh output (5s ago) → normal 🟢 row.
  const fresh = renderTaktProjectStack([
    { id: "a", label: "pg", cwd: "C:/pg", runner: baseRunner, stage: "running",
      summary: makeSummary(new Date(now - 5_000).toISOString()) },
  ], 80, "pi", { now });
  assert.ok(fresh.some((line) => line.includes("🟢 pg")));

  // Silent for 40s → ⚠️ stall flag replaces the green dot.
  const stalled = renderTaktProjectStack([
    { id: "a", label: "pg", cwd: "C:/pg", runner: baseRunner, stage: "running",
      summary: makeSummary(new Date(now - 40_000).toISOString()) },
  ], 80, "pi", { now });
  assert.ok(stalled.some((line) => line.includes("⚠️") && line.includes("pg")));
  assert.ok(stalled.every((line) => !line.includes("🟢 pg")));
});

test("active rows tick a live elapsed timer from run start", () => {
  const now = Date.parse("2026-08-20T00:04:32.000Z");
  const lines = renderTaktProjectStack([{
    id: "a",
    label: "pg",
    cwd: "C:/pg",
    runner: { terminal: undefined, hasSession: true, isRunning: true, resize() {} },
    stage: "running",
    summary: {
      cwd: "C:/pg",
      status: "live",
      running: 1,
      pending: 0,
      blocked: 0,
      failed: 0,
      completed: 0,
      stale: 0,
      runs: [{
        slug: "r",
        task: "t",
        workflow: "trial",
        status: "running",
        sessionStatus: "live",
        startTime: new Date(now - 272_000).toISOString(),
        currentStep: "draft",
      }],
    },
  }], 80, "pi", { now });

  assert.ok(lines.some((line) => line.includes("⏱ 04:32")));
});
