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
];

for (const [description, name, args] of invalid) {
  test(`${description}在发送HTTP请求前被拒绝`, async () => {
    let requests = 0;
    await assert.rejects(callWriteTool(name, args, async () => { requests++; }));
    assert.equal(requests, 0);
  });
}

test("仅暴露明确的新建修改工具，不接受删除或原型属性作为工具", async () => {
  assert.equal(writeTools.length, 11);
  for (const tool of writeTools) {
    assert.match(tool.name, /^(create|update|change)_/);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.inputSchema.properties.data.additionalProperties, false);
  }
  assert.equal(isWriteTool("delete_task"), false);
  assert.equal(isWriteTool("toString"), false);
  await assert.rejects(callWriteTool("delete_task", { taskId: 1 }, async () => assert.fail("不能发送请求")));
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
