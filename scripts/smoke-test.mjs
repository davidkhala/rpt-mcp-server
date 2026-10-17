// Smoke test: drives the built server over stdio with raw JSON-RPC.
import { spawn } from "node:child_process";
import readline from "node:readline";

const child = spawn("node", ["src/index.js"], {
  env: { ...process.env, RPT_ROOT: "C:\\Users\\david\\Documents\\GitHub.ibm\\avls_crystal_report" },
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

await show("list_reports", "list_reports", { pattern: "avl" }, 500);
await show("summary", "get_report_summary", { path: "avl_print.rpt" }, 900);
await show("structure", "get_report_structure", { path: "avl_print.rpt" }, 500);
await show("data_sources", "get_data_sources", { path: "avl_print.rpt" }, 500);
await show("sql", "get_command_sql", { path: "avl_print.rpt" }, 300);
await show("params", "list_parameters", { path: "avl_print.rpt" }, 300);
await show("formulas", "list_formulas", { path: "avl_print.rpt" }, 500);
await show("selection", "get_selection_formulas", { path: "avl_print.rpt" }, 300);
await show("grouping", "get_grouping_and_sorting", { path: "avl_print.rpt" }, 400);
await show("subreports", "get_subreports", { path: "application_avl.rpt" }, 600);
await show("fields", "get_database_fields", { path: "avl_print.rpt", table: "VEH_MAKE_CODE" }, 400);
await show("objects", "list_report_objects", { path: "avl_print.rpt", kind: "TextObject" }, 400);
await show("search", "search_reports", { query: "APPLN_REF_NO", scope: "sql", maxResults: 5 }, 900);
await show("export", "export_report_json", { path: "avl_print.rpt" }, 100);

console.log("\n===== sandbox =====");
await show("traversal", "get_report_summary", { path: "..\\..\\..\\.bob\\settings\\mcp.json" });
await show("absolute", "get_report_summary", { path: "C:\\Windows\\win.ini" });
await show("not rpt", "get_report_summary", { path: "avl_print.rpt\\..\\..\\x.txt" });
await show("missing", "get_report_summary", { path: "nope.rpt" });
await show("dir escape", "list_reports", { subdir: ".." });

child.kill();
process.exit(0);
