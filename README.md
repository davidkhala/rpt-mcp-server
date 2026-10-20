# rpt-mcp-server

MCP server，让 Bob 可以读取、导出、重建本机上的 Crystal Reports `.rpt` 文件。

## 工作方式

`.rpt` 是二进制格式，只有 Crystal 自带的 .NET SDK 能可靠解析，因此分两层：

- `reader/RptReader.exe`：C# 小程序（.NET Framework 4.x，x64），调用本机已安装的 Crystal Reports SDK。
  - **读取模式**：`RptReader.exe <file.rpt>` — 将报表元数据序列化为 JSON 输出到 stdout。
  - **写入模式**：`RptReader.exe --write <input.json> <output.rpt>` — 以原文件为模板，将 JSON 中的可写字段重新写入 `.rpt`。
- `src/index.js`：Node MCP server（纯 JavaScript，无需编译），负责路径校验、调度读取器、按文件修改时间缓存结果、提供工具。

不连接数据库，不刷新数据，不导出密码（连接信息只含 server 和 database 名称）。

## 前置条件

- Windows，Node.js 20 及以上
- 已安装 Crystal Reports for Visual Studio，即 GAC 中存在 `CrystalDecisions.*` 13.0.4000.0 程序集及 x64 运行时
- .NET Framework 自带的 `csc.exe`（`C:\Windows\Microsoft.NET\Framework64\v4.0.30319\`）

## 使用（npx）

npm 包已包含预编译的 `RptReader.exe`，无需自行构建。在 MCP client 中注册：

```json
{
  "mcpServers": {
    "crystal-reports": {
      "command": "npx",
      "args": ["-y", "@davidkhala/rpt-mcp-server"]
    }
  }
}
```

Bob 的配置文件是 `~/.bob/settings/mcp.json`。

server 不需要指定报表目录。调用工具时直接传 `.rpt` 的**绝对路径**（`search_reports` 传目录的绝对路径）即可。只会打开扩展名为 `.rpt` 的文件。

## 从源码构建

```powershell
git clone https://github.com/davidkhala/rpt-mcp-server.git
cd rpt-mcp-server
npm install
npm run build   # 编译 reader/RptReader.exe
```

然后把 MCP client 配置里的 `command` 改为 `node`，`args` 改为 `["<path-to>/rpt-mcp-server/src/index.js"]`。

## 工具

除 `search_reports` 接收目录绝对路径 `dir` 外，其余工具都接收 `.rpt` 的绝对路径 `path`。列目录这类文件系统操作不在本 server 范围内，请用 client 自带的文件工具。

### 只读工具

| 工具 | 用途 |
|---|---|
| `get_report_summary` | 纸张、边距，以及各类对象的数量 |
| `get_report_structure` | 各 section 及其对象类型统计 |
| `list_report_objects` | 对象的位置、文本、绑定字段 |
| `get_data_sources` | 表、连接（server/database）、表链接 |
| `get_database_fields` | 表的字段名和类型 |
| `get_command_sql` | "Add Command" 里的 SQL |
| `list_parameters` | 参数及默认值 |
| `list_formulas` | 公式、SQL 表达式、累计字段、汇总字段 |
| `get_selection_formulas` | 记录和分组选择公式 |
| `get_grouping_and_sorting` | 分组和排序 |
| `get_subreports` | 子报表及其链接字段 |
| `search_reports` | 在目录下所有报表里搜 SQL、公式、字段、文本、参数、表 |
| `export_report_json` | 单个报表的完整 JSON（返回给 LLM，不写文件） |

### 导出 / 重建工具（Roundtrip）

| 工具 | 参数 | 用途 |
|---|---|---|
| `save_report_json` | `path`（源 `.rpt`），`out`（目标 `.json` 绝对路径） | 将完整 JSON dump 保存到磁盘文件；JSON 中含 `sourcePath` 字段，供重建时使用 |
| `build_report_from_json` | `json`（JSON 文件绝对路径），`out`（目标 `.rpt` 绝对路径） | 以 `sourcePath` 指向的原文件为模板，将 JSON 中所有可写字段写回，保存为新 `.rpt`，完成后立即重读并返回 JSON 供对比 |

#### 可写字段范围

Crystal Reports SDK 对写入有较多限制，以下字段可通过 `build_report_from_json` 可靠地 roundtrip：

| 分类 | 字段 |
|---|---|
| SummaryInfo | title、author、subject、comments、keywords |
| 公式 | 所有 FormulaField 的 text |
| SQL 表达式字段 | 所有 SQLExpressionField 的 text |
| 选择公式 | recordSelection、groupSelection |
| 数据库连接 | 各表的 server、database（不含凭据） |
| Command SQL | Add Command 表的 SQL 文本 |
| 参数默认值 | 离散型默认值（discrete），range 型不支持 |
| 排序方向 | SortField 的 direction（Ascending/Descending） |

以下字段 SDK **不支持写入**，在 roundtrip 中会直接沿用原文件的值（因为模板即原文件）：section 布局、running totals、summary fields、子报表链接拓扑、纸张/边距设置。

#### Roundtrip 流程示例

```
save_report_json(path="C:\reports\avl_print.rpt", out="C:\tmp\avl_print.json")
  → 生成 JSON 文件

build_report_from_json(json="C:\tmp\avl_print.json", out="C:\tmp\avl_print_rebuilt.rpt")
  → 生成重建的 .rpt，并返回其 JSON dump

# 将返回的 JSON 与原始 JSON 对比，验证可写字段是否一致
```

## 已知限制

### 读取器与本机 Crystal 版本绑定

`reader/build.ps1` 把 Crystal 程序集的路径和版本写死了：

- 版本：`13.0.4000.0`（公钥 `692fbea5521e1304`）
- 位置：`C:\Windows\Microsoft.NET\assembly\GAC_MSIL` 和 `GAC_64`

因此：

- **换一台电脑**：目标机器必须安装同版本的 Crystal Reports，否则 `build` 会编译失败。
- **升级 Crystal**：版本号变化后，需要先修改 `reader/build.ps1` 里的 `$v`，再运行 `npm run build` 重新编译。
- 读取器按 x64 编译，和已安装的 x64 运行时对应。

### 其他

- `ReportDocument.Subreports` 在子报表上会抛 `NotSupportedException`，所以只读取一层子报表（主报表的直接子报表）。
- 结果缓存在内存中，按文件修改时间失效；重启 server 后缓存清空。
- 同时最多运行 4 个读取/写入进程，单次操作超时 60 秒。

## 测试

测试套件使用 Mocha，报表目录通过环境变量 `RPT_DIR` 传入（目录下需包含 `avl_print.rpt` 和 `application_avl.rpt`）。

```powershell
# PowerShell
$env:RPT_DIR = "C:\reports"
npm test
```

```bash
# bash / CMD
RPT_DIR=C:\reports npm test
```

测试共 32 个用例，分四组：

| 组 | 内容 |
| --- | --- |
| `tools/list` | 验证所有工具均已注册 |
| `read tools` | 每个只读工具各一个用例，验证返回非错误且内容合理 |
| `input validation` | 验证相对路径、非 `.rpt` 文件、不存在路径、缺失目录均被拒绝 |
| `roundtrip` | 导出 JSON → 重建 `.rpt` → 重读 → 对每个可写字段单独断言 |

需要先编译 `reader/RptReader.exe`（`npm run build`）。不设置 `RPT_DIR` 时所有用例会被 skip（不报错）。
