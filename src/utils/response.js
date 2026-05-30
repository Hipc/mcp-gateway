/**
 * @module utils/response
 * @description HTTP JSON 响应辅助函数集。
 * 提供统一格式的错误响应函数，确保所有 API 端点返回一致的 JSON 错误结构。
 */

/**
 * 返回 404 Not Found 响应，表示 MCP 服务未找到。
 *
 * @param {import("express").Response} res  - Express 响应对象
 * @param {string}                     name - 未找到的服务名称
 */
export function jsonNotFound(res, name) {
  res.status(404).json({ error: `MCP service "${name}" not found` });
}

/**
 * 返回 400 Bad Request 响应，表示请求参数或格式错误。
 *
 * @param {import("express").Response} res     - Express 响应对象
 * @param {string}                     message - 错误描述信息
 */
export function jsonBadRequest(res, message) {
  res.status(400).json({ error: message });
}

/**
 * 返回 409 Conflict 响应，表示资源冲突（如创建已存在的服务）。
 *
 * @param {import("express").Response} res     - Express 响应对象
 * @param {string}                     message - 冲突描述信息
 */
export function jsonConflict(res, message) {
  res.status(409).json({ error: message });
}

/**
 * 返回 500 Internal Server Error 响应，表示服务端内部错误。
 *
 * @param {import("express").Response} res     - Express 响应对象
 * @param {string}                     message - 错误描述信息
 */
export function jsonServerError(res, message) {
  res.status(500).json({ error: message });
}

/**
 * 返回 401 Unauthorized 响应，表示请求缺少有效的认证信息。
 *
 * @param {import("express").Response} res - Express 响应对象
 */
export function jsonUnauthorized(res) {
  res.status(401).json({ error: "Unauthorized" });
}
