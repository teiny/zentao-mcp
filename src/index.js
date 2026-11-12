#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { callWriteTool, isWriteTool, positiveId, writeTools } from "./write-tools.js";
import { callListTool, isListTool, listTools } from "./list-tools.js";

// 配置存储
let config = {
  url: process.env.ZENTAO_URL || "",
  zentaosid: process.env.ZENTAO_SID || "", // zentaosid
};

/**
 * 发送 API 请求（使用 Cookie）
 */
async function apiRequest(endpoint, method = "GET", body = null) {
  if (!["GET", "POST", "PUT"].includes(method)) {
    throw new Error("仅支持查询、新建和修改，禁止删除数据");
  }
  if (!config.zentaosid) {
    throw new Error("请先配置 zentaosid");
  }
  
  // 确保 URL 末尾没有斜杠，然后拼接路径
  const baseUrl = config.url.replace(/\/$/, "");
  const url = `${baseUrl}/api.php/v1${endpoint}`;

  const options = {
    method,
    headers: {
      "Content-Type": "application/json",
      Cookie: `zentaosid=${config.zentaosid}`, // Cookie 中使用 zentaosid
    },
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  try {
    const response = await fetch(url, options);
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API 请求失败: ${response.status} ${errorText}`);
    }

    const result = await response.json();
    if (result?.error || result?.status === "fail") {
      throw new Error(`API 业务错误: ${JSON.stringify(result.error || result.message || result)}`);
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
    ],
  };
});

// 处理工具调用
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
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

