# 禅道 MCP 服务器

这是一个基于禅道 RESTful API v1 的 MCP (Model Context Protocol) 服务器，通过 zentaosid 进行 Cookie 认证，可以查询、新建和修改产品、项目、需求、Bug、任务，不提供删除功能。

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

API v1产品接口通常一次返回完整集合，MCP在确认集合完整后本地分页；其他接口传递并核对服务端分页。服务端忽略页码、每页数量或只返回无法确认完整性的截断集合时返回错误，不伪造分页。总数以当前账号权限和接口默认查询范围为准。

查询项目任务时，先使用 `get_executions` 分页获取执行ID，再调用 `get_tasks`，不能把项目ID当执行ID。详情工具为 `get_product(productId)`、`get_project(projectId)`、`get_requirement(storyId)`、`get_bug(bugId)` 和 `get_task(taskId)`。

### 3. 新建和修改数据

写入工具使用 `data` 对象传递业务字段，路径中的对象ID放在顶层。修改只需提供待变更字段，空修改、未知字段、删除标记和非法ID会被拒绝。

| 对象 | 新建工具 | 修改工具 | 新建必填参数 |
| --- | --- | --- | --- |
| 产品 | `create_product` | `update_product` | data: name、program、code |
| 项目 | `create_project` | `update_project` | data: name、code、begin、end、products（非空产品ID数组） |
| 需求 | `create_requirement` | `update_requirement` | data: product、title、pri、category |
| Bug | `create_bug` | `update_bug` | productId；data: title、severity、pri、type |
| 任务 | `create_task` | `update_task` | executionId；data: name、type、assignedTo、estStarted、deadline |

修改工具的顶层ID分别为 `productId`、`projectId`、`storyId`、`bugId`、`taskId`。完整可写字段以工具的 inputSchema 为准。

需求的标题、描述、验收标准使用 `change_requirement`，参数为 `storyId` 和 `data`（title、spec、verify 中至少一项）；该操作走需求变更流程，可能需要重新评审。`update_requirement` 用于模块、来源、优先级等其他字段。

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

### 5. 关闭执行

`close_execution(executionId, realEnd, comment?, dryRun?)` 先分页检查执行的全部任务，仅接受 `done`（已完成）、`closed`（已关闭）、`cancel`（已取消），空执行不能关闭。任何一条任务不满足条件时，整个执行及其任务均不写入。

默认 `dryRun=true` 只预览，返回任务统计和待关闭的已完成任务ID。明确授权后传 `dryRun=false`：先通过禅道17.0原生关闭流程将 `done` 任务关闭并回读，保留已关闭和已取消任务，再重新核对全部任务并关闭执行、回读状态及实际完成日期。`realEnd` 必填，格式为 `YYYY-MM-DD`。任务关闭失败时不继续关闭执行；操作可能部分生效，先查询核实，不自动重试。

```json
{ "executionId": 123, "realEnd": "2026-11-13", "dryRun": true }
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

