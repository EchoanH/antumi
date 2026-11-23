// Semantic version order (a pre-release before its release, numeric identifiers by value), on plain
// Node too: the app's updates, and which of two apps' backends stays on a server they share.

type Version = { core: [number, number, number]; pre: string[] }

function parseVersion(text: string): Version | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text.trim())
  if (!match) return null
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ? match[4].split('.') : [] }
}

export function isVersion(text: string): boolean {
  return parseVersion(text) !== null
}

export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return 0
  for (let index = 0; index < 3; index++) {
    const diff = (left.core[index] ?? 0) - (right.core[index] ?? 0)
    if (diff !== 0) return Math.sign(diff)
  }
  if (left.pre.length === 0 || right.pre.length === 0) return Math.sign(right.pre.length - left.pre.length)
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index++) {
    const x = left.pre[index]
    const y = right.pre[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const xs = /^\d+$/.test(x)
    const ys = /^\d+$/.test(y)
    if (xs && ys) return Math.sign(Number(x) - Number(y))
    if (xs !== ys) return xs ? -1 : 1
    return x < y ? -1 : 1
  }
  return 0
}
