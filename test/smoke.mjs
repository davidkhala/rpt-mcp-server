/**
 * Integration smoke-test for rpt-mcp-server.
 *
 * Starts the MCP server as a child process, communicates over stdio via
 * raw JSON-RPC 2.0, then kills it when the suite finishes.
 *
 * Prerequisites:
 *   - reader/RptReader.exe must be compiled (npm run build)
 *   - RPT_DIR env-var must point to a directory containing:
 *       avl_print.rpt
 *       application_avl.rpt
 *
 * Run:
 *   RPT_DIR=C:\reports npm test
 *   # or on PowerShell:
 *   $env:RPT_DIR="C:\reports"; npm test
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

// ---------------------------------------------------------------------------
// Resolve report directory  (set RPT_DIR env-var before running)
// ---------------------------------------------------------------------------
const RPT_DIR = process.env.RPT_DIR;
const root = RPT_DIR ? path.resolve(RPT_DIR) : null;
const rpt = (name) => path.join(root, name);

// ---------------------------------------------------------------------------
// MCP client helpers (shared across all tests via module-level state)
// ---------------------------------------------------------------------------
let child;
let nextId = 1;
const pending = new Map();

function startServer() {
  child = spawn("node", ["src/index.js"], { stdio: ["pipe", "pipe", "inherit"] });
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) pending.get(msg.id)(msg);
    } catch { /* ignore malformed lines */ }
  });
}

function rpc(method, params) {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

async function call(name, args) {
  const r = await rpc("tools/call", { name, arguments: args });
  const res = r.result ?? { isError: true, content: [{ text: JSON.stringify(r.error) }] };
  return { isError: !!res.isError, text: res.content[0].text };
}

/** Assert the tool call succeeded and return parsed JSON from the text. */
async function callOk(name, args) {
  const r = await call(name, args);
  assert.equal(r.isError, false, `${name} returned isError=true: ${r.text.slice(0, 300)}`);
  return r;
}

/** Assert the tool call returned an error. */
async function callErr(name, args) {
  const r = await call(name, args);
  assert.equal(r.isError, true, `${name} expected isError=true but got success`);
  return r;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
describe("rpt-mcp-server", function () {
  // Each Crystal Reports load can take several seconds; give each test generous time.
  this.timeout(60_000);

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  before(async function () {
    if (!root) this.skip();
    startServer();
    const init = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "mocha-smoke", version: "0" },
    });
    assert.ok(init.result?.serverInfo, "initialize must return serverInfo");
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
    );
  });

  after(function () {
    child.kill();
  });

  // ── Tool list ──────────────────────────────────────────────────────────────
  describe("tools/list", function () {
    it("advertises all expected tools", async function () {
      const r = await rpc("tools/list", {});
      const names = r.result.tools.map((t) => t.name);
      const expected = [
        "get_report_summary", "get_report_structure", "list_report_objects",
        "get_data_sources", "get_database_fields", "get_command_sql",
        "list_parameters", "list_formulas", "get_selection_formulas",
        "get_grouping_and_sorting", "get_subreports", "search_reports",
        "export_report_json", "save_report_json", "build_report_from_json",
      ];
      for (const name of expected) {
        assert.ok(names.includes(name), `missing tool: ${name}`);
      }
    });
  });

  // ── Read tools ─────────────────────────────────────────────────────────────
  describe("read tools (avl_print.rpt)", function () {
    it("get_report_summary returns non-empty text", async function () {
      const r = await callOk("get_report_summary", { path: rpt("avl_print.rpt") });
      assert.ok(r.text.length > 0);
    });

    it("get_report_structure returns sections array", async function () {
      const r = await callOk("get_report_structure", { path: rpt("avl_print.rpt") });
      assert.ok(r.text.includes("section") || r.text.includes("Section"), "expected section info");
    });

    it("get_data_sources returns table info", async function () {
      const r = await callOk("get_data_sources", { path: rpt("avl_print.rpt") });
      assert.ok(r.text.length > 10);
    });

    it("get_command_sql succeeds", async function () {
      await callOk("get_command_sql", { path: rpt("avl_print.rpt") });
    });

    it("list_parameters succeeds", async function () {
      await callOk("list_parameters", { path: rpt("avl_print.rpt") });
    });

    it("list_formulas succeeds", async function () {
      await callOk("list_formulas", { path: rpt("avl_print.rpt") });
    });

    it("get_selection_formulas succeeds", async function () {
      await callOk("get_selection_formulas", { path: rpt("avl_print.rpt") });
    });

    it("get_grouping_and_sorting succeeds", async function () {
      await callOk("get_grouping_and_sorting", { path: rpt("avl_print.rpt") });
    });

    it("get_database_fields filters by table name", async function () {
      const r = await callOk("get_database_fields", { path: rpt("avl_print.rpt"), table: "VEH_MAKE_CODE" });
      assert.ok(r.text.includes("VEH_MAKE_CODE"), "response should mention table name");
    });

    it("list_report_objects filters by kind", async function () {
      const r = await callOk("list_report_objects", { path: rpt("avl_print.rpt"), kind: "TextObject" });
      assert.ok(r.text.length > 0);
    });

    it("export_report_json returns JSON with a name field", async function () {
      const r = await callOk("export_report_json", { path: rpt("avl_print.rpt") });
      const obj = JSON.parse(r.text);
      assert.ok(obj.name, "dump must have a name field");
    });
  });

  describe("get_subreports (application_avl.rpt)", function () {
    it("returns subreport info", async function () {
      await callOk("get_subreports", { path: rpt("application_avl.rpt") });
    });
  });

  describe("search_reports", function () {
    it("finds SQL matches in the directory", async function () {
      const r = await callOk("search_reports", { dir: root, query: "APPLN_REF_NO", scope: "sql", maxResults: 5 });
      assert.ok(r.text.length > 0);
    });
  });

  // ── Input validation ───────────────────────────────────────────────────────
  describe("input validation", function () {
    it("rejects a relative .rpt path", async function () {
      await callErr("get_report_summary", { path: "avl_print.rpt" });
    });

    it("rejects a non-.rpt file", async function () {
      await callErr("get_report_summary", { path: "C:\\Windows\\win.ini" });
    });

    it("rejects a missing .rpt file", async function () {
      await callErr("get_report_summary", { path: rpt("nope.rpt") });
    });

    it("rejects a relative directory for search_reports", async function () {
      await callErr("search_reports", { dir: "..", query: "xx" });
    });

    it("rejects a missing directory for search_reports", async function () {
      await callErr("search_reports", { dir: rpt("no-such-dir"), query: "xx" });
    });
  });

  // ── Roundtrip ──────────────────────────────────────────────────────────────
  describe("roundtrip (save_report_json → build_report_from_json)", function () {
    this.timeout(120_000);

    let tmpDir;
    let jsonOut;
    let rptOut;
    let originalData;

    before(async function () {
      tmpDir  = path.join(os.tmpdir(), `rpt-roundtrip-${Date.now()}`);
      jsonOut = path.join(tmpDir, "avl_print.json");
      rptOut  = path.join(tmpDir, "avl_print_rebuilt.rpt");
    });

    after(async function () {
      if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    });

    it("save_report_json writes the JSON file", async function () {
      const r = await callOk("save_report_json", { path: rpt("avl_print.rpt"), out: jsonOut });
      assert.ok(r.text.includes(jsonOut) || r.text.includes("Saved"), `unexpected response: ${r.text}`);
      const stat = await fs.stat(jsonOut);
      assert.ok(stat.size > 0, "JSON file must be non-empty");
      originalData = JSON.parse(await fs.readFile(jsonOut, "utf8"));
    });

    it("build_report_from_json produces a .rpt file", async function () {
      const r = await callOk("build_report_from_json", { json: jsonOut, out: rptOut });
      const rebuilt = JSON.parse(r.text);
      assert.ok(rebuilt.name, "rebuilt dump must have a name field");
      const stat = await fs.stat(rptOut);
      assert.ok(stat.size > 0, "rebuilt .rpt must be non-empty");
    });

    // One it() per compared key — easy to see which field fails.
    for (const key of ["formulas", "sqlExpressions", "recordSelection", "groupSelection", "sortFields", "groups"]) {
      it(`roundtrip preserves ${key}`, async function () {
        if (!originalData) this.skip();
        const rebuildResult = await call("build_report_from_json", { json: jsonOut, out: rptOut });
        if (rebuildResult.isError) this.skip();
        const rebuiltData = JSON.parse(rebuildResult.text);
        assert.deepEqual(rebuiltData[key] ?? null, originalData[key] ?? null);
      });
    }

    for (const k of ["title", "author", "subject", "comments", "keywords"]) {
      it(`roundtrip preserves summary.${k}`, async function () {
        if (!originalData?.summary) this.skip();
        const rebuildResult = await call("build_report_from_json", { json: jsonOut, out: rptOut });
        if (rebuildResult.isError) this.skip();
        const rebuiltData = JSON.parse(rebuildResult.text);
        assert.equal(rebuiltData.summary?.[k] ?? "", originalData.summary[k] ?? "");
      });
    }
  });
});
