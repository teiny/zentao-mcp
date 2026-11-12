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

### 4. 验证

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

