import { api, formatApiErrorMessage } from './api'

describe('api error formatting', () => {
  it('returns string details directly', () => {
    expect(formatApiErrorMessage({ detail: 'Invalid credentials' }, 401)).toBe('邮箱或密码错误。')
  })

  it('formats FastAPI validation arrays into readable text', () => {
    expect(
      formatApiErrorMessage(
        {
          detail: [
            { loc: ['body', 'email'], msg: 'value is not a valid email address' },
            { loc: ['body', 'password'], msg: 'String should have at least 8 characters' },
          ],
        },
        422,
      ),
    ).toBe('邮箱：邮箱格式不正确；密码：长度不能少于 8 个字符')
  })

  it('falls back to status when payload is empty', () => {
    expect(formatApiErrorMessage(null, 500)).toBe('请求失败（状态码 500）')
  })

  it('builds encoded Agent SSE thread event paths', () => {
    expect(api.agentThreadEventsPath('thread/with space')).toBe('/api/v1/agent/threads/thread%2Fwith%20space/events')
  })
})
