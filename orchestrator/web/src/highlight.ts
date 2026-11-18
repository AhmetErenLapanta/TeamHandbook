/** A stretch of code and what it is: drawn from its parts alone, so none of it becomes markup. */
export type Token = { kind: "plain" | "comment" | "string" | "number" | "keyword"; text: string };

interface Family { comment: string; keywords: string }

const C_LIKE: Family = {
  comment: "//[^\\n]*|/\\*[\\s\\S]*?(?:\\*/|$)",
  keywords: "abstract|as|async|await|break|case|catch|class|const|continue|default|delete|do|else|enum|export|extends|false|finally|for|fn|from|func|function|go|if|implements|import|in|instanceof|interface|let|match|new|null|of|package|private|protected|public|return|static|struct|super|switch|this|throw|true|try|type|typeof|undefined|use|val|var|void|while|yield",
};
const PYTHON: Family = {
  comment: "#[^\\n]*",
  keywords: "and|as|assert|async|await|break|class|continue|def|del|elif|else|except|False|finally|for|from|global|if|import|in|is|lambda|None|not|or|pass|raise|return|True|try|while|with|yield",
};
const SHELL: Family = {
  comment: "#[^\\n]*",
  keywords: "case|do|done|elif|else|esac|export|fi|for|function|if|in|local|return|then|until|while",
};

const FAMILIES: Record<string, Family> = {
  ts: C_LIKE, tsx: C_LIKE, typescript: C_LIKE, js: C_LIKE, jsx: C_LIKE, javascript: C_LIKE, java: C_LIKE, kotlin: C_LIKE, kt: C_LIKE, go: C_LIKE, rust: C_LIKE, rs: C_LIKE, c: C_LIKE, cpp: C_LIKE, json: { comment: "(?!)", keywords: "true|false|null" },
  py: PYTHON, python: PYTHON, sh: SHELL, bash: SHELL, shell: SHELL, zsh: SHELL, yaml: { comment: "#[^\\n]*", keywords: "true|false|null" }, yml: { comment: "#[^\\n]*", keywords: "true|false|null" },
};

const STRING = "\"(?:[^\"\\\\\\n]|\\\\.)*\"?|'(?:[^'\\\\\\n]|\\\\.)*'?|`(?:[^`\\\\]|\\\\[\\s\\S])*(?:`|$)";
const NUMBER = "\\b\\d[\\d_]*(?:\\.\\d+)?(?:e[+-]?\\d+)?\\b";

const compiled = new Map<Family, RegExp>();
function matcher(family: Family): RegExp {
  let re = compiled.get(family);
  if (!re) {
    re = new RegExp(`(${family.comment})|(${STRING})|(${NUMBER})|\\b(${family.keywords})\\b`, "gi");
    compiled.set(family, re);
  }
  re.lastIndex = 0;
  return re;
}

const push = (out: Token[], kind: Token["kind"], text: string) => {
  if (!text) return;
  const last = out.at(-1);
  if (last?.kind === kind) last.text += text;
  else out.push({ kind, text });
};

/** The comments, strings, numbers and keywords of code in a language it knows; any other text is one plain stretch. */
export function highlight(text: string, lang: string): Token[] {
  const family = FAMILIES[lang.trim().toLowerCase()];
  if (!family) return text ? [{ kind: "plain", text }] : [];
  const out: Token[] = [];
  const re = matcher(family);
  let from = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0] === "") {
      re.lastIndex++;
      continue;
    }
    push(out, "plain", text.slice(from, m.index));
    push(out, m[1] !== undefined ? "comment" : m[2] !== undefined ? "string" : m[3] !== undefined ? "number" : "keyword", m[0]);
    from = m.index + m[0].length;
  }
  push(out, "plain", text.slice(from));
  return out;
}
