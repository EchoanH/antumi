import { describe, expect, it } from 'vitest'
import { chromeUserAgent, mobileClientHints, mobileRequestHeaders, mobileUserAgent, siteUserAgent } from './user-agent'

describe('chromeUserAgent', () => {
  it('drops the app and Electron, keeping the platform and Chrome major', () => {
    const electron = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Antumi/0.21.1 Chrome/146.0.7680.65 Electron/44.4.3 Safari/537.36'
    expect(chromeUserAgent(electron, '146.0.7680.65')).toBe('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36')
  })

  it('keeps the Windows platform as it is', () => {
    const electron = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Antumi/0.21.1 Chrome/146.0.7680.65 Electron/44.4.3 Safari/537.36'
    expect(chromeUserAgent(electron, '146.0.7680.65')).toBe('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36')
  })

  it('at least drops Electron from a string of another shape', () => {
    expect(chromeUserAgent('Something Electron/44.4.3 Safari/537.36', '146.0.1.2')).toBe('Something Safari/537.36')
  })
})

describe('mobileUserAgent', () => {
  it('says Android Chrome, with Mobile only for a phone', () => {
    expect(mobileUserAgent('146.0.7680.65', true)).toBe('Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Mobile Safari/537.36')
    expect(mobileUserAgent('146.0.7680.65', false)).toBe('Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36')
  })
})

describe('siteUserAgent', () => {
  it('is Android on Google sign-in, where an embedded browser is refused', () => {
    for (const url of ['https://accounts.google.com/v3/signin', 'https://accounts.youtube.com/accounts/SetSID']) expect(siteUserAgent(url)).toBe('android')
  })

  it('is Chrome on the rest of Google and its own everywhere else', () => {
    for (const url of ['https://www.google.com/', 'https://google.com/', 'https://docs.google.com/document/d/1']) expect(siteUserAgent(url)).toBe('chrome')
    for (const url of ['https://www.v2ex.com/signin', 'https://linux.do/login', 'https://accounts.google.com.evil.test/', 'https://notgoogle.com/', 'about:blank', 'file:///google.com', 'nonsense']) expect(siteUserAgent(url)).toBe('own')
  })
})

describe('mobileRequestHeaders', () => {
  it('replaces the user agent and every client hint, keeping the rest', () => {
    const headers = { 'User-Agent': 'Electron', 'sec-ch-ua': '"Chromium";v="152"', 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"macOS"', 'sec-ch-ua-full-version-list': '"Chromium";v="152.0.1"', Accept: 'text/html' }
    expect(mobileRequestHeaders(headers, 'Android Chrome', mobileClientHints('152.0.7977.130', true))).toEqual({
      Accept: 'text/html',
      'User-Agent': 'Android Chrome',
      'Sec-CH-UA': '"Chromium";v="152", "Google Chrome";v="152", "Not.A/Brand";v="99"',
      'Sec-CH-UA-Mobile': '?1',
      'Sec-CH-UA-Platform': '"Android"'
    })
  })
})
