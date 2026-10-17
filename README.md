# rpt-mcp-server

只读的 MCP server,让 Bob 可以读取本机上的 Crystal Reports `.rpt` 文件。

## 工作方式

`.rpt` 是二进制格式,只有 Crystal 自带的 .NET SDK 能可靠解析,因此分两层:

- `reader/RptReader.exe`:C# 小程序(.NET Framework 4.x,x64),调用本机已安装的 Crystal Reports SDK,每次读一个报表并输出 JSON。
- `src/index.js`:Node MCP server(纯 JavaScript,无需编译),负责路径校验、调度读取器、按文件修改时间缓存结果、提供工具。

全程只读:不连接数据库,不刷新数据,不导出用户名和密码(连接信息只含 server 和 database)。

## 前置条件

- Windows,Node.js 20 及以上
- 已安装 Crystal Reports for Visual Studio,即 GAC 中存在 `CrystalDecisions.*` 13.0.4000.0 程序集及 x64 运行时
- .NET Framework 自带的 `csc.exe`(`C:\Windows\Microsoft.NET\Framework64\v4.0.30319\`)

## 构建

```powershell
npm install
npm run build:reader   # 编译 reader/RptReader.exe
```

## 配置

报表根目录不写死,按以下优先级确定:

1. 命令行参数 `--root <目录>`(或 `--root=<目录>`)
2. 环境变量 `RPT_ROOT`
3. 都没给时,使用 server 进程的当前工作目录(MCP 客户端通常在当前 workspace 下启动它)

所有工具只能访问根目录下的 `.rpt`,包括不能通过符号链接绕出去。

在 `~/.bob/settings/mcp.json` 中注册(`<path-to>` 换成本项目所在位置)。

默认读取当前 workspace:

```json
{
  "mcpServers": {
    "crystal-reports": {
      "command": "node",
      "args": ["<path-to>/rpt-mcp-server/src/index.js"]
    }
  }
}
```

指定其他目录:

```json
{
  "mcpServers": {
    "crystal-reports": {
      "command": "node",
      "args": ["<path-to>/rpt-mcp-server/src/index.js", "--root", "<报表目录>"]
    }
  }
}
```

| 配置项 | 必填 | 说明 |
|---|---|---|
| `--root` | 否 | 报表根目录,优先级最高 |
| `RPT_ROOT` | 否 | 报表根目录,`--root` 未给时使用 |
| `RPT_READER_EXE` | 否 | 自定义 `RptReader.exe` 路径,默认 `reader/RptReader.exe` |

## 工具

| 工具 | 用途 |
|---|---|
| `list_reports` | 列出 `.rpt`,可按名字过滤 |
| `get_report_summary` | 纸张、边距,以及各类对象的数量 |
| `get_report_structure` | 各 section 及其对象类型统计 |
| `list_report_objects` | 对象的位置、文本、绑定字段 |
| `get_data_sources` | 表、连接(server/database)、表链接 |
| `get_database_fields` | 表的字段名和类型 |
| `get_command_sql` | "Add Command" 里的 SQL |
| `list_parameters` | 参数及默认值 |
| `list_formulas` | 公式、SQL 表达式、累计字段、汇总字段 |
| `get_selection_formulas` | 记录和分组选择公式 |
| `get_grouping_and_sorting` | 分组和排序 |
| `get_subreports` | 子报表及其链接字段 |
| `search_reports` | 在所有报表里搜 SQL、公式、字段、文本、参数、表 |
| `export_report_json` | 单个报表的完整 JSON |

## 已知限制

### 读取器与本机 Crystal 版本绑定

`reader/build.ps1` 把 Crystal 程序集的路径和版本写死了:

- 版本:`13.0.4000.0`(公钥 `692fbea5521e1304`)
- 位置:`C:\Windows\Microsoft.NET\assembly\GAC_MSIL` 和 `GAC_64`

因此:

- **换一台电脑**:目标机器必须安装同版本的 Crystal Reports,否则 `build:reader` 会编译失败。
- **升级 Crystal**:版本号变化后,需要先修改 `reader/build.ps1` 里的 `$v`,再运行 `npm run build:reader` 重新编译。
- 读取器按 x64 编译,和已安装的 x64 运行时对应。

### 其他

- `ReportDocument.Subreports` 在子报表上会抛 `NotSupportedException`,所以只读取一层子报表(主报表的直接子报表)。
- 结果缓存在内存中,按文件修改时间失效;重启 server 后缓存清空。
- 同时最多运行 4 个读取进程,单个读取超时 60 秒。

## 测试

```powershell
node scripts/smoke-test.mjs <报表目录>   # 也可以设置 RPT_ROOT 环境变量
```

脚本通过 stdio 启动 server,调用全部工具,并验证路径越界会被拒绝。需要先编译 `reader/RptReader.exe`。
