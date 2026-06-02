/**
 * @module routes/mcp
 * @description MCP 代理路由。
 * 将 /mcp/:name 下的请求按服务配置的传输类型分发到对应的处理函数：
 * - URL 类型服务 → 转发到上游 Web 服务
 * - Stdio 类型服务（GET）→ 建立 SSE 长连接
 * - Stdio 类型服务（POST + sessionId）→ 发送消息到已有 SSE 会话
 * - Stdio 类型服务（POST 无 sessionId）→ 持久化进程池转发
 */

import { Router } from "express";
import { jsonNotFound } from "../utils/response.js";
import { forwardToWebService } from "../transport/web.js";
import { StdioProcessPool } from "../transport/persistent-stdio.js";
import { startSseSession, sendSseMessage } from "../transport/sse.js";
import { parseJsonSafely } from "../utils/helpers.js";
import { spawn } from "node:child_process";

/**
 * 创建 /mcp 的 Express Router 实例。
 * 处理所有到 /mcp/:name 的 GET 和 POST 请求，
 * 根据服务配置类型进行路由分发。
 *
 * @param {object}               options               - 路由配置选项
 * @param {Map<string, object>}  options.services      - 共享的 MCP 服务 Map 集合
 * @param {Map<string, object>}  options.sseConnections - 共享的 SSE 连接注册表
 * @param {Function}             [options.spawnImpl=spawn] - 自定义 spawn 函数（用于测试注入 mock）
 * @param {Function}             [options.fetchImpl=fetch] - 自定义 fetch 函数（用于测试注入 mock）
 * @returns {import("express").Router} Express Router 实例
 */
export function createMcpRouter({
  services,
  sseConnections,
  spawnImpl = spawn,
  fetchImpl = fetch,
}) {
  const router = Router();
  // 持久化 stdio 进程池，用于处理无 sessionId 的 POST 请求
  const stdioPool = new StdioProcessPool(spawnImpl);

  // GET /mcp/:name — 对 stdio 服务启动 SSE 长连接，对 web 服务直接转发 GET 请求
  router.get("/:name", (req, res) => {
    // 从 URL 参数中获取服务名
    const name = req.params.name;
    // 查找服务配置
    const service = services.get(name);
    // 服务不存在则返回 404
    if (!service) {
      jsonNotFound(res, name);
      return;
    }

    // URL 类型服务：直接转发 GET 请求到上游
    if (service.url) {
      forwardToWebService(req, res, service, fetchImpl);
      return;
    }

    // Stdio 类型服务：启动 SSE 长连接会话
    startSseSession(req, res, service, sseConnections, spawnImpl);
  });

  // POST /mcp/:name — 根据查询参数和配置分发到不同传输处理
  router.post("/:name", async (req, res) => {
    // 从 URL 参数中获取服务名
    const name = req.params.name;
    // 查找服务配置
    const service = services.get(name);
    // 服务不存在则返回 404
    if (!service) {
      jsonNotFound(res, name);
      return;
    }

    // URL 类型服务：转发 POST 请求到上游
    if (service.url) {
      await forwardToWebService(req, res, service, fetchImpl);
      return;
    }

    // SSE 会话模式：如果查询参数中包含 sessionId，将消息发送到对应会话的 stdin
    const sessionId = req.query.sessionId;
    if (sessionId) {
      await sendSseMessage(req, res, sessionId, sseConnections);
      return;
    }

    // 持久化 stdio 模式：通过进程池发送请求，保持子进程活跃
    try {
      const body = await readRequestBody(req);
      const message = parseJsonSafely(body.toString("utf8"), null);
      if (!message) {
        res.status(400).json({ error: "Invalid JSON-RPC request" });
        return;
      }
      const response = await stdioPool.send(service, message);
      if (response === null) {
        // 通知类消息（无 id），无需返回响应体
        res.status(202).end();
      } else {
        res.json(response);
      }
    } catch (err) {
      res.status(502).json({ error: err?.message || "Stdio MCP request failed" });
    }
  });

  return router;
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
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
