import { useState } from "react";
import { call, manages } from "../api";
import type { Principal } from "../api";
import { usePref } from "../prefs";
import { HANDBOOK_MARKETPLACE_NAME, HANDBOOK_PLUGIN_NAME } from "./handbook-plugin";
import { usePersonalSetup } from "./personal";

const DISMISSED_KEY = "orchestrator.handbook-plugin.dismissed";

type Step = { at: "offer" } | { at: "asking" } | { at: "busy" } | { at: "done" } | { at: "failed"; why: string };

/**
 * One card, shown where this orchestrator reads the person's own Claude Code and finds the handbook
 * plugin missing from it: what the plugin is in a sentence, the one button, and what pressing it
 * does before it does it. Nothing is installed but by the person's click, and nothing shows where
 * their Claude Code is not read or the plugin is already there. `quiet` is for a screen whose own first action is another
 * button: this one then has no fill.
 */
export function HandbookPluginCard({ me, quiet = false }: { me: Principal; quiet?: boolean }) {
  const [step, setStep] = useState<Step>({ at: "offer" });
  const [dismissed, setDismissed] = usePref(DISMISSED_KEY);
  const here = me.mode === "local" && manages(me);
  const personal = usePersonalSetup(here);
  const missing = Boolean(personal) && !personal!.plugins.some((p) => p.name === HANDBOOK_PLUGIN_NAME && p.marketplace === HANDBOOK_MARKETPLACE_NAME);
  if (!here || (!missing && step.at !== "done") || (dismissed && step.at === "offer")) return null;
  const install = () => {
    setStep({ at: "busy" });
    call<{ installed: true } | { installed: false; why: string }>("POST", "/api/handbook/plugin").then(
      (r) => setStep(r.installed ? { at: "done" } : { at: "failed", why: r.why }),
      (e: Error) => setStep({ at: "failed", why: e.message }),
    );
  };
  return (
    <div className="plugin-card" role="status">
      {step.at === "done" ? (
        <p>The handbook plugin is installed; your next Claude Code session has it.</p>
      ) : (
        <>
          <p><strong>Add the handbook plugin to your Claude Code.</strong> It turns what your sessions teach into skills you keep or share.</p>
          {step.at === "asking" || step.at === "busy" ? <p className="muted">This adds the TeamHandbook marketplace to your Claude Code and installs the handbook plugin from it, with <code>claude plugin marketplace add</code> and <code>claude plugin install</code>. Nothing else changes.</p> : null}
          {step.at === "failed" ? <p className="error" role="alert">{step.why}</p> : null}
          <div className="actions">
            {step.at === "offer" || step.at === "failed" ? <button type="button" className={quiet ? "secondary" : undefined} onClick={() => setStep({ at: "asking" })}>Install the plugin…</button> : null}
            {step.at === "asking" || step.at === "busy" ? <button type="button" disabled={step.at === "busy"} onClick={install}>{step.at === "busy" ? "Installing…" : "Install"}</button> : null}
            <button type="button" className="secondary" disabled={step.at === "busy"} onClick={() => (step.at === "offer" ? setDismissed("yes") : setStep({ at: "offer" }))}>{step.at === "offer" ? "Not now" : "Cancel"}</button>
          </div>
        </>
      )}
    </div>
  );
}
