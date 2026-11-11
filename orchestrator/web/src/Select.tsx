import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { createPortal } from "react-dom";

export interface SelectOption { value: string; label: string; hint?: string; disabled?: boolean }

/** Lists longer than this get a filter box at the top of the list. */
const SEARCH_FROM = 8;

/**
 * The orchestrator's one dropdown, in place of the browser's own `<select>`: a combobox button and a
 * listbox, worked with the keyboard as a select is (arrows, Home and End, Enter, Escape, typing a
 * letter to jump), and with a filter box once the list is long. The list opens in a layer of its
 * own over the page, so a card or a table it sits in never cuts it off or scrolls for it.
 */
export function Select({ label, labelHidden = false, value, onChange, options, disabled = false, describedBy, invalid = false, placeholder = "Choose…" }: {
  label: string;
  /** Kept for screen readers only, where the place already says what is picked. */
  labelHidden?: boolean;
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  disabled?: boolean;
  describedBy?: string;
  invalid?: boolean;
  placeholder?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [filter, setFilter] = useState("");
  const [at, setAt] = useState<{ left: number; top: number; width: number; up: boolean } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const typed = useRef({ text: "", at: 0 });
  const searchable = options.length > SEARCH_FROM;
  const needle = filter.trim().toLowerCase();
  const shown = needle ? options.filter((o) => `${o.label} ${o.hint ?? ""}`.toLowerCase().includes(needle)) : options;
  const chosen = options.find((o) => o.value === value);

  const place = () => {
    const box = button.current?.getBoundingClientRect();
    if (!box) return;
    const below = window.innerHeight - box.bottom;
    setAt({ left: box.left, top: box.bottom, width: box.width, up: below < 240 && box.top > below });
  };
  const show = () => {
    if (disabled) return;
    place();
    setFilter("");
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  };
  const close = (focus = true) => {
    setOpen(false);
    if (focus) button.current?.focus();
  };
  const pick = (option: SelectOption | undefined) => {
    if (!option || option.disabled) return;
    if (option.value !== value) onChange(option.value);
    close();
  };
  const move = (from: number, step: number) => {
    for (let i = from + step; i >= 0 && i < shown.length; i += step) if (!shown[i]!.disabled) return setActive(i);
  };

  // The layer follows the button as the page scrolls or resizes under it.
  useLayoutEffect(() => {
    if (!open) return;
    const away = (e: Event) => {
      if (list.current?.contains(e.target as Node)) return;
      place();
    };
    const outside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (button.current?.contains(target) || list.current?.parentElement?.contains(target)) return;
      close(false);
    };
    window.addEventListener("resize", away);
    window.addEventListener("scroll", away, true);
    document.addEventListener("mousedown", outside);
    return () => {
      window.removeEventListener("resize", away);
      window.removeEventListener("scroll", away, true);
      document.removeEventListener("mousedown", outside);
    };
  }, [open]);
  // The active option is kept in view by scrolling the list alone, never the page under it.
  useEffect(() => {
    const box = list.current;
    const item = box?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    if (!open || !box || !item) return;
    if (item.offsetTop < box.scrollTop) box.scrollTop = item.offsetTop;
    else if (item.offsetTop + item.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = item.offsetTop + item.offsetHeight - box.clientHeight;
  }, [open, active]);

  const onKey = (e: KeyboardEvent) => {
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
        e.preventDefault();
        show();
      }
      return;
    }
    if (e.key === "ArrowDown") { e.preventDefault(); move(active, 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(active, -1); }
    else if (e.key === "Home") { e.preventDefault(); move(-1, 1); }
    else if (e.key === "End") { e.preventDefault(); move(shown.length, -1); }
    else if (e.key === "Enter") { e.preventDefault(); pick(shown[active]); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === "Tab") close(false);
    else if (!searchable && e.key.length === 1) {
      // Typing jumps to the next option that starts with what was typed, as a select does.
      const now = Date.now();
      typed.current = { text: (now - typed.current.at < 700 ? typed.current.text : "") + e.key.toLowerCase(), at: now };
      const found = shown.findIndex((o) => !o.disabled && o.label.toLowerCase().startsWith(typed.current.text));
      if (found >= 0) setActive(found);
    }
  };

  const labelId = `${id}-label`;
  const listId = `${id}-list`;
  const optionId = (i: number) => `${id}-option-${i}`;
  const layer: ReactNode = open && at ? (
    <div className="select-layer" style={{ left: at.left, width: Math.max(at.width, 200), ...(at.up ? { bottom: window.innerHeight - at.top + (button.current?.offsetHeight ?? 0) + 4 } : { top: at.top + 4 }) }}>
      {searchable ? (
        <input className="select-filter" aria-label={`Filter ${label}`} aria-controls={listId} aria-activedescendant={shown[active] ? optionId(active) : undefined} autoFocus value={filter} onChange={(e) => { setFilter(e.target.value); setActive(0); }} onKeyDown={onKey} placeholder="Type to filter" />
      ) : null}
      <ul ref={list} id={listId} role="listbox" aria-labelledby={labelId} className="select-list">
        {shown.map((o, i) => (
          <li
            key={o.value}
            id={optionId(i)}
            data-index={i}
            role="option"
            aria-selected={o.value === value}
            aria-disabled={o.disabled || undefined}
            className={i === active ? "active" : undefined}
            onMouseEnter={() => setActive(i)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => pick(o)}
          >
            <span>{o.label}</span>
            {o.hint ? <span className="muted"> {o.hint}</span> : null}
          </li>
        ))}
        {!shown.length ? <li className="muted" role="presentation">Nothing matches “{filter.trim()}”.</li> : null}
      </ul>
    </div>
  ) : null;
  return (
    <div className="select-field">
      <span id={labelId} className={labelHidden ? "visually-hidden" : "select-label"}>{label}</span>
      <button
        ref={button}
        type="button"
        role="combobox"
        className="select-button"
        aria-labelledby={labelId}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && !searchable && shown[active] ? optionId(active) : undefined}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        disabled={disabled}
        onClick={() => (open ? close() : show())}
        onKeyDown={onKey}
      >
        <span className={chosen ? undefined : "muted"}>{chosen?.label ?? placeholder}</span>
        <span className="select-chevron" aria-hidden="true" />
      </button>
      {layer ? createPortal(layer, document.body) : null}
    </div>
  );
}
