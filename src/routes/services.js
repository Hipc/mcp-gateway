/**
 * @module routes/services
 * @description MCP 服务管理 CRUD 路由。
 * 提供 /api/services 下的 RESTful API：
 * - GET    /api/services           — 列出所有已注册的 MCP 服务
 * - POST   /api/services           — 创建新的 MCP 服务
 * - GET    /api/services/:name     — 获取指定名称的服务配置
 * - PUT    /api/services/:name     — 更新指定服务（配置变更时自动重连 SSE 会话）
 * - DELETE /api/services/:name     — 删除指定服务（自动关闭关联的 SSE 会话）
 */

import { Router } from "express";
import { saveMcpConfig } from "../config.js";
import {
  jsonNotFound,
  jsonBadRequest,
  jsonConflict,
  jsonServerError,
} from "../utils/response.js";
import { serviceResponse, hasTransportConfig } from "../utils/mcp-config.js";
import { hasActualServiceUpdate } from "../utils/compare.js";
import { killSseSessionsByName } from "../transport/sse.js";

/**
 * 创建 /api/services 的 Express Router 实例。
 * 路由处理器通过闭包引用共享的 services Map、configPath 和 sseConnections，
 * 确保在多路由间共享同一份运行时状态。
 *
 * @param {object}               options              - 路由配置选项
 * @param {Map<string, object>}  options.services     - 共享的 MCP 服务 Map 集合（可变引用）
 * @param {string}               options.configPath   - mcp.json 配置文件路径，用于持久化
 * @param {Map<string, object>}  options.sseConnections - 共享的 SSE 连接注册表
 * @returns {import("express").Router} Express Router 实例
 */
export function createServicesRouter({ services, configPath, sseConnections }) {
  const router = Router();

  // GET /api/services — 列出所有已注册的 MCP 服务
  router.get("/", (req, res) => {
    // 将 Map 展开为数组并转换为响应格式
    res.json(
      [...services].map(([name, service]) => serviceResponse(name, service)),
    );
  });

  // POST /api/services — 创建一个新的 MCP 服务
  router.post("/", async (req, res) => {
    // 从 Express 解析好的 JSON body 中提取 payload
    const payload =
      typeof req.body === "object" &&
      req.body !== null &&
      !Array.isArray(req.body)
        ? req.body
        : null;

    // 校验请求体必须为 JSON 对象
    if (!payload) {
      jsonBadRequest(res, "Request body must be a JSON object");
      return;
    }

    // 从 payload 中分离出服务名和其余配置字段
    const { name, ...serviceConfig } = payload;
    // 服务名不能为空
    if (!name) {
      jsonBadRequest(res, "Service name is required");
      return;
    }
    // 至少要配置 command 或 url 中的一个
    if (!hasTransportConfig(serviceConfig)) {
      jsonBadRequest(res, "Service command or url is required");
      return;
    }
    // 不允许重复创建同名服务
    if (services.has(name)) {
      jsonConflict(res, `MCP service "${name}" already exists`);
      return;
    }

    // 构建完整的服务配置对象（包含 name）
    const service = { name, ...serviceConfig };
    try {
      // 创建服务快照，先写入文件再更新内存，保证持久化成功后再生效
      const nextServices = new Map(services);
      nextServices.set(name, service);
      // 持久化到 mcp.json 文件
      persistServices(configPath, nextServices);
      // 持久化成功后更新共享的 services Map
      services.set(name, service);
      // 返回 201 Created 及服务配置
      res.status(201).json(serviceResponse(name, service));
    } catch (error) {
      // 持久化失败时返回 500，services Map 保持不变
      jsonServerError(res, error?.message || "Failed to persist config");
    }
  });

  // GET /api/services/:name — 获取单个服务的配置
  router.get("/:name", (req, res) => {
    // 从 URL 参数中获取服务名
    const name = req.params.name;
    // 在 Map 中查找服务
    const service = services.get(name);
    // 服务不存在则返回 404
    if (!service) {
      jsonNotFound(res, name);
      return;
    }
    // 返回服务配置
    res.json(serviceResponse(name, service));
  });

  // PUT /api/services/:name — 更新指定服务的配置
  router.put("/:name", async (req, res) => {
    // 从 URL 参数中获取服务名
    const name = req.params.name;
    // 查找当前已有的服务配置
    const existingService = services.get(name);
    // 服务不存在则返回 404
    if (!existingService) {
      jsonNotFound(res, name);
      return;
    }

    // 提取更新字段，过滤非对象 body（如空 body 或数组）
    const updates =
      typeof req.body === "object" &&
      req.body !== null &&
      !Array.isArray(req.body)
        ? { ...req.body }
        : {};
    // 检查是否存在实质性配置变更（需要重连 SSE 的变更）
    const shouldClearSseSessions = hasActualServiceUpdate(
      existingService,
      updates,
    );
    // 不允许通过更新修改服务名
    delete updates.name;

    // 合并已有配置与更新字段（更新字段覆盖已有值）
    const nextService = { ...existingService, ...updates, name };
    try {
      // 创建快照用于持久化
      const nextServices = new Map(services);
      nextServices.set(name, nextService);
      // 先持久化到文件
      persistServices(configPath, nextServices);
      // 如果有实质变更，关闭该服务的所有活跃 SSE 会话
      if (shouldClearSseSessions) {
        killSseSessionsByName(sseConnections, name);
      }
      // 持久化成功后更新内存中的服务配置
      services.set(name, nextService);
      // 返回更新后的服务配置
      res.json(serviceResponse(name, nextService));
    } catch (error) {
      // 持久化失败时返回 500，services Map 保持不变
      jsonServerError(res, error?.message || "Failed to persist config");
    }
  });

  // DELETE /api/services/:name — 删除指定服务
  router.delete("/:name", (req, res) => {
    // 从 URL 参数中获取服务名
    const name = req.params.name;
    // 检查服务是否存在
    if (!services.has(name)) {
      jsonNotFound(res, name);
      return;
    }

    // 创建快照用于持久化（移除目标服务）
    const nextServices = new Map(services);
    nextServices.delete(name);
    try {
      // 先持久化到文件
      persistServices(configPath, nextServices);
      // 关闭该服务所有活跃的 SSE 会话
      killSseSessionsByName(sseConnections, name);
      // 持久化成功后从内存中移除
      services.delete(name);
      // 返回 204 No Content 表示删除成功
      res.status(204).end();
    } catch (error) {
      // 持久化失败时返回 500，services Map 保持不变
      jsonServerError(res, error?.message || "Failed to persist config");
    }
  });

  return router;
}

/**
 * 将当前服务配置持久化到 mcp.json 文件。
 * 持久化成功后调用方才更新内存中的 services Map，
 * 确保文件写入失败时内存状态不受影响。
 *
 * @param {string}              configPath - mcp.json 文件的绝对路径
 * @param {Map<string, object>} services   - 待持久化的服务 Map 快照
 * @throws {Error} configPath 为空或文件写入失败时抛出错误
 */
function persistServices(configPath, services) {
  // configPath 是必需的，缺失则抛出错误
  if (!configPath) {
    throw new Error("configPath is required to persist MCP services");
  }
  saveMcpConfig(configPath, services);
}
