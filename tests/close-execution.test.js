import assert from "node:assert/strict";
import { test } from "node:test";
import { callWorkflowTool } from "../src/workflow-tools.js";

const executionArgs = { executionId: 2, realEnd: "2026-11-13", dryRun: false, comment: "关闭执行" };
const taskArgs = { taskId: 10, dryRun: false, comment: "关闭任务" };
function backend({ executionStatus = "doing", taskStatus = "done", failure = false, noSave = false, wrongId = false, changed = false, deleted = false } = {}) {
  const records = {
    execution: { id: 2, type: "sprint", project: 77, name: "执行", status: executionStatus, realEnd: null, deleted, lastEditedDate: "2026-11-13T01:00:00Z" },
    task: { id: 10, execution: 2, project: 77, name: "任务", status: taskStatus, closedReason: "", deleted, lastEditedDate: "2026-11-13T01:00:00Z" },
  };
  const reads = [];
  const writes = [];
  const request = async path => {
    reads.push(path);
    const type = path === "/executions/2" ? "execution" : path === "/tasks/10" ? "task" : null;
    assert.ok(type, "通用关闭工具不能查询任务列表或关联项目以套用业务条件");
    const count = reads.filter(item => item === path).length;
    return { ...records[type], ...(changed && count === 2 ? { lastEditedDate: "2026-11-13T02:00:00Z" } : {}) };
  };
  const native = async (type, action, id, body) => {
    assert.equal(action, "close");
    assert.equal(id, records[type].id);
    if (!body) return { [type]: { ...records[type], ...(wrongId ? { id: 99 } : {}) } };
    writes.push({ type, id, body });
    if (failure) throw new Error("服务端拒绝关闭");
    if (!noSave) {
      const before = records[type].status;
      Object.assign(records[type], { status: body.get("status") });
      if (type === "execution") records[type].realEnd = body.get("realEnd");
      else records.task.closedReason = before === "cancel" ? "cancel" : "done";
    }
  };
  return { request, native, reads, writes, records };
}
const closeExecution = b => callWorkflowTool("close_execution", executionArgs, b.request, b.native);
const closeTask = b => callWorkflowTool("close_task", taskArgs, b.request, b.native);

test("关闭执行只处理指定执行，不查询任务清单、不自动关闭done或其他状态的任务", async () => {
  for (const taskStatus of ["done", "wait", "doing", "pause", "cancel"]) {
    const b = backend({ taskStatus });
    const result = await closeExecution(b);
    assert.equal(result.verified, true);
    assert.equal(result.execution.status, "closed");
    assert.equal(result.execution.project, 77);
    assert.equal(b.records.task.status, taskStatus);
    assert.deepEqual(b.writes.map(write => [write.type, write.id]), [["execution", 2]]);
    assert.equal(b.writes[0].body.get("realEnd"), executionArgs.realEnd);
  }
});

test("空执行和服务端允许关闭的状态不被MCP附加业务规则拦截", async () => {
  for (const executionStatus of ["wait", "suspended", "server-custom-status"]) {
    const b = backend({ executionStatus });
    delete b.records.task;
    assert.equal((await closeExecution(b)).verified, true);
    assert.deepEqual(b.writes.map(write => write.type), ["execution"]);
  }
});

test("任务可以独立关闭，取消任务的关闭原因由服务端决定，不联动所属执行", async () => {
  for (const taskStatus of ["done", "cancel"]) {
    const b = backend({ taskStatus });
    const result = await closeTask(b);
    assert.equal(result.verified, true);
    assert.equal(result.task.status, "closed");
    assert.equal(result.task.closedReason, taskStatus === "cancel" ? "cancel" : "done");
    assert.equal(b.records.execution.status, "doing");
    assert.deepEqual(b.writes.map(write => [write.type, write.id]), [["task", 10]]);
    assert.equal(b.writes[0].body.get("status"), "closed");
    assert.equal(b.writes[0].body.get("comment"), taskArgs.comment);
  }
});

test("两个关闭工具默认仅预览；已关闭对象不重复写入", async () => {
  for (const [name, args, key] of [["close_execution", executionArgs, "execution"], ["close_task", taskArgs, "task"]]) {
    const b = backend();
    const { dryRun, ...previewArgs } = args;
    const preview = await callWorkflowTool(name, previewArgs, b.request, b.native);
    assert.equal(preview.dryRun, true);
    assert.equal(preview.written, false);
    assert.equal(b.writes.length, 0);
    b.records[key].status = "closed";
    const result = await callWorkflowTool(name, args, b.request, b.native);
    assert.equal(result.alreadyClosed, true);
    assert.equal(b.writes.length, 0);
  }
});

test("对象不匹配、删除标记和并发修改在写入前阻止；服务端拒绝和回读失败不重试", async () => {
  for (const close of [closeExecution, closeTask]) {
    for (const options of [{ wrongId: true }, { deleted: true }, { changed: true }]) {
      const b = backend(options);
      await assert.rejects(close(b));
      assert.equal(b.writes.length, 0);
    }
    for (const options of [{ failure: true }, { noSave: true }]) {
      const b = backend(options);
      await assert.rejects(close(b), /只读核实.*不要盲目重试/);
      assert.equal(b.writes.length, 1);
    }
  }
});

test("非法日期、ID、删除字段和未知参数均不发送请求", async () => {
  const never = async () => assert.fail("非法参数不应发送请求");
  for (const [name, args] of [
    ["close_execution", { ...executionArgs, realEnd: "2026-02-30" }],
    ["close_execution", { ...executionArgs, executionId: "2/delete" }],
    ["close_execution", { ...executionArgs, tasksToClose: [10] }],
    ["close_task", { ...taskArgs, taskId: 0 }],
    ["close_task", { ...taskArgs, deleted: 1 }],
    ["close_task", { ...taskArgs, status: "deleted" }],
  ]) await assert.rejects(callWorkflowTool(name, args, never, never));
});
