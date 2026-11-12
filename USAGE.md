# 禅道 MCP 服务器使用指南

## 快速开始

### 1. 安装依赖

```bash
cd /Users/unie/Desktop/Project/zentao-mcp
npm install
```

### 2. 配置 MCP 客户端（以 Cursor 为例）

#### 方法一：使用环境变量配置

在 Cursor 的 MCP 配置文件中添加（通常在 `~/.cursor/mcp.json` 或项目配置中）：

```json
{
  "mcpServers": {
    "zentao": {
      "command": "node",
      "args": ["/Users/unie/Desktop/Project/zentao-mcp/src/index.js"],
      "env": {
        "ZENTAO_URL": "https://your-zentao-url.com",
        "ZENTAO_SID": "your-zentaosid"
      }
    }
  }
}
```

**如何获取 zentaosid：**
1. 登录禅道系统
2. 打开浏览器开发者工具（F12）
3. 在 Network 标签中查看请求的 Cookie
4. 复制 `zentaosid` 的值

#### 方法二：动态配置（推荐）

如果不想在配置文件中硬编码 zentaosid，可以只配置命令，然后通过工具动态配置：

```json
{
  "mcpServers": {
    "zentao": {
      "command": "node",
      "args": ["/Users/unie/Desktop/Project/zentao-mcp/src/index.js"]
    }
  }
}
```

### 3. 重启 Cursor

配置完成后，重启 Cursor 以使 MCP 服务器生效。

### 4. 使用 MCP 工具

在 Cursor 的聊天界面中，你可以直接使用自然语言请求，AI 会自动调用相应的工具。

## 使用示例

### 示例 1：配置禅道连接

**对话示例：**

```
你：请帮我配置禅道连接，URL 是 https://zentao.example.com，zentaosid 是 712bc0a88bfff38a0a7310240521b40f

AI：我会使用 configure 工具来配置禅道连接信息...
```

### 示例 2：获取产品需求列表

**对话示例：**

```
你：请获取产品ID为1的所有需求

AI：我会使用 get_requirements 工具获取产品需求...
```

### 示例 2.1：获取单个需求详情

**对话示例：**

```
你：获取需求10818的详情

AI：我会使用 get_requirement 工具获取需求详情...
```

### 示例 3：获取 Bug 列表

**对话示例：**

```
你：查看产品1的第1页bug，每页显示10条

AI：我会使用 get_bugs 工具获取bug列表...
```

### 示例 4：获取执行任务

**对话示例：**

```
你：获取执行ID为2159的任务

AI：我会使用 get_tasks 工具获取执行任务；如果只有项目ID，先用 get_executions 获取执行列表。
```

## 可用工具列表

### 六类分页列表

`get_products`（产品）、`get_projects`（项目）、`get_executions`（执行）、`get_requirements`（需求）、`get_tasks`（任务）、`get_bugs`（Bug）统一支持page和limit。

- page为正整数，默认1；limit为1至100的整数，默认20。
- 需求、Bug按productId查询；任务按executionId查询；执行可选projectId，不传时查全局。
- 返回原实体数组和page、limit、total、totalPages、count、hasNext、nextPage。hasNext为true时保留范围及limit，按nextPage继续；用户要求全部数据时须逐页完成。
- 产品接口全量返回时由MCP分页。其他接口的分页请求和响应须一致，不能把服务端重复返回的第一页标成第二页。

### configure
配置禅道连接信息
- **参数：**
  - `url` (string, 必需): 禅道服务器地址（例如：https://your-zentao-url.com）
  - `zentaosid` (string, 必需): zentaosid（用于 Cookie 认证）

**如何获取 zentaosid：**
1. 登录禅道系统
2. 打开浏览器开发者工具（F12）
3. 在 Network 标签中查看任意请求的 Cookie
4. 复制 `zentaosid` 的值

### get_requirements
获取产品需求列表
- **参数：**
  - `productId` (number, 必需): 产品ID
  - `page` (integer, 可选): 正整数页码，默认1
  - `limit` (integer, 可选): 每页数量1至100，默认20

### get_requirement
获取单个需求详情
- **参数：**
  - `storyId` (number, 必需): 需求ID

### get_bugs
获取产品 bug 列表
- **参数：**
  - `productId` (number, 必需): 产品ID
  - `page` (integer, 可选): 正整数页码，默认1
  - `limit` (integer, 可选): 每页数量1至100，默认20

### get_tasks
获取执行任务列表
- **参数：**
  - `executionId` (integer, 必需): 执行ID，不是项目ID
  - `page` (integer, 可选): 正整数页码，默认1
  - `limit` (integer, 可选): 每页数量1至100，默认20

### get_executions
分页获取执行列表，参数为page、limit及可选的 `projectId`（正整数项目ID）；不传projectId时查询全局执行列表。

### get_task
获取任务详情，参数为 `taskId`（正整数任务ID）。

### 新建、修改及需求内容变更

提供 `create_product` / `update_product`、`create_project` / `update_project`、`create_requirement` / `update_requirement`、`create_bug` / `update_bug`、`create_task` / `update_task`。业务字段放在 `data` 对象，目标或父对象ID放在顶层。必填字段及示例见 [README 的新建和修改说明](README.md#3-新建和修改数据)。

需求标题、描述或验收标准的变更使用 `change_requirement`，不使用普通字段修改工具。删除、软删除和任意 HTTP 请求均不支持。

### resolve_bug

通过独立的 `POST /bugs/{bugId}/resolve` 解决Bug。

- `bugId`：必填，正整数Bug ID。
- `data.resolution`：必填，fixed、bydesign、duplicate、external、notrepro、postponed、willnotfix或tostory。
- `data.duplicateBug`：重复Bug方案必填，不能与bugId相同。
- `data.resolvedBuild`：可选，版本ID整数、ID字符串或trunk。
- `data.resolvedDate`：可选，YYYY-MM-DD或YYYY-MM-DD HH:mm:ss。
- `data.assignedTo`：可选，用户账号。
- `data.comment`：可选，备注。

先用get_bug核对目标，调用后读回状态。普通update_bug不会代替该状态流转操作。附件上传、新建版本不在此工具范围。

### get_product
获取产品详情
- **参数：**
  - `productId` (number, 必需): 产品ID

### get_project
获取项目详情
- **参数：**
  - `projectId` (number, 必需): 项目ID

## 常见问题

### Q: 如何找到 Cursor 的 MCP 配置文件？

A: Cursor 的 MCP 配置通常在以下位置：
- macOS: `~/Library/Application Support/Cursor/User/globalStorage/mcp.json`
- 或者通过 Cursor 设置界面配置

### Q: Zentaosid 过期了怎么办？

A: Zentaosid 会过期，如果遇到认证失败，需要重新从浏览器 Cookie 中获取最新的 zentaosid，然后使用 `configure` 工具重新配置。

### Q: 如何测试 MCP 服务器是否正常工作？

A: 可以在终端直接运行服务器测试：

```bash
node /Users/unie/Desktop/Project/zentao-mcp/src/index.js
```

如果看到 "禅道 MCP 服务器已启动" 的提示，说明服务器运行正常。

### Q: 权限不足怎么办？

A: 确保你的禅道账号有相应的权限：
- 查看需求的权限
- 查看 bug 的权限
- 查看任务的权限

可以在禅道后台的「人员管理-权限」中调整。

## 下一步

配置完成后，你就可以在 Cursor 中直接询问关于禅道的问题，AI 会自动调用相应的工具来获取数据。


