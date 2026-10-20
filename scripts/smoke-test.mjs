// Smoke test: drives the server over stdio with raw JSON-RPC.
// Usage: node scripts/smoke-test.mjs <report-dir>
// The directory must contain avl_print.rpt and application_avl.rpt.
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

if (!process.argv[2]) {
  console.error("Usage: node scripts/smoke-test.mjs <report-dir>");
  process.exit(1);
}
const root = path.resolve(process.argv[2]);
const rpt = (name) => path.join(root, name);
const child = spawn("node", ["src/index.js"], {
  stdio: ["pipe", "pipe", "inherit"],
});
const pending = new Map();
readline.createInterface({ input: child.stdout }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id !== undefined && pending.has(msg.id)) pending.get(msg.id)(msg);
});
let nextId = 1;
const rpc = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
const call = async (name, args) => {
  const r = await rpc("tools/call", { name, arguments: args });
  const res = r.result ?? { isError: true, content: [{ text: JSON.stringify(r.error) }] };
  return { isError: !!res.isError, text: res.content[0].text };
};

const init = await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "smoke", version: "0" },
});
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
console.log("server:", init.result?.serverInfo);

const tools = await rpc("tools/list", {});
console.log("tools:", tools.result.tools.map((t) => t.name).join(", "));

const show = async (label, name, args, max = 600) => {
  const r = await call(name, args);
  console.log(`\n### ${label} isError=${r.isError} len=${r.text.length}\n${r.text.slice(0, max)}`);
};

await show("summary", "get_report_summary", { path: rpt("avl_print.rpt") }, 900);
await show("structure", "get_report_structure", { path: rpt("avl_print.rpt") }, 500);
await show("data_sources", "get_data_sources", { path: rpt("avl_print.rpt") }, 500);
await show("sql", "get_command_sql", { path: rpt("avl_print.rpt") }, 300);
await show("params", "list_parameters", { path: rpt("avl_print.rpt") }, 300);
await show("formulas", "list_formulas", { path: rpt("avl_print.rpt") }, 500);
await show("selection", "get_selection_formulas", { path: rpt("avl_print.rpt") }, 300);
await show("grouping", "get_grouping_and_sorting", { path: rpt("avl_print.rpt") }, 400);
await show("subreports", "get_subreports", { path: rpt("application_avl.rpt") }, 600);
await show("fields", "get_database_fields", { path: rpt("avl_print.rpt"), table: "VEH_MAKE_CODE" }, 400);
await show("objects", "list_report_objects", { path: rpt("avl_print.rpt"), kind: "TextObject" }, 400);
await show("search", "search_reports", { dir: root, query: "APPLN_REF_NO", scope: "sql", maxResults: 5 }, 900);
await show("export", "export_report_json", { path: rpt("avl_print.rpt") }, 100);

console.log("\n===== input validation =====");
await show("relative path", "get_report_summary", { path: "avl_print.rpt" });
await show("not rpt", "get_report_summary", { path: "C:\\Windows\\win.ini" });
await show("missing", "get_report_summary", { path: rpt("nope.rpt") });
await show("relative dir", "search_reports", { dir: "..", query: "xx" });
await show("missing dir", "search_reports", { dir: rpt("no-such-dir"), query: "xx" });

// ---------------------------------------------------------------------------
// Roundtrip test: export → save JSON → build .rpt → re-read → compare
// ---------------------------------------------------------------------------
console.log("\n===== roundtrip =====");
let roundtripPassed = true;
const tmpDir = path.join(os.tmpdir(), `rpt-roundtrip-${Date.now()}`);
const jsonOut = path.join(tmpDir, "avl_print.json");
const rptOut  = path.join(tmpDir, "avl_print_rebuilt.rpt");

// 1. Save JSON to disk.
const saveResult = await call("save_report_json", { path: rpt("avl_print.rpt"), out: jsonOut });
console.log(`\n[1] save_report_json  isError=${saveResult.isError}  ${saveResult.text.slice(0, 200)}`);
if (saveResult.isError) { roundtripPassed = false; }

// 2. Build .rpt from the JSON.
const buildResult = await call("build_report_from_json", { json: jsonOut, out: rptOut });
console.log(`\n[2] build_report_from_json  isError=${buildResult.isError}  len=${buildResult.text.length}`);
if (buildResult.isError) {
  console.log(buildResult.text.slice(0, 500));
  roundtripPassed = false;
}

if (!saveResult.isError && !buildResult.isError) {
  // 3. Compare the original JSON (from disk) with the rebuilt dump.
  const originalJson = JSON.parse(await fs.readFile(jsonOut, "utf8"));
  const rebuiltDump  = JSON.parse(buildResult.text);

  // Keys to compare (subset that the SDK can faithfully round-trip).
  const compareKeys = [
    "formulas", "sqlExpressions", "recordSelection", "groupSelection",
    "sortFields", "groups",
  ];

  // Also compare summary sub-fields that are writable.
  const summaryKeys = ["title", "author", "subject", "comments", "keywords"];

  let diffs = 0;

  for (const key of compareKeys) {
    const orig = JSON.stringify(originalJson[key] ?? null);
    const rebu = JSON.stringify(rebuiltDump[key] ?? null);
    if (orig !== rebu) {
      console.log(`  DIFF [${key}]`);
      console.log(`    original : ${orig.slice(0, 200)}`);
      console.log(`    rebuilt  : ${rebu.slice(0, 200)}`);
      diffs++;
    }
  }

  if (originalJson.summary && rebuiltDump.summary) {
    for (const k of summaryKeys) {
      const orig = originalJson.summary[k] ?? "";
      const rebu = rebuiltDump.summary[k] ?? "";
      if (orig !== rebu) {
        console.log(`  DIFF [summary.${k}]  original="${orig}"  rebuilt="${rebu}"`);
        diffs++;
      }
    }
  }

  if (diffs === 0) {
    console.log("\n✓ Roundtrip PASSED – all compared fields match.");
  } else {
    console.log(`\n✗ Roundtrip FAILED – ${diffs} field(s) differ.`);
    roundtripPassed = false;
  }
}

// 4. Cleanup temp files.
try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }

child.kill();
process.exit(roundtripPassed ? 0 : 1);
