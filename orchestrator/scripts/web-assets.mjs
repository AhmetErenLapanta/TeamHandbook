// The web app ships everything it draws with it (no font CDN): a build is refused when a font has
// no licence text beside it, or when a stylesheet asks for a file the build does not hold, so
// neither the npm package nor the release archive goes out with a font whose terms it does not
// include, or a page that quietly falls back to another typeface or loses an icon.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const FONT = /\.(woff2?|ttf|otf)$/i;
const LICENCE = /^(OFL|LICEN[CS]E)[^/]*\.(txt|md)$/i;

function filesUnder(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
}

/** Every font file under `dir` whose own directory holds no OFL or LICENSE text; empty when all are covered. */
export function fontsWithoutLicence(dir) {
  const files = filesUnder(dir);
  const covered = new Set(files.filter((f) => LICENCE.test(f.split(/[\\/]/).pop())).map((f) => dirname(f)));
  return files.filter((f) => FONT.test(f) && !covered.has(dirname(f))).map((f) => relative(dir, f));
}

/**
 * Every url() a stylesheet under `dir` names that is not a file under `dir`, as "<stylesheet>: <url>".
 * An address on another host counts as missing too: the page would reach out for it, which a local
 * orchestrator never does. data: carries its bytes and is fine.
 */
export function missingStyleAssets(dir) {
  const missing = [];
  for (const sheet of filesUnder(dir).filter((f) => f.endsWith(".css"))) {
    for (const [, raw] of readFileSync(sheet, "utf8").matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
      const ref = raw.trim().split(/[?#]/)[0];
      if (!ref || /^(data:|#)/i.test(raw.trim())) continue;
      if (/^([a-z]+:)?\/\//i.test(raw.trim())) {
        missing.push(`${relative(dir, sheet)}: ${raw.trim()} (another host)`);
        continue;
      }
      const file = ref.startsWith("/") ? join(dir, ref) : join(dirname(sheet), ref);
      if (!existsSync(file)) missing.push(`${relative(dir, sheet)}: ${raw.trim()}`);
    }
  }
  return [...new Set(missing)];
}
