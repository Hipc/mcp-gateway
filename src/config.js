/**
 * @module config
 * @description 配置文件管理模块。
 * 负责 .env 环境变量加载、mcp.json 配置文件的读取/保存/持久化,
 * 以及根据工作目录解析相关文件路径。
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * 从 .env 文件加载环境变量。
 * 支持 `#` 开头的注释行和引号包裹的值，不支持多行值。
 *
 * @param {string} dotEnvPath - .env 文件的绝对路径
 * @returns {Record<string, string>} 解析出的键值对对象；文件不存在时返回空对象
 */
export function loadDotEnv(dotEnvPath) {
  // .env 文件不存在则返回空对象
  if (!existsSync(dotEnvPath)) {
    return {};
  }

  // 读取 .env 文件原始文本内容
  const raw = readFileSync(dotEnvPath, "utf8");
  // 存储解析出的键值对
  const entries = {};

  // 按行遍历 .env 文件内容
  for (const line of raw.split(/\r?\n/)) {
    // 去除行首尾空白字符
    const trimmed = line.trim();
    // 跳过空行和注释行（以 # 开头）
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    // 找到等号的位置，以此分隔键和值
    const separator = trimmed.indexOf("=");
    // 等号不存在或在第 0 位（键为空），跳过该行
    if (separator <= 0) {
      continue;
    }
    // 提取并清理键名
    const key = trimmed.slice(0, separator).trim();
    // 提取等号右侧的值（去除首尾空白）
    const rawValue = trimmed.slice(separator + 1).trim();
    // 检查值是否被匹配的引号包裹（单引号或双引号）
    const hasMatchingQuotes =
      (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
      (rawValue.startsWith("'") && rawValue.endsWith("'"));
    // 如果被引号包裹则去除引号，否则保持原值
    const value = hasMatchingQuotes ? rawValue.slice(1, -1) : rawValue;
    entries[key] = value;
  }
  return entries;
}

/**
 * 加载并解析 mcp.json 配置文件。
 *
 * @param {string} configPath - mcp.json 的绝对路径
 * @returns {object} 解析后的 JSON 配置对象
 * @throws {Error} 配置文件不存在时抛出错误
 */
export function loadMcpConfig(configPath) {
  // 检查配置文件是否存在
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }
  // 读取文件内容并解析为 JSON
  const raw = readFileSync(configPath, "utf8");
  return JSON.parse(raw);
}

/**
 * 将 MCP 服务配置持久化写入 mcp.json 文件。
 * 先写入临时文件再重命名，确保原子性写入，避免配置损坏。
 * 对于对象类型的服务配置，会自动去除 name 字段后再保存。
 *
 * @param {string} configPath - mcp.json 的绝对路径
 * @param {Map<string, object>} servicesMap - 当前所有服务的 Map 集合
 */
export function saveMcpConfig(configPath, servicesMap) {
  // 构建 mcpServers 对象，用于序列化到配置文件
  const mcpServers = {};
  // 遍历所有服务条目，转换为普通对象结构
  for (const [name, service] of servicesMap) {
    if (service && typeof service === "object" && !Array.isArray(service)) {
      // 对象类型配置：拷贝副本并移除运行时追加的 name 字段
      const persistedService = { ...service };
      delete persistedService.name;
      mcpServers[name] = persistedService;
      continue;
    }
    // 非对象类型（如字符串）直接保存
    mcpServers[name] = service;
  }
  // 序列化为格式化的 JSON 字符串
  const serialized = JSON.stringify({ mcpServers }, null, 2) + "\n";
  // 生成唯一临时文件路径，避免并发写入冲突
  const tempPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;

  // 先写入临时文件
  writeFileSync(tempPath, serialized, "utf8");
  // 原子性重命名为目标文件（rename 在同文件系统上是原子的）
  renameSync(tempPath, configPath);
}

/**
 * 根据工作目录和环境变量解析配置文件路径。
 * 优先使用环境变量 MCP_CONFIG 指定的路径，否则使用工作目录下的 mcp.json。
 *
 * @param {string} cwd - 工作目录
 * @param {Record<string, string>} envFromFile - 从 .env 加载的环境变量
 * @returns {{ configPath: string, dotEnvPath: string }} 配置文件和 .env 文件的绝对路径
 */
export function resolvePaths(cwd, envFromFile) {
  // 优先使用环境变量 MCP_CONFIG 指定的路径，否则默认为 cwd/mcp.json
  const configPath = envFromFile.MCP_CONFIG
    ? path.resolve(cwd, envFromFile.MCP_CONFIG)
    : path.resolve(cwd, "mcp.json");
  // .env 文件始终在 cwd 目录下
  const dotEnvPath = path.resolve(cwd, ".env");
  return { configPath, dotEnvPath };
}
