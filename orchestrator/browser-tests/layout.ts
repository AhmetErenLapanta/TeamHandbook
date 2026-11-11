import type { Page } from "@playwright/test";

// Every page at four widths and in both themes: nothing sticks out of the box it sits in,
// scroll sideways inside a card, or be cut short. Tables and code blocks are the exceptions that
// scroll on purpose, in a box of their own; the top tabs scroll on a phone.
export const WIDTHS = [1440, 1024, 768, 390] as const;
export const THEMES = ["light", "dark"] as const;

export interface Overflow { where: string; why: string }

/** What sticks out on the page as drawn now. */
export async function overflows(page: Page): Promise<Overflow[]> {
  return page.evaluate(() => {
    const found: { where: string; why: string }[] = [];
    const name = (el: Element) => {
      const parts: string[] = [];
      for (let at: Element | null = el; at && at !== document.body && parts.length < 4; at = at.parentElement) {
        const id = at.id ? `#${at.id}` : "";
        const cls = typeof at.className === "string" && at.className.trim() ? `.${at.className.trim().split(/\s+/).join(".")}` : "";
        parts.unshift(`${at.tagName.toLowerCase()}${id}${cls}`);
      }
      return parts.join(" > ");
    };
    // Scrolling sideways on purpose: a table's or a code block's own box, the tab rows, and a sprint board's columns.
    const scrollsOnPurpose = (el: Element) =>
      el.matches("table, pre, textarea, .tabs, .subnav, .fault, .task-log, .board") || (el.querySelector(":scope > table") !== null && el.children.length === 1);
    if (document.documentElement.scrollWidth > window.innerWidth + 1) found.push({ where: "the page", why: `scrolls sideways (${document.documentElement.scrollWidth} > ${window.innerWidth})` });
    for (const el of Array.from(document.querySelectorAll("main *, header *"))) {
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || style.position === "absolute" || style.position === "fixed") continue;
      if (el.closest(".visually-hidden, [hidden]")) continue;
      const box = el.getBoundingClientRect();
      if (!box.width) continue;
      if (style.textOverflow === "ellipsis" && el.scrollWidth > el.clientWidth + 1) found.push({ where: name(el), why: "text cut short" });
      else if (["auto", "scroll", "hidden"].includes(style.overflowX) && el.scrollWidth > el.clientWidth + 1 && !scrollsOnPurpose(el) && !["INPUT", "SELECT"].includes(el.tagName)) {
        found.push({ where: name(el), why: `hides ${el.scrollWidth - el.clientWidth}px sideways` });
      }
      const parent = el.parentElement;
      if (!parent || parent === document.body) continue;
      const outer = parent.getBoundingClientRect();
      const parentStyle = getComputedStyle(parent);
      if (parentStyle.overflowX !== "visible" || scrollsOnPurpose(parent)) continue;
      if (box.right > outer.right + 1 || box.left < outer.left - 1) found.push({ where: name(el), why: `sticks out of its box by ${Math.round(Math.max(box.right - outer.right, outer.left - box.left))}px` });
    }
    // One finding per place: a child that sticks out takes its own children with it.
    return found.filter((f, i) => !found.slice(0, i).some((g) => g.why === f.why && f.where.startsWith(g.where)));
  });
}
