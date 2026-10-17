// Smoke test: drives the server over stdio with raw JSON-RPC.
// Usage: node scripts/smoke-test.mjs <report-dir>
// The directory must contain avl_print.rpt and application_avl.rpt.
import { spawn } from "node:child_process";
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

await show("list_reports", "list_reports", { dir: root, pattern: "avl" }, 500);
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
await show("relative dir", "list_reports", { dir: ".." });
await show("missing dir", "list_reports", { dir: rpt("no-such-dir") });

child.kill();
process.exit(0);
