# ── 阶段1: 安装依赖 ────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

# 先拷贝依赖声明文件，利用 Docker 层缓存加速构建
COPY package.json pnpm-lock.yaml ./

# 安装 pnpm 并执行生产依赖安装
RUN corepack enable pnpm && pnpm install --frozen-lockfile --prod

# ── 阶段2: 运行镜像 ────────────────────────────
FROM node:20-alpine

LABEL maintainer="mcp-gateway"

WORKDIR /app

# 仅拷贝生产依赖（不含 devDependencies）
COPY --from=deps /app/node_modules ./node_modules
# 拷贝应用源码和配置文件
COPY package.json ./
COPY src/ ./src/

# 默认端口
ENV PORT=3000
# mcp.json 配置文件路径（容器内路径）
ENV MCP_CONFIG=/app/config/mcp.json

EXPOSE 3000

ENTRYPOINT ["node", "src/index.js"]
