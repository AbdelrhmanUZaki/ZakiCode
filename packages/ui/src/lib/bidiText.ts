/**
 Bidi grouping helper for plain-text lines: groups parsed text/mention parts by source line (\n) so every rendered
 line can carry dir="auto" — each line's direction comes from its first strong character (UAX #9),
 giving RTL content like Arabic correct per-line direction and alignment while pure-Latin content is unaffected.
 Pure functions, no React, no state; direction decisions are left to the browser's dir="auto" implementation.
 */

export type BidiTextPart<TPart> = { type: "text"; text: string } | TPart;

/** Contract: TPart is a non-text part (mention, etc.) and must not declare type: "text". */
const isTextPart = <TPart extends { type: string }>(
  part: BidiTextPart<TPart>,
): part is { type: "text"; text: string } => part.type === "text";

export function splitPartsIntoBidiLines<TPart extends { type: string }>(
  parts: ReadonlyArray<BidiTextPart<TPart>>,
): Array<Array<BidiTextPart<TPart>>> {
  const lines: Array<Array<BidiTextPart<TPart>>> = [];
  // current always points at the last group in lines, avoiding an undefined indexing branch.
  let current: Array<BidiTextPart<TPart>> = [];
  lines.push(current);

  for (const part of parts) {
    if (!isTextPart(part)) {
      // A mention chip never contains newlines (the parser emits it as a single token); it belongs to the current line as a whole.
      current.push(part);
      continue;
    }

    const segments = part.text.split("\n");
    segments.forEach((segment, index) => {
      if (index > 0) {
        current = [];
        lines.push(current);
      }
      // A \r on a non-final segment split by \n belongs to the CRLF separator, not the line content.
      const text = index === segments.length - 1 ? segment : segment.replace(/\r$/, "");
      if (text) {
        current.push({ type: "text", text });
      }
    });
  }

  // Aligns with whitespace-pre-wrap: "abc\n" renders one line with no visible empty line;
  // but consecutive newlines mid-text ("a\n\nb") must preserve the empty line.
  const lastLine = lines[lines.length - 1];
  if (lines.length > 1 && lastLine && lastLine.length === 0) {
    lines.pop();
  }

  return lines;
}
