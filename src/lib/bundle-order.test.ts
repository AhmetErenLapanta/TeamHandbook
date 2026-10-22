import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// The plugin runs the esbuild bundles in dist/, not src/, and the two disagree in one
// place. Real ES modules resolve an import cycle with live bindings; esbuild flattens the
// cycle into one scope, writes one side's body first and turns its top-level const into
// var. A value the first body reads from the second at module level is then read before
// it is assigned: no TDZ error, just a silent `undefined` baked into a string or a regex.
// It happened once, in a note telling the user which file to correct: every bundle that
// carried it said "if a name in undefined is wrong", while the src/ test asserting the full
// sentence passed and dist/ stayed in sync with the build. Nothing that runs src/ can see
// it and nothing in the bundle's text shows it, so this checks the shape itself.
//
// The condition that separates broken from safe is the import cycle, not the bundle
// layout. Without a cycle the provider is always evaluated first, including when esbuild
// wraps it for a dynamic import: measured, the transcript role pattern built at module
// level from a class imported from a wrapped module carried its real value in all three
// bundles that wrap that module. Entrypoints import nothing that imports them back, so
// their module-level main() needs no exemption.
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

interface CycleRead {
  file: string;
  line: number;
  name: string;
  from: string;
  via: string;
}

function resolveImport(from: string, specifier: string, files: Map<string, ts.SourceFile>): string | null {
  if (!specifier.startsWith(".")) return null;
  const target = resolve(dirname(from), specifier).replace(/\.js$/, ".ts");
  return files.has(target) ? target : null;
}

/** Each module-level read of a value imported from a module in the reader's own static
 * import cycle. Type-only imports and import() are not edges: neither is evaluated with
 * the module. */
function cycleReads(sources: Map<string, string>, root: string): CycleRead[] {
  const files = new Map(
    [...sources].map(([path, text]) => [path, ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)]),
  );
  const edges = new Map<string, Set<string>>();
  const imported = new Map<string, Map<string, string>>();
  for (const [path, file] of files) {
    const out = new Set<string>();
    const names = new Map<string, string>();
    for (const statement of file.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        const target = resolveImport(path, statement.moduleSpecifier.text, files);
        const clause = statement.importClause;
        if (!target || clause?.isTypeOnly) continue;
        const values: string[] = [];
        if (clause?.name) values.push(clause.name.text);
        const bindings = clause?.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) values.push(bindings.name.text);
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) if (!element.isTypeOnly) values.push(element.name.text);
        }
        if (!clause || values.length) out.add(target);
        for (const value of values) names.set(value, target);
      } else if (
        ts.isExportDeclaration(statement) &&
        !statement.isTypeOnly &&
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        const target = resolveImport(path, statement.moduleSpecifier.text, files);
        if (target) out.add(target);
      }
    }
    edges.set(path, out);
    imported.set(path, names);
  }

  // Tarjan's strongly connected components: a component of more than one module is a cycle.
  const cycleOf = new Map<string, Set<string>>();
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  let next = 0;
  const connect = (v: string): void => {
    index.set(v, next);
    low.set(v, next);
    next++;
    stack.push(v);
    for (const w of edges.get(v) ?? []) {
      if (!index.has(w)) {
        connect(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (stack.includes(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
    }
    if (low.get(v) === index.get(v)) {
      const component = new Set<string>();
      let w: string;
      do {
        w = stack.pop()!;
        component.add(w);
      } while (w !== v);
      for (const member of component) cycleOf.set(member, component);
    }
  };
  for (const path of files.keys()) if (!index.has(path)) connect(path);

  const reads: CycleRead[] = [];
  for (const [path, file] of files) {
    const cycle = cycleOf.get(path)!;
    if (cycle.size < 2) continue;
    const names = imported.get(path)!;
    const localFunctions = new Map<string, ts.Node>();
    for (const statement of file.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
        localFunctions.set(statement.name.text, statement.body);
      }
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          const init = declaration.initializer;
          if (ts.isIdentifier(declaration.name) && init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
            localFunctions.set(declaration.name.text, init.body);
          }
        }
      }
    }
    // A function body runs when it is called, so it is skipped - unless module-level code
    // calls a function of this same file, which runs that body right then.
    const walk = (node: ts.Node, via: string, entered: Set<string>): void => {
      if (ts.isFunctionLike(node)) return;
      if (ts.isClassLike(node)) {
        for (const member of node.members) {
          const isStatic = ts.canHaveModifiers(member) && ts.getModifiers(member)?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword);
          if (ts.isPropertyDeclaration(member) && isStatic && member.initializer) walk(member.initializer, via, entered);
          if (ts.isClassStaticBlockDeclaration(member)) walk(member.body, via, entered);
          if (member.name && ts.isComputedPropertyName(member.name)) walk(member.name.expression, via, entered);
        }
        node.heritageClauses?.forEach((clause) => clause.types.forEach((type) => walk(type.expression, via, entered)));
        return;
      }
      if (ts.isIdentifier(node) && names.has(node.text)) {
        const parent = node.parent;
        const isPropertyName =
          (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
          (ts.isPropertyAssignment(parent) && parent.name === node);
        const provider = names.get(node.text)!;
        if (!isPropertyName && cycle.has(provider)) {
          reads.push({
            file: relative(root, path),
            line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1,
            name: node.text,
            from: relative(root, provider),
            via,
          });
        }
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const callee = node.expression.text;
        const body = localFunctions.get(callee);
        if (body && !entered.has(callee)) {
          ts.forEachChild(body, (child) => walk(child, `${via} via ${callee}()`, new Set([...entered, callee])));
        }
      }
      ts.forEachChild(node, (child) => walk(child, via, entered));
    };
    for (const statement of file.statements) {
      if (ts.isImportDeclaration(statement) || ts.isFunctionDeclaration(statement)) continue;
      if (ts.isExportDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) continue;
      walk(statement, "module level", new Set());
    }
  }
  return reads;
}

function sourceTree(dir: string): Map<string, string> {
  const sources = new Map<string, string>();
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      for (const [p, text] of sourceTree(path)) sources.set(p, text);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".d.ts")) {
      sources.set(path, readFileSync(path, "utf8"));
    }
  }
  return sources;
}

function fixture(modules: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(modules).map(([name, text]) => [join("/fixture", name), text]));
}

describe("a module-level value read from inside an import cycle", () => {
  it("given the source tree, when every module-level evaluation is swept, then none reads a value imported from its own cycle", () => {
    const reads = cycleReads(sourceTree(join(repoRoot, "src")), repoRoot);

    expect(
      reads.map((r) => `${r.file}:${r.line} reads ${r.name} from ${r.from} at ${r.via}; build it inside a function or move it out of the cycle`),
    ).toEqual([]);
  });

  it("given a module-level template reading a constant from a module that imports it back, when swept, then the read is reported", () => {
    const reads = cycleReads(
      fixture({
        "notes.ts": `import { TEAM_FILE } from "./setup.js";\nexport const CORRECT = \`if a name in \${TEAM_FILE} is wrong\`;\nexport function note() { return CORRECT; }\n`,
        "setup.ts": `import { note } from "./notes.js";\nexport const TEAM_FILE = ".team.json";\nexport function run() { return note(); }\n`,
      }),
      "/fixture",
    );

    expect(reads).toEqual([{ file: "notes.ts", line: 2, name: "TEAM_FILE", from: "setup.ts", via: "module level" }]);
  });

  it("given the same module-level read with no cycle, when swept, then nothing is reported", () => {
    const reads = cycleReads(
      fixture({
        "usage.ts": `import { DEFAULT_SIZE } from "./command.js";\nexport const USAGE = \`--limit <n> (default \${DEFAULT_SIZE})\`;\n`,
        "command.ts": `export const DEFAULT_SIZE = 5;\n`,
      }),
      "/fixture",
    );

    expect(reads).toEqual([]);
  });

  it("given a read from the cycle that sits inside a function body, when swept, then nothing is reported", () => {
    const reads = cycleReads(
      fixture({
        "notes.ts": `import { TEAM_FILE } from "./setup.js";\nexport function note() { return \`if a name in \${TEAM_FILE} is wrong\`; }\n`,
        "setup.ts": `import { note } from "./notes.js";\nexport const TEAM_FILE = ".team.json";\nexport const run = () => note();\n`,
      }),
      "/fixture",
    );

    expect(reads).toEqual([]);
  });

  it("given module-level code calling a local helper that reads from the cycle, when swept, then the read is reported through the helper", () => {
    const reads = cycleReads(
      fixture({
        "notes.ts": `import { TEAM_FILE } from "./setup.js";\nfunction correct() { return \`in \${TEAM_FILE}\`; }\nexport const CORRECT = correct();\n`,
        "setup.ts": `import { CORRECT } from "./notes.js";\nexport const TEAM_FILE = ".team.json";\nexport function run() { return CORRECT; }\n`,
      }),
      "/fixture",
    );

    expect(reads).toEqual([{ file: "notes.ts", line: 2, name: "TEAM_FILE", from: "setup.ts", via: "module level via correct()" }]);
  });

  it("given a cycle closed only by a type-only import, when swept, then nothing is reported", () => {
    const reads = cycleReads(
      fixture({
        "notes.ts": `import { TEAM_FILE } from "./setup.js";\nexport const CORRECT = \`in \${TEAM_FILE}\`;\nexport type Note = string;\n`,
        "setup.ts": `import type { Note } from "./notes.js";\nexport const TEAM_FILE = ".team.json";\nexport const empty: Note = "";\n`,
      }),
      "/fixture",
    );

    expect(reads).toEqual([]);
  });
});
