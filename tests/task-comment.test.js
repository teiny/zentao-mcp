import assert from "node:assert/strict";
import { test } from "node:test";
import { callWorkflowTool, workflowTools } from "../src/workflow-tools.js";

const input = { taskId: 42, comment: "需求确认：金额 >= 0 & < 100\n第二行", dryRun: false };
function backend(options = {}) {
  const record = { id: 42, name: "任务", type: "devel", desc: "原描述", status: "wait", assignedTo: { account: "owner" }, deleted: false,
    actions: [{ id: 7, objectType: "task", objectID: 42, action: "commented", comment: input.comment }] };
  const writes = [];
  let reads = 0;
  const request = async () => {
    reads++;
    if (reads > 1 && options.readFailure) throw new Error("回读中断");
    return structuredClone({ ...record, ...(options.task ?? {}), ...(reads > 1 && options.changed ? { status: "doing" } : {}) });
  };
  const native = async (module, action, id, body) => {
    assert.deepEqual([module, action, id], ["task", "comment", 42]);
    assert.deepEqual([...body.keys()], ["comment"]);
    writes.push(body);
    if (options.denied) throw new Error("403 无备注权限");
    if (!options.noSave) record.actions.push({ id: options.oldId ? 7 : 8, objectType: "task", objectID: options.wrongObject ? 99 : 42,
      action: "commented", comment: '<p>' + body.get("comment") + '</p>' });
    return options.responseId ?? 8;
  };
  return { record, writes, request, native };
}

test("备注工具默认预览，只读取任务且保留待追加正文", async () => {
  const b = backend();
  const result = await callWorkflowTool("add_task_comment", { taskId: 42, comment: input.comment }, b.request, b.native);
  assert.equal(result.dryRun, true);
  assert.equal(result.written, false);
  assert.equal(result.comment, input.comment);
  assert.equal(b.writes.length, 0);
  const schema = workflowTools.find(tool => tool.name === "add_task_comment").inputSchema;
  assert.deepEqual(schema.required, ["taskId", "comment"]);
  assert.equal(schema.additionalProperties, false);
});

test("追加备注只提交转义正文并保留换行，按新增操作ID验证而非复用旧备注", async () => {
  const b = backend();
  const before = structuredClone(b.record);
  const result = await callWorkflowTool("add_task_comment", input, b.request, b.native);
  assert.equal(result.verified, true);
  assert.equal(result.written, true);
  assert.equal(result.action.id, 8);
  assert.equal(b.writes.length, 1);
  assert.equal(b.writes[0].get("comment"), "需求确认：金额 &gt;= 0 &amp; &lt; 100<br />第二行");
  assert.deepEqual({ ...b.record, actions: before.actions }, before);
});

test("非法ID、空备注、错误类型和未知参数在请求前拒绝", async () => {
  const never = async () => assert.fail("非法参数不得发送请求");
  for (const value of [{ ...input, taskId: "42/delete" }, { ...input, comment: " \n " }, { ...input, comment: null },
    { ...input, taskId: 0 }, { ...input, status: "closed" }, { ...input, deleted: true }, { taskId: 42 }]) {
    await assert.rejects(callWorkflowTool("add_task_comment", value, never, never));
  }
});

test("任务不存在、已删除或缺失历史时不写入", async () => {
  for (const task of [{ id: 99 }, { deleted: true }, { deleted: "1" }, { actions: null }]) {
    const b = backend({ task });
    await assert.rejects(callWorkflowTool("add_task_comment", input, b.request, b.native));
    assert.equal(b.writes.length, 0);
  }
});

test("未新增、错误对象、旧操作ID和响应ID不匹配时不将旧备注误报为成功", async () => {
  for (const options of [{ noSave: true }, { wrongObject: true }, { oldId: true }, { responseId: 99 }]) {
    const b = backend(options);
    await assert.rejects(callWorkflowTool("add_task_comment", input, b.request, b.native), /不要盲目重试/);
    assert.equal(b.writes.length, 1);
  }
});

test("权限失败、回读中断及任务业务字段变化均不自动重复追加", async () => {
  for (const options of [{ denied: true }, { readFailure: true }, { changed: true }]) {
    const b = backend(options);
    await assert.rejects(callWorkflowTool("add_task_comment", input, b.request, b.native), /不要盲目重试/);
    assert.equal(b.writes.length, 1);
  }
});
