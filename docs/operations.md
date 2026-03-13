# 运维说明

## 本地运行

前端：

```bash
npm.cmd install
npm.cmd run dev:web
```

后端：

```bash
python -m pip install -e ./apps/api
python -m uvicorn app.main:app --app-dir apps/api --reload
```

## 数据库

- 本地默认：`SQLite`
- 生产目标：`PostgreSQL`
- 当前建表 / 迁移入口：在 `apps/api` 下运行 `python -m app.migrations`
- 当前迁移策略基于元数据和补丁脚本，可重复执行；`create_all()` 多次运行是安全的

## 验证命令

```bash
npm.cmd run test:web
npm.cmd run build:web
python -m pytest apps/api/tests
npm.cmd run test
```

预期结果：

- 前端单测全部通过
- 前端生产构建成功
- 后端 API 集成测试全部通过
- 根目录组合测试命令通过

## 审计覆盖

以下核心动作会写入 `audit_logs`：

- 认证：注册 / 登录 / 退出 / 会话续期 / 注销
- 草稿：自动保存与自动保存冲突
- 版本：发布与回滚
- 分享：创建 / 重新签发 / 撤销
- 账务：记账 / 作废
- 期间：锁定 / 解锁

## 部署说明

- `apps/web` 与 `apps/api` 必须保持独立可部署
- 部署脚本放在 `infra/scripts`，不要重新摊平到仓库根目录
- SQLite 仅用于本地和开发环境，生产请使用 PostgreSQL 并配套备份
- 在引入不可逆线上迁移前，先补正式 Alembic 迁移体系
