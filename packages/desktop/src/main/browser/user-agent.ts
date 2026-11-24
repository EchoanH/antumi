// What Chrome itself would send on this machine, for Google's pages (siteUserAgent): Electron's own
// names the app and Electron. Sent to Google alone: elsewhere a page that claims Chrome without
// being it fails Cloudflare's checks on some sites, V2EX's among them, and their challenge never
// lets it through.
export function chromeUserAgent(electron: string, chromeVersion: string): string {
  const platform = /^Mozilla\/5\.0 (\([^)]*\))/.exec(electron)?.[1]
  const major = chromeVersion.split('.')[0]
  if (!platform || !major) return electron.replace(/ Electron\/\S+/, '')
  // The reduced form Chrome has sent since 101: the major version alone.
  return `Mozilla/5.0 ${platform} AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
}

// What Chrome on Android sends, in its reduced form, for a page held at a phone's or a tablet's
// size: many sites (Google's own) pick their mobile layout from this, not from the width. A tablet
// is told apart by leaving out "Mobile", as Chrome does.
export function mobileUserAgent(chromeVersion: string, phone: boolean): string {
  const major = chromeVersion.split('.')[0] ?? '0'
  return `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 ${phone ? 'Mobile ' : ''}Safari/537.36`
}

// The client hints that go with mobileUserAgent, as Chrome on Android gives them.
export function mobileClientHints(chromeVersion: string, phone: boolean) {
  const major = chromeVersion.split('.')[0] ?? '0'
  return {
    brands: [{ brand: 'Chromium', version: major }, { brand: 'Google Chrome', version: major }, { brand: 'Not.A/Brand', version: '99' }],
    platform: 'Android',
    platformVersion: '10.0.0',
    architecture: '',
    model: phone ? 'K' : '',
    mobile: phone
  }
}

// A request as Chrome on Android sends it: client hints included, which Electron fills in for the
// desktop it runs on whatever the user agent says.
export function mobileRequestHeaders(headers: Record<string, string>, userAgent: string, hints: ReturnType<typeof mobileClientHints>): Record<string, string> {
  const kept = Object.fromEntries(Object.entries(headers).filter(([name]) => !/^(user-agent|sec-ch-ua(-.*)?)$/i.test(name)))
  return {
    ...kept,
    'User-Agent': userAgent,
    'Sec-CH-UA': hints.brands.map(({ brand, version }) => `"${brand}";v="${version}"`).join(', '),
    'Sec-CH-UA-Mobile': hints.mobile ? '?1' : '?0',
    'Sec-CH-UA-Platform': `"${hints.platform}"`
  }
}

export type SiteUserAgent = 'own' | 'chrome' | 'android'

// What the built-in browser says it is on a site. Google's sign-in refuses a browser embedded in an
// app and tells Electron from desktop Chrome however well it claims to be one, but lets Chrome on
// Android through, so there it is a phone. The rest of Google gets desktop Chrome, its pages laid out
// for a desktop. Everywhere else it says what it is.
export function siteUserAgent(url: string): SiteUserAgent {
  try {
    const { protocol, hostname } = new URL(url)
    if (protocol !== 'https:' && protocol !== 'http:') return 'own'
    if (hostname === 'accounts.google.com' || hostname === 'accounts.youtube.com') return 'android'
    return hostname === 'google.com' || hostname.endsWith('.google.com') ? 'chrome' : 'own'
  } catch { return 'own' }
}
