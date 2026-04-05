# 接口说明

## 认证

- `POST /api/v1/auth/register`
  - 创建 `user + workspace + draft + session`
- `POST /api/v1/auth/login`
  - 创建新的会话 Cookie
- `GET /api/v1/auth/me`
  - 返回当前用户并刷新会话有效期
- `POST /api/v1/auth/logout`
  - 只撤销当前会话
- `DELETE /api/v1/auth/me`
  - 注销账号并撤销全部会话

## 工作区

- `GET /api/v1/workspace/draft`
  - 返回当前可编辑草稿
- `PATCH /api/v1/workspace/draft`
  - 必须传 `revision`
  - 草稿版本过旧时返回 `409`
- `GET /api/v1/workspace/versions`
  - 返回不可变版本列表及当前分享信息
- `POST /api/v1/workspace/versions`
  - `kind` 取值：`snapshot | release`
  - 发布时会固化 `forecast_month_facts` 与 `forecast_line_item_facts`
- `POST /api/v1/workspace/versions/{id}/rollback`
  - 从历史不可变版本生成新草稿
  - 回滚后账期、科目与预实分析口径会同步切到该版本对应的草稿
- `DELETE /api/v1/workspace/versions/{id}`
  - 若版本已激活或已分享，则拒绝删除

## 分享

- `POST /api/v1/workspace/versions/{id}/share`
  - 仅允许分享发布版
- `DELETE /api/v1/workspace/versions/{id}/share`
  - 立即撤销公开访问 Token
- `GET /api/v1/public/shares/{token}`
  - 返回冻结的发布版配置与结果，只读展示

## 账务

- `GET /api/v1/ledger/periods`
  - 返回期间列表，以及计划 / 实际汇总
  - 若当前草稿已有月份但账期尚未生成，会按草稿自动补齐
  - 只返回当前草稿规划范围内仍然有效的月份；当规划月数从 24 缩到 12 时，超出的账期会从列表里收回
- `GET /api/v1/ledger/periods/{id}/subjects`
  - 返回该期间当前草稿计划对应的标准化预测科目
  - 会包含少量计划值为 `0` 的通用挂账科目，例如收入侧的 `退费退款`
- `POST /api/v1/ledger/periods/{id}/lock`
- `POST /api/v1/ledger/periods/{id}/unlock`
- `GET /api/v1/ledger/entries?periodId=...`
- `POST /api/v1/ledger/entries`
  - 支持一笔分录分摊到多个科目
  - 分摊总额必须等于分录金额
  - 分摊科目方向必须与 `direction` 一致
  - 若显式传入 `occurredAt`，后端会按该日期的月份归到账期；若未传，则继续使用请求里的 `ledgerPeriodId`
  - 锁定期间拒绝写入
- `PATCH /api/v1/ledger/entries/{id}`
  - 更新已过账的手工分录
  - 若本次更新显式改了 `occurredAt`，分录会同步移动到对应月份的账期
  - 自动生成的提成分录不能直接编辑，需要从源收入分录一起修改
- `POST /api/v1/ledger/entries/{id}/void`
  - 锁定期间拒绝作废
- `POST /api/v1/ledger/entries/{id}/restore`
  - 锁定期间拒绝取消作废
  - 自动生成的提成分录不能直接取消作废，需要从源收入分录一起恢复

## 预实分析

- `GET /api/v1/variance/periods/{id}`
  - 返回：
    - 当前期间计划 / 实际汇总
    - 当前期间差异额 / 差异率
    - 累计计划 / 实际汇总
    - 累计差异额 / 差异率
    - 科目级差异明细

## 错误语义

- `401`：未登录或会话已失效
- `403`：资源存在但属于其他工作区
- `404`：资源不存在
- `409`：草稿版本冲突或受保护资源删除失败
- `422`：业务参数非法
