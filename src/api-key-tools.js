export function apiKeyTools(businessTools) {
  return [
    {
      name: "configure_api_key",
      description: "独立配置禅道应用 API Key（REST v1 Token 请求头），不修改原有 SID 配置；成功仅表示配置已保存，需业务查询验证认证",
      inputSchema: {
        type: "object", properties: { url: { type: "string" }, appKey: { type: "string", minLength: 1 } },
        required: ["url", "appKey"], additionalProperties: false,
      },
    },
    {
      name: "call_api_key_tool",
      description: "使用独立 API Key 连接调用现有业务工具，业务参数和预览规则与原工具相同；不回退 SID，不提供任意路由或删除能力",
      inputSchema: {
        type: "object", properties: {
          tool: { type: "string", enum: businessTools.map(tool => tool.name) },
          arguments: { type: "object", description: "所选业务工具的原始参数，按该工具 inputSchema 提供" },
        }, required: ["tool", "arguments"], additionalProperties: false,
      },
    },
  ];
}

export function validateApiKeyConfig(args) {
  if (!args || typeof args !== "object" || Array.isArray(args) ||
      Object.keys(args).some(key => !["url", "appKey"].includes(key))) throw new Error("仅支持url和appKey");
  let url;
  try { url = new URL(args.url); } catch { throw new Error("请提供有效的禅道URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("禅道URL只允许不含凭据、查询参数及片段的HTTP或HTTPS地址");
  }
  if (typeof args.appKey !== "string" || !args.appKey.trim() || /[\r\n]/.test(args.appKey)) throw new Error("请提供非空API Key，不能包含换行");
  return { url: args.url, appKey: args.appKey };
}

export function apiKeyInvocation(args, businessTools) {
  if (!args || typeof args !== "object" || Array.isArray(args) ||
      Object.keys(args).some(key => !["tool", "arguments"].includes(key))) throw new Error("仅支持tool和arguments");
  const tool = businessTools.find(tool => tool.name === args.tool);
  if (!tool) throw new Error("不支持的API Key业务工具");
  const input = args.arguments;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("arguments必须为对象");
  const schema = tool.inputSchema;
  for (const key of schema.required ?? []) if (!Object.hasOwn(input, key)) throw new Error(`缺少参数${key}`);
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(schema.properties, key)) throw new Error(`不支持参数${key}`);
    if (key.endsWith("Id") && (!Number.isSafeInteger(value) || value < 1)) throw new Error(`${key}必须为正整数`);
  }
  return { name: tool.name, args: input };
}
