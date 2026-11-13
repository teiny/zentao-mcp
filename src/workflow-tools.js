import { positiveId, validateData } from "./write-tools.js";
import { callListTool } from "./list-tools.js";

const id = { type: "integer", minimum: 1 };
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


export async function callWorkflowTool(name, args, request, nativeRequest) {
  argumentsFor(name, args);
  if (name === "get_execution") return request(`/executions/${args.executionId}`);
  return closeExecution(args, request, nativeRequest);
}
