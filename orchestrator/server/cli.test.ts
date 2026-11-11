import { describe, expect, it } from "vitest";
import { parseCli, USAGE } from "./cli.js";

describe("the orchestrator's command line", () => {
  it("given no arguments, when they are read, then the orchestrator starts with no setting changed", () => {
    expect(parseCli([], "1.2.3")).toEqual({ env: {}, args: [] });
  });

  it("given --port, --data-dir and --no-open, when they are read, then each becomes the setting the orchestrator reads, the directory made absolute", () => {
    expect(parseCli(["--port", "18740", "--data-dir", "data/here", "--no-open"], "1.2.3", "/work")).toEqual({ env: { ORCHESTRATOR_PORT: "18740", ORCHESTRATOR_DATA_DIR: "/work/data/here", ORCHESTRATOR_NO_BROWSER: "1" }, args: [] });
  });

  it("given doctor with --fix after a flag, when they are read, then doctor runs with its own argument and the flag's setting", () => {
    expect(parseCli(["--data-dir", "/d", "doctor", "--fix"], "1.2.3")).toEqual({ env: { ORCHESTRATOR_DATA_DIR: "/d" }, args: ["doctor", "--fix"] });
  });

  it("given --env-file, when it is read, then the file is named absolute for the start to read, apart from the flags' settings", () => {
    expect(parseCli(["--env-file", "service.env", "--no-open"], "1.2.3", "/work")).toEqual({ env: { ORCHESTRATOR_NO_BROWSER: "1" }, args: [], envFile: "/work/service.env" });
  });

  it("given --help and --version, when they are read, then each is printed and nothing starts", () => {
    expect(parseCli(["--help"], "1.2.3")).toEqual({ print: USAGE, code: 0 });
    expect(parseCli(["--version"], "1.2.3")).toEqual({ print: "teamhandbook-orchestrator 1.2.3\n", code: 0 });
  });

  it.each([
    [["--port"]],
    [["--port", "0"]],
    [["--port", "eighty"]],
    [["--data-dir"]],
    [["--env-file"]],
    [["--open-sesame"]],
    [["migrate-store", "--from", "sqlite:x"]],
    [["serve"]],
  ])("given %j, when they are read, then the usage is printed with exit code 2 and nothing starts", (argv) => {
    const plan = parseCli(argv, "1.2.3");
    expect(plan).toMatchObject({ code: 2 });
    expect("print" in plan && plan.print.endsWith(USAGE)).toBe(true);
  });
});
