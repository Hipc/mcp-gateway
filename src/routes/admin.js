/**
 * @module routes/admin
 * @description MCP Gateway 管理后台页面路由。
 * 将 /public/admin.html 静态文件通过 /admin 路径对外提供，
 * 管理页面通过前端 JavaScript 调用 /api/services 的 CRUD API 来管理 MCP 服务。
 */

import { Router } from "express";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 当前文件所在目录的绝对路径
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 管理页面 HTML 文件的路径（位于 src/public/admin.html）
const adminHtmlPath = path.resolve(__dirname, "../public/admin.html");

/**
 * 创建 /admin 路由的 Express Router 实例。
 * 将 admin.html 作为完整 HTML 响应返回给浏览器。
 *
 * @returns {import("express").Router} Express Router 实例
 */
export function createAdminRouter() {
  const router = Router();

  // GET /admin — 返回管理页面 HTML
  router.get("/", (req, res) => {
    // 读取并返回管理页面 HTML 文件内容
    const html = readFileSync(adminHtmlPath, "utf8");
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.send(html);
  });

  return router;
}
