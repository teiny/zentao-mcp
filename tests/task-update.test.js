import assert from "node:assert/strict";
import { test } from "node:test";
import { callWriteTool, writeTools } from "../src/write-tools.js";

function backend(overrides = {}) {
  const record = { id: 42, name: "任务", type: "devel", mode: "", parent: 0, execution: 4,
    module: 0, story: 0, pri: 3, estStarted: "", deadline: "", status: "doing", assignedTo: "owner",
    estimate: 32, consumed: 8, left: 24, desc: "原描述",
    realStarted: "2026-11-13 15:37:49", finishedDate: "0000-00-00 00:00:00", finishedBy: "", canceledBy: "", canceledDate: "0000-00-00 00:00:00", closedBy: "", closedDate: "0000-00-00 00:00:00", closedReason: "", ...overrides };
  const writes = [];
  const request = async (path, method = "GET") => {
    assert.equal(path, "/tasks/42");
    assert.equal(method, "GET", "日期保留不能走有兼容问题的任务PUT接口");
    return structuredClone(record);
  };
  const native = async (module, action, id, form) => {
    assert.deepEqual([module, action, id], ["task", "edit", 42]);
    if (!form) return { task: structuredClone(record) };
    writes.push(form);
    if (form.get("status") === "done" && !form.get("finishedBy")) record.finishedBy = "editor";
    for (const key of Object.keys(record)) {
      if (form.has(key)) record[key] = typeof record[key] === "number" ? Number(form.get(key)) : form.get(key);
    }
    return { result: "success" };
  };
  return { record, writes, request, native };
}

test("仅修改描述时保留原实际开始、完成时间和其他字段", async () => {
  for (const original of [
    { status: "wait", realStarted: "0000-00-00 00:00:00" },
    {},
    { status: "done", finishedDate: "2026-11-20 11:12:52", finishedBy: "original-finisher", left: 0 }
  ]) {
    const b = backend(original);
    const before = structuredClone(b.record);
    const data = { desc: "<h3>本期需求</h3>" };
    await callWriteTool("update_task", { taskId: 42, data }, b.request, b.native);
    assert.deepEqual(b.record, { ...before, desc: data.desc });
    assert.deepEqual(data, { desc: "<h3>本期需求</h3>" });
    assert.equal(b.writes.length, 1);
  }
});

test("可明确恢复实际开始时间，保留描述、状态、工时和完成时间", async () => {
  const b = backend({ realStarted: "0000-00-00 00:00:00" });
  const before = structuredClone(b.record);
  const realStarted = "2026-11-13 15:37:49";
  await callWriteTool("update_task", { taskId: 42, data: { realStarted } }, b.request, b.native);
  assert.deepEqual(b.record, { ...before, realStarted });
  assert.equal(writeTools.find(t => t.name === "update_task").inputSchema.properties.data.properties.realStarted.type, "string");
  assert.equal(Object.hasOwn(writeTools.find(t => t.name === "create_task").inputSchema.properties.data.properties, "realStarted"), false);
});

test("明确恢复完成者只改变完成者，不重复完成或修改日期与工时", async () => {
  const b = backend({ status: "done", finishedBy: "editor", finishedDate: "2026-11-20 11:12:52", left: 0 });
  const before = structuredClone(b.record);
  await callWriteTool("update_task", { taskId: 42, data: { finishedBy: "original-finisher" } }, b.request, b.native);
  assert.deepEqual(b.record, { ...before, finishedBy: "original-finisher" });
});

test("非法实际开始时间、状态和未声明字段在读取前被拒绝", async () => {
  const never = async () => assert.fail("非法参数不得读取或写入");
  for (const data of [
    { realStarted: "2026-02-30 15:37:49" }, { realStarted: "2026-11-13 24:00:00" },
    { realStarted: "2026-11-13T07:37:49Z" }, { realStarted: "" }, { realStarted: null },
    { status: "done" }, { deleted: true }, { finishedBy: "" }
  ]) await assert.rejects(callWriteTool("update_task", { taskId: 42, data }, never, never));
});

test("原字段缺失、日期无法识别、对象不匹配或复杂任务时拒绝写入", async () => {
  for (const change of [
    task => { delete task.realStarted; }, task => { delete task.finishedDate; }, task => { delete task.desc; },
    task => { task.realStarted = "2026-11-13T07:37:49Z"; }, task => { task.id = 43; },
    task => { task.mode = "multi"; }, task => { task.parent = -1; }
  ]) {
    const b = backend();
    change(b.record);
    await assert.rejects(callWriteTool("update_task", { taskId: 42, data: { desc: "新描述" } }, b.request, b.native));
    assert.equal(b.writes.length, 0);
  }
});

test("原生表单读取失败不写入，写入或回读失败不重试", async () => {
  const b = backend();
  await assert.rejects(callWriteTool("update_task", { taskId: 42, data: { desc: "新描述" } }, b.request, async () => { throw new Error("403"); }));
  assert.equal(b.writes.length, 0);
  let writes = 0;
  await assert.rejects(callWriteTool("update_task", { taskId: 42, data: { desc: "新描述" } }, b.request, async (...args) => {
    if (!args[3]) return b.native(...args);
    writes++;
    throw new Error("timeout");
  }));
  assert.equal(writes, 1);
  const readFailure = backend();
  await assert.rejects(callWriteTool("update_task", { taskId: 42, data: { desc: "新描述" } }, async () => { throw new Error("read failed"); }, readFailure.native));
  assert.equal(readFailure.writes.length, 1);
});
