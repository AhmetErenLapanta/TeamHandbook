import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MODEL_KEYS = ["model", "small_model"] as const;
const CONFIG_FILES = ["opencode.json", "opencode.jsonc", "config.json"];
const MODEL = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._:/@-]{1,200}$/;

export type OpencodeModel = Partial<Record<(typeof MODEL_KEYS)[number], string>>;

function withoutComments(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

export async function personalOpencodeModel(env: Record<string, string | undefined>): Promise<OpencodeModel> {
  const base = env.XDG_CONFIG_HOME || (env.HOME ? join(env.HOME, ".config") : null);
  if (!base) return {};
  for (const name of CONFIG_FILES) {
    const text = await readFile(join(base, "opencode", name), "utf8").catch(() => null);
    if (text === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(withoutComments(text));
    } catch {
      return {};
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const chosen = parsed as Record<string, unknown>;
    return Object.fromEntries(MODEL_KEYS.flatMap((key) => (typeof chosen[key] === "string" && MODEL.test(chosen[key]) ? [[key, chosen[key]]] : [])));
  }
  return {};
}

export async function keepOpencodeModel(configFile: string, model: OpencodeModel): Promise<void> {
  if (!Object.keys(model).length) return;
  const config = JSON.parse(await readFile(configFile, "utf8")) as Record<string, unknown>;
  await writeFile(configFile, JSON.stringify({ ...config, ...model }, null, 2) + "\n");
}
