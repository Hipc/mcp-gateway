import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export function loadDotEnv(dotEnvPath) {
  if (!existsSync(dotEnvPath)) {
    return {};
  }

  const raw = readFileSync(dotEnvPath, "utf8");
  const entries = {};

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    entries[key] = value;
  }
  return entries;
}

export function loadMcpConfig(configPath) {
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }
  const raw = readFileSync(configPath, "utf8");
  return JSON.parse(raw);
}

export function resolvePaths(cwd, envFromFile) {
  const configPath = envFromFile.MCP_CONFIG
    ? path.resolve(cwd, envFromFile.MCP_CONFIG)
    : path.resolve(cwd, "mcp.json");
  const dotEnvPath = path.resolve(cwd, ".env");
  return { configPath, dotEnvPath };
}
