// Remote backends also run on Ubuntu 20.04; the desktop package keeps its 22.04 baseline.
export function assertLinuxBindingCompatible(bytes, linuxBackend = false) {
  const baseline = linuxBackend ? 'Ubuntu 20.04' : 'Ubuntu 22.04'
  const limits = linuxBackend
    ? { GLIBC: [2, 31], GLIBCXX: [3, 4, 28], CXXABI: [1, 3, 12] }
    : { GLIBC: [2, 35] }
  const symbols = bytes.toString('latin1')
  for (const [family, limit] of Object.entries(limits)) {
    const versions = [...symbols.matchAll(new RegExp(`\\b${family}_(\\d+(?:\\.\\d+)+)\\b`, 'g'))]
      .map((match) => match[1].split('.').map(Number))
    const newest = versions.reduce((a, b) => compareVersions(a, b) < 0 ? b : a, [0])
    if (compareVersions(newest, limit) > 0) {
      throw new Error(`[bundle-backend] node-pty needs ${family}_${newest.join('.')}, newer than ${baseline}'s ${family}_${limit.join('.')}: rebuild node-pty on ${baseline}`)
    }
  }
}

function compareVersions(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0)
    if (difference) return difference
  }
  return 0
}
