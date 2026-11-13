import { readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import { positiveId, validateData } from "./write-tools.js";
import { callListTool } from "./list-tools.js";

const id = { type: "integer", minimum: 1 };
const scope = { type: "string", enum: ["project", "execution"] };
const projectSettings = {
  budget: { type: "number", minimum: 0, description: "预算金额" },
  budgetUnit: { type: "string", enum: ["CNY", "USD"] },
  days: { type: "integer", minimum: 0, description: "可用工作日" },
  auth: { type: "string", enum: ["extend", "reset"] },
};
function tool(name, description, properties, required = Object.keys(properties)) {
  return { name, description, inputSchema: { type: "object", properties, required, additionalProperties: false } };
}
export const workflowTools = [
  tool("get_execution", "获取执行详情，包括关联产品和团队成员", { executionId: id }),
  tool("close_execution", "先关闭done任务再关闭非空执行；分页复查，只接受done、closed、cancel，已关闭和已取消任务保持原状态。使用正式关闭流程并回读，默认预览，dryRun=false才写入，可能部分生效且不自动重试", {
    executionId: id,
    realEnd: { type: "string", format: "date", description: "实际完成日期，YYYY-MM-DD" },
    comment: { type: "string", description: "关闭备注" },
    dryRun: { type: "boolean", default: true },
  }, ["executionId", "realEnd"]),
  tool("get_project_team", "读取项目完整团队的账号、角色、工时等，不使用列表中的空成员占位", { projectId: id }),
  tool("get_execution_team", "读取执行完整团队的账号、角色、工时等", { executionId: id }),
  tool("update_project_settings", "维护Scrum项目的预算、可用工作日和权限继承，保留其他字段及产品；默认只预览，dryRun=false才保存并回读", {
    projectId: id,
    data: { type: "object", properties: projectSettings, minProperties: 1, additionalProperties: false },
    dryRun: { type: "boolean", default: true },
  }, ["projectId", "data"]),
  tool("copy_team", "复制团队人员与角色，保留目标已有成员；新增成员天数使用目标工作日，工时及受限标记沿用来源。默认只预览，dryRun=false才写入并回读", {
    sourceType: scope, sourceId: id, targetType: scope, targetId: id,
    dryRun: { type: "boolean", default: true },
  }, ["sourceType", "sourceId", "targetType", "targetId"]),
  tool("upload_task_attachment", "向未开始或进行中的普通单人任务上传PDF或图片附件，保留字段并回读；默认只检查，dryRun=false才上传。最大20MiB，不自动重试", {
    taskId: id, filePath: { type: "string", description: "本机文件的绝对路径" },
    dryRun: { type: "boolean", default: true },
  }, ["taskId", "filePath"]),
];
export const isWorkflowTool = (name) => workflowTools.some((item) => item.name === name);

function argumentsFor(name, args) {
  const schema = workflowTools.find((item) => item.name === name)?.inputSchema;
  if (!schema || !args || typeof args !== "object" || Array.isArray(args)) throw new Error("无效的工具或参数");
  for (const key of Object.keys(args)) if (!Object.hasOwn(schema.properties, key)) throw new Error(`不支持参数${key}`);
  for (const key of schema.required) if (!Object.hasOwn(args, key)) throw new Error(`缺少参数${key}`);
  for (const [key, value] of Object.entries(args)) {
    const field = schema.properties[key];
    if (field.type === "integer") positiveId(value, key);
    else if (field.type === "object") validateData(value, field.properties);
    else if (typeof value !== field.type || (field.enum && !field.enum.includes(value))) throw new Error(`无效参数${key}`);
  }
}

function objectMatches(object, type, objectId) {
  if (Number(object?.id) !== objectId || (type === "project" ? object.type !== "project" : !["sprint", "stage", "kanban"].includes(object.type))) {
    throw new Error("对象ID或类型不匹配，未继续写入");
  }
  if (object.deleted === true || object.deleted === "1" || object.deleted === 1) throw new Error("对象已删除");
}

async function team(type, objectId, nativeRequest) {
  const view = await nativeRequest(type, "team", objectId);
  if (Number(type === "project" ? view?.projectID : view?.execution?.id) !== objectId) throw new Error("团队响应对象ID不匹配");
  if (!view || !Object.hasOwn(view, "teamMembers") || !view.teamMembers || typeof view.teamMembers !== "object") {
    throw new Error("团队响应缺少teamMembers，不能把权限错误或不完整响应当作空团队");
  }
  const members = Object.values(view.teamMembers).map((member) => {
    if (!member || typeof member.account !== "string" || !member.account.trim()) throw new Error("团队成员缺少有效账号");
    return Object.fromEntries(["account", "realname", "role", "join", "days", "hours", "limited"]
      .filter((key) => Object.hasOwn(member, key)).map((key) => [key, member[key]]));
  });
  if (new Set(members.map((member) => member.account)).size !== members.length) throw new Error("团队成员账号重复，无法确认完整名单");
  return { type, id: objectId, count: members.length, members };
}

function memberValues(member, days) {
  const result = { ...member, days: Number(days ?? member.days), hours: Number(member.hours) };
  if (!Number.isSafeInteger(result.days) || result.days < 0 || !Number.isFinite(result.hours) || result.hours < 0 || result.hours > 24 ||
      typeof result.role !== "string" || !["yes", "no"].includes(result.limited)) {
    throw new Error(`成员${member.account}的角色、天数、工时或受限标记不完整，未继续写入`);
  }
  return result;
}
const signature = (members) => JSON.stringify([...members].sort((a, b) => a.account.localeCompare(b.account)));
const account = (value) => typeof value === "string" ? value : value?.account ?? "";

async function executionTasks(executionId, request) {
  const tasks = [];
  let total;
  for (let page = 1; ; page++) {
    const list = await callListTool("get_tasks", { executionId, page, limit: 100 }, request);
    if (total !== undefined && list.total !== total) throw new Error("翻页期间任务总数已变化，未继续关闭");
    total = list.total;
    tasks.push(...list.tasks);
    if (!list.hasNext) break;
  }
  const ids = tasks.map(task => positiveId(Number(task.id), "taskId"));
  if (tasks.length !== total || new Set(ids).size !== total) throw new Error("任务分页不完整或ID重复，未继续关闭");
  if (!tasks.length) throw new Error("空任务执行不能关闭");
  for (const task of tasks) {
    if (Number(task.execution) !== executionId || [true, 1, "1"].includes(task.deleted)) throw new Error("任务所属执行不匹配或已删除，未继续关闭");
    if (!["done", "closed", "cancel"].includes(task.status)) throw new Error(`任务#${task.id}状态为${task.status}，只允许done、closed、cancel，未继续关闭`);
  }
  return tasks;
}

async function closeDoneTask(taskId, executionId, comment, request, nativeRequest) {
  const task = await request(`/tasks/${taskId}`);
  const matches = value => Number(value?.id) === taskId && Number(value.execution) === executionId && ![true, 1, "1"].includes(value.deleted);
  if (!matches(task)) throw new Error(`任务#${taskId}对象不匹配或已删除`);
  if (task.status === "closed") return false;
  if (task.status !== "done") throw new Error(`任务#${taskId}已不再是done，未继续关闭`);
  const view = await nativeRequest("task", "close", taskId);
  if (!matches(view?.task) || view.task.status !== "done") throw new Error(`任务#${taskId}关闭表单不匹配或状态已变化`);
  await nativeRequest("task", "close", taskId, new URLSearchParams({ status: "closed", comment }));
  const saved = await request(`/tasks/${taskId}`);
  if (!matches(saved) || saved.status !== "closed" || saved.closedReason !== "done") throw new Error(`任务#${taskId}关闭后的状态或关闭原因回读不一致`);
  return true;
}

async function closeExecution(args, request, nativeRequest) {
  validateData({ realEnd: args.realEnd }, { realEnd: { type: "string", format: "date" } });
  const current = await request(`/executions/${args.executionId}`);
  objectMatches(current, "execution", args.executionId);
  const result = { executionId: args.executionId, name: current.name, projectId: current.project,
    previousStatus: current.status, realEnd: args.realEnd, dryRun: args.dryRun !== false, written: false };
  if (current.status === "closed") return { ...result, alreadyClosed: true, execution: current };
  if (!["wait", "doing", "suspended"].includes(current.status)) throw new Error("不支持的执行状态，未继续关闭");
  const view = await nativeRequest("execution", "close", args.executionId);
  objectMatches(view?.execution, "execution", args.executionId);
  if (view.execution.status !== current.status || Number(view.execution.project) !== Number(current.project)) throw new Error("执行已变化，请重新查询；未继续关闭");

  const tasks = await executionTasks(args.executionId, request);
  const statusCounts = {};
  for (const task of tasks) {
    statusCounts[task.status] = (statusCounts[task.status] ?? 0) + 1;
  }
  Object.assign(result, { taskCount: tasks.length, statusCounts, tasksToClose: tasks.filter(task => task.status === "done").map(task => Number(task.id)) });
  if (result.dryRun) return result;
  const latest = await request(`/executions/${args.executionId}`);
  objectMatches(latest, "execution", args.executionId);
  if (["status", "project", "lastEditedDate"].some(key => String(latest[key] ?? "") !== String(current[key] ?? ""))) throw new Error("执行已变化，请重新查询；未继续关闭");
  const form = new URLSearchParams({ status: "closed", realEnd: args.realEnd, comment: args.comment ?? "" });
  const closedTaskIds = [];
  try {
    for (const taskId of result.tasksToClose) {
      if (await closeDoneTask(taskId, args.executionId, args.comment ?? "", request, nativeRequest)) closedTaskIds.push(taskId);
    }
    const checked = await executionTasks(args.executionId, request);
    if (checked.length !== tasks.length || checked.some(task => !tasks.some(old => Number(old.id) === Number(task.id)) || task.status === "done")) throw new Error("任务清单已变化或仍有done任务，未关闭执行");
    await nativeRequest("execution", "close", args.executionId, form);
    const saved = await request(`/executions/${args.executionId}`);
    objectMatches(saved, "execution", args.executionId);
    if (saved.status !== "closed" || String(saved.realEnd ?? "").slice(0, 10) !== args.realEnd || Number(saved.project) !== Number(current.project)) throw new Error("关闭后的状态、实际完成日期或所属项目回读不一致");
    return { ...result, written: true, verified: true, closedTaskIds, execution: saved };
  } catch (error) {
    throw new Error(`关闭结果可能部分生效，已确认关闭任务[${closedTaskIds.join(",")}]，请只读核实，不要盲目重试：${error.message}`);
  }
}

async function updateProjectSettings(args, request, nativeRequest) {
  const current = await request(`/projects/${args.projectId}`);
  objectMatches(current, "project", args.projectId);
  if (current.model !== "scrum") throw new Error("当前设置维护仅支持Scrum项目");
  const view = await nativeRequest("project", "edit", args.projectId);
  const project = view?.project;
  objectMatches(project, "project", args.projectId);
  const fields = ["name", "code", "team", "parent", "model", "begin", "end", "days", "budget", "budgetUnit", "desc", "PM", "auth", "acl", "whitelist"];
  const value = (object, key) => key === "PM" ? account(object[key]) : ["budget", "days"].includes(key) ? String(Number(object[key])) : key === "whitelist" ? (Array.isArray(object[key]) ? object[key].map(account).join(",") : String(object[key] ?? "")) : String(object[key] ?? "").replace(/\r\n/g, "\n");
  for (const key of fields) {
    if (!Object.hasOwn(project, key) || value(current, key) !== value(project, key)) throw new Error(`项目${key}原值缺失或读取期间已变化，未继续写入`);
  }
  if (!view.linkedProducts || typeof view.linkedProducts !== "object") throw new Error("缺少项目关联产品，未继续写入");
  if (Object.values(view.linkedProducts).some(product => product.type !== "normal" || (product.plan && String(product.plan) !== "0"))) throw new Error("当前设置维护仅支持无关联计划的普通产品，未继续写入");
  const products = Object.keys(view.linkedProducts).map(Number);
  if (!products.length || products.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error("项目产品ID无效，未继续写入");
  const expected = { ...project, ...args.data };
  const result = { projectId: args.projectId, dryRun: args.dryRun !== false, changes: args.data };
  if (result.dryRun) return { ...result, written: false };
  const latest = await request(`/projects/${args.projectId}`);
  if (fields.some(key => value(current, key) !== value(latest, key))) throw new Error("项目已变化，请重新预览；未继续写入");
  const form = new URLSearchParams();
  for (const key of fields) {
    if (key === "whitelist") {
      value(expected, key).split(",").filter(Boolean).forEach(user => form.append("whitelist[]", user));
    } else form.set(key, value(expected, key));
  }
  products.forEach(id => form.append("products[]", String(id)));
  form.set("uid", "");
  await nativeRequest("project", "edit", args.projectId, form);
  const saved = await request(`/projects/${args.projectId}`);
  for (const key of fields) if (value(expected, key) !== value(saved, key)) throw new Error(`项目设置提交后${key}回读不一致，可能已部分生效；请只读核实，不要盲目重试`);
  const savedView = await nativeRequest("project", "edit", args.projectId);
  if (JSON.stringify(view.linkedProducts) !== JSON.stringify(savedView.linkedProducts)) throw new Error("项目关联产品回读不一致；请只读核实，不要盲目重试");
  return { ...result, written: true, verified: true, project: saved };
}

async function copyTeam(args, request, nativeRequest) {
  const { sourceType, sourceId, targetType, targetId } = args;
  if (sourceType === targetType && sourceId === targetId) throw new Error("来源与目标不能是同一团队");
  const sourceObject = await request(`/${sourceType === "project" ? "projects" : "executions"}/${sourceId}`);
  const targetObject = await request(`/${targetType === "project" ? "projects" : "executions"}/${targetId}`);
  objectMatches(sourceObject, sourceType, sourceId);
  objectMatches(targetObject, targetType, targetId);
  const targetDays = Number(targetObject.days);
  if (!Number.isSafeInteger(targetDays) || targetDays < 0) throw new Error("目标对象缺少有效可用工作日，未继续写入");
  const source = await team(sourceType, sourceId, nativeRequest);
  const target = await team(targetType, targetId, nativeRequest);
  const merged = new Map(target.members.map((member) => [member.account, memberValues(member)]));
  const added = [];
  for (const member of source.members) {
    if (!merged.has(member.account)) {
      merged.set(member.account, memberValues(member, targetDays));
      added.push(member.account);
    }
  }
  const members = [...merged.values()];
  if (targetType === "project" && Number(targetObject.days) > 0 && members.some((member) => member.days > Number(targetObject.days))) {
    throw new Error("成员工作日超出目标项目可用工作日，未继续写入");
  }
  const result = { sourceType, sourceId, targetType, targetId, dryRun: args.dryRun !== false, added, preserved: target.members.map((member) => member.account), members };
  if (result.dryRun || !added.length) return { ...result, written: false };
  // 原生成员维护按完整名单更新；先保留全部原成员并检查并发变化，永不提供移除模式。
  const latest = await team(targetType, targetId, nativeRequest);
  if (signature(latest.members) !== signature(target.members)) throw new Error("目标团队已变化，请重新预览；未继续写入");
  const form = new URLSearchParams({ removeExecution: "no" });
  members.forEach((member, index) => {
    for (const [field, value] of Object.entries({ accounts: member.account, roles: member.role, days: member.days, hours: member.hours, limited: member.limited })) {
      form.set(`${field}[${index}]`, String(value));
    }
  });
  await nativeRequest(targetType, "manageMembers", targetId, form);
  const saved = await team(targetType, targetId, nativeRequest);
  for (const expected of members) {
    const actual = saved.members.find((member) => member.account === expected.account);
    if (!actual || ["role", "days", "hours", "limited"].some((key) => ["days", "hours"].includes(key) ? Number(actual[key]) !== Number(expected[key]) : String(actual[key]) !== String(expected[key]))) {
      throw new Error("团队维护后回读不一致，结果可能已部分生效；请只读核实，不要盲目重试");
    }
  }
  return { ...result, written: true, verified: true, team: saved };
}

async function uploadAttachment(args, request, nativeRequest) {
  if (!isAbsolute(args.filePath)) throw new Error("filePath必须为本机绝对路径");
  if (![".pdf", ".png", ".jpg", ".jpeg", ".gif"].includes(extname(args.filePath).toLowerCase())) throw new Error("仅支持PDF或图片附件");
  const info = await stat(args.filePath);
  if (!info.isFile() || !info.size || info.size > 20 * 1024 * 1024) throw new Error("附件必须为非空普通文件且不超过20MiB");
  const task = await request(`/tasks/${args.taskId}`);
  const view = await nativeRequest("task", "edit", args.taskId);
  const current = view?.task;
  if (Number(task?.id) !== args.taskId || Number(current?.id) !== args.taskId || task.deleted || current.deleted === "1") {
    throw new Error("任务不存在、已删除或对象ID不匹配");
  }
  if (!["wait", "doing"].includes(current.status) || current.mode || Number(current.parent) !== 0 || (Array.isArray(task.team) && task.team.length)) {
    throw new Error("当前附件接口仅支持未开始或进行中的普通单人任务，不修改多人、父子或已结束任务");
  }
  for (const key of ["name", "type", "desc", "assignedTo", "estimate", "left", "consumed", "story", "parent", "execution", "module", "status"]) {
    const before = key === "assignedTo" ? account(task[key]) : task[key];
    const latest = key === "assignedTo" ? account(current[key]) : current[key];
    if (String(before ?? "") !== String(latest ?? "")) throw new Error("读取期间任务已变化，请重新检查；未继续写入");
  }
  const fields = ["name", "type", "desc", "assignedTo", "pri", "estimate", "left", "consumed", "story", "parent", "execution", "module", "status", "estStarted", "deadline", "realStarted"];
  const form = new FormData();
  for (const key of fields) {
    if (!Object.hasOwn(current, key)) throw new Error(`任务原值缺少${key}，无法安全保留字段`);
    form.set(key, key === "assignedTo" ? account(current[key]) : String(current[key] ?? ""));
  }
  const recipients = Array.isArray(current.mailto) ? current.mailto : String(current.mailto ?? "").split(",").filter(Boolean);
  recipients.forEach((recipient) => form.append("mailto[]", account(recipient)));
  form.set("comment", "");
  form.set("uid", "");
  const fileName = basename(args.filePath);
  if (args.dryRun !== false) return { taskId: args.taskId, dryRun: true, fileName, size: info.size, uploadable: true };
  form.set("files[]", new Blob([await readFile(args.filePath)]), fileName);
  const beforeIds = new Set(Object.values(task.files ?? {}).map((file) => String(file.id)));
  await nativeRequest("task", "edit", args.taskId, form);
  const saved = await request(`/tasks/${args.taskId}`);
  const files = Object.values(saved.files ?? {}).filter((file) => !beforeIds.has(String(file.id)) && file.title === fileName && Number(file.size) === info.size);
  if (files.length !== 1) throw new Error("上传后未确认唯一匹配附件，结果可能已生效；请只读核实，不要盲目重试");
  for (const key of ["name", "type", "desc", "assignedTo", "pri", "estimate", "left", "consumed", "story", "parent", "execution", "module", "status", "estStarted", "deadline", "realStarted"]) {
    const oldValue = key === "assignedTo" ? account(task[key]) : task[key];
    const newValue = key === "assignedTo" ? account(saved[key]) : saved[key];
    if (String(oldValue ?? "") !== String(newValue ?? "")) throw new Error(`附件已上传，但任务${key}发生变化；请只读核实，不要重试`);
  }
  return { taskId: args.taskId, verified: true, file: files[0] };
}

export async function callWorkflowTool(name, args, request, nativeRequest) {
  argumentsFor(name, args);
  if (name === "get_execution") return request(`/executions/${args.executionId}`);
  if (name === "close_execution") return closeExecution(args, request, nativeRequest);
  if (name === "get_project_team") return team("project", args.projectId, nativeRequest);
  if (name === "get_execution_team") return team("execution", args.executionId, nativeRequest);
  if (name === "update_project_settings") return updateProjectSettings(args, request, nativeRequest);
  if (name === "copy_team") return copyTeam(args, request, nativeRequest);
  return uploadAttachment(args, request, nativeRequest);
}
