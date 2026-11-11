import { describe, expect, it } from "vitest";
import { MOST_QUOTE_DEPTH, parseInline, parseMarkdown, safeHref } from "./markdown-read";
import type { Block } from "./markdown-read";

describe("parseMarkdown", () => {
  it("given a request description with a heading, a paragraph over two lines, a list and fenced code, when read, then each is its own block and the code stays as written", () => {
    // given
    const text = "## What changed\nRounding now goes\nhalf to even.\n\n- the API\n- the docs\n\n```ts\nconst a = <b>1</b>;\n```";

    // when
    const blocks = parseMarkdown(text);

    // then
    expect(blocks.map((b) => b.kind)).toEqual(["heading", "paragraph", "list", "code"]);
    expect(blocks[1]).toEqual({ kind: "paragraph", children: [{ kind: "text", text: "Rounding now goes half to even." }] });
    expect(blocks[3]).toEqual({ kind: "code", lang: "ts", text: "const a = <b>1</b>;" });
  });

  it("given a quote, an ordered list, a rule and an unclosed fence, when read, then the quote holds its own blocks and the fence runs to the end", () => {
    // when
    const blocks = parseMarkdown("> **Note** kept\n\n1. one\n2. two\n\n---\n```\nlast line");

    // then
    expect(blocks.map((b) => b.kind)).toEqual(["quote", "list", "rule", "code"]);
    expect(blocks[1]).toMatchObject({ kind: "list", ordered: true });
    expect(blocks[3]).toEqual({ kind: "code", lang: "", text: "last line" });
  });

  it("given raw HTML in the text, when read, then it stays words and adds no element", () => {
    // when
    const blocks = parseMarkdown('<script>alert(1)</script>\n<img src=x onerror="go()">');

    // then
    expect(blocks).toEqual([{ kind: "paragraph", children: [{ kind: "text", text: '<script>alert(1)</script> <img src=x onerror="go()">' }] }]);
  });
});

describe("nested quotes", () => {
  it("given twenty thousand quote marks before a word, when read, then quotes stop at the most they nest and the rest is the line's own text", () => {
    // when
    const blocks = parseMarkdown(`${">".repeat(20_000)} x`);

    // then
    let depth = 0;
    let at: Block | undefined = blocks[0];
    while (at?.kind === "quote") {
      depth++;
      at = at.children[0];
    }
    expect(depth).toBe(MOST_QUOTE_DEPTH);
    expect(at).toMatchObject({ kind: "paragraph", children: [{ kind: "text", text: `${">".repeat(20_000 - MOST_QUOTE_DEPTH)} x` }] });
  });
});

describe("the orchestrator's own fence", () => {
  it("given an agent's report fenced with four backticks that holds a three-backtick block, when read, then the whole report is one quote and the words after it are not", () => {
    // given
    const text = ["The block below is the agent's own output, quoted as data.", "", "````text", "Added the skill.", "```", "rm -rf /", "```", "````", "", "Reviewed by nobody yet."].join("\n");

    // when
    const blocks = parseMarkdown(text);

    // then
    expect(blocks.map((b) => b.kind)).toEqual(["paragraph", "code", "paragraph"]);
    expect(blocks[1]).toEqual({ kind: "code", lang: "text", text: "Added the skill.\n```\nrm -rf /\n```" });
  });
});

describe("parseInline", () => {
  it("given code, strong, emphasis and a link, when read, then each is marked and the link keeps its address", () => {
    // when
    const read = parseInline("Run `npm test`, **then** *merge*: [the request](https://forge.example/r/7).");

    // then
    expect(read).toEqual([
      { kind: "text", text: "Run " },
      { kind: "code", text: "npm test" },
      { kind: "text", text: ", " },
      { kind: "strong", children: [{ kind: "text", text: "then" }] },
      { kind: "text", text: " " },
      { kind: "em", children: [{ kind: "text", text: "merge" }] },
      { kind: "text", text: ": " },
      { kind: "link", href: "https://forge.example/r/7", children: [{ kind: "text", text: "the request" }] },
      { kind: "text", text: "." },
    ]);
  });

  it("given a javascript address and two images, when read, then the first stays text and each image keeps its address as written", () => {
    // when
    const bad = parseInline("[click](javascript:alert(1))");
    const image = parseInline("![flow](https://forge.example/flow.png) ![](/uploads/ab12/shot.png)");

    // then
    expect(bad).toEqual([{ kind: "text", text: "[click](javascript:alert(1)" }, { kind: "text", text: ")" }]);
    expect(image).toEqual([{ kind: "image", src: "https://forge.example/flow.png", alt: "flow" }, { kind: "text", text: " " }, { kind: "image", src: "/uploads/ab12/shot.png", alt: "" }]);
  });
});

describe("safeHref", () => {
  it("given addresses of several kinds, when checked, then only web pages pass", () => {
    // then
    expect(["https://a.example/x", "http://a.example", "javascript:alert(1)", "data:text/html,x", "mailto:a@example.test", "/relative"].map(safeHref)).toEqual(["https://a.example/x", "http://a.example/", null, null, null, null]);
  });
});
