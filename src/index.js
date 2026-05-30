/**
 * @module index
 * @description MCP Gateway 应用入口文件。
 * 负责加载运行时环境变量、读取 MCP 配置、初始化 Express 应用并启动 HTTP 服务。
 * 通过检测 `process.argv[1]` 判断是否作为主模块直接运行（vs 被其他模块导入）。
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDotEnv, loadMcpConfig, resolvePaths } from "./config.js";
import { createGatewayHandler, normalizeMcpConfig } from "./app.js";

/**
 * 获取运行时环境变量，将 .env 文件中的变量与 process.env 合并。
 * process.env 中的同名变量优先级更高，会覆盖 .env 文件中的值。
 *
 * @param {string} cwd - 当前工作目录，用于定位 .env 文件路径
 * @returns {Record<string, string>} 合并后的环境变量对象
 */
function getRuntimeEnv(cwd) {
  // 根据工作目录解析出 .env 文件路径
  const { dotEnvPath } = resolvePaths(cwd, process.env);
  // 从 .env 文件读取环境变量
  const envFromFile = loadDotEnv(dotEnvPath);
  // process.env 覆盖 .env 中的同名变量（系统环境变量优先）
  return { ...envFromFile, ...process.env };
}

/**
 * 创建 MCP Gateway 的 Express 应用实例。
 * 读取 .env 和 mcp.json 配置，初始化服务列表，组装 Express app。
 *
 * @param {string} [cwd=process.cwd()] - 项目根目录，用于定位配置文件
 * @returns {import("express").Express} 配置好的 Express 应用实例，可直接调用 .listen()
 */
export function createServer(cwd = process.cwd()) {
  // 获取合并后的运行时环境变量
  const runtimeEnv = getRuntimeEnv(cwd);
  // 根据环境变量解析 mcp.json 配置文件路径
  const { configPath } = resolvePaths(cwd, runtimeEnv);
  // 从配置文件加载原始 JSON 配置
  const rawConfig = loadMcpConfig(configPath);
  // 将原始配置规范化为 Map<string, Service> 结构
  const services = normalizeMcpConfig(rawConfig);
  // 创建 Express 应用（含所有路由和中间件）
  const app = createGatewayHandler({
    services,
    configPath,
    authorizationToken: runtimeEnv.AUTHORIZATION_TOKEN,
  });
  return app;
}

// 当前文件的绝对路径（用于判断是否作为主模块直接运行）
const thisFile = fileURLToPath(import.meta.url);

// 当作为主模块直接运行时（node src/index.js），启动 HTTP 服务器
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  // 获取合并后的运行时环境变量
  const runtimeEnv = getRuntimeEnv(process.cwd());
  // 从环境变量读取端口号，默认 3000
  const port = Number.parseInt(runtimeEnv.PORT || "3000", 10);
  // 创建 Express 应用实例
  const app = createServer(process.cwd());
  // 启动监听
  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`MCP gateway listening on http://localhost:${port}`);
  });
}
