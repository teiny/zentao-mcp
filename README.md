# 禅道 MCP 服务器

这是一个基于禅道 RESTful API v1 的 MCP (Model Context Protocol) 服务器，通过 zentaosid 进行 Cookie 认证，可以查询、新建和修改产品、项目、执行、需求、Bug、任务，不提供删除功能。团队维护及任务 PDF 附件使用禅道 17.0 原生表单接口封装为专用 MCP 工具。

## 功能特性

- 🔐 使用 zentaosid 进行 Cookie 认证
- 📋 获取产品需求列表
- 📄 获取单个需求详情
- 🐛 获取产品 bug 列表
- ✅ 按执行获取任务列表和任务详情，查询项目下的执行
- 📊 获取产品详情
- 🔍 获取项目详情
- ✏️ 新建和修改产品、项目、需求、Bug、任务，支持独立的需求内容变更流程
- 🐛 通过独立接口解决Bug，支持解决方案、版本、日期、指派及备注
- 🛡️ 写入字段白名单校验，拒绝删除标记，不提供任意 HTTP 请求工具
- ⚙️ 支持环境变量和动态配置两种方式

## 安装

### 方式一：从 npm 安装（如果已发布）

```bash
npm install -g zentao-mcp
```

### 方式二：从源码安装

```bash
# 克隆仓库
git clone https://github.com/teiny/zentao-mcp.git
cd zentao-mcp

# 安装依赖
npm install
```

### 方式三：本地开发

```bash
npm install
```

## 配置方式

### 方式一：环境变量配置

在启动服务器前，设置以下环境变量：

```bash
export ZENTAO_URL=https://your-zentao-url.com
export ZENTAO_SID=your-zentaosid
```

### 方式二：MCP 工具动态配置（推荐）

使用 `configure` 工具动态设置连接信息，更灵活且不需要在配置文件中硬编码敏感信息。

## 使用方法

### 1. 配置禅道连接信息

使用 `configure` 工具设置禅道 URL 和 zentaosid：

**如何获取 zentaosid：**
1. 登录禅道系统
2. 打开浏览器开发者工具（F12）
3. 在 Network 标签中查看请求的 Cookie
4. 复制 `zentaosid` 的值

**配置示例：**
```json
{
  "url": "https://your-zentao-url.com",
  "zentaosid": "712bc0a88bfff38a0a7310240521b40f"
}
```

### 2. 查询数据

| 列表工具 | 范围参数 | 返回数组 |
| --- | --- | --- |
| `get_products` | 无，当前账号可访问的产品 | products |
| `get_projects` | 无，当前账号可访问的项目 | projects |
| `get_executions` | projectId可选，不传查全局，传入查该项目下的执行 | executions |
| `get_requirements` | productId必填 | stories |
| `get_tasks` | executionId必填，执行ID不是项目ID | tasks |
| `get_bugs` | productId必填 | bugs |

六类列表统一支持 `page`（从1开始的正整数，默认1）、`limit`（1至100的整数，默认20）。每次只返回一页，保留原实体数组字段，并返回 `page`、`limit`、`total`、`totalPages`、`count`、`hasNext`、`nextPage`。查询下一页时保留范围参数和limit，将page设为nextPage，直到hasNext为false；不能把第一页当作全部数据。

`get_executions` 额外支持 `status`，默认 `all`，项目范围也包含已关闭执行；可指定 `undone`、`wait`、`doing`、`suspended`、`closed`。`get_execution(executionId)` 返回执行详情、关联产品及团队成员。

API v1产品接口通常一次返回完整集合，MCP在确认集合完整后本地分页；其他接口传递并核对服务端分页。服务端忽略页码、每页数量或只返回无法确认完整性的截断集合时返回错误，不伪造分页。总数以当前账号权限和接口默认查询范围为准。

查询项目任务时，先使用 `get_executions` 分页获取执行ID，再调用 `get_tasks`，不能把项目ID当执行ID。详情工具为 `get_product(productId)`、`get_project(projectId)`、`get_requirement(storyId)`、`get_bug(bugId)` 和 `get_task(taskId)`。

### 3. 新建和修改数据

写入工具使用 `data` 对象传递业务字段，路径中的对象ID放在顶层。修改只需提供待变更字段，空修改、未知字段、删除标记和非法ID会被拒绝。

| 对象 | 新建工具 | 修改工具 | 新建必填参数 |
| --- | --- | --- | --- |
| 产品 | `create_product` | `update_product` | data: name、program、code |
| 项目 | `create_project` | `update_project` | data: name、code、begin、end、products（非空产品ID数组） |
| 执行 | `create_execution` | `update_execution` | projectId；data: name、code、begin、end、days |
| 需求 | `create_requirement` | `update_requirement` | data: product、title、pri、category |
| Bug | `create_bug` | `update_bug` | productId；data: title、severity、pri、type |
| 任务 | `create_task` | `update_task` | executionId；data: name、type |

修改工具的顶层ID分别为 `productId`、`projectId`、`storyId`、`bugId`、`taskId`。完整可写字段以工具的 inputSchema 为准。

执行修改使用 `executionId`，不提供直接修改状态的字段。任务新建和修改支持 `desc`；新建可省略 `assignedTo`、`estStarted`、`deadline`，或显式传空字符串。MCP 按 17.0 创建循环要求将新建任务的指派转换为数组（未指派为 `[""]`），不代填负责人或日期；修改指派仍传字符串。服务端自定义必填规则仍会返回错误。项目、执行的开始日期在 17.0 后端为必填，MCP 不伪造占位日期；项目修改现支持 `begin`、`end`。

### 完成任务

finish_task(taskId, currentConsumed, realStarted, finishedDate, assignedTo?, comment?, dryRun?) 通过禅道17.0正式任务完成流程设置 done，清零剩余工时并累计本次消耗；不修改任务描述，不关闭执行。currentConsumed 为明确提供的本次实际工时，realStarted、finishedDate 为禅道本地时间 YYYY-MM-DD HH:mm:ss，不自动猜测工时或开始时间；未提供 assignedTo 时保留当前指派。

默认 dryRun=true 只预览；dryRun=false 才通过 task-finish-{id}.json 提交并回读状态、工时、原详情和本次新增的 finished 操作记录。comment 为自动转义、保留换行的纯文本，可在完成说明中记录实际完成分支和提交。当前支持普通单人任务，不支持多人或父任务；已完成任务不重复计时或补写普通评论。权限、必填字段和状态流转仍由服务端校验；结果不明不自动重试，先用 get_task 只读核实。
### 追加任务备注

`add_task_comment(taskId, comment, dryRun)` 向指定任务追加一条操作历史备注，不覆盖任务描述或修改任务状态。`comment` 为非空纯文本，自动转义 HTML 并保留换行；默认 `dryRun=true` 只预览，已获授权时传 `dryRun=false` 才写入。通过禅道17.0原生 `action-comment-task-{id}.json` 提交后，回读新备注的操作ID、对象及正文，并核对任务业务字段。结果不明或回读不一致时不自动重试，应先用 `get_task` 只读核实，避免重复追加。

### create_subtask

通过禅道17.0正式拆分流程创建真实子任务，不能用普通create_task中的额外字段代替。父任务由parentTaskId指定，data支持name、type、assignedTo、module、story、pri、estimate、estStarted、deadline、desc，name/type必填；指派填写账号。

默认只预览，显式dryRun=false才写入。未提供时沿用父任务模块、需求、优先级和已排日期，预计工时为0（未估算），不代填非零工时。禁止为17.0多人任务或子任务继续拆分；同名同字段已存在时只回读，不重复创建。权限/超时/回读不明时不自动重发，调用方须先只读核查。

新建后验证父子关系、所属执行、类型、指派及字段。父任务的状态、工时和日期由禅道正式流程汇总；如果原父任务已有消耗工时，禅道可自动新增一个继承原开发记录的子任务，工具将其作为additionalChildren返回，不删除或覆盖原子任务。

示例：

```json
{"parentTaskId":123,"data":{"name":"功能验收测试","type":"test","assignedTo":"tester","desc":"按父任务需求验证功能及相关回归"},"dryRun":false}
```

该能力只负责创建和验证，不自动完成、关闭或替测试组给出验收结论。

### 团队与任务附件

- `update_project_settings(projectId, data, dryRun)` 补齐17.0 API v1普通项目修改会忽略的 `budget`、`budgetUnit`、`days`、`auth`。默认只预览，`dryRun=false` 经原生项目编辑表单保存并回读；保留其他字段和关联产品，目前仅支持Scrum项目及无关联计划的普通产品，拒绝任意字段和删除标记。

- `get_project_team(projectId)`、`get_execution_team(executionId)` 读取完整成员的账号、角色、工作日、工时及受限标记。
- `copy_team` 使用 `sourceType`、`sourceId`、`targetType`、`targetId`，类型为 `project` 或 `execution`。默认 `dryRun=true` 仅预览；显式 `dryRun=false` 才维护并回读。保留目标已有成员及其配置，新增成员复制角色、每日工时和受限标记，工作日取目标可用工作日。原生管理接口按完整名单保存，因此写入前复查名单变化，不提供移除成员模式。
- `upload_task_attachment(taskId, filePath, dryRun)` 接收本机绝对路径的 PDF 或图片，最大 20MiB（服务端仍可能有更低限制）。默认只检查文件和任务；`dryRun=false` 才上传并回读附件。只支持未开始或进行中的普通单人任务，拒绝多人、父子或已结束任务，避免原生编辑接口改变其业务状态。
- 原生接口使用 `index.php/module-method-id.json` 和已有 Cookie 权限。17.0 API v1 的 `/files` 只接受图片，PDF 不通过该入口上传。任务附件通过原生编辑表单保留原字段并提交 `files[]`；上传后核对新附件及任务原值。失败或结果不明不自动重试，不暴露任意 HTTP 路由或删除能力。

需求的标题、描述、验收标准使用 `change_requirement`，参数为 `storyId` 和 `data`（title、spec、verify 中至少一项）；该操作走需求变更流程，可能需要重新评审。`update_requirement` 用于模块、来源、优先级等其他字段。

Bug 新建和修改支持 `data.assignedTo`，传入用户账号字符串；修改时传空字符串表示取消指派。指派不会改变 Bug 的解决状态。

Bug 的部分修改会先读取原记录，保留 API 要求的 title、severity、pri、type 未修改值，不复制删除标记或其他响应字段。写入后应使用对应详情工具读回核实；超时或结果不明时先查询，不盲目重复创建。

示例：修改任务名称。

```json
{
  "taskId": 6866,
  "data": { "name": "修改后的任务名称" }
}
```

不提供删除、批量删除、软删除或通用 HTTP 写入工具；HTTP 方法仅允许 GET、POST、PUT。

### 4. 解决 Bug

使用 `resolve_bug` 调用 API v1 的 `POST /bugs/{bugId}/resolve`，不通过 `update_bug` 直接修改状态。顶层 `bugId` 必填，业务字段放在 `data`：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| resolution | 是 | fixed已解决、bydesign设计如此、duplicate重复Bug、external外部原因、notrepro无法重现、postponed延期、willnotfix不予解决、tostory转需求 |
| duplicateBug | duplicate时必填 | 重复Bug的正整数ID，不能指向当前Bug自身 |
| resolvedBuild | 否 | 正整数版本ID、版本ID字符串，或trunk（主干） |
| resolvedDate | 否 | YYYY-MM-DD或YYYY-MM-DD HH:mm:ss；不传时由禅道决定 |
| assignedTo | 否 | 解决后指派给的用户账号，不是显示姓名 |
| comment | 否 | 解决备注 |

示例参数（实际调用时替换Bug ID和解决信息）：

```json
{
  "bugId": 123,
  "data": {
    "resolution": "fixed",
    "resolvedBuild": "trunk",
    "assignedTo": "tester",
    "comment": "修复说明和验证结果"
  }
}
```

解决前使用 `get_bug` 核对目标和状态，解决后再次查询核实。结果不明时先读回，不盲目重试。此工具使用已有解决版本，不包含附件上传或新建版本功能。参见[官方 API v1 解决Bug接口](https://www.zentao.net/book/api/1181.html)。

### 5. 关闭任务、执行与项目

`close_task(taskId, comment?, dryRun?)`、`close_execution(executionId, realEnd, comment?, dryRun?)` 和 `close_project(projectId, realEnd, comment?, dryRun?)` 是独立的通用操作，分别通过禅道17.0原生关闭流程关闭指定任务、执行或项目。每个工具只处理指定对象，不查询、筛选或自动关闭关联的任务、执行及项目。权限及可进行的状态流转由禅道服务端校验。

默认 `dryRun=true` 只预览，传 `dryRun=false` 才写入并回读状态；已关闭对象不重复写入。关闭执行和项目时 `realEnd` 必填，格式为 `YYYY-MM-DD`，写入后同时核对实际完成日期。项目关闭核对其项目类型和所属项目集，拒绝把执行或项目集当作项目。结果不明时先查询核实，不自动重试。

MCP负责认证、参数校验、服务端协议适配和结果核实。业务范围、任务完成定义、空执行是否处理及跨对象关闭顺序，由调用方的 agent skill 或应用编排决定。非标交付的关闭顺序保留在 `zentao-nonstandard-delivery` 技能中，工具不内置“非标项目”“仅全部任务结束才可关闭”等特定业务策略。

```json
{ "projectId": 123, "realEnd": "2026-11-13", "dryRun": true }
```

### 6. 验证

运行 `npm test`，使用本机随机端口的内存服务完成单元测试和 stdio MCP 集成测试，不依赖生产配置或凭据。实际实例的任务查询已经只读验证；新增和修改的真实业务写入权限及定制校验以实际调用结果为准。

## MCP 客户端配置示例

在 Cursor 或其他 MCP 客户端的配置文件中添加：

### 如果全局安装了 zentao-mcp

```json
{
  "mcpServers": {
    "zentao": {
      "command": "zentao-mcp"
    }
  }
}
```

### 如果从源码安装

```json
{
  "mcpServers": {
    "zentao": {
      "command": "node",
      "args": ["/absolute/path/to/zentao-mcp/src/index.js"],
      "env": {
        "ZENTAO_URL": "https://your-zentao-url.com",
        "ZENTAO_SID": "your-zentaosid"
      }
    }
  }
}
```

**注意：** 推荐使用动态配置方式，不在配置文件中硬编码 zentaosid，而是通过 `configure` 工具动态设置。

## API 文档

参考 [禅道 RESTful API v1 文档](https://www.zentao.net/book/api/1397.html)

## 技术实现

- 使用 `@modelcontextprotocol/sdk` 实现 MCP 协议
- 通过 Cookie 认证（zentaosid）访问禅道 API
- 支持分页查询（page 和 limit 参数）
- 完整的错误处理机制

## 许可证

MIT
