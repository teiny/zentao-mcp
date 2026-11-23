import assert from "node:assert/strict";
import { test } from "node:test";
import { callWorkflowTool, workflowTools } from "../src/workflow-tools.js";

const args = { taskId: 42, currentConsumed: 1.5, realStarted: "2026-11-23 09:00:00",
  finishedDate: "2026-11-23 10:30:00", comment: "后端 & 管理端\n分支：feature-test\n提交：abc123", dryRun: false };

function backend(options = {}) {
  const record = { id: 42, name: "任务", type: "devel", desc: "需求及截图保持原样", status: "wait",
    assignedTo: { account: "owner" }, project: 3, execution: 4, parent: 0, mode: "", team: [], children: [],
    consumed: 2, left: 1, estimate: 3, deleted: false, actions: [], ...(options.task ?? {}) };
  const writes = [];
  let reads = 0;
  const request = async path => {
    assert.equal(path, "/tasks/42");
    reads++;
    if (writes.length && options.readFailure) throw new Error("回读中断");
    return structuredClone({ ...record, ...(reads === 2 && options.changed ? { consumed: 99 } : {}) });
  };
  const native = async (module, action, id, form) => {
    assert.deepEqual([module, action, id], ["task", "finish", 42]);
    if (!form) return { task: structuredClone(record) };
    writes.push(form);
    if (options.denied) throw new Error("403 无完成权限");
    if (!options.noSave) {
      Object.assign(record, { status: "done", left: 0, consumed: Number(form.get("consumed")),
        assignedTo: form.get("assignedTo"), realStarted: form.get("realStarted"), finishedDate: form.get("finishedDate"), finishedBy: "owner" });
      if (options.wrongConsumed) record.consumed = 99;
      if (options.changedDescription) record.desc = "被覆盖";
      if (!options.noAction) record.actions.push({ id: 8, objectType: "task", objectID: options.wrongObject ? 99 : 42,
        action: "finished", comment: form.get("comment") });
    }
    return { responseReceived: true };
  };
  return { record, request, native, writes };
}

test("完成任务默认仅预览，明确工时和时间且不修改原任务", async () => {
  const b = backend();
  const input = { ...args };
  delete input.dryRun;
  const result = await callWorkflowTool("finish_task", input, b.request, b.native);
  assert.equal(result.dryRun, true);
  assert.equal(result.written, false);
  assert.equal(result.currentConsumed, 1.5);
  assert.equal(b.record.status, "wait");
  assert.equal(b.writes.length, 0);
  const schema = workflowTools.find(tool => tool.name === "finish_task").inputSchema;
  assert.deepEqual(schema.required, ["taskId", "currentConsumed", "realStarted", "finishedDate"]);
  assert.equal(schema.additionalProperties, false);
});

test("通过正式完成流程累计工时、清零剩余并把说明写入完成记录，详情不变", async () => {
  const b = backend();
  const result = await callWorkflowTool("finish_task", args, b.request, b.native);
  assert.equal(result.written, true);
  assert.equal(result.verified, true);
  assert.equal(result.task.status, "done");
  assert.equal(result.task.consumed, 3.5);
  assert.equal(result.task.left, 0);
  assert.equal(result.task.desc, "需求及截图保持原样");
  assert.equal(result.action.action, "finished");
  assert.equal(b.writes.length, 1);
  assert.equal(b.writes[0].get("status"), "done");
  assert.equal(b.writes[0].get("currentConsumed"), "1.5");
  assert.equal(b.writes[0].get("consumed"), "3.5");
  assert.equal(b.writes[0].get("assignedTo"), "owner");
  assert.equal(b.writes[0].get("comment"), "后端 &amp; 管理端<br />分支：feature-test<br />提交：abc123");
  assert.equal(b.writes[0].has("desc"), false);
});

test("显式指派可修改，已完成任务不重复计时或补写评论", async () => {
  const b = backend();
  assert.equal((await callWorkflowTool("finish_task", { ...args, assignedTo: "reviewer" }, b.request, b.native)).task.assignedTo, "reviewer");
  const done = backend({ task: { status: "done" } });
  const result = await callWorkflowTool("finish_task", args, done.request, done.native);
  assert.equal(result.alreadyDone, true);
  assert.equal(result.written, false);
  assert.equal(done.writes.length, 0);
});

test("非法参数、工时、日期或时间倒置在请求前拒绝，不猜测缺少的工时和开始时间", async () => {
  const never = async () => assert.fail("非法参数不得发送请求");
  for (const input of [
    { ...args, taskId: 0 }, { ...args, currentConsumed: -1 }, { ...args, currentConsumed: NaN },
    { ...args, realStarted: "2026-02-30 09:00:00" }, { ...args, realStarted: "2026-11-23 24:00:00" },
    { ...args, realStarted: "2026-11-24 09:00:00" }, { ...args, finishedDate: "" },
    { ...args, status: "done" }, { ...args, deleted: true },
    { taskId: 42, realStarted: args.realStarted, finishedDate: args.finishedDate },
    { taskId: 42, currentConsumed: 1, finishedDate: args.finishedDate }
  ]) await assert.rejects(callWorkflowTool("finish_task", input, never, never));
});

test("任务身份、删除标记和当前不支持的多人或父任务在写入前拒绝", async () => {
  for (const task of [{ id: 99 }, { deleted: true }, { mode: "multi" }, { team: { owner: {} } },
    { parent: -1 }, { children: [{ id: 43 }] }, { actions: null }, { consumed: -1 }]) {
    const b = backend({ task });
    await assert.rejects(callWorkflowTool("finish_task", args, b.request, b.native));
    assert.equal(b.writes.length, 0);
  }
});

test("读取表单后任务有并发变化，不覆盖新工时", async () => {
  const b = backend({ changed: true });
  await assert.rejects(callWorkflowTool("finish_task", args, b.request, b.native), /已变化/);
  assert.equal(b.writes.length, 0);
});

test("权限拒绝、结果未保存、回读失败或工时和详情不符均不自动重试", async () => {
  for (const options of [{ denied: true }, { noSave: true }, { readFailure: true }, { wrongConsumed: true }, { changedDescription: true }]) {
    const b = backend(options);
    await assert.rejects(callWorkflowTool("finish_task", args, b.request, b.native), /只读核实.*不要盲目重试/);
    assert.equal(b.writes.length, 1);
  }
});

test("只接受本次新增的目标任务完成记录，不用无关或缺失的备注证明完成", async () => {
  for (const options of [{ noAction: true }, { wrongObject: true }]) {
    const b = backend(options);
    await assert.rejects(callWorkflowTool("finish_task", args, b.request, b.native), /不要盲目重试/);
    assert.equal(b.writes.length, 1);
  }
});
