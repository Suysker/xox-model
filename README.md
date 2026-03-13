# xox-model

面向小型经营团队的测算、记账、预实分析与版本化管理平台。

## 仓库结构

- `apps/web`：React + Vite 前端
- `apps/api`：FastAPI + SQLAlchemy 后端
- `docs`：架构、项目规划、接口说明、验收清单、运维说明
- `infra/scripts`：部署与辅助脚本

## 功能范围

- 认证：注册、登录、退出登录、注销账号
- 测算：可编辑草稿、自动保存、发布版本、历史回滚、公开分享
- 记账：按预测科目录入实际收入与成本分录
- 预实分析：按期间与科目对比预算基线和实际结果
- 分享：为不可变发布版生成只读公开链接，并支持撤销

## 本地开发

### 前端

```bash
npm.cmd install
npm.cmd run dev:web
```

### 后端

```bash
python -m pip install -e ./apps/api
python -m uvicorn app.main:app --app-dir apps/api --reload
```

## 验证命令

```bash
npm.cmd run test:web
npm.cmd run build:web
python -m pytest apps/api/tests
npm.cmd run test
```

## 文档索引

- 架构说明：`docs/project-architecture.md`
- 项目总规划：`docs/project-plan.md`
- 接口说明：`docs/api.md`
- 运维与迁移：`docs/operations.md`
- 验收清单：`docs/acceptance.md`

## 说明

- 前端放在 `apps/web` 下，避免仓库随着功能增长而把所有文件堆在根目录。
- 后端围绕“可变草稿、不可变发布版、按期间记账、按基线做预实分析”这条主线设计。
- 公开分享只允许针对发布版，确保外部链接不会被后续草稿修改污染。
- 审计日志覆盖认证、工作区、分享和账务关键动作。
- 发布时会同时固化月度事实表和行项目事实表，便于后续对账与分析。
