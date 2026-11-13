const text = (description) => ({ type: "string", description });
const integer = (description, minimum = 0) => ({ type: "integer", minimum, description });
const hours = { type: "number", minimum: 0, description: "预计工时" };
const date = (description) => ({ type: "string", format: "date", description });
const optionalDate = (description) => ({ description, anyOf: [date(description), { type: "string", enum: [""] }] });
const strings = (description) => ({ type: "array", items: { type: "string" }, description });
const priority = { type: "integer", minimum: 1, maximum: 4, description: "优先级（1最高）" };

const productFields = {
  name: text("产品名称"), code: text("产品代号"), program: integer("项目集ID"),
  line: integer("产品线ID"), PO: text("产品负责人账号"), QD: text("测试负责人账号"),
  RD: text("发布负责人账号"), type: { ...text("产品类型"), enum: ["normal", "branch", "platform"] },
  desc: text("产品描述"), acl: { ...text("访问控制"), enum: ["open", "private"] },
  whitelist: strings("白名单账号"),
};
const projectFields = {
  name: text("项目名称"), code: text("项目代号"), parent: integer("项目集ID"),
  PM: text("项目负责人账号"), budget: { type: "number", minimum: 0, description: "预算金额" },
  budgetUnit: { ...text("预算币种"), enum: ["CNY", "USD"] }, days: integer("可用工作日"),
  desc: text("项目描述"), acl: { ...text("访问控制"), enum: ["open", "private"] },
  whitelist: strings("白名单账号"), auth: { ...text("权限控制"), enum: ["extend", "reset"] },
  begin: date("计划开始日期，不能为空"), end: date("计划结束日期，不能为空"),
};
const executionFields = {
  name: text("执行名称"), code: text("执行代号"),
  begin: date("计划开始日期，不能为空"), end: date("计划结束日期，不能为空"),
  days: integer("可用工作日"), desc: text("执行描述"),
  lifetime: { ...text("执行周期"), enum: ["short", "long", "ops"] },
  PO: text("产品负责人账号，空字符串表示不指定"), PM: text("执行负责人账号，空字符串表示不指定"),
  QD: text("测试负责人账号，空字符串表示不指定"), RD: text("发布负责人账号，空字符串表示不指定"),
  acl: { ...text("访问控制"), enum: ["open", "private"] }, whitelist: strings("白名单账号"),
  products: { type: "array", items: integer("产品ID", 1), description: "关联产品ID" },
};
const requirementFields = {
  module: integer("模块ID"), source: text("需求来源"), sourceNote: text("来源备注"),
  pri: priority, category: text("需求类型，如feature、interface、performance、safe、experience、improve、other"),
  estimate: hours, keywords: text("关键词"),
};
const requirementContent = {
  title: text("需求标题"), spec: text("需求描述"), verify: text("验收标准"),
};
const bugFields = {
  title: text("Bug标题"), severity: { type: "integer", minimum: 1, maximum: 4, description: "严重程度" },
  pri: priority, type: text("Bug类型，如codeerror、config、install、security、performance、others"),
  branch: integer("产品分支ID"), module: integer("模块ID"), execution: integer("执行ID"),
  keywords: text("关键词"), os: text("操作系统"), browser: text("浏览器"), steps: text("重现步骤"),
  task: integer("关联任务ID"), story: integer("关联需求ID"), deadline: date("截止日期，YYYY-MM-DD"),
  openedBuild: strings("影响版本ID字符串，可使用trunk"),
};
const taskFields = {
  name: text("任务名称"), type: text("任务类型，如devel、test、design、request、study、discuss、ui、affair、misc"),
  assignedTo: text("指派给账号；省略或空字符串表示未指派"), module: integer("模块ID"), story: integer("关联需求ID"),
  fromBug: integer("来源Bug ID"), pri: priority, estimate: hours,
  estStarted: optionalDate("预计开始日期，YYYY-MM-DD；空字符串表示未设置"),
  deadline: optionalDate("截止日期，YYYY-MM-DD；空字符串表示未设置"), desc: text("任务描述"),
};

const definitions = {
  create_product: {
    description: "新建产品；data中的name、program、code必填",
    method: "POST", endpoint: () => "/products", fields: productFields, required: ["name", "program", "code"],
  },
  update_product: {
    description: "修改产品；data仅填写需要变更的字段，不支持删除标记",
    method: "PUT", id: "productId", endpoint: (id) => `/products/${id}`,
    fields: { ...productFields, status: { ...text("产品状态"), enum: ["normal", "closed"] } },
  },
  create_project: {
    description: "新建项目；必须提供项目名称、代号、起止日期和关联产品ID数组",
    method: "POST", endpoint: () => "/projects",
    fields: {
      name: projectFields.name, code: projectFields.code, parent: projectFields.parent,
      begin: date("计划开始日期，YYYY-MM-DD"), end: date("计划结束日期，YYYY-MM-DD"),
      products: { type: "array", minItems: 1, items: integer("产品ID", 1), description: "关联产品ID，不能为空" },
      model: text("项目模型，默认scrum"),
    },
    required: ["name", "code", "begin", "end", "products"],
  },
  update_project: {
    description: "修改项目基本信息；data仅填写需要变更的字段",
    method: "PUT", id: "projectId", endpoint: (id) => `/projects/${id}`, fields: projectFields,
  },
  create_execution: {
    description: "在项目下新建执行；name、code、begin、end、days必填，不伪造空开始日期",
    method: "POST", id: "projectId", endpoint: (id) => `/projects/${id}/executions`,
    fields: executionFields, required: ["name", "code", "begin", "end", "days"],
  },
  update_execution: {
    description: "修改执行基本信息、日期及关联产品；不直接修改状态或团队",
    method: "PUT", id: "executionId", endpoint: (id) => `/executions/${id}`, fields: executionFields,
  },
  create_requirement: {
    description: "新建研发需求；data中的product为产品ID，title、pri、category必填",
    method: "POST", endpoint: () => "/stories",
    fields: { ...requirementFields, ...requirementContent, product: integer("产品ID", 1), reviewer: strings("评审人账号") },
    required: ["product", "title", "pri", "category"],
  },
  update_requirement: {
    description: "修改需求的模块、来源、优先级等字段；标题、描述、验收标准请用change_requirement",
    method: "PUT", id: "storyId", endpoint: (id) => `/stories/${id}`, fields: requirementFields,
  },
  change_requirement: {
    description: "通过需求变更流程修改标题、描述或验收标准，可能触发重新评审",
    method: "POST", id: "storyId", endpoint: (id) => `/stories/${id}/change`, fields: requirementContent,
  },
  create_bug: {
    description: "在产品下新建Bug；data中的title、severity、pri、type必填",
    method: "POST", id: "productId", endpoint: (id) => `/products/${id}/bugs`, fields: bugFields,
    required: ["title", "severity", "pri", "type"],
  },
  update_bug: {
    description: "部分修改Bug；自动读取并保留API要求的标题、严重程度、优先级、类型原值",
    method: "PUT", id: "bugId", endpoint: (id) => `/bugs/${id}`, fields: bugFields, preserveBugRequired: true,
  },
  resolve_bug: {
    description: "解决Bug，调用独立状态流转接口；resolution必填，duplicate方案还必须提供duplicateBug",
    method: "POST", id: "bugId", endpoint: (id) => `/bugs/${id}/resolve`, required: ["resolution"],
    fields: {
      resolution: {
        ...text("解决方案：fixed已解决、bydesign设计如此、duplicate重复Bug、external外部原因、notrepro无法重现、postponed延期、willnotfix不予解决、tostory转需求"),
        enum: ["fixed", "bydesign", "duplicate", "external", "notrepro", "postponed", "willnotfix", "tostory"],
      },
      duplicateBug: integer("重复Bug ID，resolution为duplicate时必填，不能指向自身", 1),
      resolvedBuild: {
        description: "解决版本：正整数版本ID、版本ID字符串，或trunk（主干）",
        anyOf: [integer("版本ID", 1), { type: "string", pattern: "^(?:trunk|[1-9]\\d*)$" }],
      },
      resolvedDate: {
        ...text("解决日期或时间，YYYY-MM-DD或YYYY-MM-DD HH:mm:ss；省略时由禅道决定"),
        pattern: "^\\d{4}-\\d{2}-\\d{2}(?: \\d{2}:\\d{2}:\\d{2})?$",
      },
      assignedTo: text("解决后指派给的用户账号，不是显示姓名"),
      comment: text("解决备注"),
    },
  },
  create_task: {
    description: "在执行下新建任务；name、type必填，支持desc；指派和日期可省略或传空，服务端自定义必填校验仍生效",
    method: "POST", id: "executionId", endpoint: (id) => `/executions/${id}/tasks`, fields: taskFields,
    required: ["name", "type"],
  },
  update_task: {
    description: "修改任务基本字段；data仅填写需要变更的字段",
    method: "PUT", id: "taskId", endpoint: (id) => `/tasks/${id}`, fields: taskFields,
  },
};

export function positiveId(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name}必须为正整数ID`);
  return value;
}

function validateValue(value, schema, name) {
  if (schema.anyOf) {
    for (const option of schema.anyOf) {
      try { validateValue(value, option, name); return; } catch { /* 尝试其他声明的类型 */ }
    }
    throw new Error(`${name}不符合允许的类型或取值`);
  }
  const type = schema.type;
  const valid = type === "array" ? Array.isArray(value)
    : type === "integer" ? Number.isSafeInteger(value)
    : type === "number" ? typeof value === "number" && Number.isFinite(value)
    : typeof value === type;
  if (!valid) throw new Error(`${name}类型必须为${type}`);
  if (schema.minimum !== undefined && value < schema.minimum) throw new Error(`${name}不能小于${schema.minimum}`);
  if (schema.maximum !== undefined && value > schema.maximum) throw new Error(`${name}不能大于${schema.maximum}`);
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${name}不是支持的值`);
  if (schema.pattern && !new RegExp(schema.pattern).test(value)) throw new Error(`${name}格式不正确`);
  if (schema.format === "date" && (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) {
    throw new Error(`${name}必须为有效YYYY-MM-DD日期`);
  }
  if (type === "array") {
    if (schema.minItems && value.length < schema.minItems) throw new Error(`${name}不能为空`);
    value.forEach((item) => validateValue(item, schema.items, name));
  }
}

export function validateData(data, fields, required = []) {
  if (!data || typeof data !== "object" || Array.isArray(data) || Object.keys(data).length === 0) {
    throw new Error("data必须是包含待写入字段的非空对象");
  }
  for (const key of Object.keys(data)) {
    if (!Object.hasOwn(fields, key)) throw new Error(`不支持字段${key}；禁止删除及未声明字段`);
    validateValue(data[key], fields[key], key);
  }
  for (const key of required) {
    if (!Object.hasOwn(data, key) || (typeof data[key] === "string" && data[key].trim() === "")) {
      throw new Error(`缺少必填字段${key}`);
    }
  }
  return { ...data };
}

export const writeTools = Object.entries(definitions).map(([name, definition]) => ({
  name,
  description: definition.description,
  inputSchema: {
    type: "object",
    properties: {
      ...(definition.id ? { [definition.id]: integer(definition.id, 1) } : {}),
      data: {
        type: "object", description: "明确声明的业务字段，不支持删除标记或任意字段",
        properties: definition.fields, required: definition.required || [], minProperties: 1, additionalProperties: false,
      },
    },
    required: [...(definition.id ? [definition.id] : []), "data"],
    additionalProperties: false,
  },
}));

export function isWriteTool(name) {
  return Object.hasOwn(definitions, name);
}

export async function callWriteTool(name, args, request) {
  if (!isWriteTool(name)) throw new Error(`未知的写入工具: ${name}`);
  const definition = definitions[name];
  if (!args || Object.keys(args).some((key) => key !== "data" && key !== definition.id)) {
    throw new Error("写入参数只能包含对象ID和data");
  }
  const id = definition.id ? positiveId(args[definition.id], definition.id) : undefined;
  const body = validateData(args.data, definition.fields, definition.required);
  if (body.begin && body.end && body.end < body.begin) throw new Error("结束日期不能早于开始日期");
  if (body.estStarted && body.deadline && body.deadline < body.estStarted) throw new Error("截止日期不能早于预计开始日期");
  if (name === "create_task") {
    // 17.0 API检查字段存在，普通任务模型允许空日期；创建循环要求指派人为数组。
    body.assignedTo = [body.assignedTo ?? ""];
    body.estStarted ??= "";
    body.deadline ??= "";
  }
  if (name === "resolve_bug" && body.resolution === "duplicate") {
    positiveId(body.duplicateBug, "duplicateBug");
    if (body.duplicateBug === id) throw new Error("duplicateBug不能指向当前Bug自身");
  }
  if (definition.preserveBugRequired) {
    const required = ["title", "severity", "pri", "type"];
    if (required.some((key) => !Object.hasOwn(body, key))) {
      const current = await request(definition.endpoint(id));
      for (const key of required) if (!Object.hasOwn(body, key)) body[key] = current[key];
      validateData(body, definition.fields, required);
    }
  }
  return request(definition.endpoint(id), definition.method, body);
}
