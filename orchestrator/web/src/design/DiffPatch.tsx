import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

export type DiffLine = "add" | "del" | "hunk" | "meta" | "context";

/**
 * What each line of a unified diff is. Inside a hunk a line's first character says it; outside one
 * the file headers are. Read in order rather than line by line, since a removed line whose text
 * starts "-- " is "--- ..." on the page, the same as a file header.
 */
export function diffLines(patch: string): DiffLine[] {
  let inHunk = false;
  return patch.split("\n").map((line) => {
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      return "meta";
    }
    if (line.startsWith("@@")) {
      inHunk = true;
      return "hunk";
    }
    if (!inHunk) return line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("index ") ? "meta" : "context";
    if (line.startsWith("+")) return "add";
    if (line.startsWith("-")) return "del";
    if (line.startsWith("\\")) return "meta";
    return "context";
  });
}

/**
 * Where a patch's reading starts: its first hunk. Git's own header lines before it (diff --git,
 * index, --- and +++, new file mode) say again the path its row already names; a patch with no
 * hunk, as a change of mode alone, is shown whole.
 */
export function bodyStart(kinds: DiffLine[]): number {
  const at = kinds.indexOf("hunk");
  return at < 0 ? 0 : at;
}

/** A diff line with where it sits in the file before and after the change; a header line sits in neither. */
export interface NumberedLine { kind: DiffLine; text: string; old: number | null; new: number | null }

/** Each line of a patch numbered from its hunk headers, the way the forge shows them beside the code. */
export function numberLines(patch: string): NumberedLine[] {
  // A patch that ends with a newline has no line after it; numbered, it read as an empty line 0.
  const body = patch.endsWith("\n") ? patch.slice(0, -1) : patch;
  const kinds = diffLines(body);
  let old = 0;
  let next = 0;
  return body.split("\n").map((text, i) => {
    const kind = kinds[i]!;
    if (kind === "hunk") {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
      old = m ? Number(m[1]) : old;
      next = m ? Number(m[2]) : next;
      return { kind, text, old: null, new: null };
    }
    if (kind === "add") return { kind, text, old: null, new: next++ };
    if (kind === "del") return { kind, text, old: old++, new: null };
    if (kind === "context" && (old || next)) return { kind, text, old: old++, new: next++ };
    return { kind, text, old: null, new: null };
  });
}

/**
 * A patch's lines from its first hunk, each with its line before and after the change in a gutter
 * drawn from data attributes, so a copied selection carries the code and not the numbers.
 */
export function PatchLines({ patch }: { patch: string }) {
  const lines = numberLines(patch);
  const from = bodyStart(lines.map((l) => l.kind));
  return (
    <>
      {lines.map((l, i) => (i < from ? null : (
        <span key={i} data-i={i} className={`diff-line ${l.kind}`}>
          <span className="diff-num" aria-hidden="true" data-old={l.old ?? ""} data-new={l.new ?? ""} />
          {l.text || " "}
        </span>
      )))}
    </>
  );
}

/**
 * Whether a box that scrolls sideways holds more to its right, read again as it scrolls or
 * resizes: a phone's patch cut at the edge gave no sign it went on.
 */
export function useMoreRight<T extends HTMLElement>(): [RefObject<T>, boolean] {
  const box = useRef<T>(null);
  const [more, setMore] = useState(false);
  useEffect(() => {
    const at = box.current;
    if (!at) return;
    const read = () => setMore(at.scrollLeft + at.clientWidth < at.scrollWidth - 1);
    read();
    at.addEventListener("scroll", read, { passive: true });
    const sized = new ResizeObserver(read);
    sized.observe(at);
    return () => {
      at.removeEventListener("scroll", read);
      sized.disconnect();
    };
  }, []);
  return [box, more];
}

/** A file's patch with each added line tinted green and each removed one red, as a reviewer reads it on the forge. */
export function DiffPatch({ patch }: { patch: string }) {
  const [box, more] = useMoreRight<HTMLPreElement>();
  return (
    <div className="patch-scroll" data-more-right={more || undefined}>
      <pre ref={box} className="pre mono diff-patch"><PatchLines patch={patch} /></pre>
    </div>
  );
}
