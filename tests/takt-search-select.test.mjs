import assert from "node:assert/strict";
import test from "node:test";

const { SearchableListController } = await import("../lib/takt-search-select.ts");

const ITEMS = [
  "anthropic/claude-opus-4-8",
  "anthropic/claude-haiku-4-5",
  "cursor/auto",
  "openai-codex/gpt-5-codex",
];

test("searchable list filters as the user types and resets highlight", () => {
  const controller = new SearchableListController(ITEMS);
  assert.equal(controller.visible().length, 4);

  // Subsequence matching: "auto" only survives inside cursor/auto.
  for (const char of "auto") {
    controller.handleInput(char);
  }
  assert.deepEqual(controller.visible().map((entry) => entry.text), ["cursor/auto"]);

  controller.handleInput("\u007f"); // backspace clears the query one char at a time
  controller.handleInput("\u007f");
  controller.handleInput("\u007f");
  controller.handleInput("\u007f");
  assert.equal(controller.getQuery(), "");
  assert.equal(controller.visible().length, 4);
});

test("searchable list confirms highlighted entry", () => {
  const controller = new SearchableListController(ITEMS);

  // Type a filter that leaves exactly one match, then confirm it.
  for (const char of "codex") {
    assert.equal(controller.handleInput(char), "changed");
  }
  assert.deepEqual(controller.visible().map((entry) => entry.text), ["openai-codex/gpt-5-codex"]);
  assert.equal(controller.getHighlightedValue(), "openai-codex/gpt-5-codex");
  assert.equal(controller.handleInput("\r"), "confirmed");
});

test("searchable list ignores Enter with no match and confirms after backspacing", () => {
  const controller = new SearchableListController(ITEMS);

  for (const char of "autoz") {
    controller.handleInput(char);
  }
  assert.deepEqual(controller.visible(), []);
  assert.equal(controller.handleInput("\r"), "ignored");
  assert.equal(controller.getQuery(), "autoz");
  assert.equal(controller.handleInput("\u007f"), "changed");
  assert.equal(controller.getHighlightedValue(), "cursor/auto");
  assert.equal(controller.handleInput("\r"), "confirmed");
});

test("searchable list cancels on Escape even with no match", () => {
  const controller = new SearchableListController(ITEMS);
  controller.handleInput("z");
  assert.deepEqual(controller.visible(), []);
  assert.equal(controller.handleInput("\x1b"), "cancelled");
});

test("searchable list moves highlight with arrow keys only within matches", () => {
  const controller = new SearchableListController(["a/one", "b/two"]);

  assert.equal(controller.handleInput("\x1b[B"), "changed"); // down
  assert.equal(controller.getHighlightedValue(), "b/two");
  assert.equal(controller.handleInput("\x1b[B"), "changed");
  assert.equal(controller.getHighlightedValue(), "b/two"); // clamped at end

  controller.handleInput("\x1b[A"); // up
  assert.equal(controller.getHighlightedValue(), "a/one");

  assert.equal(controller.handleInput("\x1b"), "cancelled");
});

test("searchable list ignores control chunks and empty backspace", () => {
  const controller = new SearchableListController(["only"]);
  assert.equal(controller.handleInput("\x1b[200~"), "ignored"); // bracketed paste marker
  assert.equal(controller.handleInput("\u007f"), "ignored"); // backspace with empty query
  assert.equal(controller.getQuery(), "");
});
