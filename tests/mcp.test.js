import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const records = Object.fromEntries(
  ["products", "projects", "stories", "bugs", "tasks"].map((name) => [name, new Map()])
);
const requests = [];
let nextId = 100;
let api;
let client;
let transport;
let child;
let port;

before(async () => {
  api = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const path = url.pathname.replace(/^\/zentao\/api\.php\/v1/, "");
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = text ? JSON.parse(text) : undefined;
    requests.push({ method: request.method, path, query: Object.fromEntries(url.searchParams), body, cookie: request.headers.cookie });
    const send = (status, data) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(data));
    };
    if (request.headers.cookie !== "zentaosid=test-session") {
      return send(401, { error: "unauthorized" });
    }
    const lists = {
      "/products": ["products", 1], "/projects": ["projects", 101],
      "/executions": ["executions", 2159], "/projects/121/executions": ["executions", 2159],
      "/products/1/stories": ["stories", 301], "/products/1/bugs": ["bugs", 501],
      "/executions/2159/tasks": ["tasks", 6866],
    };
    if (request.method === "GET" && lists[path]) {
      const [key, firstId] = lists[path];
      const rows = Array.from({ length: 5 }, (_, index) => ({ id: firstId + index, name: `测试${key}${index}` }));
      if (path === "/products") return send(200, { total: rows.length, [key]: rows });
      const page = Number(url.searchParams.get("page") || 1);
      const limit = Number(url.searchParams.get("limit") || 20);
      return send(200, { page, limit, total: rows.length, [key]: rows.slice((page - 1) * limit, page * limit) });
    }
    if (request.method === "GET" && path === "/products/401") {
      return send(401, { error: "会话失效 test-session" });
    }
    if (request.method === "GET" && path === "/products/400") {
      return send(200, { error: "业务校验失败" });
    }
    let collection = path.match(/^\/(products|projects|stories)$/)?.[1];
    let parent = {};
    const bugParent = path.match(/^\/products\/(\d+)\/bugs$/);
    const taskParent = path.match(/^\/executions\/(\d+)\/tasks$/);
    if (bugParent) { collection = "bugs"; parent = { product: Number(bugParent[1]) }; }
    if (taskParent) { collection = "tasks"; parent = { execution: Number(taskParent[1]) }; }
    if (request.method === "POST" && collection) {
      const record = { id: nextId++, ...(collection === "bugs" ? { status: "active" } : {}), ...parent, ...body };
      records[collection].set(record.id, record);
      return send(201, record);
    }
    const change = path.match(/^\/stories\/(\d+)\/change$/);
    if (request.method === "POST" && change) {
      const record = records.stories.get(Number(change[1]));
      if (!record) return send(404, { error: "not found" });
      Object.assign(record, body);
      return send(200, record);
    }
    const resolve = path.match(/^\/bugs\/(\d+)\/resolve$/);
    if (request.method === "POST" && resolve) {
      const record = records.bugs.get(Number(resolve[1]));
      if (!record) return send(404, { error: "not found" });
      Object.assign(record, body, { status: "resolved" });
      return send(200, record);
    }
    const single = path.match(/^\/(products|projects|stories|bugs|tasks)\/(\d+)$/);
    if (single) {
      const record = records[single[1]].get(Number(single[2]));
      if (!record) return send(404, { error: "not found" });
      if (request.method === "GET") return send(200, record);
      if (request.method === "PUT") {
        if (single[1] === "bugs" && ["title", "severity", "pri", "type"].some((key) => body[key] === undefined)) {
          return send(400, { error: "Bug 修改缺少必填字段" });
        }
        Object.assign(record, body);
        return send(200, record);
      }
    }
    send(404, { error: "not found" });
  });
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  port = api.address().port;
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../src/index.js", import.meta.url))],
    env: { ZENTAO_URL: `http://127.0.0.1:${port}/zentao`, ZENTAO_SID: "test-session" },
    stderr: "ignore",
  });
  client = new Client({ name: "zentao-integration-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  child = transport._process;
  console.log(JSON.stringify({ purpose: "Local MCP integration tests", pid: child.pid, testPid: process.pid, startedAt: new Date().toISOString(), executable: process.execPath, close: "client.close() and api.close()", mockPort: port }));
});

after(async () => {
  child ??= transport?._process;
  const closed = child && child.exitCode === null && child.signalCode === null ? new Promise((resolve) => child.once("close", resolve)) : Promise.resolve();
  await client?.close();
  await closed;
  if (api?.listening) {
    await new Promise((resolve, reject) => api.close((error) => error ? reject(error) : resolve()));
  }
  if (port) {
    await new Promise((resolve, reject) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.on("connect", () => { socket.destroy(); reject(new Error("模拟服务端口未释放")); });
      socket.on("error", (error) => error.code === "ECONNREFUSED" ? resolve() : reject(error));
    });
  }
  console.log(JSON.stringify({ cleanup: true, pid: child?.pid, childExited: !child || child.exitCode !== null || child.signalCode !== null, mockPortReleased: !api?.listening }));
});

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError ?? false, false, JSON.stringify(result));
  return JSON.parse(result.content[0].text);
}

test("任务列表使用执行ID和正确的API路径", async () => {
  const result = await call("get_tasks", { executionId: 2159, page: 1, limit: 2 });
  assert.equal(result.tasks[0].id, 6866);
  assert.equal(requests.at(-1).path, "/executions/2159/tasks");
});

test("项目执行列表支持选择任务所属执行", async () => {
  const result = await call("get_executions", { projectId: 121 });
  assert.equal(result.executions[0].id, 2159);
});

const listExamples = [
  ["get_products", "products", {}],
  ["get_projects", "projects", {}],
  ["get_executions", "executions", {}],
  ["get_requirements", "stories", { productId: 1 }],
  ["get_tasks", "tasks", { executionId: 2159 }],
  ["get_bugs", "bugs", { productId: 1 }],
];

for (const [name, key, scope] of listExamples) {
  test(`六类列表${name}分页、末页和越界空页`, async () => {
    const first = await call(name, { ...scope, page: 1, limit: 2 });
    const second = await call(name, { ...scope, page: 2, limit: 2 });
    assert.deepEqual([first.page, second.page, first.limit, second.limit], [1, 2, 2, 2]);
    assert.equal(first[key].length, 2);
    assert.equal(second[key].length, 2);
    assert.equal(first.total, 5);
    assert.equal(first.totalPages, 3);
    assert.equal(first.count, 2);
    assert.equal(first.hasNext, true);
    assert.equal(first.nextPage, 2);
    assert.equal(first[key].some((row) => second[key].some((other) => row.id === other.id)), false);
    assert.equal(requests.at(-1).query.page, "2");
    assert.equal(requests.at(-1).query.limit, "2");
    const last = await call(name, { ...scope, page: 3, limit: 2 });
    assert.equal(last[key].length, 1);
    assert.equal(last.hasNext, false);
    assert.equal(last.nextPage, null);
    const empty = await call(name, { ...scope, page: 4, limit: 2 });
    assert.deepEqual(empty[key], []);
    assert.equal(empty.count, 0);
    assert.equal(empty.total, 5);
    assert.equal(empty.hasNext, false);
  });
}

test("六类列表默认分页和工具schema一致，项目执行也传递分页", async () => {
  const tools = await client.listTools();
  for (const [name, key, scope] of listExamples) {
    const tool = tools.tools.find((item) => item.name === name);
    assert.equal(tool.inputSchema.properties.page.type, "integer");
    assert.equal(tool.inputSchema.properties.page.default, 1);
    assert.equal(tool.inputSchema.properties.limit.default, 20);
    assert.equal(tool.inputSchema.properties.limit.maximum, 100);
    const result = await call(name, scope);
    assert.equal(result.page, 1);
    assert.equal(result.limit, 20);
    assert.equal(result[key].length, 5);
  }
  const executions = await call("get_executions", { projectId: 121, page: 2, limit: 2 });
  assert.equal(executions.executions[0].id, 2161);
  assert.equal(requests.at(-1).path, "/projects/121/executions");
  assert.deepEqual(requests.at(-1).query, { page: "2", limit: "2" });
});

test("列表非法分页和范围ID不发送HTTP请求", async () => {
  const beforeCount = requests.length;
  for (const [name, args] of [
    ["get_products", { page: 0 }], ["get_projects", { page: 1.5 }],
    ["get_executions", { limit: 0 }], ["get_executions", { limit: 101 }],
    ["get_requirements", { productId: 1, limit: "2" }],
    ["get_bugs", { productId: "1/delete" }], ["get_tasks", { executionId: 0 }],
  ]) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, name);
  }
  assert.equal(requests.length, beforeCount);
});

const examples = [
  ["product", "products", "productId", { name: "测试产品", program: 1, code: "test-product" }, { name: "修改产品" }],
  ["project", "projects", "projectId", { name: "测试项目", code: "test-project", begin: "2026-11-12", end: "2026-12-12", products: [1] }, { desc: "修改项目描述" }],
  ["requirement", "stories", "storyId", { title: "测试需求", product: 1, pri: 2, category: "feature" }, { pri: 1 }],
  ["bug", "bugs", "bugId", { title: "测试Bug", severity: 2, pri: 2, type: "codeerror", openedBuild: ["trunk"] }, { steps: "修改复现步骤" }],
  ["task", "tasks", "taskId", { name: "测试任务", type: "devel", assignedTo: "tester", estStarted: "2026-11-12", deadline: "2026-12-12" }, { name: "修改任务" }],
];

for (const [tool, collection, idKey, data, patch] of examples) {
  test(`${tool}通过MCP新建、读取、部分修改和读回`, async () => {
    const parent = tool === "bug" ? { productId: 1 } : tool === "task" ? { executionId: 2159 } : {};
    const created = await call(`create_${tool}`, { ...parent, data });
    const createRequest = requests.at(-1);
    assert.equal(createRequest.method, "POST");
    assert.equal(createRequest.path, tool === "bug" ? "/products/1/bugs" : tool === "task" ? "/executions/2159/tasks" : `/${collection}`);
    assert.deepEqual(createRequest.body, data);
    const read = await call(`get_${tool}`, { [idKey]: created.id });
    assert.equal(read.id, created.id);
    await call(`update_${tool}`, { [idKey]: created.id, data: patch });
    const updateRequest = requests.at(-1);
    assert.equal(updateRequest.method, "PUT");
    assert.equal(updateRequest.path, `/${collection}/${created.id}`);
    if (tool === "bug") {
      assert.equal(updateRequest.body.title, data.title);
      assert.equal(updateRequest.body.severity, data.severity);
    } else {
      assert.deepEqual(updateRequest.body, patch);
    }
    const updated = await call(`get_${tool}`, { [idKey]: created.id });
    for (const [key, value] of Object.entries(patch)) assert.deepEqual(updated[key], value);
    assert.equal(updated.code ?? updated.type ?? updated.category ?? data.title, data.code ?? data.type ?? data.category ?? data.title);
  });
}

test("需求内容通过独立变更接口更新", async () => {
  const created = await call("create_requirement", { data: { product: 1, title: "原需求", pri: 2, category: "feature" } });
  await call("change_requirement", { storyId: created.id, data: { title: "变更标题", spec: "变更描述", verify: "验收标准" } });
  assert.equal(requests.at(-1).method, "POST");
  assert.equal(requests.at(-1).path, `/stories/${created.id}/change`);
  const updated = await call("get_requirement", { storyId: created.id });
  assert.equal(updated.title, "变更标题");
});

test("解决Bug通过MCP调用独立接口并读回解决状态", async () => {
  const created = await call("create_bug", { productId: 1, data: { title: "待解决Bug", severity: 2, pri: 2, type: "codeerror" } });
  assert.equal(created.status, "active");
  const data = {
    resolution: "fixed", resolvedBuild: "trunk", resolvedDate: "2026-11-12 17:09:22",
    assignedTo: "tester", comment: "修复后已验证",
  };
  const resolved = await call("resolve_bug", { bugId: created.id, data });
  assert.equal(requests.at(-1).method, "POST");
  assert.equal(requests.at(-1).path, `/bugs/${created.id}/resolve`);
  assert.deepEqual(requests.at(-1).body, data);
  assert.equal(resolved.status, "resolved");
  const readBack = await call("get_bug", { bugId: created.id });
  assert.equal(readBack.status, "resolved");
  assert.equal(readBack.resolution, "fixed");
  assert.equal(readBack.resolvedBuild, "trunk");
  assert.equal(readBack.assignedTo, "tester");
});

test("重复Bug解决方案携带关联Bug且非法解决参数不发送请求", async () => {
  const created = await call("create_bug", { productId: 1, data: { title: "重复Bug", severity: 2, pri: 2, type: "codeerror" } });
  await call("resolve_bug", { bugId: created.id, data: { resolution: "duplicate", duplicateBug: 42, resolvedBuild: 8 } });
  assert.deepEqual(requests.at(-1).body, { resolution: "duplicate", duplicateBug: 42, resolvedBuild: 8 });
  const beforeCount = requests.length;
  for (const data of [
    { resolution: "duplicate" }, { resolution: "duplicate", duplicateBug: created.id },
    { resolution: "delete" }, { resolution: "fixed", deleted: 1 },
  ]) {
    const result = await client.callTool({ name: "resolve_bug", arguments: { bugId: created.id, data } });
    assert.equal(result.isError, true);
  }
  assert.equal(requests.length, beforeCount);
});

test("删除工具、删除标记和错误任务参数均不触发HTTP请求", async () => {
  const tools = await client.listTools();
  assert.equal(tools.tools.some((tool) => /delete|remove|purge|http_request/i.test(tool.name)), false);
  const beforeCount = requests.length;
  for (const [name, args] of [
    ["delete_bug", { bugId: 1 }],
    ["update_product", { productId: 1, data: { deleted: 1 } }],
    ["update_task", { taskId: 1, data: { status: "deleted" } }],
    ["get_tasks", { projectId: 121 }],
  ]) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, name);
  }
  assert.equal(requests.length, beforeCount);
});

test("HTTP认证错误及HTTP200业务错误返回失败且不显示会话值", async () => {
  for (const productId of [401, 400]) {
    const result = await client.callTool({ name: "get_product", arguments: { productId } });
    assert.equal(result.isError, true);
    assert.equal(JSON.stringify(result).includes("test-session"), false);
  }
});
