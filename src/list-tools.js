import { positiveId } from "./write-tools.js";

const paginationProperties = {
  page: { type: "integer", minimum: 1, default: 1, description: "页码，从1开始，每次返回一页" },
  limit: { type: "integer", minimum: 1, maximum: 100, default: 20, description: "每页条数，1至100，默认20" },
};

const definitions = {
  get_products: {
    description: "分页获取产品列表；兼容API v1全量返回的产品接口",
    key: "products", endpoint: () => "/products", completeWithoutTotal: true,
  },
  get_projects: {
    description: "分页获取项目列表",
    key: "projects", endpoint: () => "/projects",
  },
  get_executions: {
    description: "分页获取执行列表；不传projectId查全局，传入则查该项目下的执行",
    key: "executions", scope: "projectId", optionalScope: true,
    endpoint: (id) => id ? `/projects/${id}/executions` : "/executions",
  },
  get_requirements: {
    description: "分页获取产品的研发需求列表",
    key: "stories", scope: "productId", endpoint: (id) => `/products/${id}/stories`,
  },
  get_tasks: {
    description: "分页获取执行的任务列表；executionId是执行ID，不是项目ID，可先用get_executions查询",
    key: "tasks", scope: "executionId", endpoint: (id) => `/executions/${id}/tasks`,
  },
  get_bugs: {
    description: "分页获取产品的Bug列表",
    key: "bugs", scope: "productId", endpoint: (id) => `/products/${id}/bugs`,
  },
};

export const listTools = Object.entries(definitions).map(([name, definition]) => ({
  name,
  description: `${definition.description}；返回实体数组及page、limit、total、totalPages、count、hasNext、nextPage`,
  inputSchema: {
    type: "object",
    properties: {
      ...(definition.scope ? {
        [definition.scope]: { type: "integer", minimum: 1, description: `${definition.scope}，正整数ID` },
      } : {}),
      ...paginationProperties,
      ...(name === "get_executions" ? { status: {
        type: "string", enum: ["all", "undone", "wait", "doing", "suspended", "closed"],
        default: "all", description: "执行状态，默认all，包含已关闭执行",
      } } : {}),
    },
    required: definition.scope && !definition.optionalScope ? [definition.scope] : [],
    additionalProperties: false,
  },
}));

export function isListTool(name) {
  return Object.hasOwn(definitions, name);
}

function nonnegativeInteger(value, name) {
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`列表响应的${name}必须为非负整数`);
  return number;
}

function paginate(result, definition, page, limit) {
  const rows = result?.[definition.key];
  if (!Array.isArray(rows)) throw new Error(`列表响应缺少${definition.key}数组`);
  const total = nonnegativeInteger(
    result.total ?? (definition.completeWithoutTotal ? rows.length : undefined), "total"
  );
  if (rows.length > total) throw new Error("列表条数超过服务端声明的total，无法确认分页结果");
  const totalPages = Math.ceil(total / limit);
  let items;
  if (rows.length === total) {
    // 产品等旧接口可能全量返回，只有确认集合完整才在本机分页。
    items = rows.slice((page - 1) * limit, page * limit);
  } else if (page > totalPages) {
    // 部分API会把越界页钳制为末页，向调用者返回其请求的空页。
    items = [];
  } else {
    const responsePage = nonnegativeInteger(result.page, "page");
    const responseLimit = nonnegativeInteger(result.limit, "limit");
    if (responsePage !== page || responseLimit !== limit || rows.length > limit) {
      throw new Error("服务端分页未按请求生效，拒绝将截断或重复数据当作完整分页结果");
    }
    items = rows;
  }
  const hasNext = page < totalPages;
  return {
    ...result, [definition.key]: items, page, limit, total, totalPages,
    count: items.length, hasNext, nextPage: hasNext ? page + 1 : null,
  };
}

export async function callListTool(name, args = {}, request) {
  if (!isListTool(name)) throw new Error(`未知的列表工具: ${name}`);
  const definition = definitions[name];
  if (!args || typeof args !== "object" || Array.isArray(args) ||
      Object.keys(args).some((key) => key !== "page" && key !== "limit" && key !== definition.scope && !(name === "get_executions" && key === "status"))) {
    throw new Error("列表参数只能包含page、limit及工具声明的范围ID");
  }
  const page = positiveId(args.page === undefined ? 1 : args.page, "page");
  const limit = positiveId(args.limit === undefined ? 20 : args.limit, "limit");
  if (limit > 100) throw new Error("limit不能大于100，请分页查询");
  let id;
  if (definition.scope && (!definition.optionalScope || args[definition.scope] !== undefined)) {
    id = positiveId(args[definition.scope], definition.scope);
  }
  const query = new URLSearchParams({ page: String(page), limit: String(limit) });
  if (name === "get_executions") {
    const status = args.status === undefined ? "all" : args.status;
    if (!["all", "undone", "wait", "doing", "suspended", "closed"].includes(status)) throw new Error("不支持的执行状态");
    query.set("status", status);
  }
  const result = await request(`${definition.endpoint(id)}?${query}`);
  return paginate(result, definition, page, limit);
}
