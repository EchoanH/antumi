import { isValidElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ChatCatalog } from '@antumi/protocol'
import { resolveModel, type ModelChoice } from '../agent-models'
import { AgentModelPicker } from './AgentModelPicker'
import { ChatModelPicker } from './ChatPicker'

vi.hoisted(() => {
  vi.stubGlobal('window', { antumi: undefined, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
  vi.stubGlobal('navigator', { userAgent: 'Mac', platform: 'MacIntel' })
})

const catalog: ChatCatalog = { models: [
  { id: 'flash', label: 'Antigravity Flash', description: null, efforts: ['low', 'medium', 'high'], isDefault: true },
  { id: 'neon', label: 'Antigravity Neon', description: null, efforts: ['low', 'medium', 'high', 'xhigh'], isDefault: false },
  { id: 'none', label: 'Antigravity None', description: null, efforts: [], isDefault: false }
] }

function picker(choice: ModelChoice, onChange: (next: ModelChoice) => void) {
  const element = AgentModelPicker({ catalog, choice, onChange })
  if (!isValidElement<ComponentProps<typeof ChatModelPicker>>(element) || element.type !== ChatModelPicker) throw new Error('expected a model picker')
  return element
}

describe('Antigravity model choices', () => {
  it('resolves efforts against the selected model while retaining the server default', () => {
    expect(resolveModel(catalog, { effort: 'high' })).toMatchObject({ model: catalog.models[0], effort: 'high' })
    expect(resolveModel(catalog, { model: 'neon', effort: 'xhigh' })).toMatchObject({ defaultModel: catalog.models[0], modelId: 'neon', efforts: ['low', 'medium', 'high', 'xhigh'], effort: 'xhigh' })
    expect(resolveModel(catalog, { effort: 'xhigh' }).effort).toBeUndefined()
    expect(resolveModel(catalog, { model: 'none', effort: 'high' }).effort).toBeUndefined()
  })

  it('renders each selected model and passes all of its reasoning levels to the picker', () => {
    for (const model of catalog.models) {
      const element = picker({ model: model.id, effort: model.efforts.at(-1) }, () => {})
      expect(renderToStaticMarkup(element)).toContain(model.label)
      expect(element.props.models.find((entry) => entry.value === model.id)?.efforts?.map((entry) => entry.value)).toEqual(model.efforts)
      expect(element.props.effort).toBe(model.efforts.at(-1) ?? null)
    }
  })

  it('preserves compatible efforts, clears incompatible ones and saves an effort with its model', () => {
    const changed = vi.fn<(next: ModelChoice) => void>()
    picker({ effort: 'high' }, changed).props.onModel('neon')
    expect(changed).toHaveBeenLastCalledWith({ model: 'neon', effort: 'high' })
    picker({ model: 'neon', effort: 'xhigh' }, changed).props.onModel('flash')
    expect(changed).toHaveBeenLastCalledWith({ model: 'flash' })
    picker({ model: 'neon', effort: 'high' }, changed).props.onModel('none')
    expect(changed).toHaveBeenLastCalledWith({ model: 'none' })
    picker({ model: 'neon' }, changed).props.onEffort('xhigh')
    expect(changed).toHaveBeenLastCalledWith({ model: 'neon', effort: 'xhigh' })
    picker({}, changed).props.onEffort('high')
    expect(changed).toHaveBeenLastCalledWith({ model: 'flash', effort: 'high' })
  })
})
