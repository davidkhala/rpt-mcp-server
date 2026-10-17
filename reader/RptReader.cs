// Read-only dumper: loads one .rpt with the Crystal Reports .NET SDK and prints its
// metadata as JSON (UTF-8, stdout). It never connects to a database or refreshes data.
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
            if (args.Length != 1)
            {
                Console.Error.WriteLine("usage: RptReader.exe <file.rpt>");
                return 2;
            }

            ReportDocument rd = new ReportDocument();
            try
            {
                rd.Load(args[0]);
                Dictionary<string, object> dump = Dump(rd, rd, true);
                FileInfo fi = new FileInfo(args[0]);
                dump["file"] = fi.Name;
                dump["name"] = fi.Name;
                dump["sizeBytes"] = fi.Length;

                JavaScriptSerializer js = new JavaScriptSerializer();
                js.MaxJsonLength = int.MaxValue;
                js.RecursionLimit = 200;
                byte[] bytes = new UTF8Encoding(false).GetBytes(js.Serialize(dump));
                using (Stream stdout = Console.OpenStandardOutput())
                {
                    stdout.Write(bytes, 0, bytes.Length);
                }
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

            // ReportDocument.Subreports throws NotSupportedException when called on a subreport, so only the root enumerates them.
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

        // A failure while reading one facet must not hide the others.
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
                {
                    fields.Add(D("name", f.Name, "formulaName", f.FormulaName, "type", S(f.ValueType), "length", f.NumberOfBytes));
                }
                // Credentials are deliberately not exported.
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

        // SQL of "Add Command" tables is only reachable through the RAS client document.
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
