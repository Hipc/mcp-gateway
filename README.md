# mcp-gateway

将本地 `stdio` MCP 服务和已有 Web MCP 服务统一暴露为一个 HTTP 网关。

## 功能

- 通过 `mcp.json` 配置多个 MCP 服务
- 每个服务自动映射到路径：`/mcp/:mcp-name`
- 支持两类后端：
  - 本地 stdio（通过 `command` + `args`）
  - 远程 Web MCP（通过 `url`）
- 可选鉴权：
  - `.env` 中不配置 token：默认放行
  - `.env` 配置 `AUTHORIZATION_TOKEN`：必须携带 `Authorization: Bearer <token>`

## 快速开始

```bash
npm install
npm start
```

默认监听 `http://localhost:3000`。

## 配置

### `.env`（可选）

```env
AUTHORIZATION_TOKEN=xxxx
PORT=3000
MCP_CONFIG=./mcp.json
```

### `mcp.json`

```json
{
  "mcpServers": {
    "local-stdio": {
      "command": "node",
      "args": ["./local-mcp-server.js"]
    },
    "remote-web": {
      "url": "https://example.com/mcp"
    }
  }
}
```

访问方式示例：

- `POST /mcp/local-stdio`
- `POST /mcp/remote-web`
