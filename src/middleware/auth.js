/**
 * @module middleware/auth
 * @description Bearer Token 认证中间件。
 * 当配置了 AUTHORIZATION_TOKEN 环境变量时，所有请求都必须携带匹配的 Bearer token。
 * 未配置 token 时中间件直接放行，不影响请求处理。
 */

import { jsonUnauthorized } from "../utils/response.js";

/**
 * 创建 Bearer Token 认证中间件工厂函数。
 * 返回的中间件会检查每个请求的 Authorization header 是否匹配预设 token。
 *
 * @param {string} [authorizationToken=""] - 预设的认证令牌；为空或非字符串时不启用认证
 * @returns {import("express").RequestHandler} Express 中间件函数
 */
export function createAuthMiddleware(authorizationToken = "") {
  // 清理 token：仅接受非空字符串，去除首尾空白
  const configuredToken =
    typeof authorizationToken === "string" ? authorizationToken.trim() : "";

  /**
   * Express 认证中间件。
   * 检查请求的 Authorization header 是否为 `Bearer <token>` 格式。
   *
   * @param {import("express").Request}  req  - Express 请求对象
   * @param {import("express").Response} res  - Express 响应对象
   * @param {import("express").NextFunction} next - Express next 函数，调用则放行
   */
  return function authMiddleware(req, res, next) {
    // token 未配置，无需认证，直接放行
    if (!configuredToken) {
      next();
      return;
    }
    // 从请求头提取 Authorization 字段
    const authHeader = req.headers.authorization || "";
    // 比对 token 是否匹配
    if (authHeader === `Bearer ${configuredToken}`) {
      next();
      return;
    }
    // token 不匹配，返回 401
    jsonUnauthorized(res);
  };
}
