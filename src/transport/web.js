/**
 * @module transport/web
 * @description Web（URL）传输层。
 * 将客户端的 MCP JSON-RPC 请求透传到上游 Web 服务的指定 URL，
 * 并将上游响应原样返回给客户端。
 */

/**
 * 将请求转发到上游 Web MCP 服务。
 * 读取客户端请求体，构造到目标 URL 的 HTTP 请求，
 * 将上游的响应状态码、响应头和响应体透传回客户端。
 *
 * @param {import("express").Request}  req        - Express 请求对象
 * @param {import("express").Response} res        - Express 响应对象
 * @param {object}                     service    - MCP 服务配置对象
 * @param {string}                     service.url - 上游 MCP 服务 URL
 * @param {string}                     [service.name] - 服务名称（用于日志）
 * @param {object}                     [service.headers] - 额外追加到上游请求的 headers
 * @param {Function}                   [fetchImpl=fetch] - 自定义 fetch 函数（用于测试注入 mock）
 */
export async function forwardToWebService(
  req,
  res,
  service,
  fetchImpl = fetch,
) {
  const name = service.name || service.url;
  // 读取客户端发送的原始请求体
  const body = await readRequestBody(req);

  let response;
  try {
    // 使用 fetch 向上游服务发起请求
    response = await fetchImpl(service.url, {
      // 透传客户端的 HTTP 方法
      method: req.method,
      headers: {
        // 保留客户端的 content-type，默认 application/json
        "content-type": req.headers["content-type"] || "application/json",
        // 合并服务配置中自定义的 headers
        ...service.headers,
      },
      // 只在有请求体时附带 body
      body: body.length > 0 ? body : undefined,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[${name}] 上游请求失败: ${err.message}`);
    res.status(502).json({ error: `Upstream request failed: ${err.message}` });
    return;
  }

  // 上游返回非 2xx 时记录日志
  if (!response.ok) {
    // eslint-disable-next-line no-console
    console.error(`[${name}] 上游返回 ${response.status}`);
  }

  // 将上游响应体读取为 Buffer
  const responseBuffer = Buffer.from(await response.arrayBuffer());
  // 设置与上游一致的 HTTP 状态码
  res.status(response.status);
  // 透传上游的 content-type 头
  const contentType = response.headers.get("content-type");
  if (contentType) {
    res.setHeader("content-type", contentType);
  }
  // 发送响应数据
  res.send(responseBuffer);
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
