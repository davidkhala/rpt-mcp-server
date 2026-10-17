#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod/v4";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const HERE = path.dirname(fileURLToPath(import.meta.url));
const READER_EXE = process.env.RPT_READER_EXE ?? path.resolve(HERE, "..", "reader", "RptReader.exe");
// Report root, in order of precedence:
//   1. command line:  --root <dir>  or  --root=<dir>
//   2. environment:   RPT_ROOT
//   3. the current working directory (MCP clients normally start the server in the workspace)
function rootFromArgs(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") return argv[i + 1];
    if (argv[i].startsWith("--root=")) return argv[i].slice("--root=".length);
  }
  return undefined;
}
const ROOT = path.resolve(rootFromArgs(process.argv.slice(2)) || process.env.RPT_ROOT || process.cwd());
const READER_TIMEOUT_MS = 60_000;
const MAX_PARALLEL_READERS = 4;

// ---------------------------------------------------------------------------
// The JSON emitted by RptReader.exe ("dump") has this shape:
//   { name, file?, sizeBytes?, summary?, sections, tables, links, commands,
//     parameters, formulas, sqlExpressions, runningTotals, summaryFields,
//     groups, sortFields, recordSelection, groupSelection, subreports: [dump] }
// ---------------------------------------------------------------------------
class UserError extends Error {}

// ---------------------------------------------------------------------------
// Path sandbox
// ---------------------------------------------------------------------------
function isInside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Resolve a user supplied path to a real .rpt file strictly inside ROOT. */
async function resolveReport(input) {
  const full = path.resolve(ROOT, input);
  if (!isInside(ROOT, full)) throw new UserError("Path is outside the allowed report directory");
  if (path.extname(full).toLowerCase() !== ".rpt") throw new UserError("Only .rpt files are supported");
  let real;
  try {
    real = await fs.realpath(full);
  } catch {
    throw new UserError(`Report not found: ${input}`);
  }
  if (!isInside(await fs.realpath(ROOT), real)) throw new UserError("Path is outside the allowed report directory");
  return real;
}

async function resolveDirectory(input) {
  const full = path.resolve(ROOT, input ?? ".");
  if (!isInside(ROOT, full)) throw new UserError("Path is outside the allowed report directory");
  let real;
  try {
    real = await fs.realpath(full);
  } catch {
    throw new UserError(`Directory not found: ${input}`);
  }
  if (!isInside(await fs.realpath(ROOT), real)) throw new UserError("Path is outside the allowed report directory");
  return real;
}

// ---------------------------------------------------------------------------
// Reader process + cache
// ---------------------------------------------------------------------------
const cache = new Map();
let running = 0;
const waiters = [];

async function acquire() {
  if (running < MAX_PARALLEL_READERS) {
    running++;
    return;
  }
  await new Promise((resolve) => waiters.push(resolve));
}

function release() {
  const next = waiters.shift();
  if (next) next();
  else running--;
}

function runReader(file) {
  return new Promise((resolve, reject) => {
    execFile(
      READER_EXE,
      [file],
      { timeout: READER_TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024, windowsHide: true, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (err) {
          console.error(`RptReader failed for ${file}: ${err.message}\n${stderr}`);
          reject(new UserError("Failed to read the report (see server log for details)"));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          console.error(`Invalid reader output for ${file}: ${String(e)}`);
          reject(new UserError("Failed to parse the report (see server log for details)"));
        }
      },
    );
  });
}

async function loadReport(input) {
  const file = await resolveReport(input);
  const rel = path.relative(await fs.realpath(ROOT), file).replaceAll("\\", "/");
  const stat = await fs.stat(file);
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs) return { rel, dump: hit.dump };

  await acquire();
  try {
    const dump = await runReader(file);
    cache.set(file, { mtimeMs: stat.mtimeMs, dump });
    return { rel, dump };
  } finally {
    release();
  }
}

async function listRptFiles(dir, recursive) {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory() && recursive) out.push(...(await listRptFiles(p, true)));
    else if (e.isFile() && e.name.toLowerCase().endsWith(".rpt")) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function text(value) {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

function fail(error) {
  const message = error instanceof UserError ? error.message : "Unexpected error (see server log for details)";
  if (!(error instanceof UserError)) console.error(error);
  return { content: [{ type: "text", text: message }], isError: true };
}

function wrap(fn) {
  return async (args) => {
    try {
      return text(await fn(args));
    } catch (e) {
      return fail(e);
    }
  };
}

/** Apply a facet extractor to the main report and every subreport. */
function perReport(dump, pick) {
  const result = { report: dump.name, ...asObject(pick(dump)) };
  if (dump.subreports.length > 0) {
    result.subreports = dump.subreports.map((s) => ({ subreport: s.name, ...asObject(pick(s)) }));
  }
  return result;
}

function asObject(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : { value: v };
}

const pathArg = z.string().describe("Report path relative to the report root, e.g. avl_print.rpt");

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = new McpServer({ name: "rpt-mcp-server", version: "0.1.0" });

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

server.registerTool(
  "list_reports",
  {
    description: "List .rpt files under the report root (does not open them).",
    inputSchema: z.object({
      subdir: z.string().optional().describe("Sub-directory relative to the root"),
      pattern: z.string().optional().describe("Case-insensitive substring filter on the file name"),
      recursive: z.boolean().optional().describe("Recurse into sub-directories (default true)"),
    }),
    annotations: readOnly,
  },
  wrap(async ({ subdir, pattern, recursive }) => {
    const dir = await resolveDirectory(subdir);
    const realRoot = await fs.realpath(ROOT);
    const files = await listRptFiles(dir, recursive ?? true);
    const needle = pattern?.toLowerCase();
    const items = [];
    for (const f of files) {
      if (needle && !path.basename(f).toLowerCase().includes(needle)) continue;
      const st = await fs.stat(f);
      items.push({
        path: path.relative(realRoot, f).replaceAll("\\", "/"),
        sizeBytes: st.size,
        modified: st.mtime.toISOString(),
      });
    }
    items.sort((a, b) => a.path.localeCompare(b.path));
    return { root: ROOT, count: items.length, reports: items };
  }),
);

server.registerTool(
  "get_report_summary",
  {
    description:
      "High level overview of a report: title/author, paper, margins and counts of sections, tables, parameters, formulas, subreports.",
    inputSchema: z.object({ path: pathArg }),
    annotations: readOnly,
  },
  wrap(async ({ path: p }) => {
    const { rel, dump } = await loadReport(p);
    const count = (v) => (Array.isArray(v) ? v.length : 0);
    return {
      path: rel,
      sizeBytes: dump.sizeBytes,
      summary: dump.summary,
      counts: {
        sections: count(dump.sections),
        tables: count(dump.tables),
        commands: count(dump.commands),
        links: count(dump.links),
        parameters: count(dump.parameters),
        formulas: count(dump.formulas),
        sqlExpressions: count(dump.sqlExpressions),
        runningTotals: count(dump.runningTotals),
        groups: count(dump.groups),
        sortFields: count(dump.sortFields),
        subreports: dump.subreports.length,
      },
      subreports: dump.subreports.map((s) => s.name),
    };
  }),
);

server.registerTool(
  "get_report_structure",
  {
    description:
      "Section layout of the report (Report Header, Page Header, Group Header, Details, ...) with the number of objects and their kinds per section. Use list_report_objects for object details.",
    inputSchema: z.object({ path: pathArg }),
    annotations: readOnly,
  },
  wrap(async ({ path: p }) => {
    const { rel, dump } = await loadReport(p);
    return {
      path: rel,
      ...perReport(dump, (r) => ({
        sections: (Array.isArray(r.sections) ? r.sections : []).map((s) => {
          const kinds = {};
          for (const o of s.objects) kinds[o.kind] = (kinds[o.kind] ?? 0) + 1;
          return { name: s.name, kind: s.kind, height: s.height, objectCount: s.objects.length, objectKinds: kinds };
        }),
      })),
    };
  }),
);

server.registerTool(
  "list_report_objects",
  {
    description:
      "List objects in a report (fields, text, lines, boxes, subreports, ...) with position/size, text content and bound field.",
    inputSchema: z.object({
      path: pathArg,
      section: z.string().optional().describe("Exact section name, e.g. DetailSection1"),
      kind: z.string().optional().describe("Object kind filter, e.g. FieldObject, TextObject, SubreportObject"),
    }),
    annotations: readOnly,
  },
  wrap(async ({ path: p, section, kind }) => {
    const { rel, dump } = await loadReport(p);
    return {
      path: rel,
      ...perReport(dump, (r) => ({
        objects: (Array.isArray(r.sections) ? r.sections : [])
          .filter((s) => !section || s.name === section)
          .flatMap((s) =>
            s.objects.filter((o) => !kind || o.kind === kind).map((o) => ({ section: s.name, ...o })),
          ),
      })),
    };
  }),
);

server.registerTool(
  "get_data_sources",
  {
    description:
      "Tables, connection (server/database only, never credentials) and table links (join type and fields). Add-Command tables appear with their SQL in get_command_sql.",
    inputSchema: z.object({ path: pathArg }),
    annotations: readOnly,
  },
  wrap(async ({ path: p }) => {
    const { rel, dump } = await loadReport(p);
    return {
      path: rel,
      ...perReport(dump, (r) => ({
        tables: (Array.isArray(r.tables) ? r.tables : []).map((t) => ({
          name: t.name,
          location: t.location,
          connection: t.connection,
          fieldCount: t.fields.length,
        })),
        links: r.links,
      })),
    };
  }),
);

server.registerTool(
  "get_database_fields",
  {
    description: "Database fields (name, type, byte length) of the tables used by the report.",
    inputSchema: z.object({
      path: pathArg,
      table: z.string().optional().describe("Only this table (case-insensitive exact name)"),
    }),
    annotations: readOnly,
  },
  wrap(async ({ path: p, table }) => {
    const { rel, dump } = await loadReport(p);
    const want = table?.toLowerCase();
    return {
      path: rel,
      ...perReport(dump, (r) => ({
        tables: (Array.isArray(r.tables) ? r.tables : [])
          .filter((t) => !want || String(t.name).toLowerCase() === want)
          .map((t) => ({ name: t.name, fields: t.fields })),
      })),
    };
  }),
);

server.registerTool(
  "get_command_sql",
  {
    description:
      "SQL text of 'Add Command' data sources. This is usually where the report's business logic lives. Parameters appear as {?name}.",
    inputSchema: z.object({ path: pathArg }),
    annotations: readOnly,
  },
  wrap(async ({ path: p }) => {
    const { rel, dump } = await loadReport(p);
    return { path: rel, ...perReport(dump, (r) => ({ commands: r.commands })) };
  }),
);

server.registerTool(
  "list_parameters",
  {
    description: "Parameter fields: name, type, prompt text, multi-value/range kind, default values.",
    inputSchema: z.object({ path: pathArg }),
    annotations: readOnly,
  },
  wrap(async ({ path: p }) => {
    const { rel, dump } = await loadReport(p);
    return { path: rel, ...perReport(dump, (r) => ({ parameters: r.parameters })) };
  }),
);

server.registerTool(
  "list_formulas",
  {
    description: "Formula fields, SQL expression fields, running totals and summary fields with their definitions.",
    inputSchema: z.object({
      path: pathArg,
      name: z.string().optional().describe("Only formulas whose name contains this text (case-insensitive)"),
    }),
    annotations: readOnly,
  },
  wrap(async ({ path: p, name }) => {
    const { rel, dump } = await loadReport(p);
    const needle = name?.toLowerCase();
    const filter = (v) =>
      Array.isArray(v) && needle ? v.filter((f) => String(f.name).toLowerCase().includes(needle)) : v;
    return {
      path: rel,
      ...perReport(dump, (r) => ({
        formulas: filter(r.formulas),
        sqlExpressions: filter(r.sqlExpressions),
        runningTotals: filter(r.runningTotals),
        summaryFields: filter(r.summaryFields),
      })),
    };
  }),
);

server.registerTool(
  "get_selection_formulas",
  {
    description: "Record selection formula and group selection formula.",
    inputSchema: z.object({ path: pathArg }),
    annotations: readOnly,
  },
  wrap(async ({ path: p }) => {
    const { rel, dump } = await loadReport(p);
    return {
      path: rel,
      ...perReport(dump, (r) => ({ recordSelection: r.recordSelection, groupSelection: r.groupSelection })),
    };
  }),
);

server.registerTool(
  "get_grouping_and_sorting",
  {
    description: "Group definitions and record sort fields.",
    inputSchema: z.object({ path: pathArg }),
    annotations: readOnly,
  },
  wrap(async ({ path: p }) => {
    const { rel, dump } = await loadReport(p);
    return { path: rel, ...perReport(dump, (r) => ({ groups: r.groups, sortFields: r.sortFields })) };
  }),
);

server.registerTool(
  "get_subreports",
  {
    description: "Subreports of a report with their link fields, tables, commands and parameters.",
    inputSchema: z.object({ path: pathArg }),
    annotations: readOnly,
  },
  wrap(async ({ path: p }) => {
    const { rel, dump } = await loadReport(p);
    return {
      path: rel,
      subreports: dump.subreports.map((s) => ({
        name: s.name,
        links: s.links,
        tables: (Array.isArray(s.tables) ? s.tables : []).map((t) => t.name),
        commands: s.commands,
        parameters: s.parameters,
      })),
    };
  }),
);

const searchScopes = ["formula", "sql", "field", "text", "parameter", "table", "all"];

function searchReport(dump, needle, scope) {
  const hits = [];
  const want = (s) => scope === "all" || scope === s;
  const add = (kind, report, where, value) => {
    const s = typeof value === "string" ? value : "";
    const i = s.toLowerCase().indexOf(needle);
    if (i < 0) return;
    hits.push({ in: kind, report, where, snippet: s.slice(Math.max(0, i - 60), i + needle.length + 60) });
  };
  const walk = (r) => {
    const arr = (v) => (Array.isArray(v) ? v : []);
    if (want("formula")) {
      for (const f of arr(r.formulas)) {
        add("formula", r.name, f.name, f.name);
        add("formula", r.name, f.name, f.text);
      }
      for (const f of arr(r.sqlExpressions)) {
        add("formula", r.name, `SQL expression ${f.name}`, f.text);
      }
      add("formula", r.name, "record selection", r.recordSelection);
      add("formula", r.name, "group selection", r.groupSelection);
    }
    if (want("sql")) for (const c of arr(r.commands)) add("sql", r.name, c.name ?? "Command", c.sql);
    if (want("table")) for (const t of arr(r.tables)) add("table", r.name, t.name, `${t.name} ${t.location ?? ""}`);
    if (want("parameter")) for (const pa of arr(r.parameters)) add("parameter", r.name, pa.name, `${pa.name} ${pa.promptText ?? ""}`);
    if (want("field") || want("text")) {
      for (const s of arr(r.sections)) {
        for (const o of arr(s.objects)) {
          if (want("field")) add("field", r.name, `${s.name}/${o.name}`, o.field);
          if (want("text")) add("text", r.name, `${s.name}/${o.name}`, o.text);
        }
      }
    }
    if (want("field")) {
      for (const t of arr(r.tables)) for (const f of arr(t.fields)) add("field", r.name, `${t.name}.${f.name}`, f.formulaName);
    }
    for (const s of r.subreports) walk(s);
  };
  walk(dump);
  return hits;
}

server.registerTool(
  "search_reports",
  {
    description:
      "Case-insensitive text search across all reports (formulas, command SQL, field names, static text, parameters, tables). Example: which reports use the field PolicyNo.",
    inputSchema: z.object({
      query: z.string().min(2).max(200).describe("Text to look for"),
      scope: z.enum(searchScopes).optional().describe("Where to search (default all)"),
      subdir: z.string().optional().describe("Limit to this sub-directory"),
      maxResults: z.number().int().min(1).max(500).optional().describe("Maximum hits to return (default 100)"),
    }),
    annotations: readOnly,
  },
  wrap(async ({ query, scope, subdir, maxResults }) => {
    const dir = await resolveDirectory(subdir);
    const realRoot = await fs.realpath(ROOT);
    const files = await listRptFiles(dir, true);
    const needle = query.toLowerCase();
    const limit = maxResults ?? 100;
    const results = [];
    const errors = [];
    let total = 0;
    await Promise.all(
      files.map(async (f) => {
        const rel = path.relative(realRoot, f).replaceAll("\\", "/");
        try {
          const { dump } = await loadReport(rel);
          const hits = searchReport(dump, needle, scope ?? "all");
          if (hits.length > 0) {
            total += hits.length;
            results.push({ path: rel, hits });
          }
        } catch {
          errors.push(rel);
        }
      }),
    );
    results.sort((a, b) => a.path.localeCompare(b.path));
    let remaining = limit;
    for (const r of results) {
      r.hits = r.hits.slice(0, Math.max(0, remaining));
      remaining -= r.hits.length;
    }
    return {
      query,
      scope: scope ?? "all",
      scanned: files.length,
      totalHits: total,
      truncated: total > limit,
      failedToRead: errors,
      results: results.filter((r) => r.hits.length > 0),
    };
  }),
);

server.registerTool(
  "export_report_json",
  {
    description: "Complete JSON dump of one report (everything the other tools expose). Can be large.",
    inputSchema: z.object({ path: pathArg }),
    annotations: readOnly,
  },
  wrap(async ({ path: p }) => {
    const { rel, dump } = await loadReport(p);
    return { path: rel, ...dump };
  }),
);

async function main() {
  const rootStat = await fs.stat(ROOT).catch(() => undefined);
  if (!rootStat?.isDirectory()) throw new Error(`Report root is not a directory: ${ROOT}`);
  await fs.access(READER_EXE).catch(() => {
    throw new Error(`RptReader.exe not found at ${READER_EXE}. Run: npm run build:reader`);
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`rpt-mcp-server running on stdio, root=${ROOT}`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
