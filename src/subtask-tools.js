import { positiveId, taskFields, validateData } from "./write-tools.js";

const fields = Object.fromEntries(["name", "type", "assignedTo", "module", "story", "pri", "estimate", "estStarted", "deadline", "desc"]
  .map(key => [key, taskFields[key]]));
export const subtaskTools = [{
  name: "create_subtask",
  description: "通过禅道17.0正式拆分流程创建一个子任务并回读父子关系；保留既有子任务及工时。默认预览，dryRun=false写入，结果不明不自动重试",
  inputSchema: {
    type: "object",
    properties: {
      parentTaskId: { type: "integer", minimum: 1, description: "父任务ID" },
      data: { type: "object", properties: fields, required: ["name", "type"], additionalProperties: false },
      dryRun: { type: "boolean", default: true },
    },
    required: ["parentTaskId", "data"], additionalProperties: false,
  },
}];
const account = value => typeof value === "string" ? value : value?.account ?? "";
const date = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && value !== "0000-00-00" ? value : "";
const description = value => String(value ?? "").replace(/<br\s*\/?>/gi, "\n").replace(/\r\n/g, "\n").replace(/\n+/g, "\n").trim();

function matches(task, data) {
  return Object.entries(data).every(([key, value]) => {
    if (key === "assignedTo") return account(task[key]) === value;
    if (key === "desc") return description(task[key]) === description(value);
    if (["estStarted", "deadline"].includes(key)) return date(task[key]) === value;
    if (typeof value === "number") return Number(task[key]) === value;
    return task[key] === value;
  });
}

export async function createSubtask(args, request, nativeRequest) {
  if (!args || typeof args !== "object" || Array.isArray(args) ||
      Object.keys(args).some(key => !["parentTaskId", "data", "dryRun"].includes(key))) throw new Error("不支持的子任务参数");
  positiveId(args.parentTaskId, "parentTaskId");
  if (args.dryRun !== undefined && typeof args.dryRun !== "boolean") throw new Error("dryRun必须为布尔值");
  const data = validateData(args.data, fields, ["name", "type"]);
  if (data.estStarted && data.deadline && data.deadline < data.estStarted) throw new Error("截止日期不能早于预计开始日期");
  const parent = await request(`/tasks/${args.parentTaskId}`);
  if (Number(parent?.id) !== args.parentTaskId || [true, 1, "1"].includes(parent.deleted)) throw new Error("父任务不存在或已删除");
  const executionId = positiveId(Number(parent.execution), "父任务execution");
  if (Number(parent.parent) > 0 || parent.mode || (parent.team?.length ?? 0) > 1) throw new Error("17.0不支持为子任务或多人任务继续拆分");
  if (!Array.isArray(parent.children)) throw new Error("父任务缺少完整子任务清单，未继续创建");
  const sameName = parent.children.filter(child => child.name === data.name);
  if (sameName.length) {
    if (sameName.length === 1) {
      const existing = await request(`/tasks/${positiveId(Number(sameName[0].id), "子任务ID")}`);
      if (Number(existing.id) === Number(sameName[0].id) && ![true, 1, "1"].includes(existing.deleted) &&
          Number(existing.parent) === args.parentTaskId && Number(existing.execution) === executionId && matches(existing, data)) {
        return { parentTaskId: args.parentTaskId, written: false, alreadyExists: true, verified: true, task: existing };
      }
    }
    throw new Error("已存在同名子任务但字段不匹配，请先核对；未重复创建");
  }
  // 沿用父任务的归属、优先级和已排日期，不代填预计工时。
  const values = { module: Number(parent.module ?? 0), story: Number(parent.story ?? 0), pri: Number(parent.pri ?? 3),
    estimate: 0, assignedTo: "", estStarted: date(parent.estStarted), deadline: date(parent.deadline), desc: "", ...data };
  validateData(values, fields, ["name", "type"]);
  if (values.estStarted && values.deadline && values.deadline < values.estStarted) throw new Error("截止日期不能早于预计开始日期");
  if (args.dryRun !== false) return { parentTaskId: args.parentTaskId, executionId, dryRun: true, written: false, data: values };
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) form.set(`${key}[1]`, String(value));
  form.set("parent[1]", String(args.parentTaskId));
  form.set("color[1]", "");
  form.set("vision[1]", parent.vision || "rnd");
  const beforeIds = new Set(parent.children.map(child => Number(child.id)));
  try {
    await nativeRequest("task", "batchCreate", executionId, form, args.parentTaskId);
    const saved = await request(`/tasks/${args.parentTaskId}`);
    if (Number(saved.id) !== args.parentTaskId || [true, 1, "1"].includes(saved.deleted) ||
        Number(saved.execution) !== executionId || Number(saved.parent) !== -1 ||
        !Array.isArray(saved.children) || saved.name !== parent.name || saved.desc !== parent.desc ||
        parent.children.some(child => !saved.children.some(current => Number(current.id) === Number(child.id)))) {
      throw new Error("父任务或既有子任务回读不一致");
    }
    const added = saved.children.filter(child => !beforeIds.has(Number(child.id)));
    const candidates = added.filter(child => child.name === values.name && child.type === values.type);
    if (candidates.length !== 1) throw new Error("未确认唯一的新子任务");
    const child = await request(`/tasks/${positiveId(Number(candidates[0].id), "新子任务ID")}`);
    if (Number(child.id) !== Number(candidates[0].id) || Number(child.parent) !== args.parentTaskId || Number(child.execution) !== executionId ||
        [true, 1, "1"].includes(child.deleted) || !matches(child, values)) throw new Error("新子任务字段或父子关系回读不一致");
    return { parentTaskId: args.parentTaskId, executionId, written: true, verified: true, task: child,
      parentStatusBefore: parent.status, parentStatusAfter: saved.status,
      // 原生流程可将已有开发工时转存为继承子任务，不把它误判为重复创建。
      additionalChildren: added.filter(item => Number(item.id) !== Number(child.id)).map(item => ({
        id: item.id, name: item.name, type: item.type, status: item.status, consumed: item.consumed,
      })) };
  } catch (error) {
    throw new Error(`子任务创建或回读未确认：${error.message}；可能已生效，请只读核实，不要盲目重试`);
  }
}
