import { describe, expect, it } from 'vitest'
import { productionCsp } from '../../electron.vite.config'
import { WALLPAPER_SCHEME } from '../shared/wallpaper'

function parseDirectives(policy: string): Map<string, string[]> {
  const directives = new Map<string, string[]>()
  for (const raw of policy.split(';')) {
    const tokens = raw.trim().split(/\s+/).filter(Boolean)
    const [name, ...sources] = tokens
    if (name) directives.set(name, sources)
  }
  return directives
}

describe('production renderer CSP', () => {
  it('allows the controlled wallpaper protocol in img-src without relaxing other directives', () => {
    const plugin = productionCsp()
    expect(plugin.apply).toBe('build')
    const hook = plugin.transformIndexHtml
    expect(typeof hook).toBe('function')
    if (typeof hook !== 'function') throw new Error('Expected transformIndexHtml hook')
    const tags: unknown = Reflect.apply(hook, undefined, [
      '<!doctype html><html><head></head><body></body></html>',
      { path: '/index.html', filename: 'index.html' }
    ])
    expect(Array.isArray(tags)).toBe(true)
    if (!Array.isArray(tags)) throw new Error('Expected HTML tag descriptors')
    const cspTag = tags.find(
      (tag): tag is { tag: string; attrs?: Record<string, string | boolean | undefined> } =>
        typeof tag === 'object' && tag !== null && 'tag' in tag && tag.tag === 'meta' && 'attrs' in tag &&
        typeof tag.attrs === 'object' && tag.attrs !== null && 'http-equiv' in tag.attrs && tag.attrs['http-equiv'] === 'Content-Security-Policy'
    )
    expect(cspTag).toBeDefined()
    const content = cspTag?.attrs?.content
    expect(typeof content).toBe('string')
    if (typeof content !== 'string') throw new Error('Expected CSP content string')

    const directives = parseDirectives(content)
    expect(directives.get('default-src')).toEqual(["'self'"])
    expect(directives.get('script-src')).toEqual(["'self'"])
    expect(directives.get('img-src')).toContain(`${WALLPAPER_SCHEME}:`)
    expect(directives.get('img-src')).toContain('antumi-preview:')
    expect(directives.get('img-src')).not.toContain('http:')
    expect(directives.get('img-src')).not.toContain('https:')
    expect(directives.get('img-src')).not.toContain('*')
    expect(directives.get('frame-src')).not.toContain(`${WALLPAPER_SCHEME}:`)
  })
})
