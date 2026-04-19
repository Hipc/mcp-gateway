import { spawn } from "node:child_process";

function parseJsonSafely(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function normalizeMcpConfig(rawConfig) {
  const source = rawConfig?.mcps ?? rawConfig?.mcp ?? rawConfig ?? {};
  const entries = Array.isArray(source)
    ? source.map((item) => [item?.name, item])
    : Object.entries(source).map(([name, item]) => [name, { name, ...item }]);

  const services = new Map();
  for (const [name, service] of entries) {
    if (!name || !service) {
      continue;
    }
    services.set(name, service);
  }
  return services;
}

function getAuthToken(configuredToken) {
  return typeof configuredToken === "string" ? configuredToken.trim() : "";
}

function unauthorized(res) {
  res.statusCode = 401;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ error: "Unauthorized" }));
}

function jsonNotFound(res, name) {
  res.statusCode = 404;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ error: `MCP service "${name}" not found` }));
}

function jsonServerError(res, message) {
  res.statusCode = 500;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ error: message }));
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function forwardToWebService(req, res, service, fetchImpl) {
  const body = await readRequestBody(req);
  const response = await fetchImpl(service.url, {
    method: req.method,
    headers: {
      "content-type": req.headers["content-type"] || "application/json",
      ...service.headers,
    },
    body: body.length > 0 ? body : undefined,
  });

  const responseBuffer = Buffer.from(await response.arrayBuffer());
  res.statusCode = response.status;
  const contentType = response.headers.get("content-type");
  if (contentType) {
    res.setHeader("content-type", contentType);
  }
  res.end(responseBuffer);
}

async function forwardToStdioService(req, res, service, spawnImpl) {
  const command = service.command;
  const args = Array.isArray(service.args) ? service.args : [];
  if (!command) {
    jsonServerError(res, "Invalid stdio MCP configuration");
    return;
  }

  const body = await readRequestBody(req);
  const child = spawnImpl(command, args, {
    cwd: service.cwd,
    env: { ...process.env, ...(service.env || {}) },
    stdio: "pipe",
    shell: process.platform === "win32",
  });

  const stdoutChunks = [];
  const stderrChunks = [];
  child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
  child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
  child.stdin.write(body);
  child.stdin.end();

  await new Promise((resolve) => child.on("close", resolve));
  const stdout = Buffer.concat(stdoutChunks);
  const stderr = Buffer.concat(stderrChunks).toString("utf8");

  if (child.exitCode !== 0) {
    res.statusCode = 502;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(
      JSON.stringify({
        error: "Upstream stdio MCP failed",
        details:
          stderr || `Stdio MCP process failed with exit code ${child.exitCode}`,
      }),
    );
    return;
  }

  const asText = stdout.toString("utf8");
  const asJson = parseJsonSafely(asText, null);
  res.statusCode = 200;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(asJson ? JSON.stringify(asJson) : JSON.stringify({ output: asText }));
}

export function createGatewayHandler({
  services,
  authorizationToken = "",
  spawnImpl = spawn,
  fetchImpl = fetch,
}) {
  return async function gatewayHandler(req, res) {
    try {
      const configuredToken = getAuthToken(authorizationToken);
      if (configuredToken) {
        const authHeader = req.headers.authorization || "";
        if (authHeader !== `Bearer ${configuredToken}`) {
          unauthorized(res);
          return;
        }
      }

      const requestUrl = new URL(req.url || "/", "http://localhost");
      const parts = requestUrl.pathname.split("/").filter(Boolean);
      if (parts[0] !== "mcp" || !parts[1]) {
        jsonNotFound(res, parts[1] || "");
        return;
      }

      const mcpName = decodeURIComponent(parts[1]);
      const service = services.get(mcpName);
      if (!service) {
        jsonNotFound(res, mcpName);
        return;
      }

      if (service.url) {
        await forwardToWebService(req, res, service, fetchImpl);
        return;
      }

      await forwardToStdioService(req, res, service, spawnImpl);
    } catch (error) {
      jsonServerError(res, error?.message || "Internal server error");
    }
  };
}
