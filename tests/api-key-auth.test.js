import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { apiKeyTools, apiKeyInvocation, validateApiKeyConfig } from "../src/api-key-tools.js";

const sample = [{ name: "get_task", inputSchema: { properties: { taskId: { type: "integer" } }, required: ["taskId"] } }];
test("API Key入口只公布已有业务工具，不包含配置和任意路由", () => {
  assert.deepEqual(apiKeyTools(sample)[1].inputSchema.properties.tool.enum, ["get_task"]);
  assert.deepEqual(apiKeyInvocation({ tool: "get_task", arguments: { taskId: 42 } }, sample), { name: "get_task", args: { taskId: 42 } });
});
test("API Key配置拒绝空密钥、换行、非HTTP地址、URL凭据和额外参数", () => {
  const good = { url: "http://127.0.0.1/zentao", appKey: "fake-key" };
  assert.deepEqual(validateApiKeyConfig(good), good);
  for (const input of [null, [], {}, { ...good, appKey: "" }, { ...good, appKey: "  " }, { ...good, appKey: "bad\r\nkey" },
    { ...good, url: "file:///tmp" }, { ...good, url: "http://user:pass@localhost" }, { ...good, url: "http://localhost?token=x" },
    { ...good, url: "http://localhost#x" }, { ...good, zentaosid: "x" }]) assert.throws(() => validateApiKeyConfig(input));
});
test("API Key调用在请求前拒绝未知工具、嵌套调用、非法ID和额外参数", () => {
  for (const input of [null, [], {}, { tool: "configure", arguments: {} }, { tool: "delete_task", arguments: {} },
    { tool: "call_api_key_tool", arguments: {} }, { tool: "get_task", arguments: [] }, { tool: "get_task", arguments: {} },
    { tool: "get_task", arguments: { taskId: "1/delete" } }, { tool: "get_task", arguments: { taskId: 0 } },
    { tool: "get_task", arguments: { taskId: 1, deleted: true } }, { tool: "get_task", arguments: { taskId: 1 }, path: "/any" }]) {
    assert.throws(() => apiKeyInvocation(input, sample));
  }
});

let api, client, transport, child, port;
const requests = [];
let task, product;
const key = "fake-app-key";
const sid = "fake-browser-session";
const data = result => { assert.equal(result.isError ?? false, false, result.content[0].text); return JSON.parse(result.content[0].text); };
const invoke = (tool, args) => client.callTool({ name: "call_api_key_tool", arguments: { tool, arguments: args } });

before(async () => {
  task = { id: 42, name: "测试任务", type: "devel", project: 3, execution: 4, status: "wait", deleted: false,
    parent: 0, mode: "", team: [], children: [], desc: "原业务需求", assignedTo: "owner", consumed: 0, left: 2, estimate: 2, actions: [] };
  product = { id: 1, name: "原产品" };
  api = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    const body = raw ? req.headers["content-type"]?.includes("application/json") ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw)) : null;
    requests.push({ path: url.pathname, token: req.headers.token, cookie: req.headers.cookie, method: req.method, body });
    const send = (status, result) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(result)); };
    if (req.headers.token !== key && req.headers.cookie !== `zentaosid=${sid}`) return send(401, { error: `拒绝 ${req.headers.token ?? "missing"}` });
    const path = url.pathname.replace("/zentao/api.php/v1", "");
    if (path === "/products/401") return send(401, { error: `过期 ${key}` });
    if (path === "/products/403") return send(403, { error: "无权限" });
    if (path === "/products/400") return send(200, { error: "业务失败" });
    if (path === "/products/302") { res.writeHead(302, { Location: "/login" }); return res.end(); }
    if (path === "/products/999") { res.writeHead(200, { "Content-Type": "text/html" }); return res.end('<form id="loginForm">login</form>'); }
    if (path === "/user") return send(200, { id: 7, account: "owner" });
    if (path === "/tasks/42") return send(200, task);
    if (path === "/products/1") {
      if (req.method === "PUT") Object.assign(product, body);
      return send(200, product);
    }
    if (path === "/projects") {
      const page = Number(url.searchParams.get("page")); const limit = Number(url.searchParams.get("limit"));
      return send(200, { page, limit, total: 2, projects: [{ id: page, name: `项目${page}` }] });
    }
    if (url.pathname === "/zentao/index.php/task-finish-42.json") {
      assert.equal(req.headers.token, key); assert.equal(req.headers.cookie, undefined);
      if (req.method === "GET") return send(200, { status: "success", data: JSON.stringify({ task }) });
      Object.assign(task, { status: "done", consumed: Number(body.consumed), left: 0, realStarted: body.realStarted,
        finishedDate: body.finishedDate, assignedTo: body.assignedTo, finishedBy: "owner" });
      task.actions.push({ id: 10, objectType: "task", objectID: 42, action: "finished", comment: body.comment });
      return send(200, { result: "success" });
    }
    send(404, { error: "not found" });
  });
  api.listen(0, "127.0.0.1"); await once(api, "listening"); port = api.address().port;
  transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL("../src/index.js", import.meta.url))],
    env: { ZENTAO_URL: `http://127.0.0.1:${port}/zentao`, ZENTAO_SID: sid, ZENTAO_APP_KEY: key }, stderr: "ignore" });
  client = new Client({ name: "api-key-auth-test", version: "1" }, { capabilities: {} });
  await client.connect(transport); child = transport._process;
  child.on("error", error => { if (error.code !== "ABORT_ERR") console.error(error.code); });
  console.log(JSON.stringify({ purpose: "API Key MCP integration tests", pid: child.pid, testPid: process.pid,
    startedAt: new Date().toISOString(), executable: process.execPath, close: "client.close() and api.close()", mockPort: port }));
});
after(async () => {
  child ??= transport?._process;
  const closed = child && child.exitCode === null && child.signalCode === null ? new Promise(resolve => child.once("close", resolve)) : Promise.resolve();
  await client?.close(); await closed;
  if (api?.listening) await new Promise((resolve, reject) => api.close(error => error ? reject(error) : resolve()));
  if (port) await new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.on("connect", () => { socket.destroy(); reject(new Error("模拟端口未释放")); });
    socket.on("error", error => error.code === "ECONNREFUSED" ? resolve() : reject(error));
  });
  console.log(JSON.stringify({ cleanup: true, childExited: !child || child.exitCode !== null || child.signalCode !== null, mockPortReleased: !api?.listening }));
});
test("stdio发现独立API Key能力及原有工具", async () => {
  const names = (await client.listTools()).tools.map(tool => tool.name);
  for (const name of ["configure", "get_task", "configure_api_key", "call_api_key_tool"]) assert.ok(names.includes(name));
});
test("API Key使用Token而不发送SID，原工具同时维持Cookie认证", async () => {
  const start = requests.length;
  const result = await Promise.all([invoke("get_task", { taskId: 42 }), client.callTool({ name: "get_task", arguments: { taskId: 42 } })]);
  assert.equal(data(result[0]).id, 42); assert.equal(data(result[1]).id, 42);
  const calls = requests.slice(start);
  assert.equal(calls.filter(req => req.token === key && req.cookie === undefined).length, 1);
  assert.equal(calls.filter(req => req.cookie === `zentaosid=${sid}` && req.token === undefined).length, 1);
});
test("API Key保留原业务分页、写入和回读行为", async () => {
  assert.equal(data(await invoke("get_projects", { page: 2, limit: 1 })).projects[0].id, 2);
  assert.equal(data(await invoke("update_product", { productId: 1, data: { name: "新产品" } })).name, "新产品");
  assert.equal(data(await invoke("get_product", { productId: 1 })).name, "新产品");
});
test("API Key正式完成任务先核对身份再走原生表单，并验证完成记录", async () => {
  const args = { taskId: 42, currentConsumed: 1.5, realStarted: "2026-11-26 09:00:00", finishedDate: "2026-11-26 10:30:00", comment: "已完成" };
  const start = requests.length;
  assert.equal(data(await invoke("finish_task", args)).written, false);
  assert.equal(requests.slice(start).some(req => req.method === "POST"), false);
  const result = data(await invoke("finish_task", { ...args, dryRun: false }));
  assert.equal(result.verified, true); assert.equal(result.task.status, "done");
  assert.equal(result.task.desc, "原业务需求"); assert.equal(result.task.consumed, 1.5);
  const calls = requests.slice(start);
  const nativeIndex = calls.findIndex(req => req.path.includes("index.php"));
  assert.ok(calls.slice(0, nativeIndex).some(req => req.path.endsWith("/user")));
  assert.equal(calls.filter(req => req.method === "POST").length, 1);
});
for (const [id, expected] of [[401, /401/], [403, /403/], [400, /业务/], [302, /302/], [999, /不是JSON/]]) {
  test(`API Key异常${id}如实失败、不重试、不泄露密钥`, async () => {
    const start = requests.length; const result = await invoke("get_product", { productId: id });
    assert.equal(result.isError, true); assert.match(result.content[0].text, expected);
    assert.equal(result.content[0].text.includes(key), false); assert.equal(requests.length - start, 1);
  });
}
test("非法调用和密钥配置在stdio链路中不发送请求", async () => {
  const start = requests.length;
  for (const tool of ["delete_task", "configure", "call_api_key_tool"]) assert.equal((await invoke(tool, {})).isError, true);
  assert.equal((await invoke("get_task", { taskId: "42/delete" })).isError, true);
  assert.equal((await client.callTool({ name: "configure_api_key", arguments: { url: "http://localhost", appKey: "" } })).isError, true);
  assert.equal(requests.length, start);
});
test("独立配置互不覆盖，错误API Key不回退SID", async () => {
  const url = `http://127.0.0.1:${port}/zentao`;
  await client.callTool({ name: "configure_api_key", arguments: { url, appKey: "bad-key" } });
  const failed = await invoke("get_task", { taskId: 42 });
  assert.equal(failed.isError, true); assert.equal(failed.content[0].text.includes("bad-key"), false);
  assert.equal(data(await client.callTool({ name: "get_task", arguments: { taskId: 42 } })).id, 42);
  await client.callTool({ name: "configure_api_key", arguments: { url, appKey: key } });
  await client.callTool({ name: "configure", arguments: { url, zentaosid: "bad-session" } });
  assert.equal(data(await invoke("get_task", { taskId: 42 })).id, 42);
  assert.equal((await client.callTool({ name: "get_task", arguments: { taskId: 42 } })).isError, true);
});


test("缺少API Key时不发送HTTP请求，也不回退已配置SID", async () => {
  const start = requests.length;
  const emptyTransport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL("../src/index.js", import.meta.url))],
    env: { ZENTAO_URL: `http://127.0.0.1:${port}/zentao`, ZENTAO_SID: sid, ZENTAO_APP_KEY: "" }, stderr: "ignore" });
  const emptyClient = new Client({ name: "missing-api-key-test", version: "1" }, { capabilities: {} });
  let childProcess;
  try {
    await emptyClient.connect(emptyTransport); childProcess = emptyTransport._process;
    childProcess.on("error", error => { if (error.code !== "ABORT_ERR") console.error(error.code); });
    console.log(JSON.stringify({ purpose: "Missing API Key MCP test", pid: childProcess.pid, startedAt: new Date().toISOString(), close: "emptyClient.close()" }));
    const result = await emptyClient.callTool({ name: "call_api_key_tool", arguments: { tool: "get_task", arguments: { taskId: 42 } } });
    assert.equal(result.isError, true); assert.match(result.content[0].text, /请先配置 API Key/);
    assert.equal(requests.length, start);
  } finally {
    childProcess ??= emptyTransport._process;
    const closed = childProcess && childProcess.exitCode === null && childProcess.signalCode === null ? new Promise(resolve => childProcess.once("close", resolve)) : Promise.resolve();
    await emptyClient.close(); await closed;
    assert.ok(!childProcess || childProcess.exitCode !== null || childProcess.signalCode !== null);
  }
});
