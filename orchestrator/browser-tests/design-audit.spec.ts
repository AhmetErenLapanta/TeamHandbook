import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { overflows, THEMES } from "./layout.js";
import { finishedTask, folderPicker } from "./screens.js";

// The drawn screens held to the design tokens: what a screen shows is read from the browser's computed
// styles, so a value that reaches the page by any route (a stylesheet, an inline style, a browser default)
// is caught, and the tokens are read from the page too, so a change of scale needs no change here.
// ORCHESTRATOR_DESIGN_AUDIT names a directory each screen's findings are written to, for a list to work through.
const AUDIT = process.env.ORCHESTRATOR_DESIGN_AUDIT;
const WIDTHS = [1440, 390] as const;

interface Finding { property: string; value: string; where: string }

async function settled(page: Page): Promise<void> {
  await expect(page.getByText(/^Loading|^Working out|^Reading the forge|^Reading what reaches|^Checking the agents/).filter({ visible: true })).toHaveCount(0, { timeout: 30_000 });
}

const SCREENS: { name: string; open: (page: Page) => Promise<void> }[] = [
  { name: "folder-picker", open: folderPicker },
  { name: "task", open: finishedTask },
  { name: "tasks", open: async (p) => { await p.goto("/demo/tasks"); await expect(p.getByRole("heading", { level: 1 })).toBeVisible(); } },
];

/** Every drawn style no design token names, and every text under 4.5 to 1 on what is drawn behind it. */
async function offToken(page: Page): Promise<Finding[]> {
  return page.evaluate(() => {
    // The tokens are the custom properties the stylesheets set on :root, at the values the current theme gives them.
    const names = new Set<string>();
    const collect = (rules: CSSRuleList) => {
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSStyleRule) {
          if (rule.selectorText.includes(":root")) for (const p of Array.from(rule.style)) if (p.startsWith("--")) names.add(p);
        } else if ("cssRules" in rule) collect((rule as CSSGroupingRule).cssRules);
      }
    };
    for (const sheet of Array.from(document.styleSheets)) collect(sheet.cssRules);

    const probe = document.createElement("div");
    document.body.append(probe);
    // A colour is compared as the pixel it paints, so hex, rgb() and oklch() tokens all meet on the same terms.
    const ctx = Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d", { willReadFrequently: true })!;
    const rgba = (color: string): number[] => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      return Array.from(ctx.getImageData(0, 0, 1, 1).data);
    };
    const computed = (property: string, value: string): string => {
      probe.style.cssText = "";
      probe.style.setProperty(property, value);
      return probe.style.getPropertyValue(property) ? getComputedStyle(probe).getPropertyValue(property) : "";
    };
    // Shadows are compared one layer at a time: a control may stack two shadow tokens.
    const layers = (shadow: string) => shadow.split(/,(?![^(]*\))/).map((s) => s.trim()).filter(Boolean);

    const root = getComputedStyle(document.documentElement);
    const colours: number[][] = [];
    const sizes = new Set<string>();
    const weights = new Set<string>(["400"]);
    const radii = new Set<string>(["0px"]);
    const fonts = new Set<string>();
    const shadows = new Set<string>();
    for (const name of names) {
      const value = root.getPropertyValue(name).trim();
      if (!value) continue;
      // A colour token is told by its value, since --text is a colour and --text-xs a size.
      const colour = computed("color", value);
      if (colour) { colours.push(rgba(colour)); continue; }
      if (/^--(text|font-size)-/.test(name) && computed("font-size", value)) { sizes.add(computed("font-size", value)); continue; }
      if (/^--weight/.test(name) && computed("font-weight", value)) { weights.add(computed("font-weight", value)); continue; }
      if (/^--radius/.test(name) && computed("border-top-left-radius", value)) { radii.add(computed("border-top-left-radius", value)); continue; }
      if (value.includes(",") && computed("font-family", value)) { fonts.add(computed("font-family", value)); continue; }
      const shadow = computed("box-shadow", value);
      if (shadow && shadow !== "none") for (const layer of layers(shadow)) shadows.add(layer);
    }

    const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - (b[i] ?? 0)) <= 2);
    const onToken = (colour: string) => { const v = rgba(colour); return v[3] === 0 || colours.some((t) => near(t, v)); };
    const luminance = (c: number[]) => {
      const [r = 0, g = 0, b = 0] = c.slice(0, 3).map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const over = (top: number[], under: number[]) => { const a = (top[3] ?? 255) / 255; return [0, 1, 2].map((i) => (top[i] ?? 0) * a + (under[i] ?? 0) * (1 - a)).concat(255); };
    /** What is painted behind an element's text, its own background stacked on its ancestors'; null under an image or gradient. */
    const behind = (el: Element): number[] | null => {
      const stack: number[][] = [];
      for (let at: Element | null = el; at; at = at.parentElement) {
        const style = getComputedStyle(at);
        if (style.backgroundImage !== "none") return null;
        const v = rgba(style.backgroundColor);
        if (v[3]) stack.push(v);
        if (v[3] === 255) break;
      }
      return stack.reverse().reduce((under, top) => over(top, under), [255, 255, 255, 255]);
    };
    const name = (el: Element) => {
      const parts: string[] = [];
      for (let at: Element | null = el; at && at !== document.body && parts.length < 4; at = at.parentElement) {
        const id = at.id ? `#${at.id}` : "";
        const cls = typeof at.className === "string" && at.className.trim() ? `.${at.className.trim().split(/\s+/).join(".")}` : "";
        parts.unshift(`${at.tagName.toLowerCase()}${id}${cls}`);
      }
      return parts.join(" > ");
    };
    const ownText = (el: Element) =>
      el.matches("input:not([type=checkbox]):not([type=radio]):not([type=hidden]), textarea, select") ||
      Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim());

    const found: { property: string; value: string; where: string }[] = [];
    for (const el of Array.from(document.querySelectorAll("body *"))) {
      if (el === probe || el.closest("svg, script, style, template, noscript, canvas")) continue;
      if (!(el as HTMLElement).checkVisibility()) continue;
      const style = getComputedStyle(el);
      const where = name(el);
      const flag = (property: string, value: string) => found.push({ property, value, where });
      if (ownText(el)) {
        if (!fonts.has(style.fontFamily)) flag("font-family", style.fontFamily);
        if (!sizes.has(style.fontSize)) flag("font-size", style.fontSize);
        if (!weights.has(style.fontWeight)) flag("font-weight", style.fontWeight);
        if (!onToken(style.color)) flag("color", style.color);
        // A disabled control is allowed to read faint; everything else a person reads reaches 4.5 to 1.
        if (!el.closest(":disabled, [aria-disabled=true]")) {
          const under = behind(el);
          if (under) {
            const [hi = 0, lo = 0] = [luminance(over(rgba(style.color), under)), luminance(under)].sort((a, b) => b - a);
            const ratio = Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
            if (ratio < 4.5) flag("contrast", `${ratio}: ${style.color} on rgb(${under.slice(0, 3).join(" ")})`);
          }
        }
      }
      if (!onToken(style.backgroundColor)) flag("background-color", style.backgroundColor);
      for (const side of ["top", "right", "bottom", "left"]) {
        if (parseFloat(style.getPropertyValue(`border-${side}-width`)) > 0 && style.getPropertyValue(`border-${side}-style`) !== "none" && !onToken(style.getPropertyValue(`border-${side}-color`))) {
          flag(`border-${side}-color`, style.getPropertyValue(`border-${side}-color`));
        }
      }
      for (const corner of ["top-left", "top-right", "bottom-right", "bottom-left"]) {
        const radius = style.getPropertyValue(`border-${corner}-radius`);
        if (!radii.has(radius)) flag("border-radius", radius);
      }
      if (style.boxShadow !== "none") for (const layer of layers(style.boxShadow)) if (!shadows.has(layer)) flag("box-shadow", layer);
    }
    probe.remove();
    return found.filter((f, i) => found.findIndex((g) => g.property === f.property && g.value === f.value && g.where === f.where) === i);
  });
}

/** The findings as one line each, property and value with how many places carry them, for a failure a person can read. */
const tally = (findings: Finding[]) => findings.reduce<Record<string, number>>((t, f) => ({ ...t, [`${f.property} ${f.value}`]: (t[`${f.property} ${f.value}`] ?? 0) + 1 }), {});

test.describe("the design audit itself", () => {
  test("given an element drawn with its own size, colours and radius, when the audit reads the page, then it names each of them on that element", async ({ page }) => {
    // given
    await page.goto("/demo/activity");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.evaluate(() => {
      const off = document.createElement("p");
      off.id = "audit-probe";
      off.textContent = "Off the tokens";
      off.style.cssText = "font-size: 15.5px; color: #777777; background: #123456; border-radius: 7px";
      document.querySelector("main")?.append(off);
    });

    // when
    const found = (await offToken(page)).filter((f) => f.where.endsWith("p#audit-probe"));

    // then
    expect([...new Set(found.map((f) => f.property))].sort()).toEqual(["background-color", "border-radius", "color", "contrast", "font-size"]);
  });
});

test.describe("the main screens held to the design tokens", () => {

  for (const theme of THEMES) {
    for (const width of WIDTHS) {
      test.describe(`at ${width} pixels in the ${theme} theme`, () => {
        test.use({ colorScheme: theme, viewport: { width, height: 900 } });

        for (const screen of SCREENS) {
          test(`given the ${screen.name} screen, when its drawn styles are read, then each is a design token, every text reaches 4.5 to 1, and nothing sticks out`, async ({ page }) => {
            // given
            await screen.open(page);
            await settled(page);

            // when
            const found = await offToken(page);
            const sticking = await overflows(page);
            if (AUDIT) {
              mkdirSync(AUDIT, { recursive: true });
              writeFileSync(join(AUDIT, `${screen.name}-${theme}-${width}.json`), `${JSON.stringify({ found, sticking }, null, 2)}\n`);
            }

            // then
            expect(tally(found)).toEqual({});
            expect(sticking).toEqual([]);
          });
        }
      });
    }
  }
});
