import assert from "node:assert/strict";
import { test } from "node:test";
import { callWorkflowTool } from "../src/workflow-tools.js";

const args = { projectId: 12, realEnd: "2026-11-13" };
function backend({ object = {}, view = {}, latest = {}, saved = {}, noSave = false, denied = false } = {}) {
  const project = { id: 12, type: "project", project: 0, parent: 9, name: "项目", status: "doing", realEnd: null, budget: "100", PM: "owner", deleted: false, lastEditedDate: "2026-11-12", ...object };
  const writes = [];
  let reads = 0, views = 0;
  const request = async (path) => {
    assert.equal(path, "/projects/12", "关闭项目不应查询执行或任务");
    reads++;
    return { ...project, ...(writes.length ? saved : reads === 2 ? latest : {}) };
  };
  const native = async (type, action, id, form) => {
    assert.deepEqual([type, action, id], ["project", "close", 12]);
    if (!form) { views++; return { project: { ...project, ...view } }; }
    writes.push(form);
    if (denied) throw new Error("服务端拒绝关闭");
    if (!noSave) Object.assign(project, { status: form.get("status"), realEnd: form.get("realEnd") });
  };
  return { request, native, writes, project, views: () => views };
}

test("关闭项目默认仅预览，正式保存只提交关闭字段并回读", async () => {
  const b = backend();
  const preview = await callWorkflowTool("close_project", args, b.request, b.native);
  assert.equal(preview.dryRun, true);
  assert.equal(preview.written, false);
  assert.equal(b.project.status, "doing");
  assert.equal(b.writes.length, 0);
  const result = await callWorkflowTool("close_project", { ...args, comment: "交付关闭", dryRun: false }, b.request, b.native);
  assert.equal(result.verified, true);
  assert.equal(result.project.status, "closed");
  assert.equal(result.project.realEnd, args.realEnd);
  assert.equal(result.project.budget, "100");
  assert.equal(result.project.PM, "owner");
  assert.deepEqual(Object.fromEntries(b.writes[0]), { status: "closed", comment: "交付关闭", realEnd: args.realEnd });
  assert.equal(b.writes.length, 1);
});

test("已关闭项目不重复保存或覆盖原实际完成日期", async () => {
  const b = backend({ object: { status: "closed", realEnd: "2026-11-01" } });
  const result = await callWorkflowTool("close_project", { ...args, dryRun: false }, b.request, b.native);
  assert.equal(result.alreadyClosed, true);
  assert.equal(result.written, false);
  assert.equal(result.project.realEnd, "2026-11-01");
  assert.equal(b.views(), 0);
  assert.equal(b.writes.length, 0);
});

test("项目关闭拒绝非法ID、日期、删除标记及任意状态字段，且不发送请求", async () => {
  const never = async () => assert.fail("无效参数不应发送请求");
  for (const input of [
    { projectId: 12 }, { ...args, projectId: 0 }, { ...args, projectId: "12/delete" },
    { ...args, realEnd: "" }, { ...args, realEnd: "2026-02-30" }, { ...args, realEnd: null },
    { ...args, deleted: true }, { ...args, status: "closed" }, { ...args, dryRun: "false" },
  ]) await assert.rejects(callWorkflowTool("close_project", input, never, never));
});

test("项目关闭拒绝项目集、执行、错误ID及已删除对象", async () => {
  for (const object of [{ type: "program" }, { type: "sprint" }, { id: 99 }, { deleted: true }, { deleted: "1" }]) {
    const b = backend({ object });
    await assert.rejects(callWorkflowTool("close_project", { ...args, dryRun: false }, b.request, b.native));
    assert.equal(b.views(), 0);
    assert.equal(b.writes.length, 0);
  }
});

test("项目关闭前检测状态、所属项目集及编辑时间的并发变化", async () => {
  for (const change of [{ view: { parent: 10 } }, { view: { status: "closed" } }, { latest: { parent: 10 } }, { latest: { lastEditedDate: "2026-11-13" } }]) {
    const b = backend(change);
    await assert.rejects(callWorkflowTool("close_project", { ...args, dryRun: false }, b.request, b.native), /对象已变化/);
    assert.equal(b.writes.length, 0);
  }
});

test("项目关闭被拒绝或回读不一致时报告结果不明，不重复提交", async () => {
  for (const change of [{ denied: true }, { noSave: true }, { saved: { realEnd: "2026-11-12" } }, { saved: { parent: 10 } }, { saved: { id: 99 } }]) {
    const b = backend(change);
    await assert.rejects(callWorkflowTool("close_project", { ...args, dryRun: false }, b.request, b.native), /只读核实.*不要盲目重试/);
    assert.equal(b.writes.length, 1);
  }
});
