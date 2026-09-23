import assert from "node:assert/strict";
import test from "node:test";

import { splitPartsIntoBidiLines } from "../src/lib/bidiText.js";

type FakeMention = { type: "file"; label: string };

const text = (value: string) => ({ type: "text" as const, text: value });
const file = (label: string): FakeMention => ({ type: "file" as const, label });

test("single-line text stays one line", () => {
  assert.deepEqual(splitPartsIntoBidiLines<FakeMention>([text("hello world")]), [
    [text("hello world")],
  ]);
});

test("multi-line text splits on newlines", () => {
  assert.deepEqual(splitPartsIntoBidiLines<FakeMention>([text("hello\nمرحبا\nworld")]), [
    [text("hello")],
    [text("مرحبا")],
    [text("world")],
  ]);
});

test("CRLF separators do not leak into line content", () => {
  assert.deepEqual(splitPartsIntoBidiLines<FakeMention>([text("hello\r\nمرحبا")]), [
    [text("hello")],
    [text("مرحبا")],
  ]);
});

test("mention parts attach to the current line", () => {
  assert.deepEqual(
    splitPartsIntoBidiLines<FakeMention>([text("see "), file("docs/a.md"), text("\nسطر ثاني")]),
    [[text("see "), file("docs/a.md")], [text("سطر ثاني")]],
  );
});

test("blank middle line is preserved as empty group", () => {
  assert.deepEqual(splitPartsIntoBidiLines<FakeMention>([text("a\n\nb")]), [
    [text("a")],
    [],
    [text("b")],
  ]);
});

test("trailing newline does not produce a visible empty line", () => {
  assert.deepEqual(splitPartsIntoBidiLines<FakeMention>([text("abc\n")]), [[text("abc")]]);
  assert.deepEqual(splitPartsIntoBidiLines<FakeMention>([text("abc\n\n")]), [[text("abc")], []]);
});

test("lone newline renders as a single empty line", () => {
  assert.deepEqual(splitPartsIntoBidiLines<FakeMention>([text("\n")]), [[]]);
});

test("empty text part contributes nothing", () => {
  assert.deepEqual(splitPartsIntoBidiLines<FakeMention>([text(""), text("x")]), [[text("x")]]);
});
