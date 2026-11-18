import { describe, expect, it } from "vitest";
import { highlight } from "./highlight";

describe("highlighting code", () => {
  it("given typescript, when it is read, then keywords, strings, numbers and comments are told apart and every character is kept", () => {
    // given
    const code = 'const total = 42; // sum\nreturn "ok";';

    // when
    const tokens = highlight(code, "ts");

    // then
    expect(tokens.filter((t) => t.kind !== "plain").map((t) => [t.kind, t.text])).toEqual([["keyword", "const"], ["number", "42"], ["comment", "// sum"], ["keyword", "return"], ["string", '"ok"']]);
    expect(tokens.map((t) => t.text).join("")).toBe(code);
  });

  it("given a language it does not know, when it is read, then the text is one plain stretch", () => {
    // when
    const tokens = highlight("const a = 1", "brainfuck");

    // then
    expect(tokens).toEqual([{ kind: "plain", text: "const a = 1" }]);
  });

  it("given a string still being written, when it is read, then the open string runs to the end without losing a character", () => {
    // given
    const code = 'say("half';

    // when
    const tokens = highlight(code, "js");

    // then
    expect(tokens.at(-1)).toEqual({ kind: "string", text: '"half' });
    expect(tokens.map((t) => t.text).join("")).toBe(code);
  });

  it("given a word that only contains a keyword, when it is read, then it stays plain", () => {
    // when
    const tokens = highlight("constant interface_name", "ts");

    // then
    expect(tokens).toEqual([{ kind: "plain", text: "constant interface_name" }]);
  });
});
