import { createServer } from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { createGatewayHandler, normalizeMcpConfig } from "../src/gateway.js";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

test("normalizeMcpConfig supports object and array format", () => {
  const objectMap = normalizeMcpConfig({
    mcps: {
      local: { command: "node", args: ["-v"] }
    }
  });
  assert.equal(objectMap.get("local").command, "node");

  const arrayMap = normalizeMcpConfig({
    mcps: [{ name: "remote", url: "http://example.com" }]
  });
  assert.equal(arrayMap.get("remote").url, "http://example.com");
});

test("auth token is required when configured", async (t) => {
  const services = new Map([["demo", { url: "http://invalid.local" }]]);
  const app = createServer(
    createGatewayHandler({
      services,
      authorizationToken: "secret-token",
      fetchImpl: async () => new Response("ok")
    })
  );
  t.after(() => app.close());
  const baseUrl = await listen(app);

  const unauthorized = await fetch(`${baseUrl}/mcp/demo`, {
    method: "POST",
    body: JSON.stringify({ ping: true })
  });
  assert.equal(unauthorized.status, 401);

  const authorized = await fetch(`${baseUrl}/mcp/demo`, {
    method: "POST",
    headers: { Authorization: "Bearer secret-token" },
    body: JSON.stringify({ ping: true })
  });
  assert.equal(authorized.status, 200);
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
      services: new Map([["remote", { url: `${upstreamBase}/` }]])
    })
  );
  t.after(() => gateway.close());
  const gatewayBase = await listen(gateway);

  const response = await fetch(`${gatewayBase}/mcp/remote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hello: "world" })
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.upstream, true);
  assert.match(payload.body, /hello/);
});

test("stdio mcp service can be called through /mcp/:name", async (t) => {
  const stdioEchoScript = [
    "let d='';",
    "process.stdin.on('data', c => d += c);",
    "process.stdin.on('end', () => {",
    "  process.stdout.write(JSON.stringify({ echo: JSON.parse(d) }));",
    "});"
  ].join(" ");

  const gateway = createServer(
    createGatewayHandler({
      services: new Map([
        [
          "local",
          {
            command: process.execPath,
            args: [
              "-e",
              stdioEchoScript
            ]
          }
        ]
      ])
    })
  );
  t.after(() => gateway.close());
  const baseUrl = await listen(gateway);

  const response = await fetch(`${baseUrl}/mcp/local`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "hi" })
  });

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload, { echo: { message: "hi" } });
});
