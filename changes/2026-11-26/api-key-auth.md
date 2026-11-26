# 新增独立API Key认证能力

- 新增configure_api_key、call_api_key_tool，读取ZENTAO_APP_KEY，通过Token请求头复用现有业务工具；保留原SID工具、配置和Cookie认证。
- 每次新入口调用持有独立连接快照；原生表单前先核对身份。保留业务字段校验、预览和写后回读，不开放任意路由或删除，不自动回退、登录和重试。
- 影响：src/index.js、src/api-key-tools.js、README及新增认证测试；数据库、菜单、定时任务无变更。原生操作增加一次身份查询；回退可恢复原SID入口。
- 验证：Node.js语法检查和157个单元/stdio集成测试通过；真实实例任务6919只读查询成功。按用户授权通过新入口实际完成任务6919并回读done、consumed=4、left=0；其他真实业务写入未执行。
- 本机zentao-mcp-operations技能已改为优先选择新能力，SID流程保留。
