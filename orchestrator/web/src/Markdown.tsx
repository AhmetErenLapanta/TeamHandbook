import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { parseMarkdown, safeHref } from "./markdown-read";
import type { Block, Inline } from "./markdown-read";

/** Where an image of the text is read from, or null where none is: the text's own addresses are never fetched by the browser. */
type Media = ((src: string) => string | null) | undefined;

/** An image read through the orchestrator; one it does not read stays its words, linked when its address is a web page. */
function Picture({ src, alt, media }: { src: string; alt: string; media: Media }) {
  const [failed, setFailed] = useState(false);
  const through = media?.(src);
  if (through && !failed) return <img src={through} alt={alt} loading="lazy" onError={() => setFailed(true)} />;
  const words = `image: ${alt || src}`;
  const href = safeHref(src);
  return href ? <a href={href} target="_blank" rel="noopener noreferrer nofollow">{words}</a> : <>{words}</>;
}

function inline(parts: Inline[], media: Media): ReactNode[] {
  return parts.map((p, i) => {
    if (p.kind === "text") return p.text;
    if (p.kind === "code") return <code key={i}>{p.text}</code>;
    if (p.kind === "strong") return <strong key={i}>{inline(p.children, media)}</strong>;
    if (p.kind === "em") return <em key={i}>{inline(p.children, media)}</em>;
    if (p.kind === "image") return <Picture key={i} src={p.src} alt={p.alt} media={media} />;
    return <a key={i} href={p.href} target="_blank" rel="noopener noreferrer nofollow">{inline(p.children, media)}</a>;
  });
}

// The text sits inside a section that has its own heading, so its headings start a level below.
const HEADING = ["h3", "h3", "h4", "h5", "h6", "h6"] as const;

function block(b: Block, i: number, media: Media): ReactNode {
  if (b.kind === "heading") {
    const Tag = HEADING[b.level - 1]!;
    return <Tag key={i}>{inline(b.children, media)}</Tag>;
  }
  if (b.kind === "paragraph") return <p key={i}>{inline(b.children, media)}</p>;
  if (b.kind === "code") return <pre key={i} className="pre mono"><code>{b.text}</code></pre>;
  if (b.kind === "quote") return <blockquote key={i}>{b.children.map((c, j) => block(c, j, media))}</blockquote>;
  if (b.kind === "list") {
    const items = b.items.map((item, j) => <li key={j}>{inline(item, media)}</li>);
    return b.ordered ? <ol key={i}>{items}</ol> : <ul key={i}>{items}</ul>;
  }
  return <hr key={i} />;
}

/** Text someone else wrote, read as Markdown and drawn from its parts alone: none of it becomes markup of its own. */
export function Markdown({ text, media }: { text: string; media?: Media }) {
  // A live page draws again on every line the agent writes; the text of each sentence and card is read once.
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return <div className="markdown" dir="auto">{blocks.map((b, i) => block(b, i, media))}</div>;
}
