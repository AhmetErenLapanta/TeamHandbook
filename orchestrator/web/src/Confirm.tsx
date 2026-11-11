import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

/**
 * An action that cannot be taken back, asked in two steps on the page rather than in a browser
 * dialog. The first button only opens the question; the question says what happens before the
 * button that does it, which names the action, and the way out says what is kept.
 *
 * `consequence` starts with the result, as "This cannot be undone. Any task using this key
 * stops at once."; `confirm` is the action ("Revoke key"); `keep` what stays ("Keep key").
 */
export function ConfirmAction({ trigger, triggerLabel, consequence, confirm, keep, onConfirm, reason, small = false, primary = false, danger = false }: {
  trigger: string;
  /** The opening button's name when its text alone does not say what it acts on, as in a table row. */
  triggerLabel?: string;
  consequence: string;
  confirm: string;
  keep: string;
  /** Rejects with the reason to show; the question stays open so it can be tried again or kept. Takes the line written in `reason`'s field, empty when none. */
  onConfirm: (why: string) => Promise<unknown>;
  /** An optional one-line field in the question for why the action is taken, its label and a line under it saying where it goes. */
  reason?: { label: string; note: string };
  small?: boolean;
  /** The opening button is the screen's main action. */
  primary?: boolean;
  /** The opening button is outlined as what cannot be undone, as stopping a running task; never filled. */
  danger?: boolean;
}) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [why, setWhy] = useState("");
  const opener = useRef<HTMLButtonElement>(null);
  const keeper = useRef<HTMLButtonElement>(null);
  const reopened = useRef(false);
  // The safe answer has the focus when the question opens, and the opener gets it back after.
  useEffect(() => {
    if (asking) keeper.current?.focus();
    else if (reopened.current) opener.current?.focus();
  }, [asking]);
  const size = small ? " small" : "";
  if (!asking) {
    return <button ref={opener} type="button" className={`${danger ? "danger" : primary ? "" : "secondary"}${size}`.trim() || undefined} aria-label={triggerLabel} onClick={() => setAsking(true)}>{trigger}</button>;
  }
  const go = () => {
    setBusy(true);
    setError(null);
    onConfirm(why.trim()).then(
      () => {
        setBusy(false);
        setWhy("");
        reopened.current = false;
        setAsking(false);
      },
      (e: Error) => {
        setError(e.message);
        setBusy(false);
      },
    );
  };
  const stay = () => {
    reopened.current = true;
    setError(null);
    setAsking(false);
  };
  return (
    <div className="confirm" role="group" aria-label={confirm}>
      <p>{consequence}</p>
      {reason ? (
        <label>
          {reason.label}
          <input type="text" value={why} onChange={(e) => setWhy(e.target.value)} maxLength={300} disabled={busy} />
          <span className="muted small">{reason.note}</span>
        </label>
      ) : null}
      <div className="actions">
        <button type="button" className={`confirm-go${size}`} onClick={go} disabled={busy}>{busy ? `${confirm}…` : confirm}</button>
        <button ref={keeper} type="button" className={`secondary${size}`} onClick={stay} disabled={busy}>{keep}</button>
      </div>
      {error ? <p className="error" role="alert">{error}</p> : null}
    </div>
  );
}

function selectContents(element: HTMLElement | null): void {
  const selection = window.getSelection();
  if (!element || !selection) return;
  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * Copies `text`. Where the browser refuses the clipboard, the text in `target` is selected
 * instead, so one keyboard shortcut still copies it.
 */
export function CopyButton({ text, target, label = "Copy", primary = false, small = true }: { text: string; target: RefObject<HTMLElement | null>; label?: string; primary?: boolean; small?: boolean }) {
  const [said, setSaid] = useState<string | null>(null);
  const refused = () => {
    selectContents(target.current);
    setSaid("Copy failed; it is selected, so copy it with the keyboard.");
  };
  const copy = () => {
    if (!navigator.clipboard) return refused();
    navigator.clipboard.writeText(text).then(() => setSaid("Copied"), refused);
  };
  return (
    <>
      <button type="button" className={`${primary ? "" : "secondary"}${small ? " small" : ""}`.trim() || undefined} aria-label={label === "Copy" ? `Copy ${text}` : label} onClick={copy}>{label}</button>
      {said ? <span className="muted" role="status"> {said}</span> : null}
    </>
  );
}

/** A value shown to be copied, such as a key shown once or a link: the value and its Copy button. */
/** `primary` when copying it is the screen's one thing to do; `well` sets a command apart in a box of its own. */
export function CopyText({ text, label, primary = false, well = false }: { text: string; label?: string; primary?: boolean; well?: boolean }) {
  const shown = useRef<HTMLElement>(null);
  return (
    <span className={well ? "copy-text well" : "copy-text"}>
      <code ref={shown} className="link">{text}</code> <CopyButton text={text} target={shown} label={label} primary={primary} />
    </span>
  );
}
