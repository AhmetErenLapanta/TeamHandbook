/**
 * A small Markdown reader for text the orchestrator did not write: a request's description, an
 * agent's report. It knows headings, paragraphs, fenced code, quotes, flat lists and rules, and
 * inline code, strong, emphasis and links; raw HTML is never markup, only text, so nothing in the
 * text can add an element, a script or a style to the page.
 */

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; children: Inline[] }
  | { kind: "em"; children: Inline[] }
  | { kind: "link"; href: string; children: Inline[] }
  /** `src` as written, often a path on the forge; it is drawn only through the orchestrator's media read. */
  | { kind: "image"; src: string; alt: string };

export type Block =
  | { kind: "heading"; level: number; children: Inline[] }
  | { kind: "paragraph"; children: Inline[] }
  | { kind: "code"; lang: string; text: string }
  | { kind: "quote"; children: Block[] }
  | { kind: "list"; ordered: boolean; items: Inline[][] }
  | { kind: "rule" };

/** Only addresses a browser opens as a page; javascript:, data: and the like stay text. */
export function safeHref(href: string): string | null {
  try {
    const url = new URL(href);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

const INLINE = /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_|!?\[([^\]]*)\]\(([^)\s]+)\)/g;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let at = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index! > at) out.push({ kind: "text", text: text.slice(at, m.index) });
    const [whole, code, strong, strong2, em, em2, label, href] = m;
    if (code !== undefined) out.push({ kind: "code", text: code });
    else if (strong !== undefined || strong2 !== undefined) out.push({ kind: "strong", children: parseInline(strong ?? strong2!) });
    else if (em !== undefined || em2 !== undefined) out.push({ kind: "em", children: parseInline(em ?? em2!) });
    else if (whole.startsWith("!")) out.push({ kind: "image", src: href!, alt: label ?? "" });
    else {
      const safe = safeHref(href!);
      out.push(safe ? { kind: "link", href: safe, children: parseInline(label || href!) } : { kind: "text", text: whole });
    }
    at = m.index! + whole.length;
  }
  if (at < text.length) out.push({ kind: "text", text: text.slice(at) });
  return out;
}

const LIST_ITEM = /^\s{0,3}(?:([-*+])|(\d{1,9})[.)])\s+(.*)$/;

/**
 * Quotes nest at most this deep; a deeper `>` is the line's own text. Anyone who opens a request
 * on the forge writes its description, and each level is read again, so an unbounded run of `>`
 * would read itself until the page's stack gave out.
 */
export const MOST_QUOTE_DEPTH = 8;

export function parseMarkdown(text: string, depth = 0): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const endParagraph = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", children: parseInline(paragraph.join(" ")) });
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^\s{0,3}(`{3,}|~{3,})\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      endParagraph();
      // A fence closes only on a run of its own character at least as long, alone on its line: the
      // orchestrator fences an agent's words with more backticks than they hold, so a shorter run
      // inside stays part of the quote. An unclosed fence runs to the end, as a forge shows it.
      const mark = fence[1]!;
      const closes = new RegExp(`^\\s{0,3}${mark[0] === "`" ? "`" : "~"}{${mark.length},}\\s*$`);
      const body: string[] = [];
      while (++i < lines.length && !closes.test(lines[i]!)) body.push(lines[i]!);
      blocks.push({ kind: "code", lang: fence[2] ?? "", text: body.join("\n") });
      continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      endParagraph();
      blocks.push({ kind: "heading", level: heading[1]!.length, children: parseInline(heading[2]!) });
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      endParagraph();
      blocks.push({ kind: "rule" });
      continue;
    }
    if (depth < MOST_QUOTE_DEPTH && /^\s{0,3}>/.test(line)) {
      endParagraph();
      const quoted: string[] = [];
      for (; i < lines.length && /^\s{0,3}>/.test(lines[i]!); i++) quoted.push(lines[i]!.replace(/^\s{0,3}>\s?/, ""));
      i--;
      blocks.push({ kind: "quote", children: parseMarkdown(quoted.join("\n"), depth + 1) });
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      endParagraph();
      const ordered = item[2] !== undefined;
      const items: Inline[][] = [];
      for (; i < lines.length; i++) {
        const next = LIST_ITEM.exec(lines[i]!);
        if (next && (next[2] !== undefined) === ordered) items.push(parseInline(next[3]!));
        else if (lines[i]!.trim() && /^\s{2,}/.test(lines[i]!) && items.length) items[items.length - 1]!.push({ kind: "text", text: ` ${lines[i]!.trim()}` });
        else break;
      }
      i--;
      blocks.push({ kind: "list", ordered, items });
      continue;
    }
    if (!line.trim()) endParagraph();
    else paragraph.push(line.trim());
  }
  endParagraph();
  return blocks;
}
