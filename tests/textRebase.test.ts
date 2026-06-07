import assert from "node:assert/strict";
import test from "node:test";

import { rebaseTextChange } from "../src-core/engine";

test("text changes are rebased onto current replicated content", () => {
  const oldText = "A\nC\n";
  const currentText = "A\nB\nC\n";
  const newText = "A\nC!\n";

  const result = rebaseTextChange(oldText, currentText, newText);

  assert.equal(result.text, "A\nB\nC!\n");
  assert.deepEqual(result.patchResults, [true]);
});

test("text rebase returns new text directly when current text matches old text", () => {
  const result = rebaseTextChange("hello", "hello", "hello world");

  assert.equal(result.text, "hello world");
  assert.deepEqual(result.patchResults, []);
});
