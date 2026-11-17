import assert from "node:assert/strict";
import { test } from "node:test";
import { callWriteTool, isWriteTool, writeTools } from "../src/write-tools.js";

const invalid = [
  ["缺少新建产品必填字段", "create_product", { data: { name: "产品" } }],
  ["空修改", "update_task", { taskId: 1, data: {} }],
  ["非法ID", "update_task", { taskId: -1, data: { name: "任务" } }],
  ["ID不能注入路径", "update_bug", { bugId: "1/delete", data: { steps: "步骤" } }],
  ["未知顶层参数", "update_product", { productId: 1, method: "DELETE", data: { name: "产品" } }],
  ["软删除字段", "update_product", { productId: 1, data: { deleted: 1 } }],
  ["删除状态", "update_product", { productId: 1, data: { status: "deleted" } }],
  ["字符串不能作为优先级", "update_requirement", { storyId: 1, data: { pri: "1" } }],
  ["越界优先级", "update_requirement", { storyId: 1, data: { pri: 5 } }],
  ["负数工时", "update_task", { taskId: 1, data: { estimate: -1 } }],
  ["无效日期格式", "update_task", { taskId: 1, data: { deadline: "明天" } }],
  ["空关联产品", "create_project", { data: { name: "项目", code: "p", begin: "2026-11-12", end: "2026-12-12", products: [] } }],
  ["关联产品类型错误", "create_project", { data: { name: "项目", code: "p", begin: "2026-11-12", end: "2026-12-12", products: ["1"] } }],
  ["需求内容不能走普通编辑", "update_requirement", { storyId: 1, data: { spec: "新描述" } }],
  ["不能使用继承属性作为字段", "update_product", { productId: 1, data: JSON.parse('{"__proto__":{"deleted":1}}') }],
  ["缺少解决方案", "resolve_bug", { bugId: 1, data: { comment: "说明" } }],
  ["未知解决方案", "resolve_bug", { bugId: 1, data: { resolution: "delete" } }],
  ["重复解决缺少关联Bug", "resolve_bug", { bugId: 1, data: { resolution: "duplicate" } }],
  ["重复Bug不能指向自身", "resolve_bug", { bugId: 1, data: { resolution: "duplicate", duplicateBug: 1 } }],
  ["解决版本不能为零", "resolve_bug", { bugId: 1, data: { resolution: "fixed", resolvedBuild: 0 } }],
  ["解决版本不能为任意文本", "resolve_bug", { bugId: 1, data: { resolution: "fixed", resolvedBuild: "任意版本名" } }],
  ["解决日期格式无效", "resolve_bug", { bugId: 1, data: { resolution: "fixed", resolvedDate: "明天" } }],
  ["解决操作不能携带删除标记", "resolve_bug", { bugId: 1, data: { resolution: "fixed", deleted: 1 } }],
];

for (const [description, name, args] of invalid) {
  test(`${description}在发送HTTP请求前被拒绝`, async () => {
    let requests = 0;
    await assert.rejects(callWriteTool(name, args, async () => { requests++; }));
    assert.equal(requests, 0);
  });
}

test("仅暴露明确的新建修改工具，不接受删除或原型属性作为工具", async () => {
  assert.equal(writeTools.length, 14);
  for (const tool of writeTools) {
    assert.match(tool.name, /^(create|update|change|resolve)_/);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.inputSchema.properties.data.additionalProperties, false);
  }
  assert.equal(isWriteTool("delete_task"), false);
  assert.equal(isWriteTool("toString"), false);
  await assert.rejects(callWriteTool("delete_task", { taskId: 1 }, async () => assert.fail("不能发送请求")));
});

test("普通任务可未指派且无开始日期，保留描述并正确传给17.0创建循环", async () => {
  const args = { executionId: 1, data: { name: "开发", type: "devel", desc: "非标编号 1119" } };
  let sent;
  await callWriteTool("create_task", args, async (path, method, body) => { sent = { path, method, body }; });
  assert.deepEqual(sent, { path: "/executions/1/tasks", method: "POST", body: { ...args.data, assignedTo: [""], estStarted: "", deadline: "" } });
  assert.equal(Object.hasOwn(args.data, "assignedTo"), false);
});

test("修改任务支持清空指派及开始日期，不携带其他业务字段", async () => {
  const data = { assignedTo: "", estStarted: "", desc: "新描述" };
  await callWriteTool("update_task", { taskId: 1, data }, async (path, method, body) => {
    assert.equal(method, "PUT");
    assert.deepEqual(body, data);
  });
});

test("项目和执行拒绝空开始、非法公历日期及倒置日期，不伪造开始日期", async () => {
  for (const [name, args] of [
    ["create_execution", { projectId: 1, data: { name: "迭代", code: "e", begin: "", end: "2026-11-26", days: 5 } }],
    ["create_project", { data: { name: "项目", code: "p", begin: "", end: "2026-11-26", products: [7] } }],
    ["update_execution", { executionId: 1, data: { begin: "2026-02-30" } }],
    ["update_task", { taskId: 1, data: { estStarted: "2026-11-26", deadline: "2026-11-19" } }],
    ["update_task", { taskId: 1, data: { assignedTo: null } }],
  ]) await assert.rejects(callWriteTool(name, args, async () => assert.fail("非法参数不能发送请求")));
});

test("Bug部分修改保留必填原值且不复制删除标记或修改调用者数据", async () => {
  const args = { bugId: 10, data: { steps: "新步骤" } };
  const requests = [];
  await callWriteTool("update_bug", args, async (path, method = "GET", body) => {
    requests.push({ path, method, body });
    return method === "GET" ? { title: "原标题", severity: 2, pri: 3, type: "codeerror", deleted: "0", status: "active" } : { id: 10, ...body };
  });
  assert.equal(requests[0].method, "GET");
  assert.deepEqual(requests[1], {
    path: "/bugs/10", method: "PUT",
    body: { steps: "新步骤", title: "原标题", severity: 2, pri: 3, type: "codeerror" },
  });
  assert.deepEqual(args.data, { steps: "新步骤" });
});

test("Bug读取失败不会继续写入", async () => {
  let requests = 0;
  await assert.rejects(callWriteTool("update_bug", { bugId: 10, data: { steps: "新步骤" } }, async () => {
    requests++;
    throw new Error("403 permission denied");
  }));
  assert.equal(requests, 1);
});

test("完整Bug修改不额外读取，产品正常关闭仍属于允许的修改", async () => {
  const requests = [];
  const request = async (path, method, body) => { requests.push({ path, method, body }); return { id: 1, ...body }; };
  await callWriteTool("update_bug", { bugId: 1, data: { title: "标题", severity: 1, pri: 1, type: "codeerror" } }, request);
  await callWriteTool("update_product", { productId: 1, data: { status: "closed" } }, request);
  assert.deepEqual(requests.map((item) => item.method), ["PUT", "PUT"]);
  assert.equal(requests[1].body.status, "closed");
});

test("解决Bug接受版本ID、ID字符串或主干，不自动填充其他字段", async () => {
  for (const resolvedBuild of [8, "8", "trunk"]) {
    const requests = [];
    await callWriteTool("resolve_bug", { bugId: 10, data: { resolution: "fixed", resolvedBuild } }, async (path, method, body) => {
      requests.push({ path, method, body });
      return { id: 10, status: "resolved" };
    });
    assert.deepEqual(requests, [{ path: "/bugs/10/resolve", method: "POST", body: { resolution: "fixed", resolvedBuild } }]);
  }
});

test("解决Bug支持日期及完整时间，重复Bug使用另一对象ID", async () => {
  for (const resolvedDate of ["2026-11-12", "2026-11-12 17:09:22"]) {
    let sent;
    await callWriteTool("resolve_bug", { bugId: 10, data: { resolution: "duplicate", duplicateBug: 11, resolvedDate } }, async (path, method, body) => { sent = body; });
    assert.equal(sent.duplicateBug, 11);
    assert.equal(sent.resolvedDate, resolvedDate);
  }
});


test("Bug指派支持新建时传入账号，不改变参数类型", async () => {
  const data = { title: "指派用例", severity: 2, pri: 2, type: "codeerror", assignedTo: "developer" };
  await callWriteTool("create_bug", { productId: 1, data }, async (path, method, body) => {
    assert.equal(path, "/products/1/bugs");
    assert.equal(method, "POST");
    assert.deepEqual(body, data);
    assert.equal(typeof body.assignedTo, "string");
  });
});

test("Bug指派支持修改及清空，保留必填原值且不修改状态", async () => {
  for (const assignedTo of ["developer", ""]) {
    const data = { assignedTo };
    const requests = [];
    await callWriteTool("update_bug", { bugId: 10, data }, async (path, method = "GET", body) => {
      requests.push({ path, method, body });
      return { title: "原标题", severity: 2, pri: 3, type: "codeerror", assignedTo: "previous", status: "active" };
    });
    assert.equal(requests[0].method, "GET");
    assert.deepEqual(requests[1], { path: "/bugs/10", method: "PUT", body: { assignedTo, title: "原标题", severity: 2, pri: 3, type: "codeerror" } });
    assert.deepEqual(data, { assignedTo });
  }
  await assert.rejects(callWriteTool("update_bug", { bugId: 10, data: { assignedTo: null } }, async () => assert.fail("不能发送请求")));
  for (const name of ["create_bug", "update_bug"]) {
    assert.equal(writeTools.find(tool => tool.name === name).inputSchema.properties.data.properties.assignedTo.type, "string");
  }
});
