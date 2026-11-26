import assert from "node:assert/strict";
import { test } from "node:test";
import { createSubtask, subtaskTools } from "../src/subtask-tools.js";

const input = { parentTaskId: 42, data: { name: "业务验收测试", type: "test", assignedTo: "tester", desc: "统计与边界\n支付回归" }, dryRun: false };
function backend(options = {}) {
  const originalChild = { id: 38, parent: 42, execution: 7, name: "原开发", type: "devel", assignedTo: "owner" };
  const parent = { id: 42, execution: 7, parent: 0, mode: "", team: [], children: [originalChild], name: "原业务",
    desc: "原需求和图片", pri: 3, module: 0, story: 0, estStarted: "2026-11-20", deadline: "2026-12-04",
    status: "doing", consumed: 2, deleted: false, ...(options.parent || {}) };
  const children = new Map(parent.children?.map?.(child => [child.id, child]) || []);
  const writes = [];
  let reads = 0;
  const request = async path => {
    reads++;
    if (options.readFailure && writes.length) throw new Error("回读中断");
    const result = structuredClone(path === "/tasks/42" ? parent : children.get(Number(path.split("/").at(-1))));
    if (writes.length && path !== "/tasks/42" && options.wrongReadId) result.id = 99;
    if (writes.length && path !== "/tasks/42" && options.deletedReadback) result.deleted = true;
    return result;
  };
  const native = async (module, action, id, form, parentTaskId) => {
    assert.deepEqual([module, action, id, parentTaskId], ["task", "batchCreate", 7, 42]);
    writes.push(form);
    if (options.denied) throw new Error("403 无拆分权限");
    if (options.timeout) throw new Error("请求超时");
    if (!options.noSave) {
      const child = { id: 60, execution: 7, parent: options.wrongParent ? 99 : 42, status: "wait", deleted: false };
      for (const [key, value] of form) if (key.endsWith("[1]") && !["parent[1]", "color[1]", "vision[1]"].includes(key)) child[key.slice(0, -3)] = value;
      child.desc = child.desc.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character])
        .replace(/\r\n|\r|\n/g, "<br />\n");
      if (options.wrongUser) child.assignedTo = "other";
      children.set(child.id, child);
      parent.children.push(child);
      parent.parent = -1;
      if (options.extraClone) parent.children.push({ ...structuredClone(parent), id: 61, parent: 42, type: "devel", children: undefined });
      if (options.duplicateNew) parent.children.push({ ...child, id: 62 });
      if (options.removeOld) parent.children = parent.children.filter(item => item.id !== 38);
      if (options.changedDescription) parent.desc = "其他内容";
    }
  };
  return { parent, writes, request, native, get reads() { return reads; } };
}

test("子任务schema限定父任务、业务字段和预览，不开放任意路由或状态", () => {
  const schema = subtaskTools[0].inputSchema;
  assert.equal(subtaskTools[0].name, "create_subtask");
  assert.deepEqual(schema.required, ["parentTaskId", "data"]);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.data.additionalProperties, false);
  assert.equal(schema.properties.dryRun.default, true);
  assert.equal(Object.hasOwn(schema.properties.data.properties, "parent"), false);
  assert.equal(Object.hasOwn(schema.properties.data.properties, "status"), false);
});

test("默认仅预览，继承归属及已排日期，不编造工时或创建任务", async () => {
  const b = backend();
  const result = await createSubtask({ parentTaskId: 42, data: input.data }, b.request, b.native);
  assert.equal(result.dryRun, true);
  assert.equal(result.written, false);
  assert.equal(result.data.estimate, 0);
  assert.equal(result.data.estStarted, "2026-11-20");
  assert.equal(result.data.deadline, "2026-12-04");
  assert.equal(b.writes.length, 0);
  assert.equal(b.parent.parent, 0);
});

test("正式拆分回读父子关系、指派和描述，保留既有开发子任务", async () => {
  const b = backend();
  const result = await createSubtask(input, b.request, b.native);
  assert.equal(result.verified, true);
  assert.equal(result.written, true);
  assert.equal(result.task.id, 60);
  assert.equal(result.task.parent, 42);
  assert.equal(result.task.assignedTo, "tester");
  assert.equal(result.task.desc, "统计与边界<br />\n支付回归");
  assert.equal(b.writes.length, 1);
  assert.equal(b.writes[0].get("parent[1]"), "42");
  assert.equal(b.writes[0].get("name[1]"), input.data.name);
  assert.equal(b.writes[0].has("status"), false);
  assert.equal(b.parent.children[0].id, 38);
});

test("纯文本的特殊字符和段落经服务端转义后可正确回读及查重", async () => {
  const b = backend();
  const data = { ...input.data, desc: 'A & B < 3 > 1，"引号"与\'单引号\'\n\nMap<String> 与字面量 &lt;p&gt;' };
  const result = await createSubtask({ ...input, data }, b.request, b.native);
  assert.equal(result.verified, true);
  assert.equal(b.writes[0].get("desc[1]"), data.desc, "不要在MCP中再次转义输入");
  assert.match(result.task.desc, /A &amp; B &lt; 3 &gt; 1/);
  assert.equal((await createSubtask({ ...input, data }, b.request, b.native)).alreadyExists, true);
  assert.equal(b.writes.length, 1);
});

test("HTML排版描述在预览及写入前拒绝，避免先创建再报回读不一致", async () => {
  for (const desc of ["<p>第一段</p>\n<p>第二段</p>", "<h3>目标</h3><ul><li>验收</li></ul>", "第一行<br />第二行"]) {
    for (const dryRun of [true, false]) {
      const b = backend();
      await assert.rejects(createSubtask({ ...input, data: { ...input.data, desc }, dryRun }, b.request, b.native), /纯文本/);
      assert.equal(b.reads, 0);
      assert.equal(b.writes.length, 0);
    }
  }
});

test("完成父任务可保留服务端生成的原工时继承子任务", async () => {
  const b = backend({ parent: { status: "done", children: [] }, extraClone: true });
  const result = await createSubtask(input, b.request, b.native);
  assert.equal(result.verified, true);
  assert.equal(result.parentStatusBefore, "done");
  assert.equal(result.additionalChildren.length, 1);
  assert.equal(result.additionalChildren[0].consumed, 2);
});

test("同名同字段子任务回读后返回已存在，不重复POST", async () => {
  const existing = { id: 38, parent: 42, execution: 7, ...input.data };
  const b = backend({ parent: { children: [existing] } });
  const result = await createSubtask(input, b.request, b.native);
  assert.equal(result.alreadyExists, true);
  assert.equal(result.written, false);
  assert.equal(result.task.id, 38);
  assert.equal(b.writes.length, 0);
});

test("同名子任务指派不一致时阻止创建，不擅自重指派", async () => {
  const b = backend({ parent: { children: [{ id: 38, parent: 42, execution: 7, ...input.data, assignedTo: "other" }] } });
  await assert.rejects(createSubtask(input, b.request, b.native), /同名子任务/);
  assert.equal(b.writes.length, 0);
});

test("非法参数和删除字段在任何请求前拒绝", async () => {
  for (const value of [
    { ...input, parentTaskId: 0 }, { ...input, parentTaskId: "42/delete" }, { ...input, dryRun: "false" },
    { ...input, method: "DELETE" }, { ...input, data: { ...input.data, deleted: 1 } },
    { ...input, data: { ...input.data, parent: 99 } }, { ...input, data: { ...input.data, status: "done" } },
    { ...input, data: { ...input.data, name: " " } }, { ...input, data: { name: "缺少类型" } },
    { ...input, data: { ...input.data, estimate: -1 } },
    { ...input, data: { ...input.data, estStarted: "2026-02-30" } },
    { ...input, data: { ...input.data, estStarted: "2026-12-02", deadline: "2026-12-01" } },
  ]) {
    const b = backend();
    await assert.rejects(createSubtask(value, b.request, b.native));
    assert.equal(b.reads, 0);
    assert.equal(b.writes.length, 0);
  }
});

test("不存在、已删除、多人与嵌套子任务或缺少完整清单时不写入", async () => {
  for (const parent of [{ id: 99 }, { deleted: true }, { deleted: "1" }, { execution: 0 }, { parent: 20 },
    { mode: "multi" }, { team: [{ account: "a" }, { account: "b" }] }, { children: null }]) {
    const b = backend({ parent });
    await assert.rejects(createSubtask(input, b.request, b.native));
    assert.equal(b.writes.length, 0);
  }
});

test("未落库、错误父子或指派、重复新任务、旧子任务丢失均不误报成功", async () => {
  for (const options of [{ noSave: true }, { wrongParent: true }, { wrongUser: true }, { duplicateNew: true },
    { removeOld: true }, { changedDescription: true }, { wrongReadId: true }, { deletedReadback: true }]) {
    const b = backend(options);
    await assert.rejects(createSubtask(input, b.request, b.native), /不要盲目重试/);
    assert.equal(b.writes.length, 1);
  }
});

test("权限、超时与回读失败均不自动重试写入", async () => {
  for (const options of [{ denied: true }, { timeout: true }, { readFailure: true }]) {
    const b = backend(options);
    await assert.rejects(createSubtask(input, b.request, b.native), /不要盲目重试/);
    assert.equal(b.writes.length, 1);
  }
});
