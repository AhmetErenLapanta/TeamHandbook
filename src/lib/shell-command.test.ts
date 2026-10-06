import { describe, it, expect } from "vitest";
import { shellWriteTargets, simpleCommands, statusReaches } from "./shell-command.js";

const CWD = "/work/acme-api";
const HOME = "/home/fixture";

describe("shellWriteTargets", () => {
  it("given an in-place sed, a redirect, tee and a copy, when the line is read, then each written file is found", () => {
    const line = "sed -i '' 's/a/b/' src/A.kt && echo x > notes.txt | tee -a out.log && cp src/A.kt src/B.kt";

    const targets = shellWriteTargets(line, CWD, HOME);

    expect(targets).toEqual(["/work/acme-api/src/A.kt", "/work/acme-api/notes.txt", "/work/acme-api/out.log", "/work/acme-api/src/B.kt"]);
  });

  it("given a heredoc written to a file, when the line is read, then the file is the target and the body is not read as commands", () => {
    const line = "cat > src/Plan.kt <<'EOF'\nval x = a > b\necho bogus > /work/acme-api/fake.kt\nEOF\nnpm test";

    const targets = shellWriteTargets(line, CWD, HOME);

    expect(targets).toEqual(["/work/acme-api/src/Plan.kt"]);
  });

  it("given a quoted separator, an awk program and a grep pattern, when the line is read, then nothing counts as written", () => {
    const line = `echo "=== x ===" && awk 'NR>=176&&NR<=190 {print > "Task"}' f.txt && grep -n '>' src/A.kt && sed 's/a/b/' src/A.kt`;

    expect(shellWriteTargets(line, CWD, HOME)).toEqual([]);
  });

  it("given a cd and a git -C, when the line is read, then relative targets resolve where the shell would be", () => {
    const line = "cd /work/acme-app && echo 1 > a.txt && git -C /work/acme-api mv old.kt new.kt";

    expect(shellWriteTargets(line, CWD, HOME)).toEqual(["/work/acme-app/a.txt", "/work/acme-api/new.kt"]);
  });

  it("given a target a shell would still expand, a stderr log and a device, when the line is read, then none is a target", () => {
    const line = "npm test 2> err.log > /dev/null && echo 1 > $OUT/x.txt && echo 2 > ~/notes.md";

    expect(shellWriteTargets(line, CWD, HOME)).toEqual(["/home/fixture/notes.md"]);
  });
});

describe("statusReaches", () => {
  it("given a check piped into tail or followed by a semicolon, when its status is asked, then the line does not report it", () => {
    const piped = simpleCommands("npm test 2>&1 | tail -5");
    const chained = simpleCommands("cd x && npm test && git commit -m done");
    const masked = simpleCommands("npm test; echo done");

    expect(statusReaches(piped, 0)).toBe(false);
    expect(statusReaches(chained, 1)).toBe(true);
    expect(statusReaches(masked, 0)).toBe(false);
  });
});
