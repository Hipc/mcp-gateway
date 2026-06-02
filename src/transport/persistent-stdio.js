/**
 * @module transport/persistent-stdio
 * @description 持久化 Stdio 进程池。
 * 为 stdio 类型的 MCP 服务维护长生命周期的子进程，使有状态的 MCP 协议交互
 * （initialize → tools/list → tools/call）可以跨越多次 HTTP 请求正常工作。
 *
 * 每个服务名对应一个持久子进程。JSON-RPC 请求通过 id 匹配对应的响应；
 * 通知类消息（无 id）写入 stdin 后立即返回。
 */

import {
  resolveCommand,
  shouldUseShell,
  parseJsonSafely,
} from "../utils/helpers.js";
import { spawn } from "node:child_process";

/** 默认请求超时时间（毫秒） */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * 持久化 Stdio 进程池。
 * 管理一组长期存活的 MCP stdio 子进程，支持按 JSON-RPC id 匹配请求与响应。
 */
export class StdioProcessPool {
  /**
   * @param {Function} [spawnImpl=spawn] - 自定义 spawn 函数（用于测试注入 mock）
   */
  constructor(spawnImpl = spawn) {
    /** @type {Function} */
    this._spawnImpl = spawnImpl;
    /**
     * 进程注册表
     * @type {Map<string, ProcessEntry>}
     * 键为服务名，值为进程条目
     */
    this.processes = new Map();
  }

  /**
   * 向指定服务的持久进程发送一条 JSON-RPC 消息。
   * 如果该服务尚无活跃进程，会自动 spawn 一个。
   *
   * 根据消息类型自动选择处理策略：
   * - 有 `id` 的请求：写入 stdin，等待 id 匹配的响应
   * - 有 `method` 但无 `id` 的通知：写入 stdin，立即返回 null
   * - 无 `id` 也无 `method` 的通用消息：写入 stdin，等待下一条 stdout 输出
   *
   * @param {object}   service          - MCP 服务配置对象
   * @param {string}   service.name     - 服务名称
   * @param {string}   service.command  - 要执行的命令
   * @param {string[]} [service.args]   - 命令参数列表
   * @param {string}   [service.cwd]    - 子进程工作目录
   * @param {object}   [service.env]    - 子进程额外环境变量
   * @param {object}   message          - JSON-RPC 消息对象
   * @param {number|string|null} [message.id] - 消息 id（通知无此字段）
   * @param {string}   [message.method] - JSON-RPC 方法名
   * @param {number}   [timeoutMs=30000] - 请求超时时间（毫秒）
   * @returns {Promise<object|null>} JSON-RPC 响应对象；通知类消息返回 null
   */
  async send(service, message, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const name = service.name;
    let entry = this.processes.get(name);

    // 如果进程不存在或已退出，spawn 一个新的
    if (!entry || !entry.process || entry.process.killed) {
      entry = this._spawnProcess(service);
      this.processes.set(name, entry);
    }

    // 标准 JSON-RPC 请求（有 id）：写入 stdin 并等待匹配的响应
    if (message.id !== undefined && message.id !== null) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          entry.pending.delete(message.id);
          reject(new Error(`MCP request timeout (id=${message.id})`));
        }, timeoutMs);

        entry.pending.set(message.id, (response) => {
          clearTimeout(timer);
          resolve(response);
        });

        entry.process.stdin.write(JSON.stringify(message) + "\n");
      });
    }

    // JSON-RPC 通知（有 method 但无 id）：写入 stdin 后立即返回
    if (message.method) {
      entry.process.stdin.write(JSON.stringify(message) + "\n");
      return null;
    }

    // 通用消息（无 id 也无 method）：写入 stdin，等待下一条 stdout 输出
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        entry.anyResponseCb = null;
        reject(new Error("MCP response timeout"));
      }, timeoutMs);

      entry.anyResponseCb = (response) => {
        clearTimeout(timer);
        resolve(response);
      };

      entry.process.stdin.write(JSON.stringify(message) + "\n");
    });
  }

  /**
   * 终止指定服务的持久进程。
   * 在服务被删除或配置变更时调用。
   *
   * @param {string} serviceName - 要终止的服务名称
   */
  kill(serviceName) {
    const entry = this.processes.get(serviceName);
    if (entry) {
      if (entry.process && !entry.process.killed) {
        entry.process.kill();
      }
      this.processes.delete(serviceName);
    }
  }

  /**
   * 终止所有持久进程。
   */
  killAll() {
    for (const name of this.processes.keys()) {
      this.kill(name);
    }
  }

  /**
   * 启动一个持久化的子进程并设置 stdout 行解析和响应路由。
   *
   * @param {object}   service          - MCP 服务配置对象
   * @param {string}   service.name     - 服务名称
   * @param {string}   service.command  - 要执行的命令
   * @param {string[]} [service.args]   - 命令参数列表
   * @param {string}   [service.cwd]    - 子进程工作目录
   * @param {object}   [service.env]    - 子进程额外环境变量
   * @returns {ProcessEntry} 进程条目
   * @private
   */
  _spawnProcess(service) {
    const command = resolveCommand(service.command);
    const args = Array.isArray(service.args) ? service.args : [];

    if (!command) {
      throw new Error("Invalid stdio MCP configuration: command is empty");
    }

    // 启动子进程
    const child = this._spawnImpl(command, args, {
      cwd: service.cwd,
      env: { ...process.env, ...(service.env || {}) },
      stdio: "pipe",
      shell: shouldUseShell(service, command),
    });

    /** @type {ProcessEntry} */
    const entry = {
      process: child,
      lineBuffer: "",
      /** @type {Map<number|string, Function>} JSON-RPC id → 响应回调 */
      pending: new Map(),
      /** @type {Function|null} 通用响应回调（用于无 id 的消息等待下一条输出） */
      anyResponseCb: null,
    };

    // 逐行解析 stdout，按 JSON-RPC id 分发响应
    child.stdout.on("data", (chunk) => {
      entry.lineBuffer += chunk.toString("utf8");
      const lines = entry.lineBuffer.split("\n");
      // 最后一段可能不完整，保留在缓冲区
      entry.lineBuffer = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const json = parseJsonSafely(trimmed, null);
        // 优先尝试按 id 匹配
        if (json && json.id !== undefined && json.id !== null) {
          const callback = entry.pending.get(json.id);
          if (callback) {
            entry.pending.delete(json.id);
            callback(json);
            continue;
          }
        }
        // 无 id 匹配时，尝试通用响应回调
        if (entry.anyResponseCb) {
          entry.anyResponseCb(json);
          entry.anyResponseCb = null;
        }
      }
    });

    // 清空 stderr 缓冲区，防止子进程因 stderr 满而阻塞
    child.stderr.on("data", () => {});

    // 允许父进程在持久子进程仍运行时正常退出
    child.unref();

    // 子进程退出或出错时的清理逻辑
    const cleanup = () => {
      this.processes.delete(service.name);
      // 拒绝所有等待中的请求
      for (const callback of entry.pending.values()) {
        callback(null);
      }
      entry.pending.clear();
      if (entry.anyResponseCb) {
        entry.anyResponseCb(null);
        entry.anyResponseCb = null;
      }
    };

    child.on("close", cleanup);
    child.on("error", cleanup);

    return entry;
  }
}

/**
 * @typedef {object} ProcessEntry
 * @property {import("node:child_process").ChildProcess} process - 子进程实例
 * @property {string}     lineBuffer    - 行缓冲区（处理不完整的行）
 * @property {Map}        pending       - JSON-RPC id → 响应回调的映射
 * @property {Function|null} anyResponseCb - 通用响应回调（用于无 id 的消息）
 */
