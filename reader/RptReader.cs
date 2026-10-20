// RptReader.exe – read/write bridge between Crystal Reports .rpt files and JSON.
//
// Read  mode (default):
//   RptReader.exe <file.rpt>
//   Loads the report with the Crystal Reports .NET SDK, dumps metadata as JSON
//   (UTF-8) to stdout.  Never connects to a database or refreshes data.
//   The JSON includes a top-level "sourcePath" key with the absolute path of
//   the input file so that the write mode knows which template to copy.
//
// Write mode:
//   RptReader.exe --write <input.json> <output.rpt>
//   Copies the original .rpt (recorded in "sourcePath" inside the JSON) to
//   <output.rpt>, then applies every field that the SDK exposes for writing:
//     - SummaryInfo (title, author, subject, comments, keywords)
//     - RecordSelectionFormula, GroupSelectionFormula
//     - FormulaFields text
//     - SQLExpressionFields text
//     - Table location (server + database via SetLogOnInfo)
//     - Command table SQL text (via RAS DatabaseController)
//     - ParameterField default values (discrete only; range values cleared)
//     - Group sort order (SortDirection on SortFields)
//   Fields the SDK does not allow writing (section layout, running totals,
//   summary fields, subreport link topology, paper/margin options) are left
//   as-is in the copied template – they will still match the original because
//   the template IS the original.
//
// Written in C# 5 so it can be built with the in-box .NET Framework csc.exe.
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;
using CrystalDecisions.CrystalReports.Engine;
using CrystalDecisions.Shared;
using RAS = CrystalDecisions.ReportAppServer.DataDefModel;
using RDM = CrystalDecisions.ReportAppServer.ReportDefModel;

namespace RptReader
{
    static class Program
    {
        static int Main(string[] args)
        {
            if (args.Length == 3 && args[0] == "--write")
                return RunWrite(args[1], args[2]);

            if (args.Length == 1 && args[0] != "--write")
                return RunRead(args[0]);

            Console.Error.WriteLine("usage:");
            Console.Error.WriteLine("  RptReader.exe <file.rpt>                       (read)");
            Console.Error.WriteLine("  RptReader.exe --write <input.json> <output.rpt> (write)");
            return 2;
        }

        // ------------------------------------------------------------------ read
        static int RunRead(string rptPath)
        {
            ReportDocument rd = new ReportDocument();
            try
            {
                rd.Load(rptPath);
                Dictionary<string, object> dump = Dump(rd, rd, true);
                FileInfo fi = new FileInfo(rptPath);
                dump["file"] = fi.Name;
                dump["name"] = fi.Name;
                dump["sizeBytes"] = fi.Length;
                dump["sourcePath"] = fi.FullName;   // needed by write mode

                JavaScriptSerializer js = new JavaScriptSerializer();
                js.MaxJsonLength = int.MaxValue;
                js.RecursionLimit = 200;
                byte[] bytes = new UTF8Encoding(false).GetBytes(js.Serialize(dump));
                using (Stream stdout = Console.OpenStandardOutput())
                    stdout.Write(bytes, 0, bytes.Length);
                return 0;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine(ex.ToString());
                return 1;
            }
            finally
            {
                try { rd.Close(); } catch { }
                rd.Dispose();
            }
        }

        // ------------------------------------------------------------------ write
        static int RunWrite(string jsonPath, string outRptPath)
        {
            // 1. Parse the JSON manifest.
            string jsonText;
            try { jsonText = File.ReadAllText(jsonPath, Encoding.UTF8); }
            catch (Exception ex) { Console.Error.WriteLine("Cannot read JSON: " + ex.Message); return 1; }

            JavaScriptSerializer js = new JavaScriptSerializer();
            js.MaxJsonLength = int.MaxValue;
            js.RecursionLimit = 200;
            Dictionary<string, object> data;
            try { data = js.Deserialize<Dictionary<string, object>>(jsonText); }
            catch (Exception ex) { Console.Error.WriteLine("Cannot parse JSON: " + ex.Message); return 1; }

            // 2. Find and copy the template .rpt.
            string sourcePath = data.ContainsKey("sourcePath") ? data["sourcePath"] as string : null;
            if (string.IsNullOrEmpty(sourcePath))
            {
                Console.Error.WriteLine("JSON must contain a \"sourcePath\" key with the original .rpt path.");
                return 1;
            }
            if (!File.Exists(sourcePath))
            {
                Console.Error.WriteLine("sourcePath not found: " + sourcePath);
                return 1;
            }

            string outDir = Path.GetDirectoryName(Path.GetFullPath(outRptPath));
            if (!string.IsNullOrEmpty(outDir) && !Directory.Exists(outDir))
                Directory.CreateDirectory(outDir);

            File.Copy(sourcePath, outRptPath, overwrite: true);

            // 3. Open the copy and apply every writable field.
            ReportDocument rd = new ReportDocument();
            try
            {
                rd.Load(outRptPath);
                ApplyData(rd, data);
                rd.SaveAs(outRptPath);
                return 0;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine(ex.ToString());
                return 1;
            }
            finally
            {
                try { rd.Close(); } catch { }
                rd.Dispose();
            }
        }

        // Apply every field from the JSON dump back onto an open ReportDocument.
        static void ApplyData(ReportDocument rd, Dictionary<string, object> data)
        {
            // --- summary info ---
            Dictionary<string, object> summary = GetDict(data, "summary");
            if (summary != null)
            {
                string v;
                if (TryStr(summary, "title",    out v)) rd.SummaryInfo.ReportTitle    = v ?? "";
                if (TryStr(summary, "author",   out v)) rd.SummaryInfo.ReportAuthor   = v ?? "";
                if (TryStr(summary, "subject",  out v)) rd.SummaryInfo.ReportSubject  = v ?? "";
                if (TryStr(summary, "comments", out v)) rd.SummaryInfo.ReportComments = v ?? "";
                if (TryStr(summary, "keywords", out v)) rd.SummaryInfo.KeywordsInReport = v ?? "";
            }

            // --- selection formulas ---
            string sel;
            if (TryStr(data, "recordSelection", out sel) && sel != null)
                try { rd.RecordSelectionFormula = sel; } catch { }
            string grpSel;
            if (TryStr(data, "groupSelection", out grpSel) && grpSel != null)
                try { rd.DataDefinition.GroupSelectionFormula = grpSel; } catch { }

            // --- formula fields ---
            IList formulas = GetList(data, "formulas");
            if (formulas != null)
            {
                foreach (object item in formulas)
                {
                    Dictionary<string, object> fd = item as Dictionary<string, object>;
                    if (fd == null) continue;
                    string name, text;
                    if (!TryStr(fd, "name", out name) || !TryStr(fd, "text", out text)) continue;
                    if (name == null || text == null) continue;
                    try
                    {
                        FormulaFieldDefinition ff = rd.DataDefinition.FormulaFields["{@" + name + "}"];
                        if (ff == null) ff = rd.DataDefinition.FormulaFields[name];
                        if (ff != null) ff.Text = text;
                    }
                    catch { }
                }
            }

            // --- SQL expression fields ---
            IList sqlExprs = GetList(data, "sqlExpressions");
            if (sqlExprs != null)
            {
                foreach (object item in sqlExprs)
                {
                    Dictionary<string, object> fd = item as Dictionary<string, object>;
                    if (fd == null) continue;
                    string name, text;
                    if (!TryStr(fd, "name", out name) || !TryStr(fd, "text", out text)) continue;
                    if (name == null || text == null) continue;
                    try
                    {
                        SQLExpressionFieldDefinition sf = rd.DataDefinition.SQLExpressionFields["%(" + name + ")"];
                        if (sf == null) sf = rd.DataDefinition.SQLExpressionFields[name];
                        if (sf != null) sf.Text = text;
                    }
                    catch { }
                }
            }

            // --- table connection (server / database only, no credentials) ---
            IList tables = GetList(data, "tables");
            if (tables != null)
            {
                foreach (object item in tables)
                {
                    Dictionary<string, object> td = item as Dictionary<string, object>;
                    if (td == null) continue;
                    string tableName;
                    if (!TryStr(td, "name", out tableName) || tableName == null) continue;
                    Dictionary<string, object> conn = GetDict(td, "connection");
                    if (conn == null) continue;
                    string server, database;
                    TryStr(conn, "server",   out server);
                    TryStr(conn, "database", out database);
                    try
                    {
                        Table t = rd.Database.Tables[tableName];
                        if (t == null) continue;
                        TableLogOnInfo info = t.LogOnInfo;
                        if (server   != null) info.ConnectionInfo.ServerName   = server;
                        if (database != null) info.ConnectionInfo.DatabaseName = database;
                        t.ApplyLogOnInfo(info);
                    }
                    catch { }
                }
            }

            // --- command table SQL (via RAS) ---
            IList commands = GetList(data, "commands");
            if (commands != null)
            {
                try
                {
                    IEnumerable rasTables = rd.ReportClientDocument.DatabaseController.Database.Tables;
                    foreach (object item in commands)
                    {
                        Dictionary<string, object> cd = item as Dictionary<string, object>;
                        if (cd == null) continue;
                        string cmdName, sql;
                        if (!TryStr(cd, "name", out cmdName) || !TryStr(cd, "sql", out sql)) continue;
                        if (cmdName == null || sql == null) continue;
                        foreach (object o in rasTables)
                        {
                            RAS.CommandTable ct = o as RAS.CommandTable;
                            if (ct != null && ct.Name == cmdName)
                            {
                                ct.CommandText = sql;
                                break;
                            }
                        }
                    }
                }
                catch { }
            }

            // --- parameter default values (discrete only) ---
            IList parameters = GetList(data, "parameters");
            if (parameters != null)
            {
                foreach (object item in parameters)
                {
                    Dictionary<string, object> pd = item as Dictionary<string, object>;
                    if (pd == null) continue;
                    string pname;
                    if (!TryStr(pd, "name", out pname) || pname == null) continue;
                    IList defaults = GetList(pd, "defaultValues");
                    if (defaults == null) continue;
                    try
                    {
                        ParameterFieldDefinition pf = rd.DataDefinition.ParameterFields[pname];
                        if (pf == null) continue;
                        ParameterValues newDefaults = new ParameterValues();
                        foreach (object dv in defaults)
                        {
                            Dictionary<string, object> dvd = dv as Dictionary<string, object>;
                            if (dvd == null) continue;
                            string val;
                            if (TryStr(dvd, "value", out val) && val != null)
                            {
                                ParameterDiscreteValue pdv = new ParameterDiscreteValue();
                                pdv.Value = val;
                                string desc;
                                if (TryStr(dvd, "description", out desc) && desc != null)
                                    pdv.Description = desc;
                                newDefaults.Add(pdv);
                            }
                        }
                        if (newDefaults.Count > 0)
                            pf.DefaultValues = newDefaults;
                    }
                    catch { }
                }
            }

            // --- sort field directions ---
            IList sortFields = GetList(data, "sortFields");
            if (sortFields != null)
            {
                int idx = 0;
                foreach (object item in sortFields)
                {
                    Dictionary<string, object> sfd = item as Dictionary<string, object>;
                    if (sfd == null) { idx++; continue; }
                    string dir;
                    if (!TryStr(sfd, "direction", out dir) || dir == null) { idx++; continue; }
                    try
                    {
                        if (idx < rd.DataDefinition.SortFields.Count)
                        {
                            SortField sf = rd.DataDefinition.SortFields[idx];
                            if (dir == "AscendingOrder")
                                sf.SortDirection = SortDirection.AscendingOrder;
                            else if (dir == "DescendingOrder")
                                sf.SortDirection = SortDirection.DescendingOrder;
                        }
                    }
                    catch { }
                    idx++;
                }
            }
        }

        // ------------------------------------------------------------------ helpers
        static Dictionary<string, object> GetDict(Dictionary<string, object> d, string key)
        {
            object v;
            if (!d.TryGetValue(key, out v)) return null;
            return v as Dictionary<string, object>;
        }

        static IList GetList(Dictionary<string, object> d, string key)
        {
            object v;
            if (!d.TryGetValue(key, out v)) return null;
            return v as IList;
        }

        static bool TryStr(Dictionary<string, object> d, string key, out string result)
        {
            object v;
            if (!d.TryGetValue(key, out v)) { result = null; return false; }
            result = v == null ? null : v.ToString();
            return true;
        }

        // ------------------------------------------------------------------ read helpers (unchanged)
        static string S(object o) { return o == null ? null : o.ToString(); }

        static Dictionary<string, object> D(params object[] kv)
        {
            Dictionary<string, object> d = new Dictionary<string, object>();
            for (int i = 0; i + 1 < kv.Length; i += 2) d[(string)kv[i]] = kv[i + 1];
            return d;
        }

        static Dictionary<string, object> Dump(ReportDocument rd, ReportDocument root, bool isRoot)
        {
            Dictionary<string, object> r = new Dictionary<string, object>();
            r["name"] = rd.Name;
            if (isRoot) r["summary"] = Summary(rd);
            r["sections"] = Safe(delegate { return Sections(rd); });
            r["tables"] = Safe(delegate { return Tables(rd); });
            r["links"] = Safe(delegate { return Links(rd); });
            r["commands"] = Commands(rd, root, isRoot);
            r["parameters"] = Safe(delegate { return Parameters(rd); });
            r["formulas"] = Safe(delegate { return Formulas(rd); });
            r["sqlExpressions"] = Safe(delegate { return SqlExpressions(rd); });
            r["runningTotals"] = Safe(delegate { return RunningTotals(rd); });
            r["summaryFields"] = Safe(delegate { return SummaryFields(rd); });
            r["groups"] = Safe(delegate { return Groups(rd); });
            r["sortFields"] = Safe(delegate { return SortFields(rd); });
            r["recordSelection"] = Safe(delegate { return rd.RecordSelectionFormula; });
            r["groupSelection"] = Safe(delegate { return rd.DataDefinition.GroupSelectionFormula; });

            // ReportDocument.Subreports throws NotSupportedException when called on a subreport.
            List<object> subs = new List<object>();
            if (isRoot)
            {
                foreach (ReportDocument sub in rd.Subreports)
                {
                    Dictionary<string, object> s = Dump(sub, root, false);
                    s["links"] = SubreportLinks(root, sub.Name);
                    subs.Add(s);
                }
            }
            r["subreports"] = subs;
            return r;
        }

        static object Safe(Func<object> f)
        {
            try { return f(); }
            catch (Exception ex) { return D("error", ex.Message); }
        }

        static object Summary(ReportDocument rd)
        {
            Dictionary<string, object> d = D(
                "title", rd.SummaryInfo.ReportTitle,
                "author", rd.SummaryInfo.ReportAuthor,
                "subject", rd.SummaryInfo.ReportSubject,
                "comments", rd.SummaryInfo.ReportComments,
                "keywords", rd.SummaryInfo.KeywordsInReport);
            try
            {
                d["paperSize"] = S(rd.PrintOptions.PaperSize);
                d["paperOrientation"] = S(rd.PrintOptions.PaperOrientation);
                d["printerName"] = rd.PrintOptions.PrinterName;
                PageMargins m = rd.PrintOptions.PageMargins;
                d["margins"] = D("left", m.leftMargin, "right", m.rightMargin, "top", m.topMargin, "bottom", m.bottomMargin);
            }
            catch (Exception ex) { d["printOptionsError"] = ex.Message; }
            return d;
        }

        static object Sections(ReportDocument rd)
        {
            List<object> list = new List<object>();
            foreach (Section s in rd.ReportDefinition.Sections)
            {
                List<object> objs = new List<object>();
                foreach (ReportObject o in s.ReportObjects)
                {
                    Dictionary<string, object> od = D(
                        "name", o.Name,
                        "kind", S(o.Kind),
                        "left", o.Left, "top", o.Top, "width", o.Width, "height", o.Height);
                    TextObject t = o as TextObject;
                    if (t != null) od["text"] = t.Text;
                    FieldObject f = o as FieldObject;
                    if (f != null && f.DataSource != null) od["field"] = f.DataSource.FormulaName;
                    SubreportObject so = o as SubreportObject;
                    if (so != null) od["subreportName"] = so.SubreportName;
                    objs.Add(od);
                }
                list.Add(D("name", s.Name, "kind", S(s.Kind), "height", s.Height, "objects", objs));
            }
            return list;
        }

        static object Tables(ReportDocument rd)
        {
            List<object> list = new List<object>();
            foreach (Table t in rd.Database.Tables)
            {
                List<object> fields = new List<object>();
                foreach (DatabaseFieldDefinition f in t.Fields)
                    fields.Add(D("name", f.Name, "formulaName", f.FormulaName, "type", S(f.ValueType), "length", f.NumberOfBytes));
                ConnectionInfo ci = t.LogOnInfo.ConnectionInfo;
                list.Add(D(
                    "name", t.Name,
                    "location", t.Location,
                    "connection", D("server", ci.ServerName, "database", ci.DatabaseName),
                    "fields", fields));
            }
            return list;
        }

        static object Links(ReportDocument rd)
        {
            List<object> list = new List<object>();
            foreach (TableLink l in rd.Database.Links)
            {
                list.Add(D(
                    "sourceTable", l.SourceTable.Name,
                    "destinationTable", l.DestinationTable.Name,
                    "joinType", S(l.JoinType),
                    "sourceFields", FieldNames(l.SourceFields),
                    "destinationFields", FieldNames(l.DestinationFields)));
            }
            return list;
        }

        static List<object> FieldNames(DatabaseFieldDefinitions fields)
        {
            List<object> l = new List<object>();
            foreach (DatabaseFieldDefinition f in fields) l.Add(f.FormulaName);
            return l;
        }

        static object Commands(ReportDocument rd, ReportDocument root, bool isRoot)
        {
            List<object> list = new List<object>();
            try
            {
                IEnumerable tables;
                if (isRoot) tables = root.ReportClientDocument.DatabaseController.Database.Tables;
                else tables = root.ReportClientDocument.SubreportController.GetSubreportDatabase(rd.Name).Tables;
                foreach (object o in tables)
                {
                    RAS.CommandTable ct = o as RAS.CommandTable;
                    if (ct != null) list.Add(D("name", ct.Name, "alias", ct.Alias, "sql", ct.CommandText));
                }
            }
            catch (Exception ex) { list.Add(D("error", ex.Message)); }
            return list;
        }

        static object SubreportLinks(ReportDocument root, string subName)
        {
            List<object> list = new List<object>();
            try
            {
                RDM.SubreportLinks links = root.ReportClientDocument.SubreportController.GetSubreportLinks(subName);
                for (int i = 0; i < links.Count; i++)
                {
                    RDM.SubreportLink l = links[i];
                    list.Add(D("mainReportField", l.MainReportFieldName, "subreportField", l.SubreportFieldName, "linkedParameter", l.LinkedParameterName));
                }
            }
            catch (Exception ex) { list.Add(D("error", ex.Message)); }
            return list;
        }

        static object Parameters(ReportDocument rd)
        {
            List<object> list = new List<object>();
            foreach (ParameterFieldDefinition p in rd.DataDefinition.ParameterFields)
            {
                List<object> defaults = new List<object>();
                foreach (ParameterValue v in p.DefaultValues)
                {
                    ParameterDiscreteValue dv = v as ParameterDiscreteValue;
                    ParameterRangeValue rv = v as ParameterRangeValue;
                    if (dv != null) defaults.Add(D("value", S(dv.Value), "description", dv.Description));
                    else if (rv != null) defaults.Add(D("start", S(rv.StartValue), "end", S(rv.EndValue)));
                }
                list.Add(D(
                    "name", p.ParameterFieldName,
                    "valueType", S(p.ValueType),
                    "promptText", p.PromptText,
                    "multiValue", p.EnableAllowMultipleValue,
                    "allowNull", p.EnableNullValue,
                    "optional", p.IsOptionalPrompt,
                    "kind", S(p.DiscreteOrRangeKind),
                    "usage", S(p.ParameterFieldUsage2),
                    "reportName", p.ReportName,
                    "defaultValues", defaults));
            }
            return list;
        }

        static object Formulas(ReportDocument rd)
        {
            List<object> list = new List<object>();
            foreach (FormulaFieldDefinition f in rd.DataDefinition.FormulaFields)
                list.Add(D("name", f.Name, "text", f.Text));
            return list;
        }

        static object SqlExpressions(ReportDocument rd)
        {
            List<object> list = new List<object>();
            foreach (SQLExpressionFieldDefinition f in rd.DataDefinition.SQLExpressionFields)
                list.Add(D("name", f.Name, "text", f.Text));
            return list;
        }

        static object RunningTotals(ReportDocument rd)
        {
            List<object> list = new List<object>();
            foreach (RunningTotalFieldDefinition f in rd.DataDefinition.RunningTotalFields)
            {
                list.Add(D(
                    "name", f.Name,
                    "operation", S(f.Operation),
                    "summarizedField", f.SummarizedField == null ? null : f.SummarizedField.FormulaName,
                    "evaluate", S(f.EvaluationConditionType),
                    "reset", S(f.ResetConditionType)));
            }
            return list;
        }

        static object SummaryFields(ReportDocument rd)
        {
            List<object> list = new List<object>();
            foreach (SummaryFieldDefinition f in rd.DataDefinition.SummaryFields)
            {
                list.Add(D(
                    "name", f.Name,
                    "operation", S(f.Operation),
                    "summarizedField", f.SummarizedField == null ? null : f.SummarizedField.FormulaName,
                    "group", f.Group == null || f.Group.ConditionField == null ? null : f.Group.ConditionField.FormulaName));
            }
            return list;
        }

        static object Groups(ReportDocument rd)
        {
            List<object> list = new List<object>();
            foreach (Group g in rd.DataDefinition.Groups)
            {
                list.Add(D(
                    "field", g.ConditionField == null ? null : g.ConditionField.FormulaName,
                    "condition", g.GroupOptions.Condition));
            }
            return list;
        }

        static object SortFields(ReportDocument rd)
        {
            List<object> list = new List<object>();
            foreach (SortField sf in rd.DataDefinition.SortFields)
                list.Add(D("field", sf.Field == null ? null : sf.Field.FormulaName, "direction", S(sf.SortDirection)));
            return list;
        }
    }
}
