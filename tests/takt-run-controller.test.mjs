import assert from "node:assert/strict";
import test from "node:test";
import xterm from "@xterm/headless";
import {
  createTaktScreenTerminal,
  formatTaktPastedInput,
  terminalContainsText,
  terminalEndsWithText,
} from "../lib/takt-run-controller.ts";

const { Terminal } = xterm;

test("formatTaktPastedInput preserves multiline TAKT prompts as one bracketed paste", () => {
  assert.equal(
    formatTaktPastedInput("line one\r\nline two\rline three"),
    "\u001b[200~line one\nline two\nline three\u001b[201~\r",
  );
});

test("formatTaktPastedInput appends one terminal submit", () => {
  assert.equal(formatTaktPastedInput("/go"), "\u001b[200~/go\u001b[201~\r");
});

test("terminalContainsText finds the parsed TAKT input prompt", async () => {
  const terminal = new Terminal({ cols: 40, rows: 8, allowProposedApi: true, scrollback: 20 });
  await new Promise((resolve) => terminal.write("Preparing…\r\nAssistant> ", resolve));

  assert.equal(terminalContainsText(terminal, "Assistant>"), true);
  assert.equal(terminalEndsWithText(terminal, "Assistant>"), true);
  assert.equal(terminalContainsText(terminal, "Missing>"), false);
  terminal.dispose();
});

test("terminalEndsWithText ignores a previous Assistant> left in scrollback", async () => {
  const terminal = new Terminal({ cols: 40, rows: 8, allowProposedApi: true, scrollback: 20 });
  await new Promise((resolve) => {
    terminal.write("Assistant> \r\nworking on the task…\r\nmore output\r\n", resolve);
  });

  assert.equal(terminalContainsText(terminal, "Assistant>"), true);
  assert.equal(terminalEndsWithText(terminal, "Assistant>"), false);

  await new Promise((resolve) => terminal.write("Assistant> ", resolve));
  assert.equal(terminalEndsWithText(terminal, "Assistant>"), true);
  terminal.dispose();
});

test("terminalEndsWithText rejects a filled Assistant> input line", async () => {
  const terminal = new Terminal({ cols: 40, rows: 4, allowProposedApi: true });
  await new Promise((resolve) => terminal.write("Assistant> draft prompt", resolve));

  assert.equal(terminalContainsText(terminal, "Assistant>"), true);
  assert.equal(terminalEndsWithText(terminal, "Assistant>"), false);
  terminal.dispose();
});

test("createTaktScreenTerminal stays silent on stray PTY control bytes", async () => {
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => { errors.push(args); };
  try {
    const terminal = createTaktScreenTerminal(40, 8);
    // Gray SGR progress styling followed by a stray DEL is typical TAKT PTY
    // output. xterm.js flags the DEL as a parser error and would otherwise
    // dump `xterm.js: Parsing error: ...` plus parser state to the console,
    // which Pi surfaces in its TUI.
    await new Promise((resolve) => {
      terminal.write("gather 1/2 \u001b[90m⠙\u001b[0m working\x7f done", resolve);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(errors.length, 0);
    assert.equal(terminalContainsText(terminal, "done"), true);
    terminal.dispose();
  } finally {
    console.error = originalError;
  }
});
