import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { mkdtemp, writeFile, unlink, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const records = Object.fromEntries(
  ["products", "projects", "executions", "stories", "bugs", "tasks"].map((name) => [name, new Map()])
);
const requests = [];
let nextId = 100;
let api;
let client;
let transport;
let child;
let port;
let attachmentPath;
let fixtureDirectory;
const member = (account, role = "开发") => ({ account, realname: account, role, days: 10, hours: 8, limited: "no", join: "2026-01-01" });
const teams = new Map([["project:10", [member("alice"), member("bob")]], ["project:20", [{ ...member("alice", "负责人"), days: 5 }]]]);

before(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), "zentao-mcp-test-"));
  attachmentPath = join(fixtureDirectory, "立项单.pdf");
  await writeFile(attachmentPath, "%PDF-1.4\nmock attachment\n");
  records.projects.set(10, { id: 10, type: "project", days: 10, deleted: false });
  records.projects.set(20, { id: 20, type: "project", days: 5, deleted: false });
  records.projects.set(30, { id: 30, type: "project", model: "scrum", name: "项目设置", code: "settings", team: "原团队", parent: 9, begin: "2026-11-06", end: "2026-11-26", days: 0, budget: "0", budgetUnit: "CNY", desc: "原描述", PM: "owner", auth: "", acl: "open", whitelist: [], deleted: false });
  api = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const path = url.pathname.replace(/^\/zentao\/api\.php\/v1/, "");
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const contentType = request.headers["content-type"] || "";
    let body;
    if (raw.length && /multipart\/form-data|application\/x-www-form-urlencoded/.test(contentType)) {
      body = Object.fromEntries(await new Response(raw, { headers: { "Content-Type": contentType } }).formData());
    } else body = raw.length ? JSON.parse(raw.toString()) : undefined;
    requests.push({ method: request.method, path, query: Object.fromEntries(url.searchParams), body, cookie: request.headers.cookie });
    const send = (status, data) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(data));
    };
    if (request.headers.cookie !== "zentaosid=test-session") {
      return send(401, { error: "unauthorized" });
    }
    const commentRoute = url.pathname.match(/^\/zentao\/index\.php\/action-comment-task-(\d+)\.json$/);
    if (commentRoute && request.method === "POST") {
      const taskId = Number(commentRoute[1]);
      const record = records.tasks.get(taskId);
      if (!record) return send(404, { error: "not found" });
      if (record.commentDenied) return send(403, { error: "无备注权限" });
      assert.deepEqual(Object.keys(body), ["comment"]);
      const actionId = nextId++;
      if (!record.commentNoSave) record.actions.push({ id: actionId, objectType: "task", objectID: taskId, action: "commented", comment: body.comment });
      return send(200, { status: "success", data: JSON.stringify(actionId) });
    }
    const nativeRoute = url.pathname.match(/^\/zentao\/index\.php\/(project|execution|task)-(team|manageMembers|edit|close|finish)-(\d+)\.json$/);
    if (nativeRoute) {
      const [, module, action, rawId] = nativeRoute;
      const objectId = Number(rawId);
      if (objectId === 999) { response.writeHead(200, { "Content-Type": "text/html" }); return response.end('<form id="loginForm">login</form>'); }
      if (module === "task" && action === "finish") {
        const record = records.tasks.get(objectId);
        if (!record) return send(404, { error: "not found" });
        if (request.method === "GET") return send(200, { status: "success", data: JSON.stringify({ task: record }) });
        assert.equal(body.status, "done");
        assert.equal(Number(body.currentConsumed) > 0, true);
        Object.assign(record, { status: "done", left: 0, consumed: Number(body.consumed), assignedTo: body.assignedTo,
          realStarted: body.realStarted, finishedDate: body.finishedDate, finishedBy: "owner" });
        record.actions.push({ id: nextId++, objectType: "task", objectID: objectId, action: "finished", comment: body.comment });
        return send(200, { result: "success" });
      }
      if (["project", "execution", "task"].includes(module) && action === "close") {
        const record = records[`${module}s`].get(objectId);
        if (!record) return send(404, { error: "not found" });
        if (record.closeUnauthorized) return send(403, { error: "无关闭权限" });
        if (request.method === "GET") return send(200, { status: "success", data: JSON.stringify({ [module]: record }) });
        if (module === "task") {
          assert.equal(body.status, "closed");
          Object.assign(record, { closedReason: record.status === "cancel" ? "cancel" : "done", status: body.status });
        }
        else {
          if (record.closeDenied) return send(200, { result: "fail", message: `服务端不允许关闭此${module === "project" ? "项目" : "执行"}` });
          if (!record.closeNoSave) Object.assign(record, { status: body.status, realEnd: body.realEnd });
        }
        response.writeHead(200, { "Content-Type": "text/html" });
        return response.end('<script>parent.location.reload();</script>');
      }
      if (["project", "execution"].includes(module) && action === "team") {
        const teamMembers = teams.get(`${module}:${objectId}`) ?? [];
        return send(200, { status: "success", data: JSON.stringify({ projectID: objectId, execution: { id: objectId }, teamMembers }) });
      }
      if (["project", "execution"].includes(module) && action === "manageMembers" && request.method === "POST") {
        const saved = [];
        for (let index = 0; body[`accounts[${index}]`] !== undefined; index++) {
          saved.push({ account: body[`accounts[${index}]`], role: body[`roles[${index}]`], days: Number(body[`days[${index}]`]), hours: Number(body[`hours[${index}]`]), limited: body[`limited[${index}]`] });
        }
        teams.set(`${module}:${objectId}`, saved);
        response.writeHead(200, { "Content-Type": "text/html" });
        return response.end('<script>parent.location="team";</script>');
      }
      if (module === "project" && action === "edit") {
        const record = records.projects.get(objectId);
        if (!record) return send(404, { error: "not found" });
        if (request.method === "GET") return send(200, { status: "success", data: JSON.stringify({ project: record, linkedProducts: { 7: { id: 7, type: "normal" } } }) });
        assert.equal(body["products[]"], "7");
        assert.equal(body.desc, "原描述");
        assert.equal(body.PM, "owner");
        Object.assign(record, { budget: body.budget, days: Number(body.days), auth: body.auth });
        return send(200, { result: "success" });
      }
      if (module === "task" && action === "edit") {
        const record = records.tasks.get(objectId);
        if (!record) return send(404, { error: "not found" });
        if (request.method === "GET") return send(200, { status: "success", data: JSON.stringify({ task: record }) });
        const file = body["files[]"];
        assert.equal(file.name, "立项单.pdf");
        assert.equal(await file.text(), "%PDF-1.4\nmock attachment\n");
        for (const key of ["name", "type", "desc", "status", "assignedTo", "estimate", "left", "consumed", "realStarted"]) assert.equal(String(body[key]), String(record[key]));
        const fileId = nextId++;
        record.files[fileId] = { id: fileId, title: file.name, size: file.size, objectType: "task", objectID: objectId };
        response.writeHead(200, { "Content-Type": "text/html" });
        return response.end('<script>parent.location="task-view";</script>');
      }
      return send(404, { error: "unsupported native route" });
    }
    const lists = {
      "/products": ["products", 1], "/projects": ["projects", 101],
      "/executions": ["executions", 2159], "/projects/121/executions": ["executions", 2159],
      "/products/1/stories": ["stories", 301], "/products/1/bugs": ["bugs", 501],
      "/executions/2159/tasks": ["tasks", 6866],
    };
    const executionTasks = path.match(/^\/executions\/(\d+)\/tasks$/);
    if (request.method === "GET" && executionTasks && records.executions.has(Number(executionTasks[1]))) {
      const rows = [...records.tasks.values()].filter(task => task.execution === Number(executionTasks[1]));
      const page = Number(url.searchParams.get("page") || 1);
      const limit = Number(url.searchParams.get("limit") || 20);
      return send(200, { page, limit, total: rows.length, tasks: rows.slice((page - 1) * limit, page * limit) });
    }
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
    const executionParent = path.match(/^\/projects\/(\d+)\/executions$/);
    if (bugParent) { collection = "bugs"; parent = { product: Number(bugParent[1]) }; }
    if (taskParent) { collection = "tasks"; parent = { execution: Number(taskParent[1]) }; }
    if (executionParent) { collection = "executions"; parent = { project: Number(executionParent[1]), type: "sprint" }; }
    if (request.method === "POST" && collection) {
      const record = { id: nextId++, ...(collection === "bugs" ? { status: "active" } : {}), ...parent, ...body };
      if (collection === "projects") record.type = "project";
      if (collection === "tasks") Object.assign(record, { status: "wait", desc: "", mode: "", team: [], parent: 0, pri: 3, estimate: 0, left: 0, consumed: 0, story: 0, module: 0, realStarted: "0000-00-00 00:00:00", files: {}, ...body, assignedTo: body.assignedTo[0] });
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
    const single = path.match(/^\/(products|projects|executions|stories|bugs|tasks)\/(\d+)$/);
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
  child.on("error", (error) => { if (error.code !== "ABORT_ERR") console.error(error.code); });
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
  if (attachmentPath) await unlink(attachmentPath);
  if (fixtureDirectory) await rmdir(fixtureDirectory);
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
  assert.deepEqual(requests.at(-1).query, { page: "2", limit: "2", status: "all" });
});

test("列表非法分页和范围ID不发送HTTP请求", async () => {
  const beforeCount = requests.length;
  for (const [name, args] of [
    ["get_products", { page: 0 }], ["get_projects", { page: 1.5 }],
    ["get_executions", { limit: 0 }], ["get_executions", { limit: 101 }],
    ["get_executions", { status: null }], ["get_executions", { status: "deleted" }],
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
    assert.deepEqual(createRequest.body, tool === "task" ? { ...data, assignedTo: [data.assignedTo] } : data);
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

test("执行通过MCP创建、详情、修改及回读，保留未指定负责人", async () => {
  const data = { name: "新执行", code: "order-3", begin: "2026-11-13", end: "2026-11-26", days: 10, products: [7], PM: "" };
  const created = await call("create_execution", { projectId: 20, data });
  assert.equal(created.project, 20);
  assert.equal(created.PM, "");
  assert.equal(requests.at(-1).path, "/projects/20/executions");
  await call("update_execution", { executionId: created.id, data: { desc: "执行说明", end: "2026-11-27" } });
  const saved = await call("get_execution", { executionId: created.id });
  assert.equal(saved.desc, "执行说明");
  assert.equal(saved.end, "2026-11-27");
  assert.equal(saved.begin, data.begin);
});

test("任务描述、空开始日期与未指派通过MCP保存及回读", async () => {
  const created = await call("create_task", { executionId: 2159, data: { name: "待排期", type: "devel", desc: "非标编号 1119" } });
  assert.equal(created.assignedTo, "");
  assert.equal(created.estStarted, "");
  assert.deepEqual(requests.at(-1).body.assignedTo, [""]);
  await call("update_task", { taskId: created.id, data: { desc: "非标编号 1119\n需求内容", estStarted: "", assignedTo: "" } });
  const saved = await call("get_task", { taskId: created.id });
  assert.equal(saved.desc, "非标编号 1119\n需求内容");
  assert.equal(saved.assignedTo, "");
  assert.equal(saved.estStarted, "");
});

test("项目预算工作日和继承权限通过专用MCP维护并保留产品及其他字段", async () => {
  const args = { projectId: 30, data: { budget: 10500, days: 15, auth: "extend" } };
  const beforeWrites = requests.filter(item => item.method !== "GET").length;
  assert.equal((await call("update_project_settings", args)).written, false);
  assert.equal(requests.filter(item => item.method !== "GET").length, beforeWrites);
  const result = await call("update_project_settings", { ...args, dryRun: false });
  assert.equal(result.verified, true);
  const saved = await call("get_project", { projectId: 30 });
  assert.equal(saved.budget, "10500");
  assert.equal(saved.days, 15);
  assert.equal(saved.auth, "extend");
  assert.equal(saved.desc, "原描述");
  assert.equal(saved.PM, "owner");
});

test("团队复制默认只预览，确认复制保留目标成员和角色并按目标天数新增", async () => {
  const args = { sourceType: "project", sourceId: 10, targetType: "project", targetId: 20 };
  const beforeWrites = requests.filter((item) => item.method !== "GET").length;
  const preview = await call("copy_team", args);
  assert.equal(preview.dryRun, true);
  assert.equal(preview.written, false);
  assert.deepEqual(preview.added, ["bob"]);
  assert.equal(requests.filter((item) => item.method !== "GET").length, beforeWrites);
  const saved = await call("copy_team", { ...args, dryRun: false });
  assert.equal(saved.verified, true);
  assert.equal(saved.team.members.find((item) => item.account === "alice").role, "负责人");
  assert.equal(saved.team.members.find((item) => item.account === "bob").days, 5);
  const read = await call("get_project_team", { projectId: 20 });
  assert.equal(read.count, 2);
  const afterWrites = requests.filter((item) => item.method !== "GET").length;
  assert.equal((await call("copy_team", { ...args, dryRun: false })).written, false);
  assert.equal(requests.filter((item) => item.method !== "GET").length, afterWrites);
});

test("执行团队查询、原生登录页识别及删除参数拒绝", async () => {
  teams.set("execution:2159", [member("tester")]);
  const executionTeam = await call("get_execution_team", { executionId: 2159 });
  assert.equal(executionTeam.members[0].account, "tester");
  const login = await client.callTool({ name: "get_project_team", arguments: { projectId: 999 } });
  assert.equal(login.isError, true);
  assert.match(login.content[0].text, /不是JSON/);
  const count = requests.length;
  const invalid = await client.callTool({ name: "copy_team", arguments: { sourceType: "project", sourceId: 10, targetType: "project", targetId: 20, remove: true } });
  assert.equal(invalid.isError, true);
  assert.equal(requests.length, count);
});

test("PDF附件通过专用MCP表单上传、回读且保留描述、状态和未指派值", async () => {
  const created = await call("create_task", { executionId: 2159, data: { name: "附件任务", type: "test", desc: "非标编号 1119", estimate: 40 } });
  const writes = requests.filter((item) => item.method !== "GET").length;
  const preview = await call("upload_task_attachment", { taskId: created.id, filePath: attachmentPath });
  assert.equal(preview.uploadable, true);
  assert.equal(preview.dryRun, true);
  assert.equal(requests.filter((item) => item.method !== "GET").length, writes);
  const uploaded = await call("upload_task_attachment", { taskId: created.id, filePath: attachmentPath, dryRun: false });
  assert.equal(uploaded.verified, true);
  assert.equal(uploaded.file.objectID, created.id);
  const saved = await call("get_task", { taskId: created.id });
  assert.equal(saved.desc, created.desc);
  assert.equal(saved.status, "wait");
  assert.equal(saved.assignedTo, "");
  assert.equal(Object.keys(saved.files).length, 1);
});

test("附件不修改多人、父子和已结束任务，预检查失败不发送POST", async () => {
  const created = await call("create_task", { executionId: 2159, data: { name: "受限附件任务", type: "test" } });
  const record = records.tasks.get(created.id);
  const writes = requests.filter((item) => item.method !== "GET").length;
  for (const patch of [{ mode: "multi" }, { mode: "", parent: 1 }, { parent: 0, status: "done" }]) {
    Object.assign(record, patch);
    const reply = await client.callTool({ name: "upload_task_attachment", arguments: { taskId: record.id, filePath: attachmentPath, dryRun: false } });
    assert.equal(reply.isError, true);
  }
  assert.equal(requests.filter((item) => item.method !== "GET").length, writes);
});

test("MCP关闭执行不查询或修改任务，未完成任务的处理策略由调用方决定", async () => {
  records.executions.set(8001, { id: 8001, project: 20, type: "sprint", name: "通用执行", status: "doing", realEnd: null, deleted: false });
  records.tasks.set(9000, { id: 9000, execution: 8001, status: "done", deleted: false });
  records.tasks.set(9100, { id: 9100, execution: 8001, status: "wait", deleted: false });
  const args = { executionId: 8001, realEnd: "2026-11-13" };
  const start = requests.length;
  const preview = await call("close_execution", args);
  assert.equal(preview.dryRun, true);
  assert.equal(preview.written, false);
  const result = await call("close_execution", { ...args, dryRun: false });
  assert.equal(result.verified, true);
  assert.equal(result.execution.status, "closed");
  assert.equal(result.execution.realEnd, args.realEnd);
  assert.equal(records.tasks.get(9000).status, "done");
  assert.equal(records.tasks.get(9100).status, "wait");
  const trace = requests.slice(start);
  assert.equal(trace.some(item => item.path.includes("/tasks") || item.path.includes("task-close")), false);
  assert.deepEqual(trace.filter(item => item.method === "POST").map(item => item.path), ["/zentao/index.php/execution-close-8001.json"]);
});

test("MCP提供独立任务关闭，关闭原因沿用服务端结果且不关闭执行", async () => {
  records.executions.set(8002, { id: 8002, project: 20, type: "sprint", name: "所属执行", status: "doing", deleted: false });
  const start = requests.length;
  for (const [taskId, status] of [[9200, "done"], [9201, "cancel"]]) {
    records.tasks.set(taskId, { id: taskId, execution: 8002, status, deleted: false });
    assert.equal((await call("close_task", { taskId })).written, false);
    const result = await call("close_task", { taskId, comment: "关闭备注", dryRun: false });
    assert.equal(result.verified, true);
    assert.equal(result.task.status, "closed");
    assert.equal(result.task.closedReason, status === "cancel" ? "cancel" : "done");
  }
  assert.equal(records.executions.get(8002).status, "doing");
  assert.deepEqual(requests.slice(start).filter(item => item.method === "POST").map(item => item.path), ["/zentao/index.php/task-close-9200.json", "/zentao/index.php/task-close-9201.json"]);
});

test("空执行可以通过MCP交由服务端关闭，服务端拒绝时返回失败且不自动重试", async () => {
  for (const [executionId, closeDenied] of [[8003, false], [8004, true]]) {
    records.executions.set(executionId, { id: executionId, project: 20, type: "sprint", name: "空执行", status: "wait", realEnd: null, deleted: false, closeDenied });
    const start = requests.length;
    const result = await client.callTool({ name: "close_execution", arguments: { executionId, realEnd: "2026-11-13", dryRun: false } });
    assert.equal(result.isError ?? false, closeDenied);
    assert.equal(records.executions.get(executionId).status, closeDenied ? "wait" : "closed");
    assert.equal(requests.slice(start).filter(item => item.method === "POST").length, 1);
    if (closeDenied) assert.match(result.content[0].text, /服务端不允许关闭此执行/);
  }
});

test("MCP暴露独立项目关闭，默认预览并保存回读，不查询或关闭执行与任务", async () => {
  const schema = (await client.listTools()).tools.find(tool => tool.name === "close_project").inputSchema;
  assert.deepEqual(schema.required, ["projectId", "realEnd"]);
  assert.equal(schema.properties.dryRun.default, true);
  assert.equal(schema.additionalProperties, false);
  records.projects.set(9300, { id: 9300, type: "project", project: 0, parent: 9, name: "通用项目", status: "doing", realEnd: null, budget: "100", PM: "owner", deleted: false });
  records.executions.set(8300, { id: 8300, project: 9300, type: "sprint", status: "doing", deleted: false });
  records.tasks.set(9400, { id: 9400, execution: 8300, status: "wait", deleted: false });
  const args = { projectId: 9300, realEnd: "2026-11-13" };
  const start = requests.length;
  const preview = await call("close_project", args);
  assert.equal(preview.dryRun, true);
  assert.equal(preview.written, false);
  assert.equal(requests.slice(start).some(item => item.method === "POST"), false);
  const result = await call("close_project", { ...args, comment: "交付关闭", dryRun: false });
  assert.equal(result.verified, true);
  const saved = await call("get_project", { projectId: 9300 });
  assert.equal(saved.status, "closed");
  assert.equal(saved.realEnd, args.realEnd);
  assert.equal(saved.parent, 9);
  assert.equal(saved.budget, "100");
  assert.equal(saved.PM, "owner");
  assert.equal(records.executions.get(8300).status, "doing");
  assert.equal(records.tasks.get(9400).status, "wait");
  const trace = requests.slice(start);
  assert.equal(trace.some(item => /execution|task/.test(item.path)), false);
  const writes = trace.filter(item => item.method === "POST");
  assert.deepEqual(writes.map(item => item.path), ["/zentao/index.php/project-close-9300.json"]);
  assert.deepEqual(writes[0].body, { status: "closed", comment: "交付关闭", realEnd: args.realEnd });
  const repeated = await call("close_project", { ...args, realEnd: "2026-11-12", dryRun: false });
  assert.equal(repeated.alreadyClosed, true);
  assert.equal(repeated.written, false);
  assert.equal(repeated.project.realEnd, args.realEnd);
  assert.equal(requests.slice(start).filter(item => item.method === "POST").length, 1);
});

test("MCP项目关闭的权限拒绝、业务拒绝及保存失败均如实失败且不重试", async () => {
  for (const [projectId, flags, expectedPosts, message] of [
    [9301, { closeUnauthorized: true }, 0, /403/],
    [9302, { closeDenied: true }, 1, /服务端不允许关闭此项目/],
    [9303, { closeNoSave: true }, 1, /回读不一致/],
  ]) {
    records.projects.set(projectId, { id: projectId, type: "project", parent: 9, name: "失败项目", status: "doing", realEnd: null, deleted: false, ...flags });
    const start = requests.length;
    const response = await client.callTool({ name: "close_project", arguments: { projectId, realEnd: "2026-11-13", dryRun: false } });
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, message);
    assert.equal(records.projects.get(projectId).status, "doing");
    assert.equal(requests.slice(start).filter(item => item.method === "POST").length, expectedPosts);
  }
});

test("MCP项目关闭在发送请求前拒绝非法日期和越界字段", async () => {
  const beforeCount = requests.length;
  for (const args of [
    { projectId: 9300 },
    { projectId: 9300, realEnd: "2026-02-30" },
    { projectId: 9300, realEnd: "2026-11-13", deleted: true },
    { projectId: "9300/delete", realEnd: "2026-11-13" },
  ]) {
    assert.equal((await client.callTool({ name: "close_project", arguments: args })).isError, true);
  }
  assert.equal(requests.length, beforeCount);
});


test("Bug指派通过MCP创建、修改、清空并读回，状态和原字段保持不变", async () => {
  const data = { title: "指派集成用例", severity: 2, pri: 2, type: "codeerror", assignedTo: "developer" };
  const created = await call("create_bug", { productId: 1, data });
  assert.equal(created.assignedTo, "developer");
  for (const assignedTo of ["reviewer", ""]) {
    await call("update_bug", { bugId: created.id, data: { assignedTo } });
    assert.deepEqual(requests.at(-1).body, { assignedTo, title: data.title, severity: data.severity, pri: data.pri, type: data.type });
    const saved = await call("get_bug", { bugId: created.id });
    assert.equal(saved.assignedTo, assignedTo);
    assert.equal(saved.status, "active");
    assert.equal(saved.title, data.title);
  }
});


test("任务备注工具经stdio发现、预览和固定原生路由追加，不修改描述及状态", async () => {
  const schema = (await client.listTools()).tools.find(tool => tool.name === "add_task_comment").inputSchema;
  assert.deepEqual(schema.required, ["taskId", "comment"]);
  const record = { id: 9700, name: "备注集成任务", type: "devel", status: "wait", desc: "原需求描述", assignedTo: "owner", deleted: false, actions: [] };
  records.tasks.set(record.id, record);
  const start = requests.length;
  assert.equal((await call("add_task_comment", { taskId: record.id, comment: "需求确认\n仅追加备注" })).written, false);
  assert.equal(requests.slice(start).some(item => item.method !== "GET"), false);
  const saved = await call("add_task_comment", { taskId: record.id, comment: "需求确认\n仅追加备注", dryRun: false });
  assert.equal(saved.verified, true);
  assert.equal(saved.action.comment, "需求确认<br />仅追加备注");
  const writes = requests.slice(start).filter(item => item.method !== "GET");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, "/zentao/index.php/action-comment-task-9700.json");
  assert.deepEqual(writes[0].body, { comment: "需求确认<br />仅追加备注" });
  assert.equal(record.desc, "原需求描述");
  assert.equal(record.status, "wait");
  assert.equal(record.assignedTo, "owner");
});

test("备注无权限或回读未落库经stdio返回失败且不重复POST", async () => {
  for (const [taskId, flag] of [[9701, "commentDenied"], [9702, "commentNoSave"]]) {
    records.tasks.set(taskId, { id: taskId, name: "备注失败任务", status: "wait", desc: "原描述", deleted: false, actions: [], [flag]: true });
    const start = requests.length;
    const reply = await client.callTool({ name: "add_task_comment", arguments: { taskId, comment: "确认说明", dryRun: false } });
    assert.equal(reply.isError, true);
    assert.match(reply.content[0].text, /不要盲目重试/);
    assert.equal(requests.slice(start).filter(item => item.method === "POST").length, 1);
  }
});

test("MCP完成任务使用独立原生工作流、累计工时并保留详情和所属执行", async () => {
  const schema = (await client.listTools()).tools.find(tool => tool.name === "finish_task").inputSchema;
  assert.equal(schema.additionalProperties, false);
  records.executions.set(9800, { id: 9800, project: 20, type: "sprint", status: "doing", deleted: false });
  records.tasks.set(9801, { id: 9801, name: "完成任务", type: "devel", project: 20, execution: 9800, status: "wait",
    desc: "原始业务需求及截图", consumed: 2, left: 1, estimate: 3, assignedTo: { account: "owner" },
    parent: 0, mode: "", team: [], children: [], actions: [], deleted: false });
  const input = { taskId: 9801, currentConsumed: 1.5, realStarted: "2026-11-23 09:00:00", finishedDate: "2026-11-23 10:30:00",
    comment: "后端 & 管理端\n分支：feature-test\n提交：abc123" };
  const start = requests.length;
  assert.equal((await call("finish_task", input)).written, false);
  assert.equal(requests.slice(start).some(item => item.method === "POST"), false);
  const result = await call("finish_task", { ...input, dryRun: false });
  assert.equal(result.verified, true);
  assert.equal(result.task.status, "done");
  assert.equal(result.task.consumed, 3.5);
  assert.equal(result.task.left, 0);
  assert.equal(result.task.desc, "原始业务需求及截图");
  assert.equal(result.task.realStarted, input.realStarted);
  assert.equal(result.task.finishedDate, input.finishedDate);
  assert.equal(result.action.action, "finished");
  assert.equal(records.executions.get(9800).status, "doing");
  const writes = requests.slice(start).filter(item => item.method !== "GET");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, "/zentao/index.php/task-finish-9801.json");
  assert.equal(writes[0].body.comment, "后端 &amp; 管理端<br />分支：feature-test<br />提交：abc123");
  assert.equal(Object.hasOwn(writes[0].body, "desc"), false);
});
