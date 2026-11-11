import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const TOKENS = join(WEB, "design", "tokens.css");

function files(dir: string, ext: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path, ext);
    return path.endsWith(ext) && !path.endsWith(".test.ts") ? [path] : [];
  });
}

const COLOUR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb|color)\(/i;
const LENGTH = /\d*\.?\d+(?:px|rem|em)\b/;

/** What a declaration names outright that a token should: a colour, a radius, a shadow, a font size or weight, or a transition's duration. */
function raw(property: string, value: string): boolean {
  const v = value.replace(/var\([^)]*\)/g, "").replace(/color-mix\(/g, "");
  if (COLOUR.test(v)) return true;
  if (/^border(-[a-z-]+)?-radius$/.test(property)) return LENGTH.test(v);
  if (property === "box-shadow") return v.trim() !== "" && !/^(none|inherit|initial)$/.test(v.trim());
  if (property === "font-size") return LENGTH.test(v);
  if (property === "font") return LENGTH.test(v.split("/")[0] ?? "") || /\b[1-9]00\b|\bbold/.test(v);
  if (property === "font-weight") return /\d|bold/.test(v);
  // A transition on the duration tokens stops when reduced motion is asked for; a raw duration does not.
  if (property === "transition" || property === "transition-duration") return /\d*\.?\d+m?s\b/.test(v);
  return false;
}

/** Every declaration of a stylesheet that names a raw value, as file:line property: value. */
function inCss(path: string): string[] {
  const found: string[] = [];
  const text = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
  text.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(/([a-z-]+)\s*:\s*([^;{}]+)/g)) {
      if (raw(m[1]!, m[2]!)) found.push(`${relative(WEB, path)}:${i + 1} ${m[1]}: ${m[2]!.trim()}`);
    }
  });
  return found;
}

/** The same for an inline style object in a component. */
function inTsx(path: string): string[] {
  const found: string[] = [];
  readFileSync(path, "utf8").split("\n").forEach((line, i) => {
    for (const style of line.matchAll(/style=\{\{([^}]*)\}\}/g)) {
      for (const m of style[1]!.matchAll(/([a-zA-Z]+)\s*:\s*("[^"]*"|'[^']*'|[^,]+)/g)) {
        const property = m[1]!.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
        if (raw(property, m[2]!.replace(/^["']|["']$/g, ""))) found.push(`${relative(WEB, path)}:${i + 1} ${m[1]}: ${m[2]}`);
      }
    }
  });
  return found;
}

describe("the design tokens are the only place a look is named", () => {
  it("given every stylesheet but tokens.css, when its declarations are read, then none names a raw colour, radius, shadow, font size or transition duration", () => {
    // given
    // fonts.css declares the shipped faces; a face's weight there is a description, not a choice.
    const sheets = files(WEB, ".css").filter((p) => p !== TOKENS && p !== join(WEB, "design", "fonts.css"));

    // when
    const found = sheets.flatMap(inCss);

    // then
    expect(found).toEqual([]);
  });

  it("given every component, when its inline styles are read, then none names a raw colour, radius, shadow, font size or transition duration", () => {
    // given
    const components = files(WEB, ".tsx");

    // when
    const found = components.flatMap(inTsx);

    // then
    expect(found).toEqual([]);
  });
});
