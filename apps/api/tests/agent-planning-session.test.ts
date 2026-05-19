import { describe, expect, it } from 'vitest'
import { splitRequestedSteps } from '../src/agent/planning-session.js'

describe('Agent planning session segmentation', () => {
  it('splits compact multi-action messages on semicolons and newlines', () => {
    expect(splitRequestedSteps('新增成员 A；删除成员 B\n发布当前版本')).toEqual([
      '新增成员 A',
      '删除成员 B',
      '发布当前版本',
    ])
  })

  it('keeps long structured briefs together so one model call sees the full scenario', () => {
    const brief = [
      '我们要新建一个偏大型经营测算，先帮我规划 12 个月模型。',
      '',
      '项目名称：星河 50 期启动测算',
      '周期：从 2026 年 3 月开始，预测 12 个月。',
      '投资和股东：',
      '1. 股东 A 投资 300000，占分红 35%；启动成本 180000',
      '2. 股东 B 投资 200000，占分红 25%；启动成本 120000',
      '成员结构：',
      '- 50 个成员全部先用默认名字生成。',
      '- 10 个核心成员基础保底每月 2500，提成 12%；25 个普通成员提成 10%。',
      '请你拆成步骤，所有写入都生成可编辑确认卡。',
    ].join('\n')

    expect(splitRequestedSteps(brief)).toEqual([brief])
  })

  it('does not split semicolons inside JSON artifacts', () => {
    expect(splitRequestedSteps('导入 {"name":"A;B","items":[1,2]}；导出当前工作区')).toEqual([
      '导入 {"name":"A;B","items":[1,2]}',
      '导出当前工作区',
    ])
  })
})
