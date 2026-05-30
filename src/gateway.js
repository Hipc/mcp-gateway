import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const WINDOWS_CMD_LAUNCHERS = new Set(["npm", "npx", "pnpm", "yarn", "bunx"]);

function parseJsonSafely(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function resolveCommand(command) {
  if (typeof command !== "string") {
    return command;
  }

  return command.trim();
}

function shouldUseShell(service, command) {
  if (service.shell === true) {
    return true;
  }
  if (service.shell === false) {
    return false;
  }
  if (process.platform !== "win32" || typeof command !== "string") {
    return false;
  }

  const normalized = command.trim().toLowerCase();
  const hasPathSeparator = normalized.includes("/") || normalized.includes("\\");
  const hasExtension = /\.[^./\\]+$/.test(normalized);
  if (hasPathSeparator || hasExtension) {
    return false;
  }
  return WINDOWS_CMD_LAUNCHERS.has(normalized);
}

export function normalizeMcpConfig(rawConfig) {
  const source =
    rawConfig?.mcpServers ??
    rawConfig?.servers ??
    rawConfig?.mcps ??
    rawConfig?.mcp ??
    rawConfig ?? {};
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
  const command = resolveCommand(service.command);
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
    shell: shouldUseShell(service, command),
  });

  const stdoutChunks = [];
  const stderrChunks = [];
  let spawnError = null;
  child.on("error", (error) => {
    spawnError = error;
  });
  child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
  child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
  child.stdin.write(body);
  child.stdin.end();

  await new Promise((resolve) => child.on("close", resolve));
  if (spawnError) {
    jsonServerError(res, `Failed to start stdio MCP process: ${spawnError.message}`);
    return;
  }
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

function startSseSession(req, res, service, spawnImpl, sseConnections) {
  const command = resolveCommand(service.command);
  const args = Array.isArray(service.args) ? service.args : [];
  if (!command) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "Invalid stdio MCP configuration" }));
    return;
  }

  const sessionId = randomUUID();
  const child = spawnImpl(command, args, {
    cwd: service.cwd,
    env: { ...process.env, ...(service.env || {}) },
    stdio: "pipe",
    shell: shouldUseShell(service, command),
  });

  const session = { res, process: child, lineBuffer: "" };
  sseConnections.set(sessionId, session);

  child.on("error", (error) => {
    sseConnections.delete(sessionId);
    if (!res.headersSent) {
      res.statusCode = 502;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: `Failed to start stdio MCP process: ${error.message}` }));
      return;
    }
    if (!res.writableEnded) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: error.message })}\n\n`);
      res.end();
    }
  });

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "connection": "keep-alive",
  });

  // Forward each JSON-RPC line from stdout as an SSE message event
  child.stdout.on("data", (chunk) => {
    session.lineBuffer += chunk.toString("utf8");
    const lines = session.lineBuffer.split("\n");
    session.lineBuffer = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) {
        res.write(`event: message\ndata: ${trimmed}\n\n`);
      }
    }
  });

  child.stderr.on("data", () => {});

  child.on("close", () => {
    sseConnections.delete(sessionId);
    if (!res.writableEnded) {
      res.end();
    }
  });

  // Send the endpoint URL so the client knows where to POST messages
  const endpointPath = `/mcp/${encodeURIComponent(service.name)}?sessionId=${sessionId}`;
  res.write(`event: endpoint\ndata: ${endpointPath}\n\n`);

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) {
      res.write(": ping\n\n");
    }
  }, 15000);

  req.on("close", () => {
    clearInterval(heartbeat);
    if (!child.killed) {
      child.kill();
    }
    sseConnections.delete(sessionId);
  });
}

async function sendSseMessage(req, res, sessionId, sseConnections) {
  const session = sseConnections.get(sessionId);
  if (!session) {
    res.statusCode = 404;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "Session not found" }));
    return;
  }

  const body = await readRequestBody(req);
  const trimmed = body.toString("utf8").trim();
  if (trimmed) {
    session.process.stdin.write(trimmed + "\n");
  }
  res.statusCode = 202;
  res.end();
}

export function createGatewayHandler({
  services,
  authorizationToken = "",
  spawnImpl = spawn,
  fetchImpl = fetch,
}) {
  const sseConnections = new Map();

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

      // SSE transport: GET opens the stream, POST sends messages
      if (req.method === "GET") {
        startSseSession(req, res, service, spawnImpl, sseConnections);
        return;
      }

      const sessionId = requestUrl.searchParams.get("sessionId");
      if (req.method === "POST" && sessionId) {
        await sendSseMessage(req, res, sessionId, sseConnections);
        return;
      }

      await forwardToStdioService(req, res, service, spawnImpl);
    } catch (error) {
      jsonServerError(res, error?.message || "Internal server error");
    }
  };
}
