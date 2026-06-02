import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { saveMcpConfig } from "../src/config.js";
import { createGatewayHandler, normalizeMcpConfig } from "../src/app.js";

function listenOnce(server, port) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.off("error", onError);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      cleanup();
      resolve();
    });
  });
}

async function listen(server) {
  let lastError;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = 20000 + Math.floor(Math.random() * 30000);
    try {
      await listenOnce(server, port);
      const address = server.address();
      return `http://127.0.0.1:${address.port}`;
    } catch (error) {
      if (error.code !== "EADDRINUSE") {
        throw error;
      }
      lastError = error;
    }
  }
  throw lastError;
}

function createControllableChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write() {}, end() {} };
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    queueMicrotask(() => child.emit("close", 0));
    return true;
  };
  return child;
}

async function openSseSession(baseUrl, serviceName) {
  const response = await fetch(`${baseUrl}/mcp/${serviceName}`);
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const endpointChunk = await reader.read();
  assert.equal(endpointChunk.done, false);
  assert.match(
    Buffer.from(endpointChunk.value).toString("utf8"),
    /event: endpoint/,
  );
  return reader;
}

async function assertSseClosed(reader) {
  const closed = await Promise.race([
    reader.read(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("SSE stream did not close")), 1000),
    ),
  ]);
  assert.equal(closed.done, true);
}

async function assertSseStillOpen(reader) {
  const result = await Promise.race([
    reader.read().then((value) => ({ type: "read", value })),
    new Promise((resolve) =>
      setTimeout(() => resolve({ type: "timeout" }), 100),
    ),
  ]);
  if (result.type === "read") {
    assert.equal(result.value.done, false);
  }
}

test("normalizeMcpConfig supports object and array format", () => {
  const objectMap = normalizeMcpConfig({
    mcpServers: {
      local: { command: "node", args: ["-v"] },
    },
  });
  assert.equal(objectMap.get("local").command, "node");

  const arrayMap = normalizeMcpConfig({
    mcps: [{ name: "remote", url: "http://example.com" }],
  });
  assert.equal(arrayMap.get("remote").url, "http://example.com");
});

test("saveMcpConfig strips runtime name from normalized object config", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "mcp-gateway-config-"));
  try {
    const configPath = path.join(tempDir, "mcp.json");
    const services = normalizeMcpConfig({
      mcpServers: {
        local: {
          command: "node",
          args: ["server.js"],
          env: { NODE_ENV: "test" },
        },
      },
    });

    saveMcpConfig(configPath, services);

    const saved = JSON.parse(readFileSync(configPath, "utf8"));
    assert.deepEqual(saved, {
      mcpServers: {
        local: {
          command: "node",
          args: ["server.js"],
          env: { NODE_ENV: "test" },
        },
      },
    });
    assert.equal("name" in saved.mcpServers.local, false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("auth token is required when configured", async (t) => {
  const services = new Map([["demo", { url: "http://invalid.local" }]]);
  const app = createServer(
    createGatewayHandler({
      services,
      authorizationToken: "secret-token",
      fetchImpl: async () => new Response("ok"),
    }),
  );
  t.after(() => app.close());
  const baseUrl = await listen(app);

  const unauthorized = await fetch(`${baseUrl}/mcp/demo`, {
    method: "POST",
    body: JSON.stringify({ ping: true }),
  });
  assert.equal(unauthorized.status, 401);

  const authorized = await fetch(`${baseUrl}/mcp/demo`, {
    method: "POST",
    headers: { Authorization: "Bearer secret-token" },
    body: JSON.stringify({ ping: true }),
  });
  assert.equal(authorized.status, 200);
});

test("management services API requires bearer token when configured", async (t) => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "mcp-gateway-api-auth-"));
  const configPath = path.join(tempDir, "mcp.json");
  const app = createServer(
    createGatewayHandler({
      services: new Map([
        ["demo", { name: "demo", url: "http://invalid.local" }],
      ]),
      configPath,
      authorizationToken: "secret-token",
    }),
  );
  t.after(() => {
    app.close();
    rmSync(tempDir, { recursive: true, force: true });
  });
  const baseUrl = await listen(app);

  const unauthorized = await fetch(`${baseUrl}/api/services`);
  assert.equal(unauthorized.status, 401);

  const authorized = await fetch(`${baseUrl}/api/services`, {
    headers: { Authorization: "Bearer secret-token" },
  });
  assert.equal(authorized.status, 200);
});

test("management services API updates services map and persists config", async (t) => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "mcp-gateway-api-"));
  const configPath = path.join(tempDir, "mcp.json");
  const services = normalizeMcpConfig({
    mcpServers: {
      local: { command: process.execPath, args: ["-v"] },
    },
  });
  const app = createServer(createGatewayHandler({ services, configPath }));
  t.after(() => {
    app.close();
    rmSync(tempDir, { recursive: true, force: true });
  });
  const baseUrl = await listen(app);

  const listResponse = await fetch(`${baseUrl}/api/services`);
  assert.equal(listResponse.status, 200);
  assert.deepEqual(await listResponse.json(), [
    { name: "local", command: process.execPath, args: ["-v"] },
  ]);

  const missingResponse = await fetch(`${baseUrl}/api/services/missing`);
  assert.equal(missingResponse.status, 404);

  const createResponse = await fetch(`${baseUrl}/api/services`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "remote", url: "http://example.test/mcp" }),
  });
  assert.equal(createResponse.status, 201);
  assert.deepEqual(await createResponse.json(), {
    name: "remote",
    url: "http://example.test/mcp",
  });
  assert.equal(services.get("remote").url, "http://example.test/mcp");
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
    mcpServers: {
      local: { command: process.execPath, args: ["-v"] },
      remote: { url: "http://example.test/mcp" },
    },
  });

  const conflictResponse = await fetch(`${baseUrl}/api/services`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "remote", url: "http://example.test/other" }),
  });
  assert.equal(conflictResponse.status, 409);

  const getResponse = await fetch(`${baseUrl}/api/services/remote`);
  assert.equal(getResponse.status, 200);
  assert.deepEqual(await getResponse.json(), {
    name: "remote",
    url: "http://example.test/mcp",
  });

  const updateResponse = await fetch(`${baseUrl}/api/services/remote`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: "http://example.test/new",
      headers: { "x-test": "yes" },
    }),
  });
  assert.equal(updateResponse.status, 200);
  assert.deepEqual(await updateResponse.json(), {
    name: "remote",
    url: "http://example.test/new",
    headers: { "x-test": "yes" },
  });

  const savedAfterUpdate = JSON.parse(readFileSync(configPath, "utf8"));
  assert.deepEqual(savedAfterUpdate.mcpServers.remote, {
    url: "http://example.test/new",
    headers: { "x-test": "yes" },
  });
  assert.equal("name" in savedAfterUpdate.mcpServers.remote, false);

  const deleteResponse = await fetch(`${baseUrl}/api/services/remote`, {
    method: "DELETE",
  });
  assert.equal(deleteResponse.status, 204);
  assert.equal(services.has("remote"), false);
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
    mcpServers: {
      local: { command: process.execPath, args: ["-v"] },
    },
  });
});

test("management update closes all matching SSE sessions when command changes", async (t) => {
  const tempDir = mkdtempSync(
    path.join(tmpdir(), "mcp-gateway-api-sse-update-command-"),
  );
  const configPath = path.join(tempDir, "mcp.json");
  const spawned = [];
  const services = new Map([
    ["local", { name: "local", command: "local-command" }],
    ["other", { name: "other", command: "other-command" }],
  ]);
  const app = createServer(
    createGatewayHandler({
      services,
      configPath,
      spawnImpl: (command) => {
        const child = createControllableChild();
        spawned.push({ command, child });
        return child;
      },
    }),
  );
  t.after(() => {
    app.close();
    rmSync(tempDir, { recursive: true, force: true });
  });
  const baseUrl = await listen(app);

  const firstLocalReader = await openSseSession(baseUrl, "local");
  const secondLocalReader = await openSseSession(baseUrl, "local");
  const otherReader = await openSseSession(baseUrl, "other");

  const updateResponse = await fetch(`${baseUrl}/api/services/local`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command: "local-command-updated" }),
  });
  assert.equal(updateResponse.status, 200);

  assert.equal(spawned[0].child.killed, true);
  assert.equal(spawned[1].child.killed, true);
  assert.equal(spawned[2].child.killed, false);
  await assertSseClosed(firstLocalReader);
  await assertSseClosed(secondLocalReader);
  await assertSseStillOpen(otherReader);
  await otherReader.cancel();
});

test("management update closes matching SSE session when url changes", async (t) => {
  const tempDir = mkdtempSync(
    path.join(tmpdir(), "mcp-gateway-api-sse-update-url-"),
  );
  const configPath = path.join(tempDir, "mcp.json");
  let child;
  const services = new Map([
    ["local", { name: "local", command: "local-command" }],
  ]);
  const app = createServer(
    createGatewayHandler({
      services,
      configPath,
      spawnImpl: () => {
        child = createControllableChild();
        return child;
      },
    }),
  );
  t.after(() => {
    app.close();
    rmSync(tempDir, { recursive: true, force: true });
  });
  const baseUrl = await listen(app);

  const reader = await openSseSession(baseUrl, "local");
  const updateResponse = await fetch(`${baseUrl}/api/services/local`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "http://example.test/mcp" }),
  });
  assert.equal(updateResponse.status, 200);

  assert.equal(child.killed, true);
  await assertSseClosed(reader);
});

test("management update closes target SSE sessions when args change", async (t) => {
  const tempDir = mkdtempSync(
    path.join(tmpdir(), "mcp-gateway-api-sse-update-args-"),
  );
  const configPath = path.join(tempDir, "mcp.json");
  const spawned = [];
  const services = new Map([
    ["local", { name: "local", command: "local-command", args: ["old"] }],
    ["other", { name: "other", command: "other-command", args: ["stable"] }],
  ]);
  const app = createServer(
    createGatewayHandler({
      services,
      configPath,
      spawnImpl: (command) => {
        const child = createControllableChild();
        spawned.push({ command, child });
        return child;
      },
    }),
  );
  t.after(() => {
    app.close();
    rmSync(tempDir, { recursive: true, force: true });
  });
  const baseUrl = await listen(app);

  const localReader = await openSseSession(baseUrl, "local");
  const otherReader = await openSseSession(baseUrl, "other");

  const updateResponse = await fetch(`${baseUrl}/api/services/local`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ args: ["new"] }),
  });
  assert.equal(updateResponse.status, 200);
  assert.deepEqual(services.get("local").args, ["new"]);

  assert.equal(spawned[0].child.killed, true);
  assert.equal(spawned[1].child.killed, false);
  await assertSseClosed(localReader);
  await assertSseStillOpen(otherReader);
  await otherReader.cancel();
});

test("management update keeps SSE sessions open for no-op body changes", async (t) => {
  const tempDir = mkdtempSync(
    path.join(tmpdir(), "mcp-gateway-api-sse-update-noop-"),
  );
  const configPath = path.join(tempDir, "mcp.json");
  let child;
  const services = new Map([
    ["local", { name: "local", command: "local-command", args: ["stable"] }],
  ]);
  const app = createServer(
    createGatewayHandler({
      services,
      configPath,
      spawnImpl: () => {
        child = createControllableChild();
        return child;
      },
    }),
  );
  t.after(() => {
    app.close();
    rmSync(tempDir, { recursive: true, force: true });
  });
  const baseUrl = await listen(app);

  const reader = await openSseSession(baseUrl, "local");
  const nameOnlyResponse = await fetch(`${baseUrl}/api/services/local`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "renamed" }),
  });
  assert.equal(nameOnlyResponse.status, 200);
  assert.equal(child.killed, false);
  await assertSseStillOpen(reader);

  const emptyBodyResponse = await fetch(`${baseUrl}/api/services/local`, {
    method: "PUT",
  });
  assert.equal(emptyBodyResponse.status, 200);
  assert.equal(child.killed, false);
  assert.deepEqual(services.get("local"), {
    name: "local",
    command: "local-command",
    args: ["stable"],
  });
  await assertSseStillOpen(reader);
  await reader.cancel();
});

test("management update leaves services map unchanged when persistence fails", async (t) => {
  const tempDir = mkdtempSync(
    path.join(tmpdir(), "mcp-gateway-api-update-fail-"),
  );
  const configPath = path.join(tempDir, "missing", "mcp.json");
  const originalService = { name: "remote", url: "http://example.test/mcp" };
  const services = new Map([["remote", originalService]]);
  const app = createServer(createGatewayHandler({ services, configPath }));
  t.after(() => {
    app.close();
    rmSync(tempDir, { recursive: true, force: true });
  });
  const baseUrl = await listen(app);

  const updateResponse = await fetch(`${baseUrl}/api/services/remote`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "http://example.test/new" }),
  });

  assert.equal(updateResponse.status, 500);
  assert.equal(services.get("remote"), originalService);
  assert.deepEqual(services.get("remote"), {
    name: "remote",
    url: "http://example.test/mcp",
  });
});

test("management delete leaves services map unchanged when persistence fails", async (t) => {
  const tempDir = mkdtempSync(
    path.join(tmpdir(), "mcp-gateway-api-delete-fail-"),
  );
  const configPath = path.join(tempDir, "missing", "mcp.json");
  const originalService = { name: "remote", url: "http://example.test/mcp" };
  const services = new Map([["remote", originalService]]);
  const app = createServer(createGatewayHandler({ services, configPath }));
  t.after(() => {
    app.close();
    rmSync(tempDir, { recursive: true, force: true });
  });
  const baseUrl = await listen(app);

  const deleteResponse = await fetch(`${baseUrl}/api/services/remote`, {
    method: "DELETE",
  });

  assert.equal(deleteResponse.status, 500);
  assert.equal(services.get("remote"), originalService);
  assert.deepEqual(services.get("remote"), {
    name: "remote",
    url: "http://example.test/mcp",
  });
});

test("management delete closes matching SSE session by service name", async (t) => {
  const tempDir = mkdtempSync(
    path.join(tmpdir(), "mcp-gateway-api-sse-delete-"),
  );
  const configPath = path.join(tempDir, "mcp.json");
  const spawned = [];
  const services = new Map([
    ["local", { name: "local", command: "local-command" }],
    ["other", { name: "other", command: "other-command" }],
  ]);
  const app = createServer(
    createGatewayHandler({
      services,
      configPath,
      spawnImpl: (command) => {
        const child = createControllableChild();
        spawned.push({ command, child });
        return child;
      },
    }),
  );
  t.after(() => {
    app.close();
    rmSync(tempDir, { recursive: true, force: true });
  });
  const baseUrl = await listen(app);

  const firstLocalReader = await openSseSession(baseUrl, "local");
  const secondLocalReader = await openSseSession(baseUrl, "local");
  const otherReader = await openSseSession(baseUrl, "other");

  const deleteResponse = await fetch(`${baseUrl}/api/services/local`, {
    method: "DELETE",
  });
  assert.equal(deleteResponse.status, 204);
  assert.equal(spawned[0].child.killed, true);
  assert.equal(spawned[1].child.killed, true);
  assert.equal(spawned[2].child.killed, false);
  await assertSseClosed(firstLocalReader);
  await assertSseClosed(secondLocalReader);
  await assertSseStillOpen(otherReader);
  await otherReader.cancel();
});

test("web mcp service is proxied via /mcp/:name", async (t) => {
  const upstream = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ upstream: true, body }));
  });
  t.after(() => upstream.close());
  const upstreamBase = await listen(upstream);

  const gateway = createServer(
    createGatewayHandler({
      services: new Map([["remote", { url: `${upstreamBase}/` }]]),
    }),
  );
  t.after(() => gateway.close());
  const gatewayBase = await listen(gateway);

  const response = await fetch(`${gatewayBase}/mcp/remote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hello: "world" }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.upstream, true);
  assert.match(payload.body, /hello/);
});

test("stdio mcp service can be called through /mcp/:name", async (t) => {
  // 行式 echo 脚本：逐行读取 stdin 并即时响应（模拟真实 MCP 服务器行为）
  const stdioEchoScript = [
    "let buf='';",
    "process.stdin.on('data',c=>{",
    "  buf+=c.toString();",
    "  const lines=buf.split('\\n');",
    "  buf=lines.pop();",
    "  lines.forEach(l=>{",
    "    if(l.trim())process.stdout.write(JSON.stringify({echo:JSON.parse(l)})+'\\n');",
    "  });",
    "});",
  ].join("");

  const gateway = createServer(
    createGatewayHandler({
      services: new Map([
        [
          "local",
          {
            command: process.execPath,
            args: ["-e", stdioEchoScript],
          },
        ],
      ]),
    }),
  );
  t.after(() => gateway.close());
  const baseUrl = await listen(gateway);

  const response = await fetch(`${baseUrl}/mcp/local`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "hi" }),
  });

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload, { echo: { message: "hi" } });
});
