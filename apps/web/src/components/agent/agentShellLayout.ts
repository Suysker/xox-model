export type AgentShellLayoutMode = 'bottomDrawer' | 'sidePanel'
export type AgentShellSurface = 'drawer' | 'side'

export type AgentShellLayoutPreference = {
  mode: AgentShellLayoutMode
  bottomHeightPx: number
  sideWidthPx: number
}

export type AgentShellViewport = {
  width: number
  height: number
}

export const AGENT_SHELL_LAYOUT_STORAGE_KEY = 'xox.agent.shell.layout.v1'

export const AGENT_BOTTOM_DRAWER_DEFAULT_RATIO = 0.44
export const AGENT_BOTTOM_DRAWER_MIN_HEIGHT = 280
export const AGENT_BOTTOM_DRAWER_MAX_RATIO = 0.82
export const AGENT_SIDE_PANEL_DEFAULT_WIDTH = 420
export const AGENT_SIDE_PANEL_MIN_WIDTH = 360
export const AGENT_SIDE_PANEL_MAX_WIDTH = 720
export const AGENT_SIDE_PANEL_MAX_RATIO = 0.55
export const AGENT_SIDE_PANEL_MIN_VIEWPORT_WIDTH = 900

export const FALLBACK_VIEWPORT: AgentShellViewport = {
  width: 1280,
  height: 800,
}

type LayoutStorage = Pick<Storage, 'getItem' | 'setItem'>

function finiteNumber(value: unknown): number | null {
  const numberValue = Number(value)
  return Number.isFinite(numberValue) ? numberValue : null
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

export function bottomDrawerBounds(viewport: AgentShellViewport) {
  const max = Math.max(160, Math.floor(viewport.height * AGENT_BOTTOM_DRAWER_MAX_RATIO))
  const min = Math.min(AGENT_BOTTOM_DRAWER_MIN_HEIGHT, max)
  return { min, max }
}

export function sidePanelBounds(viewport: AgentShellViewport) {
  const maxByViewport = Math.floor(viewport.width * AGENT_SIDE_PANEL_MAX_RATIO)
  const max = Math.max(AGENT_SIDE_PANEL_MIN_WIDTH, Math.min(AGENT_SIDE_PANEL_MAX_WIDTH, maxByViewport))
  return { min: AGENT_SIDE_PANEL_MIN_WIDTH, max }
}

export function defaultBottomDrawerHeight(viewport: AgentShellViewport) {
  const bounds = bottomDrawerBounds(viewport)
  return clamp(Math.round(viewport.height * AGENT_BOTTOM_DRAWER_DEFAULT_RATIO), bounds.min, bounds.max)
}

export function defaultSidePanelWidth(viewport: AgentShellViewport) {
  const bounds = sidePanelBounds(viewport)
  return clamp(AGENT_SIDE_PANEL_DEFAULT_WIDTH, bounds.min, bounds.max)
}

export function clampBottomDrawerHeight(value: number, viewport: AgentShellViewport) {
  const bounds = bottomDrawerBounds(viewport)
  return clamp(value, bounds.min, bounds.max)
}

export function clampSidePanelWidth(value: number, viewport: AgentShellViewport) {
  const bounds = sidePanelBounds(viewport)
  return clamp(value, bounds.min, bounds.max)
}

export function defaultAgentShellLayoutPreference(viewport: AgentShellViewport): AgentShellLayoutPreference {
  return {
    mode: 'bottomDrawer',
    bottomHeightPx: defaultBottomDrawerHeight(viewport),
    sideWidthPx: defaultSidePanelWidth(viewport),
  }
}

export function effectiveAgentShellLayoutMode(mode: AgentShellLayoutMode, viewport: AgentShellViewport): AgentShellLayoutMode {
  return mode === 'sidePanel' && viewport.width < AGENT_SIDE_PANEL_MIN_VIEWPORT_WIDTH ? 'bottomDrawer' : mode
}

export function normalizeAgentShellLayoutPreference(value: unknown, viewport: AgentShellViewport): AgentShellLayoutPreference {
  const fallback = defaultAgentShellLayoutPreference(viewport)
  if (!value || typeof value !== 'object') return fallback
  const record = value as Record<string, unknown>
  const mode = record.mode === 'sidePanel' || record.mode === 'bottomDrawer' ? record.mode : fallback.mode
  return {
    mode,
    bottomHeightPx: clampBottomDrawerHeight(finiteNumber(record.bottomHeightPx) ?? fallback.bottomHeightPx, viewport),
    sideWidthPx: clampSidePanelWidth(finiteNumber(record.sideWidthPx) ?? fallback.sideWidthPx, viewport),
  }
}

export function readAgentShellLayoutPreference(storage: LayoutStorage | undefined | null, viewport: AgentShellViewport) {
  if (!storage) return defaultAgentShellLayoutPreference(viewport)
  try {
    const raw = storage.getItem(AGENT_SHELL_LAYOUT_STORAGE_KEY)
    return normalizeAgentShellLayoutPreference(raw ? JSON.parse(raw) : null, viewport)
  } catch {
    return defaultAgentShellLayoutPreference(viewport)
  }
}

export function writeAgentShellLayoutPreference(storage: LayoutStorage | undefined | null, preference: AgentShellLayoutPreference) {
  if (!storage) return
  try {
    storage.setItem(AGENT_SHELL_LAYOUT_STORAGE_KEY, JSON.stringify(preference))
  } catch {
    // Layout preference is non-authoritative UI state.
  }
}
