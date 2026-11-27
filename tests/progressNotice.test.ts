import assert from "node:assert/strict";
import test from "node:test";
import { createProgressNoticeFragment } from "../src/progressNotice";

class ElementStub {
  children: ElementStub[] = [];
  textContent = "";
  attributes: Record<string, string> = {};
  classList = { add(_name: string) {} };
  constructor(public tag: string) {}
  appendChild(child: ElementStub) { this.children.push(child); return child; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
}
const doc = {
  createDocumentFragment: () => new ElementStub("fragment"),
  createElement: (tag: string) => new ElementStub(tag),
} as unknown as Document;

test("sync notice puts readable counts above the bar and ETA below it", () => {
  const fragment = createProgressNoticeFragment({ message: "Applying changes", current: 721, total: 11694, unit: "changes", etaSeconds: 2400 }, doc) as unknown as ElementStub;
  const children = fragment.children[0].children;
  assert.deepEqual(children.map((child) => child.tag), ["div", "div", "progress", "div", "div"]);
  assert.equal(children[0].textContent, "Applying changes");
  assert.equal(children[1].textContent, "721 / 11,694 changes · 6%");
  assert.equal(children[2].attributes["aria-label"], "Sync progress");
  assert.equal(children[3].textContent, "About 40 min remaining");
  assert.equal(children[4].textContent, "Keep Obsidian open.");
});

test("warming sync shows an estimate placeholder while reset notices keep generic counts", () => {
  const syncing = createProgressNoticeFragment({ message: "Saving progress…", current: 3, total: 100, unit: "changes" }, doc) as unknown as ElementStub;
  assert.equal(syncing.children[0].children[3].textContent, "Estimating remaining time…");
  const reset = createProgressNoticeFragment({ message: "Deleting local files", current: 2, total: 5 }, doc) as unknown as ElementStub;
  assert.deepEqual(reset.children[0].children.map((child) => child.tag), ["div", "div", "progress"]);
  assert.equal(reset.children[0].children[1].textContent, "2 / 5");
});
