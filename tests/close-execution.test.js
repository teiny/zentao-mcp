import assert from "node:assert/strict";
import { test } from "node:test";
import { callWorkflowTool } from "../src/workflow-tools.js";

const input = { executionId: 2, realEnd: "2026-11-13", dryRun: false, comment: "任务已结束，关闭执行" };
function backend({ statuses = ["done", "closed", "cancel"], status = "doing", pageFault, taskFailure = false, noSave = false, formId = 2 } = {}) {
  const execution = { id: 2, type: "sprint", project: 1, name: "执行", status, realEnd: null, deleted: false };
  const tasks = statuses.map((status, index) => ({ id: index + 10, execution: 2, status, closedReason: status === "closed" ? "done" : "", deleted: false }));
  const writes = [];
  const pages = [];
  const request = async path => {
    if (path === "/executions/2") return { ...execution };
    if (/^\/tasks\/\d+$/.test(path)) return { ...tasks.find(task => task.id === Number(path.split("/").at(-1))) };
    const url = new URL(path, "http://mock");
    assert.equal(url.pathname, "/executions/2/tasks");
    const page = Number(url.searchParams.get("page"));
    const limit = Number(url.searchParams.get("limit"));
    pages.push(page);
    const rows = structuredClone(tasks.slice((page - 1) * limit, page * limit));
    const list = { tasks: rows, page, limit, total: tasks.length };
    return pageFault ? pageFault(list) : list;
  };
  const native = async (type, action, id, body) => {
    assert.equal(action, "close");
    if (!body) return type === "execution" ? { execution: { ...execution, id: formId } } : { task: { ...tasks.find(task => task.id === id) } };
    writes.push({ type, id, body });
    if (type === "task") {
      if (taskFailure) throw new Error("任务关闭响应超时");
      Object.assign(tasks.find(task => task.id === id), { status: "closed", closedReason: "done" });
    } else if (!noSave) {
      assert.equal(tasks.some(task => task.status === "done"), false, "关闭执行之前必须关闭done任务");
      Object.assign(execution, { status: body.get("status"), realEnd: body.get("realEnd") });
    }
  };
  return { request, native, writes, pages, tasks };
}
const close = b => callWorkflowTool("close_execution", input, b.request, b.native);

test("预览不写入，满足条件时先正式关闭done任务再关闭执行并回读", async () => {
  const b = backend();
  const preview = await callWorkflowTool("close_execution", { executionId: 2, realEnd: input.realEnd }, b.request, b.native);
  assert.equal(preview.dryRun, true);
  assert.deepEqual(preview.tasksToClose, [10]);
  assert.equal(b.writes.length, 0);
  const result = await close(b);
  assert.equal(result.verified, true);
  assert.deepEqual(result.closedTaskIds, [10]);
  assert.deepEqual(b.writes.map(write => [write.type, write.id]), [["task", 10], ["execution", 2]]);
  assert.equal(b.writes[0].body.get("comment"), input.comment);
  assert.equal(b.writes[0].body.get("status"), "closed");
  assert.equal(b.writes[1].body.get("realEnd"), input.realEnd);
  assert.deepEqual(b.tasks.map(task => task.status), ["closed", "closed", "cancel"]);
});

test("超过100条任务读取全部分页，第二页存在未结束任务时连第一页done任务也不关闭", async () => {
  const statuses = ["done", ...Array(100).fill("closed")];
  const b = backend({ statuses });
  assert.equal((await close(b)).taskCount, 101);
  assert.deepEqual(b.pages, [1, 2, 1, 2]);
  statuses[100] = "wait";
  const blocked = backend({ statuses });
  await assert.rejects(close(blocked), /只允许done、closed、cancel/);
  assert.deepEqual(blocked.pages, [1, 2]);
  assert.equal(blocked.writes.length, 0);
  assert.equal(blocked.tasks[0].status, "done");
});

test("空执行、wait/doing/pause和未知任务状态均不修改任何任务或执行", async () => {
  for (const statuses of [[], ...["wait", "doing", "pause", "unknown"].map(status => ["done", status])]) {
    const b = backend({ statuses });
    await assert.rejects(close(b));
    assert.equal(b.writes.length, 0);
  }
});

test("分页重复、漏项、总数变化和错误对象均在写入前阻止", async () => {
  for (const pageFault of [
    list => ({ ...list, tasks: [list.tasks[0], list.tasks[0], list.tasks[2]] }),
    list => ({ ...list, tasks: list.tasks.slice(1) }),
    list => ({ ...list, tasks: list.tasks.map(task => ({ ...task, execution: 99 })) }),
    list => ({ ...list, tasks: list.tasks.map(task => ({ ...task, deleted: true })) }),
  ]) {
    const b = backend({ pageFault });
    await assert.rejects(close(b));
    assert.equal(b.writes.length, 0);
  }
  const changed = backend({ statuses: Array(101).fill("closed"), pageFault: list => ({ ...list, total: list.page === 2 ? 102 : 101 }) });
  await assert.rejects(close(changed), /总数已变化/);
  assert.equal(changed.writes.length, 0);
  const wrong = backend({ formId: 3 });
  await assert.rejects(close(wrong), /对象ID或类型不匹配/);
  assert.equal(wrong.writes.length, 0);
});

test("任务关闭失败不关闭执行，执行回读失败不盲目重试；已关闭执行不再写入", async () => {
  const failed = backend({ taskFailure: true });
  await assert.rejects(close(failed), /可能部分生效.*不要盲目重试/);
  assert.deepEqual(failed.writes.map(write => write.type), ["task"]);
  const b = backend({ noSave: true });
  await assert.rejects(close(b), /不要盲目重试/);
  assert.equal(b.writes.length, 2);
  const closed = backend({ status: "closed" });
  assert.equal((await close(closed)).alreadyClosed, true);
  assert.equal(closed.writes.length, 0);
});

test("未开始和已挂起执行可正常关闭，无效日期、删除及未知参数不发送请求", async () => {
  for (const status of ["wait", "suspended"]) assert.equal((await close(backend({ status }))).verified, true);
  const never = async () => assert.fail("无效参数不应发送请求");
  for (const args of [{ ...input, realEnd: "2026-02-30" }, { ...input, deleted: 1 }, { ...input, status: "deleted" }, { ...input, executionId: "2/delete" }]) {
    await assert.rejects(callWorkflowTool("close_execution", args, never, never));
  }
});
