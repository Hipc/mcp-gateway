/**
 * @module utils/helpers
 * @description 通用工具函数集。
 * 提供 JSON 安全解析、命令字符串清理、Windows shell 启动判断等基础能力。
 */

import { spawn } from "node:child_process";

/** 在 Windows 上需要通过 shell 启动的包管理器命令集合 */
const WINDOWS_CMD_LAUNCHERS = new Set(["npm", "npx", "pnpm", "yarn", "bunx"]);

/**
 * 安全地解析 JSON 字符串，解析失败时返回指定的默认值而不抛出异常。
 *
 * @param {string} value    - 待解析的 JSON 字符串
 * @param {*}      fallback - 解析失败时的返回值
 * @returns {*} 解析成功返回解析结果，失败返回 fallback
 */
export function parseJsonSafely(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/**
 * 清理命令字符串，去除首尾空白。
 * 如果输入不是字符串类型则原样返回。
 *
 * @param {string|*} command - 待清理的命令字符串
 * @returns {string|*} 清理后的命令字符串，或原值（非字符串输入）
 */
export function resolveCommand(command) {
  // 非字符串类型不做处理
  if (typeof command !== "string") {
    return command;
  }
  // 去除首尾空白
  return command.trim();
}

/**
 * 判断某个 MCP 服务命令是否需要通过 shell 执行。
 * 决策优先级：
 * 1. 服务配置中显式设置了 `shell: true/false`，直接使用该值
 * 2. 非 Windows 平台默认不使用 shell
 * 3. Windows 上，若命令包含路径分隔符或文件扩展名，直接执行
 * 4. Windows 上，若命令为 npm/npx/pnpm/yarn/bunx 等，需要 shell 执行
 *
 * @param {object} service - MCP 服务配置对象，可包含 `shell` 布尔属性
 * @param {string} command - 待执行的命令字符串
 * @returns {boolean} 是否需要通过 shell 执行
 */
export function shouldUseShell(service, command) {
  // 服务配置中显式要求使用 shell
  if (service.shell === true) {
    return true;
  }
  // 服务配置中显式禁止使用 shell
  if (service.shell === false) {
    return false;
  }
  // 非 Windows 平台默认不需要 shell
  if (process.platform !== "win32" || typeof command !== "string") {
    return false;
  }

  // 命令转小写用于比较
  const normalized = command.trim().toLowerCase();
  // 检查命令是否包含路径分隔符（/ 或 \）
  const hasPathSeparator =
    normalized.includes("/") || normalized.includes("\\");
  // 检查命令是否包含文件扩展名（如 .cmd、.exe）
  const hasExtension = /\.[^./\\]+$/.test(normalized);
  // 包含路径分隔符或扩展名的命令可以直接执行，不需要 shell
  if (hasPathSeparator || hasExtension) {
    return false;
  }
  // npm/npx/pnpm 等命令在 Windows 上需要 shell 来解析 .cmd 后缀
  return WINDOWS_CMD_LAUNCHERS.has(normalized);
}

// 重新导出 spawn，供其他模块统一从此处导入
export { spawn };
