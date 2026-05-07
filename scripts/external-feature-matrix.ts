import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";

interface MatrixCommandResult {
  command: string;
  payload: unknown;
  flags: string[];
  status: number | null;
  elapsedMs: number;
  ok: boolean;
  timedOut: boolean;
  summary: string;
}

interface MatrixRepoResult {
  root: string;
  exists: boolean;
  selectedSymbol?: {
    name: string;
    file?: string;
    line?: number;
    kind?: string;
  };
  results: MatrixCommandResult[];
}

const repoRoot = process.cwd();
const cliEntry = "apps/cli/src/main.ts";
const outputPath = join(repoRoot, ".quartz/artifacts/external-feature-matrix-results.json");
const externalRoots = [
  "/Users/guilhermecastro/Projects/typefully-cli",
  "/Users/guilhermecastro/Projects/agentpkg",
  "/Users/guilhermecastro/Projects/probe-cli",
  "/Users/guilhermecastro/Projects/firecrawl-cli",
  "/Users/guilhermecastro/Projects/opencode-plugin-template",
];
const commandTimeoutMs = 8_000;

const globalCommands = [
  { command: "capabilities", payload: undefined },
  { command: "schema list", payload: undefined },
  { command: "schema show", payload: "file" },
  { command: "examples list", payload: undefined },
  { command: "examples show", payload: "file" },
];

const artifactEligibleCommands = new Set([
  "expand",
  "diagnostics",
  "file",
  "graph",
  "refactor-preview",
  "why-error",
  "explain",
  "transform-search",
]);

const runCli = (command: string, payload?: unknown): MatrixCommandResult => {
  const args = ["run", cliEntry, ...command.split(" ")];
  if (payload !== undefined) {
    args.push(command === "schema show" || command === "examples show" ? String(payload) : JSON.stringify(payload));
  }
  const flags = artifactEligibleCommands.has(command) ? ["--output", "auto"] : [];
  args.push(...flags);

  const start = performance.now();
  const result = spawnSync("bun", args, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: commandTimeoutMs,
    maxBuffer: 1024 * 1024 * 8,
  });
  const elapsedMs = Math.round(performance.now() - start);
  const output = result.stdout || result.stderr || "";
  const parsed = parseJson(output);

  return {
    command,
    payload: payload ?? null,
    flags,
    status: result.status,
    elapsedMs,
    ok: result.status === 0,
    timedOut: isSpawnTimeout(result.error),
    summary: summarizeOutput(parsed, output, result.error?.message),
  };
};

const isSpawnTimeout = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  return record.code === "ETIMEDOUT" || /timed out|ETIMEDOUT/i.test(String(record.message ?? ""));
};

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const summarizeOutput = (parsed: unknown, raw: string, error?: string): string => {
  if (error) return error;
  if (parsed && typeof parsed === "object") {
    const value = parsed as Record<string, unknown>;
    if (value.ok === false && value.error && typeof value.error === "object") {
      const err = value.error as Record<string, unknown>;
      return `${String(err.type ?? "Error")}: ${String(err.message ?? "")}`.trim();
    }
    if (value.ok === true && typeof value.command === "string") {
      return summarizeEnvelope(value);
    }
    return "json";
  }
  return raw.slice(0, 240).replace(/\s+/g, " ").trim();
};

const summarizeEnvelope = (envelope: Record<string, unknown>): string => {
  const data = envelope.data;
  if (Array.isArray(data)) return `ok array(${data.length})`;
  if (data && typeof data === "object") {
    const object = data as Record<string, unknown>;
    if (Array.isArray(object.symbols)) return `ok symbols(${object.symbols.length})`;
    if (Array.isArray(object.results)) return `ok results(${object.results.length})`;
    if (typeof object.name === "string") return `ok ${object.name}`;
    if (typeof object.valid === "boolean") return `ok valid=${object.valid}`;
    if (typeof object.compatible === "boolean") return `ok compatible=${object.compatible}`;
    if (typeof object.package_count === "number") return `ok packages=${object.package_count}`;
    if (typeof object.kind === "string") return `ok ${object.kind}`;
  }
  return "ok";
};

const hasSemanticFailure = (result: MatrixCommandResult): boolean => {
  return /^ok valid=false\b/.test(result.summary);
};

const parseEnvelopeData = (command: string, payload?: unknown): unknown => {
  const args = ["run", cliEntry, ...command.split(" ")];
  if (payload !== undefined) args.push(JSON.stringify(payload));
  const result = spawnSync("bun", args, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: commandTimeoutMs,
    maxBuffer: 1024 * 1024 * 8,
  });
  const parsed = parseJson(result.stdout);
  if (!parsed || typeof parsed !== "object") return null;
  return (parsed as Record<string, unknown>).data ?? null;
};

const chooseSymbol = (root: string): MatrixRepoResult["selectedSymbol"] | undefined => {
  const data = parseEnvelopeData("symbols", { root, limit: 50 });
  if (!data || typeof data !== "object") return undefined;
  const symbols = (data as Record<string, unknown>).symbols;
  if (!Array.isArray(symbols)) return undefined;

  const preferred = symbols.find((item) =>
    item &&
    typeof item === "object" &&
    ["interface", "type", "class", "function"].includes(String((item as Record<string, unknown>).kind)),
  ) ?? symbols[0];

  if (!preferred || typeof preferred !== "object") return undefined;
  const symbol = preferred as Record<string, unknown>;
  const name = String(symbol.name ?? "");
  if (!name) return undefined;

  return {
    name,
    ...(typeof symbol.file === "string" ? { file: symbol.file } : {}),
    ...(typeof symbol.line === "number" ? { line: symbol.line } : {}),
    ...(typeof symbol.kind === "string" ? { kind: symbol.kind } : {}),
  };
};

const repoCommands = (root: string, symbol: NonNullable<MatrixRepoResult["selectedSymbol"]>) => {
  const file = symbol.file ?? "";
  return [
    { command: "packages", payload: { root } },
    { command: "symbols", payload: { root, limit: 25 } },
    { command: "info", payload: { root, symbol: symbol.name } },
    { command: "expand", payload: { root, symbol: symbol.name } },
    { command: "search", payload: { root, query: symbol.name.slice(0, Math.min(8, symbol.name.length)), limit: 10 } },
    { command: "diagnostics", payload: { root, explain: true } },
    ...(file ? [{ command: "at-position", payload: { root, file, line: symbol.line ?? 1, column: 1 } }] : []),
    { command: "related", payload: { root, symbol: symbol.name } },
    { command: "eval", payload: { root, expression: `Partial<${symbol.name}>` } },
    { command: "check-snippet", payload: { root, code: "const value = 1 satisfies number;" } },
    ...(file ? [{ command: "file", payload: { root, file, includePrivate: false } }] : []),
    { command: "compatible", payload: { root, from: symbol.name, to: symbol.name } },
    { command: "graph", payload: { root, symbol: symbol.name, depth: 1, format: "mermaid" } },
    { command: "refactor-preview", payload: { root, symbol: symbol.name, to: `${symbol.name}RenamedForMatrix` } },
    {
      command: "why-error",
      payload: { root, code: 2322, message: `Type '${symbol.name}' is not assignable to type '${symbol.name}'.` },
    },
    { command: "explain", payload: { root, expression: `Partial<${symbol.name}>` } },
    {
      command: "transform-search",
      payload: {
        root,
        from: symbol.name,
        to: symbol.name,
        paramPosition: "any",
        unwrapReturn: true,
        exportedOnly: false,
        allowTypeErasure: true,
        limit: 5,
      },
    },
    { command: "doctor", payload: { root } },
  ];
};

const results = {
  generatedAt: new Date().toISOString(),
  repoRoot,
  global: globalCommands.map(({ command, payload }) => runCli(command, payload)),
  repositories: [] as MatrixRepoResult[],
};

for (const root of externalRoots) {
  const repoResult: MatrixRepoResult = { root, exists: existsSync(root), results: [] };
  if (!repoResult.exists) {
    repoResult.results = [{
      command: "repo-exists",
      payload: { root },
      flags: [],
      status: 1,
      elapsedMs: 0,
      ok: false,
      timedOut: false,
      summary: "External matrix root does not exist",
    }];
    results.repositories.push(repoResult);
    continue;
  }

  const symbol = chooseSymbol(root);
  if (symbol) {
    repoResult.selectedSymbol = symbol;
    repoResult.results = repoCommands(root, symbol).map(({ command, payload }) => runCli(command, payload));
  } else {
    repoResult.results = [runCli("packages", { root }), runCli("symbols", { root, limit: 25 })];
  }
  results.repositories.push(repoResult);
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(results, null, 2) + "\n", "utf8");

const failures = [
  ...results.global.filter((result) => !result.ok || hasSemanticFailure(result)),
  ...results.repositories.flatMap((repo) => repo.results.filter((result) => !result.ok || hasSemanticFailure(result))),
];

console.log(JSON.stringify({
  output: relative(repoRoot, outputPath),
  repositories: results.repositories.length,
  commands: results.global.length + results.repositories.reduce((sum, repo) => sum + repo.results.length, 0),
  failures: failures.length,
}, null, 2));
