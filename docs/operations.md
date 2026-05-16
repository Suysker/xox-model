# 运维说明

## 本地运行

前端：

```bash
npm.cmd install
npm.cmd run dev:web
```

后端：

```bash
npm.cmd run dev:api
```

## Linux 一键部署

生产环境的前后端部署统一使用 `infra/scripts/deploy-linux.sh`。这个脚本不会修改 nginx 配置，而是直接在服务器上完成：

- 代码拉取或更新（当提供 `REPO_URL` 时）
- 前端和 TypeScript API 构建
- Node workspace 依赖安装
- `xox-model-api` / `xox-model-web` 两个 systemd 服务写入与重启
- Web 服务同源代理 `/api/*` 到本机 API

在仓库根目录执行：

```bash
sudo bash infra/scripts/deploy-linux.sh
```

如果脚本是单独放在目标机器当前目录执行的，则需要在执行前传入仓库地址：

```bash
sudo REPO_URL=<git-url> bash ./deploy-linux.sh
```

可选参数：

```bash
sudo WEB_PORT=4173 API_PORT=8000 PUBLIC_ORIGIN=http://127.0.0.1:4173 bash infra/scripts/deploy-linux.sh
sudo RUN_TESTS=1 bash infra/scripts/deploy-linux.sh
```

部署后验证：

```bash
curl http://127.0.0.1:8000/api/v1/health
curl http://127.0.0.1:4173/api/v1/health
sudo systemctl status xox-model-api
sudo systemctl status xox-model-web
```

## 数据库

- 本地默认：`SQLite`
- 生产目标：`PostgreSQL`
- 当前建表 / 迁移入口：API 启动时自动运行 `apps/api/src/db/migrations.ts`
- 当前迁移策略基于 `CREATE TABLE IF NOT EXISTS` 和缺列补丁，可重复执行

## 验证命令

```bash
npm.cmd run test:web
npm.cmd run build:web
npm.cmd run build:api
npm.cmd run test:api
npm.cmd run test
```

预期结果：

- 前端单测全部通过
- 前端生产构建成功
- TypeScript 后端 API/Agent 集成测试全部通过
- 根目录组合测试命令通过

## 审计覆盖

以下核心动作会写入 `audit_logs`：

- 认证：注册 / 登录 / 退出 / 会话续期 / 注销
- 草稿：自动保存与自动保存冲突
- 版本：发布与回滚
- 分享：创建 / 重新签发 / 撤销
- 账务：记账 / 作废
- 期间：锁定 / 解锁
- Agent：确认卡创建 / 执行 / 取消，以及确认后的业务动作

## 部署说明

- `apps/web` 与 `apps/api` 必须保持独立可部署
- 部署脚本放在 `infra/scripts`，不要重新摊平到仓库根目录
- SQLite 仅用于本地和开发环境，生产请使用 PostgreSQL 并配套备份
- 在引入不可逆线上迁移前，先补正式 Kysely migration 版本目录
