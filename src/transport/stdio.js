/**
 * @module transport/stdio
 * @description Stdio 传输层。
 * 通过 spawn 启动 MCP 服务的子进程，将客户端请求体写入 stdin，
 * 收集 stdout/stderr 输出后将结果返回给客户端。
 * 适用于本地命令行 MCP 工具（一次请求一个进程的模式）。
 */

import {
  resolveCommand,
  shouldUseShell,
  parseJsonSafely,
} from "../utils/helpers.js";
import { jsonServerError } from "../utils/response.js";
import { spawn } from "node:child_process";

/**
 * 通过 stdio 模式代理 MCP 请求。
 * 启动一个子进程执行 MCP 服务命令，将请求体写入其 stdin，
 * 等待子进程退出后，将 stdout 的内容作为响应返回。
 *
 * @param {import("express").Request}  req          - Express 请求对象
 * @param {import("express").Response} res          - Express 响应对象
 * @param {object}                     service      - MCP 服务配置对象
 * @param {string}                     service.command - 要执行的命令
 * @param {string[]}                   [service.args]   - 命令参数列表
 * @param {string}                     [service.cwd]    - 子进程工作目录
 * @param {object}                     [service.env]    - 子进程额外环境变量
 * @param {Function}                   [spawnImpl=spawn] - 自定义 spawn 函数（用于测试注入 mock）
 */
export async function forwardToStdioService(
  req,
  res,
  service,
  spawnImpl = spawn,
) {
  // 清理并提取要执行的命令
  const command = resolveCommand(service.command);
  // 确保参数为字符串数组
  const args = Array.isArray(service.args) ? service.args : [];
  // 命令为空则无法执行
  if (!command) {
    jsonServerError(res, "Invalid stdio MCP configuration");
    return;
  }

  // 读取客户端发送的原始请求体
  const body = await readRequestBody(req);
  // 启动子进程，配置管道传输 stdio
  const child = spawnImpl(command, args, {
    // 子进程工作目录
    cwd: service.cwd,
    // 合并系统环境变量和服务配置中的额外变量
    env: { ...process.env, ...(service.env || {}) },
    // 使用管道连接 stdin/stdout/stderr
    stdio: "pipe",
    // 根据平台和命令类型决定是否使用 shell
    shell: shouldUseShell(service, command),
  });

  // 收集子进程的标准输出数据块
  const stdoutChunks = [];
  // 收集子进程的标准错误数据块
  const stderrChunks = [];
  // 记录子进程启动错误（如命令不存在）
  let spawnError = null;
  child.on("error", (error) => {
    spawnError = error;
  });
  // 持续收集 stdout 数据
  child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
  // 持续收集 stderr 数据
  child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
  // 将请求体写入子进程 stdin 并关闭
  child.stdin.write(body);
  child.stdin.end();

  // 等待子进程完全退出
  await new Promise((resolve) => child.on("close", resolve));
  // 如果子进程启动失败（如命令未找到），返回 500 错误
  if (spawnError) {
    jsonServerError(
      res,
      `Failed to start stdio MCP process: ${spawnError.message}`,
    );
    return;
  }
  // 合并 stdout 输出为完整 Buffer
  const stdout = Buffer.concat(stdoutChunks);
  // 合并 stderr 输出为字符串
  const stderr = Buffer.concat(stderrChunks).toString("utf8");

  // 子进程非零退出码表示执行失败，返回 502 错误
  if (child.exitCode !== 0) {
    res.status(502).json({
      error: "Upstream stdio MCP failed",
      // 优先使用 stderr 内容作为错误详情
      details:
        stderr || `Stdio MCP process failed with exit code ${child.exitCode}`,
    });
    return;
  }

  // 将 stdout 转换为文本
  const asText = stdout.toString("utf8");
  // 尝试将输出解析为 JSON
  const asJson = parseJsonSafely(asText, null);
  // 如果是有效 JSON 则直接返回，否则包裹在 output 字段中
  res.json(asJson || { output: asText });
}

/**
 * 从可读流中读取完整的请求体数据。
 * 返回 Promise，在流结束时 resolve 为拼接后的 Buffer。
 *
 * @param {import("stream").Readable} req - 可读流（Express Request 对象）
 * @returns {Promise<Buffer>} 完整的请求体 Buffer
 */
function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    // 收集所有数据块
    const chunks = [];
    // 监听 data 事件，收集每个数据块
    req.on("data", (chunk) => chunks.push(chunk));
    // 流结束时将所有块拼接为完整 Buffer
    req.on("end", () => resolve(Buffer.concat(chunks)));
    // 发生错误时 reject
    req.on("error", reject);
  });
}
