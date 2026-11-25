import { describe, expect, it } from 'vitest'
import { assertLinuxBindingCompatible } from './linux-binding-compatibility.mjs'

const binding = (...symbols) => Buffer.from(symbols.join('\0'), 'latin1')

describe('Linux binding compatibility', () => {
  it('accepts Ubuntu 20.04 system-library versions for a remote backend', () => {
    expect(() => assertLinuxBindingCompatible(binding('GLIBC_2.31', 'GLIBCXX_3.4.28', 'CXXABI_1.3.12'), true)).not.toThrow()
  })

  it('accepts older requirements and compares versions numerically', () => {
    expect(() => assertLinuxBindingCompatible(binding('GLIBC_2.9', 'GLIBC_2.2.5', 'GLIBCXX_3.4.9', 'CXXABI_1.3.9'), true)).not.toThrow()
  })

  it.each([
    ['GLIBC_2.32', 'GLIBC_2.31'],
    ['GLIBC_2.34', 'GLIBC_2.31'],
    ['GLIBC_2.35', 'GLIBC_2.31'],
    ['GLIBC_2.42', 'GLIBC_2.31'],
    ['GLIBCXX_3.4.29', 'GLIBCXX_3.4.28'],
    ['GLIBCXX_3.4.30', 'GLIBCXX_3.4.28'],
    ['CXXABI_1.3.13', 'CXXABI_1.3.12']
  ])('rejects %s in a remote backend', (required, supported) => {
    expect(() => assertLinuxBindingCompatible(binding(required), true)).toThrow(`Ubuntu 20.04's ${supported}`)
  })

  it('checks the newest symbol even when an older one appears last', () => {
    expect(() => assertLinuxBindingCompatible(binding('GLIBC_2.34', 'GLIBC_2.28'), true)).toThrow('needs GLIBC_2.34')
  })

  it('keeps the Ubuntu 22.04 glibc baseline for a desktop package', () => {
    expect(() => assertLinuxBindingCompatible(binding('GLIBC_2.35'))).not.toThrow()
    expect(() => assertLinuxBindingCompatible(binding('GLIBC_2.36'))).toThrow("Ubuntu 22.04's GLIBC_2.35")
  })

  it('does not apply remote C++ limits to the desktop package', () => {
    expect(() => assertLinuxBindingCompatible(binding('GLIBC_2.35', 'GLIBCXX_3.4.30', 'CXXABI_1.3.13'))).not.toThrow()
  })
})
