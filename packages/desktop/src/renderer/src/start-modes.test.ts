import { describe, expect, it } from 'vitest'
import { defaultStartMode, modeLabel, nextStartModes, startModes } from './components/ChatOptionsBar'
import { handoffMode } from './components/ChatHandoff'

const model = (autoMode?: boolean) => ({ id: 'opus', label: 'Opus', description: null, efforts: [], isDefault: true, ...(autoMode === undefined ? {} : { autoMode }) })

describe('startModes', () => {
  it('shows Cursor native modes, without auto or bypass', () => {
    const modes = startModes('cursor', model(true))
    expect(modes).toEqual(['ask', 'plan', 'readOnly'])
    expect(modes.map((mode) => modeLabel('cursor', mode))).toEqual(['Agent', 'Plan', 'Ask'])
    expect(defaultStartMode('cursor', modes)).toBe('ask')
  })
  it('offers auto where the model takes it, and bypass where the agent has it', () => {
    expect(startModes('claude', model(true))).toEqual(['ask', 'acceptEdits', 'plan', 'auto', 'bypass'])
    expect(startModes('claude', model())).toEqual(['ask', 'acceptEdits', 'plan', 'bypass'])
    expect(startModes('claude', undefined)).toEqual(['ask', 'acceptEdits', 'plan', 'bypass'])
    expect(startModes('codex', model())).toEqual(['acceptEdits', 'ask', 'plan', 'readOnly', 'bypass'])
    expect(startModes('codex', model(true))).toEqual(['acceptEdits', 'ask', 'plan', 'readOnly', 'bypass'])
  })

  it('defaults each agent independently and falls back when Claude auto is unavailable', () => {
    expect(defaultStartMode('claude', startModes('claude', model(true)))).toBe('auto')
    expect(defaultStartMode('claude', startModes('claude', model()))).toBe('ask')
    expect(defaultStartMode('codex', startModes('codex', model()))).toBe('acceptEdits')
  })

  it('offers backend-specific native modes for Antigravity without cross-backend leakage', () => {
    const agyModes = startModes('antigravity', model(), 'agy-cli')
    expect(agyModes).toEqual(['ask', 'acceptEdits', 'auto', 'plan', 'bypass'])
    expect(agyModes.map((mode) => modeLabel('antigravity', mode))).toEqual(['逐项确认', '自动接受编辑', '自动判断', '规划', '全部放行'])

    const managedModes = startModes('antigravity', model(), 'managed-acp')
    expect(managedModes).toEqual(['ask', 'acceptEdits', 'bypass'])
    expect(managedModes.map((mode) => modeLabel('antigravity', mode))).toEqual(['逐项确认', '自动接受编辑', '全部放行'])

    // Stopped existing conversations keep their last stage's modes even if global runtime changed.
    expect(nextStartModes('antigravity', ['ask', 'acceptEdits', 'auto', 'plan', 'bypass'], model(), 'managed-acp', false)).toEqual(['ask', 'acceptEdits', 'auto', 'plan', 'bypass'])
    expect(nextStartModes('antigravity', ['ask', 'acceptEdits', 'bypass'], model(), 'agy-cli', false)).toEqual(['ask', 'acceptEdits', 'bypass'])
    // New/unstarted conversations (no state yet) follow the globally active backend.
    expect(nextStartModes('antigravity', [], model(), 'agy-cli', false)).toEqual(['ask', 'acceptEdits', 'auto', 'plan', 'bypass'])
    expect(nextStartModes('antigravity', [], model(), 'managed-acp', false)).toEqual(['ask', 'acceptEdits', 'bypass'])
  })
})

describe('handoffMode', () => {
  it('takes the mode picked, else the chat\'s where the agent has it, else its default', () => {
    const cursor = startModes('cursor', model())
    expect(handoffMode('cursor', cursor, 'readOnly', 'plan')).toBe('readOnly')
    expect(handoffMode('cursor', cursor, undefined, 'plan')).toBe('plan')
    // Cursor has no accept-edits mode: the handoff shows it going to Cursor's default instead.
    expect(handoffMode('cursor', cursor, undefined, 'acceptEdits')).toBe('ask')
    expect(handoffMode('codex', startModes('codex', model()), 'auto', null)).toBe('acceptEdits')
  })
})
