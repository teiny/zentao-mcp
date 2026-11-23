#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { callWriteTool, isWriteTool, positiveId, writeTools } from "./write-tools.js";
import { callListTool, isListTool, listTools } from "./list-tools.js";
import { callWorkflowTool, isWorkflowTool, workflowTools } from "./workflow-tools.js";
import { createSubtask, subtaskTools } from "./subtask-tools.js";

// 配置存储
let config = {
  url: process.env.ZENTAO_URL || "",
  zentaosid: process.env.ZENTAO_SID || "", // zentaosid
};

/**
 * 发送 API 请求（使用 Cookie）
 */
async function apiRequest(endpoint, method = "GET", body = null) {
  return sendRequest(`/api.php/v1${endpoint}`, method, body);
}

// 仅供专用工具使用的17.0原生JSON表单接口，不向调用者开放任意路由。
async function nativeRequest(module, action, objectId, body = null, parentTaskId = null) {
  const allowed = { project: ["team", "manageMembers", "edit", "close"], execution: ["team", "manageMembers", "close"], task: ["edit", "close", "comment", "finish", "batchCreate"] };
  if (!Object.hasOwn(allowed, module) || !allowed[module].includes(action)) throw new Error("不支持的原生接口");
  positiveId(objectId, "objectId");
  if (parentTaskId !== null && !(module === "task" && action === "batchCreate")) throw new Error("不支持的父任务参数");
  const path = module === "task" && action === "batchCreate"
    ? `/index.php/task-batchCreate-${objectId}-0-0-${positiveId(parentTaskId, "parentTaskId")}.json`
    : module === "task" && action === "comment"
      ? `/index.php/action-comment-task-${objectId}.json`
      : `/index.php/${module}-${action}-${objectId}.json`;
  return sendRequest(path, body === null ? "GET" : "POST", body, true);
}

async function sendRequest(path, method, body, native = false) {
  if (!["GET", "POST", "PUT"].includes(method)) {
    throw new Error("仅支持查询、新建和修改，禁止删除数据");
  }
  if (!config.zentaosid) {
    throw new Error("请先配置 zentaosid");
  }
  
  // 确保 URL 末尾没有斜杠，然后拼接路径
  const baseUrl = config.url.replace(/\/$/, "");
  const url = `${baseUrl}${path}`;

  const options = {
    method,
    headers: {
      Cookie: `zentaosid=${config.zentaosid}`, // Cookie 中使用 zentaosid
      Accept: "application/json",
    },
    redirect: "manual",
    signal: AbortSignal.timeout(30000),
  };

  if (body instanceof FormData || body instanceof URLSearchParams) {
    options.body = body;
  } else if (body) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  if (native) {
    options.headers["X-Requested-With"] = "XMLHttpRequest";
    options.headers.Referer = `${baseUrl}/index.php`;
  }

  try {
    const response = await fetch(url, options);
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API 请求失败: ${response.status} ${errorText}`);
    }

    const raw = await response.text();
    let result;
    try { result = JSON.parse(raw); } catch {
      // 原生成员维护/编辑成功可返回跳转脚本；只接受已知跳转标记，调用者仍须回读验证。
      if (native && method === "POST" && /<script\b/i.test(raw) && /(?:location|reload)/i.test(raw) && !/(?:alert\s*\(|user[-/]login|loginForm)/i.test(raw)) {
        return { responseReceived: true, verified: false };
      }
      throw new Error("响应不是JSON，可能是登录页、权限错误或业务校验失败");
    }
    if (result?.error || ["fail", "error"].includes(result?.status) || result?.result === "fail") {
      throw new Error(`API 业务错误: ${JSON.stringify(result.error || result.message || result)}`);
    }
    if (native && result?.status === "success" && Object.hasOwn(result, "data")) {
      return typeof result.data === "string" ? JSON.parse(result.data) : result.data;
    }
    return result;
  } catch (error) {
    const message = config.zentaosid ? error.message.split(config.zentaosid).join("[已隐藏]") : error.message;
    throw new Error(`API 请求出错: ${message}`);
  }
}

// 创建 MCP 服务器
const server = new Server(
  {
    name: "zentao-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// 列出所有可用工具
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "configure",
        description: "配置禅道连接信息（URL、zentaosid）",
        inputSchema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "禅道服务器地址（例如：https://your-zentao-url.com）",
            },
            zentaosid: {
              type: "string",
              description: "zentaosid（用于 Cookie 认证）",
            },
          },
          required: ["url", "zentaosid"],
        },
      },
      ...listTools,
      {
        name: "get_product",
        description: "获取产品详情",
        inputSchema: {
          type: "object",
          properties: {
            productId: {
              type: "number",
              description: "产品ID",
            },
          },
          required: ["productId"],
        },
      },
      {
        name: "get_project",
        description: "获取项目详情",
        inputSchema: {
          type: "object",
          properties: {
            projectId: {
              type: "number",
              description: "项目ID",
            },
          },
          required: ["projectId"],
        },
      },
      {
        name: "get_requirement",
        description: "获取单个需求详情",
        inputSchema: {
          type: "object",
          properties: {
            storyId: {
              type: "number",
              description: "需求ID",
            },
          },
          required: ["storyId"],
        },
      },
      {
        name: "get_bug",
        description: "获取单个 bug 详情",
        inputSchema: {
          type: "object",
          properties: {
            bugId: {
              type: "number",
              description: "Bug ID",
            },
          },
          required: ["bugId"],
        },
      },
      {
        name: "get_task",
        description: "获取任务详情，用于修改前核对和写入后验证",
        inputSchema: {
          type: "object",
          properties: { taskId: { type: "integer", minimum: 1, description: "任务ID" } },
          required: ["taskId"],
        },
      },
      ...writeTools,
      ...workflowTools,
      ...subtaskTools,
    ],
  };
});

// 处理工具调用
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "create_subtask") {
      const result = await createSubtask(args, apiRequest, nativeRequest);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    if (isWorkflowTool(name)) {
      const result = await callWorkflowTool(name, args, apiRequest, nativeRequest);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    if (isListTool(name)) {
      const result = await callListTool(name, args, apiRequest);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    if (isWriteTool(name)) {
      const result = await callWriteTool(name, args, apiRequest);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    switch (name) {
      case "configure": {
        config = {
          url: args.url,
          zentaosid: args.zentaosid,
        };
        return {
          content: [
            {
              type: "text",
              text: `禅道配置已更新：
- URL: ${config.url}
- Zentaosid: ${config.zentaosid ? "已配置" : "未配置"}`,
            },
          ],
        };
      }

      case "get_product": {
        const { productId } = args;
        const result = await apiRequest(`/products/${productId}`);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "get_project": {
        const { projectId } = args;
        const result = await apiRequest(`/projects/${projectId}`);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "get_requirement": {
        const { storyId } = args;
        const result = await apiRequest(`/stories/${storyId}`);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "get_bug": {
        const { bugId } = args;
        const result = await apiRequest(`/bugs/${bugId}`);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "get_task": {
        const taskId = positiveId(args.taskId, "taskId");
        const result = await apiRequest(`/tasks/${taskId}`);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      default:
        throw new Error(`未知的工具: ${name}`);
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `错误: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

// 启动服务器
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("禅道 MCP 服务器已启动");
}

main().catch((error) => {
  console.error("服务器启动失败:", error);
  process.exit(1);
});

