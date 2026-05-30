/**
 * @module utils/mcp-config
 * @description MCP 配置规范化与服务描述工具。
 * 将多种格式的 MCP 配置（对象格式、数组格式）统一转换为 Map 结构，
 * 并提供服务配置序列化和传输类型判断能力。
 */

/**
 * 将原始 MCP 配置规范化为 Map<string, Service> 结构。
 * 支持以下多种配置格式的自动识别：
 * - `{ mcpServers: { name: config } }` — 标准格式
 * - `{ servers: { name: config } }` — 别名格式
 * - `{ mcps: [{ name, ...config }] }` — 数组格式
 * - `{ mcp: { name: config } }` — 单数别名格式
 * - 直接传对象或数组
 *
 * @param {object|Array} rawConfig - 原始配置对象
 * @returns {Map<string, object>} 以服务名为键、服务配置为值的 Map
 */
export function normalizeMcpConfig(rawConfig) {
  // 按优先级依次尝试不同的配置键名
  const source =
    rawConfig?.mcpServers ??
    rawConfig?.servers ??
    rawConfig?.mcps ??
    rawConfig?.mcp ??
    rawConfig ??
    {};
  // 数组格式：每个元素必须有 name 字段；对象格式：键即为服务名
  const entries = Array.isArray(source)
    ? source.map((item) => [item?.name, item])
    : Object.entries(source).map(([name, item]) => [name, { name, ...item }]);

  // 构建最终的 Map 集合
  const services = new Map();
  // 遍历所有解析出的条目，过滤无效项
  for (const [name, service] of entries) {
    // 跳过名称为空或配置为空的条目
    if (!name || !service) {
      continue;
    }
    services.set(name, service);
  }
  return services;
}

/**
 * 构建服务的响应数据，将服务名和配置合并为可返回给客户端的对象。
 * 对象类型配置会展开合并，非对象类型则包裹在 config 字段中。
 *
 * @param {string} name    - 服务名称
 * @param {*}      service - 服务配置值（对象或其他类型）
 * @returns {object} 包含 name 和配置信息的响应对象
 */
export function serviceResponse(name, service) {
  // 对象类型：展开服务配置并与 name 合并
  if (service && typeof service === "object" && !Array.isArray(service)) {
    return { name, ...service };
  }
  // 非对象类型（如字符串或数字）：包裹在 config 字段中
  return { name, config: service };
}

/**
 * 检查服务配置是否包含传输层参数（command 或 url）。
 * 至少需要其中之一才能确定服务的通信方式。
 *
 * @param {object} service - 服务配置对象
 * @returns {boolean} 是否包含有效的传输配置
 */
export function hasTransportConfig(service) {
  // command（stdio 模式）或 url（web/http 模式）至少需要一个
  return Boolean(service?.command || service?.url);
}
