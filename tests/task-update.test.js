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

test("父任务和已完成子任务仅修改描述，保留父子关系、工时、日期和完成者", async () => {
  for (const parent of [-1, 41]) {
    const b = backend({ parent, status: "done", left: 0, finishedBy: "original-finisher",
      finishedDate: "2026-11-20 11:12:52" });
    const before = structuredClone(b.record);
    const desc = "<p>第一段</p>\n<p>第二段</p>";
    const result = await callWriteTool("update_task", { taskId: 42, data: { desc } }, b.request, b.native);
    assert.deepEqual(result, { ...before, desc });
    assert.deepEqual(b.record, { ...before, desc });
    assert.equal(b.writes.length, 1);
  }
});

test("父子任务仍拒绝描述之外或混合字段的修改", async () => {
  for (const parent of [-1, 41]) {
    for (const data of [{ name: "其他名称" }, { desc: "<p>说明</p>", assignedTo: "other" }, { realStarted: "2026-11-20 09:00:00" }]) {
      const b = backend({ parent });
      await assert.rejects(callWriteTool("update_task", { taskId: 42, data }, b.request, b.native), /父子任务/);
      assert.equal(b.writes.length, 0);
    }
  }
});

test("父子任务描述保存后字段意外变化或HTML再次转义时不误报成功", async () => {
  for (const change of [
    task => { task.consumed = 99; }, task => { task.parent = 0; },
    task => { task.desc = "&lt;p&gt;说明&lt;/p&gt;"; },
  ]) {
    const b = backend({ parent: 41 });
    await assert.rejects(callWriteTool("update_task", { taskId: 42, data: { desc: "<p>说明</p>" } }, b.request,
      async (...args) => {
        const result = await b.native(...args);
        if (args[3]) change(b.record);
        return result;
      }), /不要盲目重试/);
    assert.equal(b.writes.length, 1);
  }
  const team = backend({ parent: 41, team: [{ account: "owner" }] });
  await assert.rejects(callWriteTool("update_task", { taskId: 42, data: { desc: "说明" } }, team.request, team.native));
  assert.equal(team.writes.length, 0);
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
    task => { task.mode = "multi"; }, task => { task.parent = -2; }
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
