import assert from "node:assert/strict";
import { test } from "node:test";
import { callWorkflowTool, workflowTools } from "../src/workflow-tools.js";

const args = { sourceType: "project", sourceId: 1, targetType: "execution", targetId: 2, dryRun: false };
const member = { account: "alice", role: "开发", days: 10, hours: 8, limited: "no" };
function backend({ source = [member], target = [], change = false, noSave = false } = {}) {
  let reads = 0;
  const writes = [];
  const request = async (path) => path === "/projects/1" ? { id: 1, type: "project", days: 10 } : { id: 2, type: "sprint", project: 3, days: 5 };
  const native = async (type, action, id, body) => {
    if (action === "team") {
      if (id === 2) reads++;
      const members = id === 1 ? source : change && reads === 2 ? [{ ...member, account: "other" }] : target;
      return { projectID: id, execution: { id }, teamMembers: structuredClone(members) };
    }
    writes.push(body);
    if (!noSave) {
      target = [];
      for (let index = 0; body.has(`accounts[${index}]`); index++) {
        target.push({ account: body.get(`accounts[${index}]`), role: body.get(`roles[${index}]`), days: Number(body.get(`days[${index}]`)), hours: Number(body.get(`hours[${index}]`)), limited: body.get(`limited[${index}]`) });
      }
    }
  };
  return { request, native, writes };
}

test("成员新增复制到执行，保留现有成员并验证结果", async () => {
  const b = backend({ target: [{ ...member, account: "owner", role: "负责人", days: 5 }] });
  const result = await callWorkflowTool("copy_team", args, b.request, b.native);
  assert.equal(result.verified, true);
  assert.equal(result.members.find((item) => item.account === "owner").role, "负责人");
  assert.equal(result.members.find((item) => item.account === "alice").days, 5);
  assert.equal(b.writes.length, 1);
  assert.equal(b.writes[0].get("removeExecution"), "no");
});

test("团队并发变化、非法工时及缺字段在写入前阻止，回读失败不重试", async () => {
  for (const options of [{ change: true }, { source: [{ ...member, hours: 25 }] }, { source: [{ account: "alice" }] }]) {
    const b = backend(options);
    await assert.rejects(callWorkflowTool("copy_team", args, b.request, b.native));
    assert.equal(b.writes.length, 0);
  }
  const b = backend({ noSave: true });
  await assert.rejects(callWorkflowTool("copy_team", args, b.request, b.native), /不要盲目重试/);
  assert.equal(b.writes.length, 1);
});

test("团队回读的7.0工时字符串与数值7等价，不误报保存失败", async () => {
  const b = backend({ source: [{ ...member, hours: "7.0" }] });
  const native = async (...input) => {
    const result = await b.native(...input);
    if (input[1] === "team") for (const member of result.teamMembers) member.hours = Number(member.hours).toFixed(1);
    return result;
  };
  assert.equal((await callWorkflowTool("copy_team", args, b.request, native)).verified, true);
  assert.equal(b.writes.length, 1);
});

test("缺失名单、错误团队ID、重复账号不能被当成完整团队", async () => {
  for (const view of [{ projectID: 1 }, { projectID: 2, teamMembers: [] }, { projectID: 1, teamMembers: [member, member] }]) {
    await assert.rejects(callWorkflowTool("get_project_team", { projectId: 1 }, async () => {}, async () => view));
  }
});

test("危险路由、删除字段、无效范围、同一团队和相对附件路径不能触发请求", async () => {
  const never = async () => assert.fail("无效参数不应发送请求");
  for (const [name, input] of [
    ["copy_team", { ...args, targetType: "delete" }],
    ["copy_team", { ...args, deleted: true }],
    ["copy_team", { ...args, sourceId: "1/delete" }],
    ["copy_team", { ...args, targetType: "project", targetId: 1 }],
    ["upload_task_attachment", { taskId: 1, filePath: "relative.pdf" }],
    ["get_execution", { executionId: 0 }],
  ]) await assert.rejects(callWorkflowTool(name, input, never, never));
  assert.equal(workflowTools.some((item) => /delete|remove|http_request/.test(item.name)), false);
});

function projectBackend({ noSave = false, change = false } = {}) {
  let reads = 0;
  const writes = [];
  const record = { id: 3, type: "project", model: "scrum", name: "项目", code: "p", team: "团队", parent: 9, begin: "2026-11-06", end: "2026-11-26", days: 0, budget: "0", budgetUnit: "CNY", desc: "原说明", PM: "owner", auth: "", acl: "open", whitelist: [], deleted: false };
  const request = async () => { reads++; return { ...record, ...(change && reads === 2 ? { desc: "他人修改" } : {}) }; };
  const native = async (type, action, id, form) => {
    assert.deepEqual([type, action, id], ["project", "edit", 3]);
    if (!form) return { project: { ...record }, linkedProducts: { 7: { id: 7, type: "normal" } } };
    writes.push(form);
    assert.equal(form.get("desc"), "原说明");
    assert.equal(form.get("PM"), "owner");
    assert.equal(form.get("team"), "团队");
    assert.deepEqual(form.getAll("products[]"), ["7"]);
    if (!noSave) Object.assign(record, { budget: form.get("budget"), days: form.get("days"), auth: form.get("auth") });
  };
  return { request, native, writes };
}

test("项目设置默认预览，写入预算工作日和权限后回读并保留原字段", async () => {
  const b = projectBackend();
  const input = { projectId: 3, data: { budget: 10500, days: 15, auth: "extend" } };
  assert.equal((await callWorkflowTool("update_project_settings", input, b.request, b.native)).written, false);
  assert.equal(b.writes.length, 0);
  const result = await callWorkflowTool("update_project_settings", { ...input, dryRun: false }, b.request, b.native);
  assert.equal(result.verified, true);
  assert.equal(b.writes.length, 1);
  assert.equal(result.project.budget, "10500");
});

test("项目设置拒绝未知字段及无效输入，检测并发变化和保存失败且不重试", async () => {
  const never = async () => assert.fail("不应发送请求");
  for (const data of [{}, { deleted: true }, { days: -1 }, { budget: -1 }, { days: 1.5 }, { auth: "delete" }]) {
    await assert.rejects(callWorkflowTool("update_project_settings", { projectId: 3, data }, never, never));
  }
  const changed = projectBackend({ change: true });
  await assert.rejects(callWorkflowTool("update_project_settings", { projectId: 3, data: { days: 15 }, dryRun: false }, changed.request, changed.native), /已变化/);
  assert.equal(changed.writes.length, 0);
  const b = projectBackend({ noSave: true });
  await assert.rejects(callWorkflowTool("update_project_settings", { projectId: 3, data: { days: 15 }, dryRun: false }, b.request, b.native), /不要盲目重试/);
  assert.equal(b.writes.length, 1);
});
