import { useEffect, useId, useState } from "react";
import { ConfirmAction } from "../Confirm";
import { DiffPatch } from "../design/DiffPatch";
import { Loading } from "../Status";
import { filePatch, filePath, filePlace, handbookFile, newSkillText } from "./handbook-file";
import type { FileKind, OpenedFile } from "./handbook-file";

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * A person's own skill or command opened as plain text in its row. "Save…" shows the change as a
 * patch and the file it writes before anything is written; a file changed since it was opened, or
 * text that looks like a key, is refused in one line and the field keeps what was typed.
 */
export function FileEditor({ source, kind, name, onDone }: { source: string; kind: FileKind; name: string; onDone: (saved: boolean) => void }) {
  const [opened, setOpened] = useState<OpenedFile | null>(null);
  const [draft, setDraft] = useState("");
  const [review, setReview] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const field = useId();
  useEffect(() => {
    handbookFile.read(source, kind, name).then((f) => {
      setOpened(f);
      setDraft(f.content ?? "");
    }, (e: Error) => setProblem(e.message));
  }, [source, kind, name]);
  if (!opened) return problem ? <p className="error small" role="alert">{problem}</p> : <Loading what={`the ${kind}`} />;
  if (opened.content === null) return <p className="muted small">It is not there any more.</p>;
  const save = () => {
    setBusy(true);
    setProblem(null);
    handbookFile.save(source, kind, name, draft, opened.digest).then(() => onDone(true), (e: Error) => {
      setProblem(e.message);
      setReview(false);
    }).finally(() => setBusy(false));
  };
  return (
    <div className="handbook-edit">
      {review ? (
        <>
          <DiffPatch patch={filePatch(opened.content, draft)} />
          <p className="muted small">Saves <span className="mono">{filePath(source, kind, name)}</span>.</p>
          <div className="actions">
            <button type="button" disabled={busy} onClick={save}>Save</button>
            <button type="button" className="secondary" disabled={busy} onClick={() => setReview(false)}>Keep editing</button>
          </div>
        </>
      ) : (
        <>
          <label className="visually-hidden" htmlFor={field}>{kind === "skill" ? "SKILL.md" : `${name}.md`} of {name}</label>
          <textarea id={field} className="mono" rows={16} spellCheck={false} value={draft} onChange={(e) => setDraft(e.target.value)} />
          {problem ? <p className="error small" role="alert">{problem}</p> : null}
          <div className="actions">
            <button type="button" disabled={draft === opened.content} onClick={() => setReview(true)}>Save…</button>
            <button type="button" className="secondary" onClick={() => onDone(false)}>Cancel</button>
          </div>
        </>
      )}
    </div>
  );
}

/** Removing a person's own skill or command: asked first, naming what it deletes. */
export function RemoveFile({ source, kind, name, onDone }: { source: string; kind: FileKind; name: string; onDone: () => void }) {
  return (
    <ConfirmAction
      trigger="Remove…"
      triggerLabel={`Remove ${name}`}
      consequence={`This deletes ${filePlace(source, kind, name)} and nothing else.`}
      confirm="Remove"
      keep="Keep it"
      small
      danger
      onConfirm={async () => {
        const now = await handbookFile.read(source, kind, name);
        if (now.digest === null) throw new Error("It is not there any more.");
        await handbookFile.remove(source, kind, name, now.digest);
        onDone();
      }}
    />
  );
}

/** A plugin's or the team's skill made the person's own under its name; one of theirs by that name is never written over. */
export function CopyToYours({ source, name, read, onDone }: { source: string; name: string; read: (source: string, name: string) => Promise<string>; onDone: () => void }) {
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const copy = () => {
    setBusy(true);
    setSaid(null);
    read(source, name)
      .then((text) => handbookFile.save("yours", "skill", name, text, null))
      .then(() => {
        setSaid({ ok: true, text: `Copied to ${filePlace("yours", "skill", name)}.` });
        onDone();
      }, (e: Error) => setSaid({ ok: false, text: e.message }))
      .finally(() => setBusy(false));
  };
  return (
    <div>
      <button type="button" className="secondary small" disabled={busy} onClick={copy}>Copy to Yours</button>
      {said ? <p className={said.ok ? "muted small" : "error small"} role={said.ok ? "status" : "alert"}>{said.text}</p> : null}
    </div>
  );
}

/** A new skill of the person's own, its name, when to use it and its body, or a new command, its name and its text; saved in Yours. */
export function NewFile({ kind, onDone }: { kind: FileKind; onDone: (saved: boolean) => void }) {
  const [name, setName] = useState("");
  const [when, setWhen] = useState("");
  const [body, setBody] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const named = NAME.test(name);
  const ready = named && body.trim() !== "" && (kind === "command" || when.trim() !== "");
  const save = () => {
    setBusy(true);
    setProblem(null);
    const text = kind === "skill" ? newSkillText(name, when, body) : `${body.trim()}\n`;
    handbookFile.save("yours", kind, name, text, null).then(() => onDone(true), (e: Error) => setProblem(e.message)).finally(() => setBusy(false));
  };
  return (
    <form className="form handbook-edit" onSubmit={(e) => { e.preventDefault(); if (ready) save(); }} aria-label={kind === "skill" ? "New skill" : "New command"}>
      <label>Name<input className="mono" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" spellCheck={false} /></label>
      {name && !named ? <p className="muted small">Lower-case letters, digits and dashes.</p> : null}
      {kind === "skill" ? <label>When to use it<input value={when} onChange={(e) => setWhen(e.target.value)} /></label> : null}
      <label>{kind === "skill" ? "Body" : "Text"}<textarea className="mono" rows={10} spellCheck={false} value={body} onChange={(e) => setBody(e.target.value)} /></label>
      {named ? <p className="muted small">Saves <span className="mono">{filePath("yours", kind, name)}</span>.</p> : null}
      {problem ? <p className="error small" role="alert">{problem}</p> : null}
      <div className="actions">
        <button type="submit" disabled={!ready || busy}>Save</button>
        <button type="button" className="secondary" onClick={() => onDone(false)}>Cancel</button>
      </div>
    </form>
  );
}
