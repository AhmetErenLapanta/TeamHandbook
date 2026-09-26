// Every non-ASCII codepoint this suite needs, built from its number.
//
// The source files here stay pure ASCII, and not for tidiness. A literal U+2028 is a
// line terminator in JavaScript source: written into a string it ends the statement and
// the file stops parsing. It was written that way once here and did exactly that. The
// repo's hygiene gate also greps added lines for non-ASCII letters, so a literal
// Cyrillic lookalike in a payload would fail the gate rather than the fence.
export const ch = (code: number): string => String.fromCharCode(code);

/** line terminators, by codepoint */
export const LF = ch(0x0a);
export const CR = ch(0x0d);
export const VT = ch(0x0b); // VERTICAL TAB
export const FF = ch(0x0c); // FORM FEED
export const NEL = ch(0x85); // NEXT LINE
export const LS = ch(0x2028); // LINE SEPARATOR
export const PS = ch(0x2029); // PARAGRAPH SEPARATOR

/** Turn a Latin string into its mathematical MONOSPACE form: astral compatibility
 * characters that NFKC folds straight back to ASCII, which is what makes them a disguise a
 * per-code-unit fold never sees. */
export const toMathMonospace = (value: string): string =>
  [...value]
    .map((ch) => {
      const c = ch.codePointAt(0)!;
      if (c >= 0x41 && c <= 0x5a) return String.fromCodePoint(0x1d670 + c - 0x41);
      if (c >= 0x61 && c <= 0x7a) return String.fromCodePoint(0x1d68a + c - 0x61);
      return ch;
    })
    .join("");

/** invisibles a payload can hide inside a sentinel */
export const SHY = ch(0x00ad); // SOFT HYPHEN
export const CGJ = ch(0x034f); // COMBINING GRAPHEME JOINER
export const MVS = ch(0x180e); // MONGOLIAN VOWEL SEPARATOR
export const FUNC_APP = ch(0x2061); // FUNCTION APPLICATION
export const INVISIBLE_TIMES = ch(0x2062); // INVISIBLE TIMES
export const VS16 = ch(0xfe0f); // VARIATION SELECTOR-16 (emoji presentation)
export const VS15 = ch(0xfe0e); // VARIATION SELECTOR-15 (text presentation)
export const LRO = ch(0x202d); // LEFT-TO-RIGHT OVERRIDE, a bidi control
/** TAG LATIN CAPITAL LETTER A (U+E0041): astral, invisible, and its whole block was
 * missing from the hand-written list the fold used to carry. */
export const TAG_A = String.fromCodePoint(0xe0041);
/** MONGOLIAN FREE VARIATION SELECTOR ONE */
export const FVS1 = ch(0x180b);
export const ZWSP = ch(0x200b);
export const ZWNJ = ch(0x200c);
export const ZWJ = ch(0x200d);
export const WJ = ch(0x2060);
export const BOM = ch(0xfeff);

/** the rightwards arrow in the real field label `resolved error->fix pairs:` */
export const ARROW = ch(0x2192);

/** fullwidth angle brackets */
export const FW_LT = ch(0xff1c);
export const FW_GT = ch(0xff1e);

/** Cyrillic and Greek capitals that read as Latin ones. Only the letters the sentinels
 * are spelled with can matter, so this is a short list rather than a full confusable
 * table. */
export const CONFUSABLE: ReadonlyMap<string, string> = new Map([
  [ch(0x0410), "A"], [ch(0x0391), "A"],
  [ch(0x0412), "B"], [ch(0x0392), "B"],
  [ch(0x0421), "C"],
  [ch(0x0415), "E"], [ch(0x0395), "E"],
  [ch(0x041d), "H"], [ch(0x0397), "H"],
  [ch(0x0406), "I"], [ch(0x0399), "I"],
  [ch(0x0408), "J"],
  [ch(0x041a), "K"], [ch(0x039a), "K"],
  [ch(0x041c), "M"], [ch(0x039c), "M"],
  [ch(0x041e), "O"], [ch(0x039f), "O"],
  [ch(0x0420), "P"], [ch(0x03a1), "P"],
  [ch(0x0405), "S"],
  [ch(0x0422), "T"], [ch(0x03a4), "T"],
  [ch(0x0423), "Y"], [ch(0x03a5), "Y"],
  [ch(0x0425), "X"], [ch(0x03a7), "X"],
]);
