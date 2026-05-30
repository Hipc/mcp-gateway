/**
 * @module app
 * @description Express 应用工厂模块。
 * 负责创建和组装完整的 Express 应用实例，包括：
 * - JSON body 解析中间件（仅对 /api/services 路由生效）
 * - Bearer Token 认证中间件
 * - /admin 管理后台页面路由
 * - /api/services 管理路由
 * - /mcp 代理路由
 * - 404 和 500 错误处理
 */

import express from "express";
import { createAuthMiddleware } from "./middleware/auth.js";
import { createServicesRouter } from "./routes/services.js";
import { createMcpRouter } from "./routes/mcp.js";
import { createAdminRouter } from "./routes/admin.js";
import { normalizeMcpConfig } from "./utils/mcp-config.js";
import { spawn } from "node:child_process";

/**
 * 创建完整的 Express 应用实例，挂载所有路由和中间件。
 *
 * @param {object}   options                         - 应用配置选项
 * @param {Map<string, object>} options.services     - 共享的 MCP 服务 Map 集合（键为服务名，值为服务配置）
 * @param {string}   options.configPath              - mcp.json 配置文件的绝对路径
 * @param {string}   [options.authorizationToken=""] - Bearer token 认证令牌；为空时不启用认证
 * @param {Function} [options.spawnImpl=spawn]       - 自定义的子进程创建函数（主要用于单元测试注入 mock）
 * @param {Function} [options.fetchImpl=fetch]       - 自定义的 fetch 函数（主要用于单元测试注入 mock）
 * @returns {{ app: import("express").Express, sseConnections: Map<string, object> }}
 *   返回 Express app 实例和共享的 SSE 连接管理 Map
 */
export function createApp({
  services,
  configPath,
  authorizationToken = "",
  spawnImpl = spawn,
  fetchImpl = fetch,
}) {
  // SSE 长连接会话注册表：Map<sessionId, { res, process, lineBuffer, serviceName }>
  const sseConnections = new Map();

  // 创建 Express 应用实例
  const app = express();

  // 仅对 /api/services 路径启用 JSON body 自动解析
  // /mcp 路由需要读取原始 raw body 用于转发，不在全局启用
  app.use("/api/services", express.json());

  // 对所有路由启用 Bearer Token 认证（token 未配置时自动放行）
  app.use(createAuthMiddleware(authorizationToken));

  // 挂载 MCP 服务管理 CRUD 路由到 /api/services
  app.use(
    "/api/services",
    createServicesRouter({ services, configPath, sseConnections }),
  );
  // 挂载 MCP 代理路由到 /mcp（处理 SSE、Web 转发、Stdio 转发）
  app.use(
    "/mcp",
    createMcpRouter({ services, sseConnections, spawnImpl, fetchImpl }),
  );
  // 挂载管理后台页面到 /admin
  app.use("/admin", createAdminRouter());

  // 404 兜底处理：未匹配到任何路由时返回 404
  app.use((req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  // 全局错误处理中间件：捕获路由中抛出的未处理异常
  app.use((err, req, res, _next) => {
    res.status(500).json({ error: err?.message || "Internal server error" });
  });

  return { app, sseConnections };
}

/**
 * 向后兼容的包装函数：创建 Express app 并返回 app 本身（可作为 http.createServer 的 handler）。
 * 保留此函数是为了兼容现有测试代码中 `createServer(createGatewayHandler(...))` 的用法。
 *
 * @deprecated 推荐直接使用 createApp() 并通过 app.listen() 启动服务
 * @param {object}   options                         - 与 createApp 相同的配置选项
 * @param {Map<string, object>} options.services     - 共享的 MCP 服务 Map 集合
 * @param {string}   options.configPath              - mcp.json 配置文件的绝对路径
 * @param {string}   [options.authorizationToken=""] - Bearer token 认证令牌
 * @param {Function} [options.spawnImpl]             - 自定义的子进程创建函数
 * @param {Function} [options.fetchImpl]             - 自定义的 fetch 函数
 * @returns {import("express").Express} Express 应用实例（兼容 Node.js http handler 接口）
 */
export function createGatewayHandler({
  services,
  configPath,
  authorizationToken = "",
  spawnImpl = spawn,
  fetchImpl = fetch,
}) {
  // 复用 createApp 创建应用，只取出 app 返回
  const { app } = createApp({
    services,
    configPath,
    authorizationToken,
    spawnImpl,
    fetchImpl,
  });
  return app;
}

// 重新导出 normalizeMcpConfig，方便外部从 app 模块统一导入
export { normalizeMcpConfig };
