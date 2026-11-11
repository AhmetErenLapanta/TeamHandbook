import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Redactor } from "../server/tasks/redact.js";

/**
 * Set by `sh lab/verify.sh --fail-gate`: a scenario then leaves out the one step its checks
 * depend on, so a run that still passes shows the checks would not have caught the fault.
 */
export const FAIL_GATE = process.env.LAB_FAIL_GATE === "1";

const WITHHELD = /^(csrf|nonce|verifier|sealed|state|token)$|_hash$/;

/**
 * What a scenario leaves for whoever reads why it passed or failed: the orchestrator's store, the
 * tasks it ran, what the orchestrator printed, and the decision. Every line passes the orchestrator's
 * own task-log Redactor with the credentials the scenario handed out, so nothing the orchestrator
 * masks in a task's log is kept here in the clear. A scenario passes every credential it hands
 * out, a tracker's or a forge's token and an API key's secret among them: a column the store
 * keeps one in under an ordinary name, such as a setting's value, is masked by that value alone.
 * It sits under LAB_EVIDENCE_DIR, or the lab directory, and never in the repository.
 */
export class Evidence {
  readonly dir: string;
  private readonly secrets: string[];

  constructor(labDir: string, scenario: string, secrets: Iterable<string>) {
    this.dir = join(process.env.LAB_EVIDENCE_DIR ?? join(labDir, "evidence"), scenario);
    this.secrets = [...secrets];
    mkdirSync(this.dir, { recursive: true });
  }

  /** A credential learned once the scenario is under way, masked in everything written from here on. */
  add(secret: string): void {
    this.secrets.push(secret);
  }

  write(name: string, text: string): void {
    // A Redactor per file: one that ended inside a private key block withholds nothing of the next.
    const redactor = new Redactor(this.secrets);
    const file = join(this.dir, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text.split("\n").map((line) => redactor.line(line)).join("\n"), { mode: 0o600 });
  }

  json(name: string, value: unknown): void {
    this.write(name, JSON.stringify(value, null, 2) + "\n");
  }

  copy(name: string, file: string): void {
    if (existsSync(file)) this.write(name, readFileSync(file, "utf8"));
  }

  /**
   * Every table of a SQLite store, a row a line, with a binary value as its length alone. A
   * column that holds a credential's hash, a sealed value or a sign-in's one-time values is
   * withheld by its name: none has a shape the Redactor recognises, and a hash of the lab's
   * one password is as good as the password.
   */
  store(file: string): void {
    if (!existsSync(file)) {
      this.write("store.txt", `no SQLite store at ${file}: a Postgres store is not dumped here\n`);
      return;
    }
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[];
      for (const { name } of tables) {
        const rows = db.prepare(`SELECT * FROM "${name}"`).all();
        const lines = rows.map((row) => JSON.stringify(row, (key, value) => (WITHHELD.test(key) && value !== null ? "[withheld]" : value instanceof Uint8Array ? `<${value.length} bytes>` : value)));
        this.write(join("store", `${name}.ndjson`), lines.join("\n") + "\n");
      }
    } finally {
      db.close();
    }
  }

  decide(passed: boolean, reason: string): void {
    this.json("decision.json", { passed, failGate: FAIL_GATE, reason: reason.replace(/\x1b\[[0-9;]*m/g, "") });
  }
}
