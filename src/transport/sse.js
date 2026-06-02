/**
 * @module transport/sse
 * @description SSE（Server-Sent Events）传输层。
 * 管理 MCP 服务通过 SSE 长连接与客户端的通信。
 * 为 stdio 类型的 MCP 服务维持持久的子进程，将 stdout 行输出转发为 SSE message 事件，
 * 并通过 POST 接口接收客户端发送的 JSON-RPC 消息，写入子进程 stdin。
 */

import { randomUUID } from "node:crypto";
import { resolveCommand, shouldUseShell } from "../utils/helpers.js";
import { spawn } from "node:child_process";

/**
 * 启动一个 SSE 长连接会话。
 * 为指定的 stdio MCP 服务 spawn 一个子进程，将 stdout 的逐行输出
 * 通过 SSE `message` 事件推送到客户端，并暴露一个 endpoint URL 供客户端 POST 消息。
 * 会话保持活跃直到子进程退出或客户端断开连接。
 *
 * @param {import("express").Request}  req             - Express 请求对象
 * @param {import("express").Response} res             - Express 响应对象（将作为 SSE 流保持打开）
 * @param {object}                     service         - MCP 服务配置对象
 * @param {string}                     service.command - 要执行的命令
 * @param {string[]}                   [service.args]  - 命令参数列表
 * @param {string}                     [service.cwd]   - 子进程工作目录
 * @param {object}                     [service.env]   - 子进程额外环境变量
 * @param {string}                     service.name    - 服务名称
 * @param {Map<string, object>}        sseConnections  - 共享的 SSE 连接注册表
 * @param {Function}                   [spawnImpl=spawn] - 自定义 spawn 函数（用于测试注入 mock）
 */
export function startSseSession(
  req,
  res,
  service,
  sseConnections,
  spawnImpl = spawn,
) {
  // 清理并提取要执行的命令
  const command = resolveCommand(service.command);
  // 确保参数为字符串数组
  const args = Array.isArray(service.args) ? service.args : [];
  // 命令为空则无法启动子进程
  if (!command) {
    res.status(500).json({ error: "Invalid stdio MCP configuration" });
    return;
  }

  // 为每个 SSE 会话分配唯一 ID
  const sessionId = randomUUID();
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

  // 创建会话上下文对象，存储会话状态
  const session = {
    // SSE 响应对象，用于推送事件
    res,
    // 子进程实例
    process: child,
    // 行缓冲区，用于处理不完整的行数据
    lineBuffer: "",
    // 关联的服务名称，用于按服务名查找会话
    serviceName: service.name,
  };
  // 将会话注册到全局连接表
  sseConnections.set(sessionId, session);

  // 监听子进程启动失败事件（如命令不存在）
  child.on("error", (error) => {
    // eslint-disable-next-line no-console
    console.error(`[${service.name}] SSE 子进程启动失败: ${error.message}`);
    // 从连接表中移除该会话
    sseConnections.delete(sessionId);
    // 如果还未发送响应头，返回 502 错误
    if (!res.headersSent) {
      res.status(502).json({
        error: `Failed to start stdio MCP process: ${error.message}`,
      });
      return;
    }
    // 如果响应头已发送（SSE 流已打开），通过 SSE error 事件通知错误
    if (!res.writableEnded) {
      res.write(
        `event: error\ndata: ${JSON.stringify({ error: error.message })}\n\n`,
      );
      res.end();
    }
  });

  // 设置 SSE 响应头，建立长连接
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  // 监听子进程 stdout 数据，逐行分发为 SSE message 事件
  child.stdout.on("data", (chunk) => {
    // 将新数据追加到行缓冲区
    session.lineBuffer += chunk.toString("utf8");
    // 按换行符分割（最后一项可能是不完整的行，放回缓冲区）
    const lines = session.lineBuffer.split("\n");
    // pop() 取出最后一段（可能不完整），保留在缓冲区等待后续数据
    session.lineBuffer = lines.pop();
    // 将已完成的行作为 SSE message 事件发送
    for (const line of lines) {
      // 去除行首尾空白，跳过空行
      const trimmed = line.trim();
      if (trimmed) {
        // 格式化为 SSE message 事件推送给客户端
        res.write(`event: message\ndata: ${trimmed}\n\n`);
      }
    }
  });

  // 打印 stderr 输出，方便排查 MCP 子进程错误
  child.stderr.on("data", (chunk) => {
    // eslint-disable-next-line no-console
    console.error(`[${service.name}] SSE stderr: ${chunk.toString("utf8").trim()}`);
  });

  // 子进程退出时清理会话
  child.on("close", (code) => {
    // eslint-disable-next-line no-console
    console.error(`[${service.name}] SSE 子进程退出, code=${code}`);
    // 从连接表中移除该会话
    sseConnections.delete(sessionId);
    // 如果 SSE 流尚未关闭，则关闭之
    if (!res.writableEnded) {
      res.end();
    }
  });

  // 向客户端发送 endpoint 事件，告知消息发送的 URL（含 sessionId）
  const endpointPath = `/mcp/${encodeURIComponent(service.name)}?sessionId=${sessionId}`;
  res.write(`event: endpoint\ndata: ${endpointPath}\n\n`);

  // 启动心跳定时器，每 15 秒发送一次 SSE 注释行 ping，保持连接活跃
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) {
      // SSE 注释行（以冒号开头），客户端会忽略但能保持连接
      res.write(": ping\n\n");
    }
  }, 15000);

  // 客户端断开连接时的清理工作
  req.on("close", () => {
    // 停止心跳定时器
    clearInterval(heartbeat);
    // 终止子进程（如果仍在运行）
    if (!child.killed) {
      child.kill();
    }
    // 从连接表中移除该会话
    sseConnections.delete(sessionId);
  });
}

/**
 * 向已存在的 SSE 会话发送 JSON-RPC 消息。
 * 客户端通过 POST 请求将消息发送到 SSE endpoint URL（带 sessionId），
 * 此函数将消息体写入对应子进程的 stdin。
 *
 * @param {import("express").Request}  req            - Express 请求对象
 * @param {import("express").Response} res            - Express 响应对象
 * @param {string}                     sessionId      - SSE 会话的唯一标识
 * @param {Map<string, object>}        sseConnections - 共享的 SSE 连接注册表
 */
export async function sendSseMessage(req, res, sessionId, sseConnections) {
  // 根据 sessionId 查找对应的会话
  const session = sseConnections.get(sessionId);
  // 会话不存在则返回 404
  if (!session) {
    // eslint-disable-next-line no-console
    console.error(`[?] SSE 会话不存在: ${sessionId}`);
    res.status(404).json({ error: "Session not found" });
    return;
  }

  // 读取客户端发送的请求体
  const body = await readRequestBody(req);
  // 去除首尾空白
  const trimmed = body.toString("utf8").trim();
  // 非空消息写入子进程 stdin（追加换行符以表示消息结束）
  if (trimmed) {
    session.process.stdin.write(trimmed + "\n");
  }
  // 返回 202 Accepted 表示消息已接收
  res.status(202).end();
}

/**
 * 根据服务名称关闭并清理所有关联的 SSE 会话。
 * 在服务更新或删除时调用，确保旧连接不会泄漏。
 *
 * @param {Map<string, object>} sseConnections - 共享的 SSE 连接注册表
 * @param {string}              serviceName    - 要关闭连接的服务名称
 */
export function killSseSessionsByName(sseConnections, serviceName) {
  // 遍历所有已注册的 SSE 会话
  for (const [sessionId, session] of sseConnections) {
    // 跳过不匹配的会话
    if (session?.serviceName !== serviceName) {
      continue;
    }
    // 终止关联的子进程（如果仍在运行）
    if (session.process && !session.process.killed) {
      session.process.kill();
    }
    // 关闭 SSE 响应流（如果尚未关闭）
    if (session.res && !session.res.writableEnded) {
      session.res.end();
    }
    // 从连接表中移除该会话
    sseConnections.delete(sessionId);
  }
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
