import assert from "node:assert/strict";
import { test } from "node:test";
import { callListTool, isListTool } from "../src/list-tools.js";

test("完整产品集合在MCP端分页且不丢失原响应字段", async () => {
  let endpoint;
  const result = await callListTool("get_products", { page: 2, limit: 2 }, async (path) => {
    endpoint = path;
    return { total: 3, products: [{ id: 1 }, { id: 2 }, { id: 3 }], marker: "保留原字段" };
  });
  assert.equal(endpoint, "/products?page=2&limit=2");
  assert.deepEqual(result.products, [{ id: 3 }]);
  assert.deepEqual([result.page, result.limit, result.total, result.totalPages, result.count, result.hasNext, result.nextPage], [2, 2, 3, 2, 1, false, null]);
  assert.equal(result.marker, "保留原字段");
});

test("旧产品接口没有total时使用其完整集合长度", async () => {
  const result = await callListTool("get_products", {}, async () => ({ products: [{ id: 1 }] }));
  assert.equal(result.total, 1);
  assert.equal(result.page, 1);
  assert.equal(result.limit, 20);
});

test("原生分页支持数字字符串元数据并按实际请求生成下一页", async () => {
  const result = await callListTool("get_projects", { page: 2, limit: 2 }, async () => ({
    page: "2", limit: "2", total: "5", projects: [{ id: 3 }, { id: 4 }],
  }));
  assert.equal(result.total, 5);
  assert.equal(result.totalPages, 3);
  assert.equal(result.hasNext, true);
  assert.equal(result.nextPage, 3);
});

test("空集合返回零总页数，越界页不误返回服务端钳制的末页", async () => {
  const empty = await callListTool("get_bugs", { productId: 1 }, async () => ({ total: 0, bugs: [] }));
  assert.equal(empty.totalPages, 0);
  assert.equal(empty.count, 0);
  assert.equal(empty.nextPage, null);
  const beyond = await callListTool("get_projects", { page: 4, limit: 2 }, async () => ({
    page: 2, limit: 2, total: 3, projects: [{ id: 3 }],
  }));
  assert.equal(beyond.page, 4);
  assert.deepEqual(beyond.projects, []);
  assert.equal(beyond.hasNext, false);
});

const invalidResponses = [
  ["截断集合缺少分页信息", { total: 5, projects: [{ id: 1 }] }],
  ["服务端忽略页码", { total: 5, page: 1, limit: 2, projects: [{ id: 1 }, { id: 2 }] }],
  ["服务端忽略每页数量", { total: 100, page: 2, limit: 20, projects: Array.from({ length: 20 }, (_, id) => ({ id })) }],
  ["列表长度超过总数", { total: 0, projects: [{ id: 1 }] }],
  ["没有实体数组", { total: 0 }],
  ["原生分页缺少总数", { page: 2, limit: 2, projects: [{ id: 3 }] }],
  ["总数非法", { total: "unknown", page: 2, limit: 2, projects: [{ id: 3 }] }],
];
for (const [description, response] of invalidResponses) {
  test(`${description}时拒绝伪造分页信息`, async () => {
    await assert.rejects(callListTool("get_projects", { page: 2, limit: 2 }, async () => response));
  });
}

test("显式null、未知参数、缺失范围和伪造工具均不发送请求", async () => {
  let requests = 0;
  const request = async () => { requests++; };
  for (const [name, args] of [
    ["get_products", { page: null }], ["get_projects", { limit: null }],
    ["get_products", { deleted: 1 }], ["get_requirements", {}],
    ["get_tasks", { projectId: 121 }], ["get_executions", { projectId: "1" }],
    ["toString", {}],
  ]) await assert.rejects(callListTool(name, args, request));
  assert.equal(requests, 0);
  assert.equal(isListTool("delete_products"), false);
  assert.equal(isListTool("toString"), false);
});
