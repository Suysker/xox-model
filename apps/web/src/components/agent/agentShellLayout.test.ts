import {
  AGENT_BOTTOM_DRAWER_MAX_RATIO,
  AGENT_BOTTOM_DRAWER_MIN_HEIGHT,
  AGENT_SIDE_PANEL_DEFAULT_WIDTH,
  AGENT_SIDE_PANEL_MIN_VIEWPORT_WIDTH,
  AGENT_SIDE_PANEL_MIN_WIDTH,
  clampBottomDrawerHeight,
  clampSidePanelWidth,
  defaultAgentShellLayoutPreference,
  effectiveAgentShellLayoutMode,
  readAgentShellLayoutPreference,
  writeAgentShellLayoutPreference,
} from './agentShellLayout'

function memoryStorage(seed?: string): Storage {
  let value = seed ?? null
  return {
    getItem: () => value,
    setItem: (_key: string, nextValue: string) => {
      value = nextValue
    },
    removeItem: () => {
      value = null
    },
    clear: () => {
      value = null
    },
    key: () => null,
    get length() {
      return value ? 1 : 0
    },
  }
}

describe('agent shell layout helpers', () => {
  it('defaults to the bottom drawer and clamps persisted dimensions', () => {
    const viewport = { width: 1280, height: 900 }
    expect(defaultAgentShellLayoutPreference(viewport)).toEqual({
      mode: 'bottomDrawer',
      bottomHeightPx: 396,
      sideWidthPx: AGENT_SIDE_PANEL_DEFAULT_WIDTH,
    })

    const preference = readAgentShellLayoutPreference(
      memoryStorage(JSON.stringify({ mode: 'sidePanel', bottomHeightPx: 9999, sideWidthPx: 10 })),
      viewport,
    )
    expect(preference).toEqual({
      mode: 'sidePanel',
      bottomHeightPx: Math.floor(viewport.height * AGENT_BOTTOM_DRAWER_MAX_RATIO),
      sideWidthPx: AGENT_SIDE_PANEL_MIN_WIDTH,
    })
  })

  it('falls back safely when localStorage is unavailable or broken', () => {
    const viewport = { width: 1280, height: 900 }
    const brokenStorage = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    } as unknown as Storage

    expect(readAgentShellLayoutPreference(null, viewport)).toEqual(defaultAgentShellLayoutPreference(viewport))
    expect(readAgentShellLayoutPreference(brokenStorage, viewport)).toEqual(defaultAgentShellLayoutPreference(viewport))
    expect(() => writeAgentShellLayoutPreference(brokenStorage, defaultAgentShellLayoutPreference(viewport))).not.toThrow()
  })

  it('temporarily falls side panel back to drawer on narrow screens', () => {
    expect(effectiveAgentShellLayoutMode('sidePanel', { width: AGENT_SIDE_PANEL_MIN_VIEWPORT_WIDTH - 1, height: 800 })).toBe('bottomDrawer')
    expect(effectiveAgentShellLayoutMode('sidePanel', { width: AGENT_SIDE_PANEL_MIN_VIEWPORT_WIDTH, height: 800 })).toBe('sidePanel')
    expect(effectiveAgentShellLayoutMode('bottomDrawer', { width: 1600, height: 800 })).toBe('bottomDrawer')
  })

  it('clamps drawer height and side panel width to viewport-aware bounds', () => {
    expect(clampBottomDrawerHeight(50, { width: 1280, height: 900 })).toBe(AGENT_BOTTOM_DRAWER_MIN_HEIGHT)
    expect(clampBottomDrawerHeight(2000, { width: 1280, height: 900 })).toBe(738)
    expect(clampSidePanelWidth(50, { width: 1280, height: 900 })).toBe(AGENT_SIDE_PANEL_MIN_WIDTH)
    expect(clampSidePanelWidth(2000, { width: 1280, height: 900 })).toBe(704)
  })
})
