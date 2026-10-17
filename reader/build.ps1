$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$g = "C:\Windows\Microsoft.NET\assembly"
$v = "v4.0_13.0.4000.0__692fbea5521e1304"
$refs = @(
    "$g\GAC_MSIL\CrystalDecisions.CrystalReports.Engine\$v\CrystalDecisions.CrystalReports.Engine.dll",
    "$g\GAC_MSIL\CrystalDecisions.Shared\$v\CrystalDecisions.Shared.dll",
    "$g\GAC_64\CrystalDecisions.ReportAppServer.DataDefModel\$v\CrystalDecisions.ReportAppServer.DataDefModel.dll",
    "$g\GAC_64\CrystalDecisions.ReportAppServer.ReportDefModel\$v\CrystalDecisions.ReportAppServer.ReportDefModel.dll",
    "$g\GAC_64\CrystalDecisions.ReportAppServer.ClientDoc\$v\CrystalDecisions.ReportAppServer.ClientDoc.dll",
    "$g\GAC_64\CrystalDecisions.ReportAppServer.Controllers\$v\CrystalDecisions.ReportAppServer.Controllers.dll",
    "System.Web.Extensions.dll",
    "System.Core.dll"
) | ForEach-Object { "/r:$_" }

& C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /platform:x64 /target:exe `
    "/out:$here\RptReader.exe" @refs "$here\RptReader.cs"
if ($LASTEXITCODE -ne 0) { throw "csc failed with exit code $LASTEXITCODE" }
