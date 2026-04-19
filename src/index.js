import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDotEnv, loadMcpConfig, resolvePaths } from "./config.js";
import { createGatewayHandler, normalizeMcpConfig } from "./gateway.js";

function getRuntimeEnv(cwd) {
  const { dotEnvPath } = resolvePaths(cwd, process.env);
  const envFromFile = loadDotEnv(dotEnvPath);
  return { ...envFromFile, ...process.env };
}

export function createApp(cwd = process.cwd()) {
  const runtimeEnv = getRuntimeEnv(cwd);
  const { configPath } = resolvePaths(cwd, runtimeEnv);
  const rawConfig = loadMcpConfig(configPath);
  const services = normalizeMcpConfig(rawConfig);
  const handler = createGatewayHandler({
    services,
    authorizationToken: runtimeEnv.AUTHORIZATION_TOKEN
  });
  return createServer(handler);
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  const runtimeEnv = getRuntimeEnv(process.cwd());
  const port = Number.parseInt(runtimeEnv.PORT || "3000", 10);
  const server = createApp(process.cwd());
  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`MCP gateway listening on http://localhost:${port}`);
  });
}
