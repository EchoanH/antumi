import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  AGENT_KINDS,
  DEFAULT_AGENT_PROXY_SETTINGS,
  agentProxyPolicy,
  hasEffectiveManualProxy,
  validateAgentProxySettings,
  type AgentKind,
  type AgentProxyPolicy,
  type AgentProxySettings as AgentProxySettingsModel,
  type AgentProxyStatus,
  type AgentProxyTestErrorCode,
  type AgentProxyTestResult,
  type GlobalProxyMode,
  type ManualProxyConfig
} from '@antumi/protocol'
import { fetchAgentProxyStatus, setChatSettings, testAgentProxy, useCore } from '../core-store'
import { filesHere } from '../desktop-bridge'
import { t } from '../i18n'
import { agentLabel } from '../labels'
import { AgentIcon, ProxyIcon, RefreshIcon } from './icons'
import { Segmented, SettingsGroup, SettingsRow, Toggle } from './SettingsControls'
import { SettingsEmptyState } from './SettingsEmptyState'

function sameManual(a: ManualProxyConfig, b: ManualProxyConfig): boolean {
  return a.url === b.url
    && a.advanced === b.advanced
    && a.httpProxy === b.httpProxy
    && a.httpsProxy === b.httpsProxy
    && a.allProxy === b.allProxy
    && a.noProxy === b.noProxy
}

export function proxySummaryLines(snapshot: { httpProxy: string | null; httpsProxy: string | null; allProxy: string | null; noProxy?: readonly string[] }): string[] {
  const lines: string[] = []
  if (snapshot.httpProxy && snapshot.httpProxy === snapshot.httpsProxy) {
    lines.push(`HTTP / HTTPS: ${snapshot.httpProxy}`)
  } else {
    if (snapshot.httpProxy) lines.push(`HTTP: ${snapshot.httpProxy}`)
    if (snapshot.httpsProxy) lines.push(`HTTPS: ${snapshot.httpsProxy}`)
  }
  if (snapshot.allProxy && snapshot.allProxy !== snapshot.httpProxy && snapshot.allProxy !== snapshot.httpsProxy) {
    lines.push(`ALL / SOCKS: ${snapshot.allProxy}`)
  }
  if (snapshot.noProxy?.length) {
    lines.push(`NO_PROXY: ${snapshot.noProxy.join(', ')}`)
  }
  return lines
}

export function proxySourceLabel(source: AgentProxyStatus['os']['source']): string | null {
  switch (source) {
    case 'windows-registry': return t('AgentProxy.systemSourceWindows')
    case 'macos-scutil': return t('AgentProxy.systemSourceMac')
    case 'linux-gsettings': return t('AgentProxy.systemSourceLinux')
    case 'none': return null
  }
}

export function proxyValidationText(field: 'url' | 'httpProxy' | 'httpsProxy' | 'allProxy' | 'noProxy', error: 'invalid-proxy-url' | 'unsupported-protocol'): string {
  if (field === 'noProxy') return t('AgentProxy.errorInvalidNoProxy')
  return error === 'unsupported-protocol' ? t('AgentProxy.errorUnsupportedProtocol') : t('AgentProxy.errorInvalidUrl')
}

export function proxyTestErrorText(code: AgentProxyTestErrorCode | null): string {
  switch (code) {
    case 'no-proxy-configured': return t('AgentProxy.testErrNoProxy')
    case 'invalid-proxy-url': return t('AgentProxy.testErrInvalidUrl')
    case 'unsupported-protocol': return t('AgentProxy.testErrUnsupported')
    case 'auth-required': return t('AgentProxy.testErrAuth')
    case 'connection-refused': return t('AgentProxy.testErrRefused')
    case 'timeout': return t('AgentProxy.testErrTimeout')
    case 'tls-error': return t('AgentProxy.testErrTls')
    case 'dns-error': return t('AgentProxy.testErrDns')
    default: return t('AgentProxy.testErrNetwork')
  }
}

export function isGlobalProxyEffective(mode: GlobalProxyMode, manual: ManualProxyConfig, status: AgentProxyStatus | null): boolean {
  if (mode === 'none') return false
  if (mode === 'manual') return hasEffectiveManualProxy(manual)
  return status?.os.available ?? false
}

export function partitionProxyAgents(environment: { checks: readonly { tool: string; status: string }[] } | null): { installed: AgentKind[]; missing: AgentKind[] } {
  if (!environment) return { installed: [...AGENT_KINDS], missing: [] }
  const installed: AgentKind[] = []
  const missing: AgentKind[] = []
  for (const kind of AGENT_KINDS) {
    const check = environment.checks.find((each) => each.tool === kind)
    if (check && check.status !== 'missing') installed.push(kind)
    else missing.push(kind)
  }
  return { installed, missing }
}

function CliPolicyRow({
  agent,
  policy,
  globalReady,
  envPresent,
  installed,
  saving,
  onChange
}: {
  agent: AgentKind
  policy: AgentProxyPolicy
  globalReady: boolean
  envPresent: boolean
  installed: boolean
  saving: boolean
  onChange: (next: AgentProxyPolicy) => void
}) {
  const labelId = useId()
  const missingGlobal = policy === 'useProxy' && !globalReady
  const description = missingGlobal
    ? t('AgentProxy.warningGlobalUnavailableHint')
    : policy === 'noProxy'
      ? t('AgentProxy.hintNoProxy')
      : policy === 'useProxy'
        ? t('AgentProxy.hintUseProxy')
        : envPresent
          ? t('AgentProxy.hintFollowEnv')
          : t('AgentProxy.hintFollowGlobal')

  return (
    <div className="settings-row proxy-cli-row" data-off={!installed || undefined}>
      <span className="agent-row-icon" aria-hidden="true"><AgentIcon agent={agent} /></span>
      <div className="settings-row-text">
        <div className="agent-row-head">
          <span id={labelId} className="settings-row-label">{agentLabel(agent)}</span>
          {!installed && <span className="agent-row-pill">{t('AgentProxy.notInstalledBadge')}</span>}
          {missingGlobal && <span className="settings-state-pill" data-state="warning">{t('AgentProxy.warningGlobalUnavailable')}</span>}
        </div>
        <p className="settings-row-description" data-warning={missingGlobal || undefined}>{description}</p>
      </div>
      <div className="settings-row-control">
        <Segmented<AgentProxyPolicy>
          labelId={labelId}
          value={policy}
          options={[
            { value: 'followGlobal', label: t('AgentProxy.policyFollowGlobal') },
            { value: 'useProxy', label: t('AgentProxy.policyUseProxy') },
            { value: 'noProxy', label: t('AgentProxy.policyNoProxy') }
          ]}
          onChange={(next) => { if (!saving && next !== policy) onChange(next) }}
        />
      </div>
    </div>
  )
}

export function AgentProxySettings() {
  const connected = useCore((s) => s.connection === 'connected')
  const chatSettings = useCore((s) => s.chatSettings)
  const environment = useCore((s) => s.environment)
  const saved: AgentProxySettingsModel = chatSettings?.agentProxy ?? DEFAULT_AGENT_PROXY_SETTINGS

  const [mode, setMode] = useState<GlobalProxyMode>(saved.mode)
  const [manual, setManual] = useState<ManualProxyConfig>(saved.manual)
  const [status, setStatus] = useState<AgentProxyStatus | null>(null)
  const [checkingStatus, setCheckingStatus] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedNotice, setSavedNotice] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<AgentProxyTestResult | null>(null)
  const testRun = useRef(0)

  const invalidateTest = () => {
    testRun.current += 1
    setTesting(false)
    setTestResult(null)
  }

  const updateManual = (patch: Partial<ManualProxyConfig>) => {
    setManual((current) => ({ ...current, ...patch }))
    setSavedNotice(false)
    invalidateTest()
  }

  const dirty = mode !== saved.mode || !sameManual(manual, saved.manual)

  useEffect(() => {
    setMode(saved.mode)
    setManual(saved.manual)
  }, [saved.mode, saved.manual.url, saved.manual.advanced, saved.manual.httpProxy, saved.manual.httpsProxy, saved.manual.allProxy, saved.manual.noProxy])

  const loadStatus = async (refresh = false) => {
    if (!connected) return
    setCheckingStatus(true)
    try {
      const next = await fetchAgentProxyStatus(refresh)
      if (next) setStatus(next)
    } finally {
      setCheckingStatus(false)
    }
  }

  useEffect(() => {
    if (!connected) return
    let active = true
    setCheckingStatus(true)
    void fetchAgentProxyStatus(false).then((next) => {
      if (active && next) setStatus(next)
    }).finally(() => {
      if (active) setCheckingStatus(false)
    })
    return () => { active = false }
  }, [connected])

  const validation = useMemo(() => validateAgentProxySettings({ mode, manual }), [mode, manual])
  // Per-CLI warnings reflect persisted global settings so unsaved manual drafts cannot mask missing proxies.
  const savedGlobalReady = isGlobalProxyEffective(saved.mode, saved.manual, status)
  const { installed, missing } = useMemo(() => partitionProxyAgents(environment), [environment])
  const hasCustomMissingPolicy = missing.some((kind) => agentProxyPolicy(saved, kind) !== 'followGlobal')

  const persistGlobal = async (nextMode: GlobalProxyMode, nextManual: ManualProxyConfig, revertOnError = false) => {
    const check = validateAgentProxySettings({ mode: nextMode, manual: nextManual })
    if (!check.ok) return false
    setSaving(true)
    setSavedNotice(false)
    try {
      const ok = await setChatSettings({ agentProxy: { ...saved, mode: nextMode, manual: nextManual } })
      if (!ok) {
        if (revertOnError) {
          const latest = useCore.getState().chatSettings?.agentProxy ?? DEFAULT_AGENT_PROXY_SETTINGS
          setMode(latest.mode)
          setManual(latest.manual)
        }
        return false
      }
      setSavedNotice(true)
      void loadStatus(nextMode === 'system')
      return true
    } finally {
      setSaving(false)
    }
  }

  const chooseMode = (nextMode: GlobalProxyMode) => {
    setMode(nextMode)
    invalidateTest()
    setSavedNotice(false)
    if (nextMode === 'none' || nextMode === 'system') {
      void persistGlobal(nextMode, saved.manual, true)
    } else if (hasEffectiveManualProxy(manual) && validateAgentProxySettings({ mode: 'manual', manual }).ok) {
      void persistGlobal('manual', manual, false)
    }
  }

  const toggleAdvanced = (advanced: boolean) => {
    setSavedNotice(false)
    invalidateTest()
    if (advanced) {
      const hasAny = Boolean(manual.httpProxy.trim() || manual.httpsProxy.trim() || manual.allProxy.trim())
      const seed = manual.url.trim()
      if (!hasAny && seed) {
        const isSocks = /^socks(?:5h?)?:\/\//i.test(seed)
        setManual({
          ...manual,
          advanced: true,
          httpProxy: isSocks ? '' : seed,
          httpsProxy: isSocks ? '' : seed,
          allProxy: isSocks ? seed : ''
        })
        return
      }
      setManual({ ...manual, advanced: true })
      return
    }
    const derived = manual.url.trim() || manual.httpsProxy.trim() || manual.httpProxy.trim() || manual.allProxy.trim()
    setManual({ ...manual, advanced: false, url: derived })
  }

  const saveManual = async (event: FormEvent) => {
    event.preventDefault()
    if (!validation.ok || saving) return
    await persistGlobal(mode, manual)
  }

  const resetManual = () => {
    setMode(saved.mode)
    setManual(saved.manual)
    setSavedNotice(false)
    invalidateTest()
  }

  const runTest = async () => {
    if (testing || mode === 'none') return
    const runId = ++testRun.current
    setTesting(true)
    try {
      const result = await testAgentProxy({ settings: { mode, manual } })
      if (testRun.current === runId && result) setTestResult(result)
    } finally {
      if (testRun.current === runId) setTesting(false)
    }
  }

  const setCliPolicy = async (agent: AgentKind, policy: AgentProxyPolicy) => {
    setSaving(true)
    try {
      const nextAgents = { ...saved.agents }
      if (policy === 'followGlobal') delete nextAgents[agent]
      else nextAgents[agent] = policy
      await setChatSettings({ agentProxy: { ...saved, agents: nextAgents } })
    } finally {
      setSaving(false)
    }
  }

  if (!connected || !chatSettings) {
    return (
      <SettingsEmptyState icon={<ProxyIcon />} title={connected ? t('AgentProxy.loading') : t('AgentProxy.disconnected')}>
        {connected ? t('AgentProxy.loadingHint') : t('ChatCommandSettings.connectToAntumiCoreToView')}
      </SettingsEmptyState>
    )
  }

  const osLines = status?.os.available ? proxySummaryLines(status.os) : []
  const envSummary = status?.env.present ? proxySummaryLines({ httpProxy: status.env.httpProxy, httpsProxy: status.env.httpsProxy, allProxy: status.env.allProxy }).join(' · ') : ''
  const fieldError = (field: 'url' | 'httpProxy' | 'httpsProxy' | 'allProxy' | 'noProxy') => (!validation.ok && validation.field === field ? proxyValidationText(field, validation.error) : null)
  const visibleFields = manual.advanced ? new Set(['httpProxy', 'httpsProxy', 'allProxy', 'noProxy']) : new Set(['url'])
  const hiddenFieldError = !validation.ok && !visibleFields.has(validation.field) ? proxyValidationText(validation.field, validation.error) : null

  return (
    <div className="proxy-settings">
      {!filesHere() && <p className="settings-note">{t('AgentProxy.onServer')}</p>}

      <SettingsGroup title={t('AgentProxy.globalTitle')} icon={<ProxyIcon />}>
        <SettingsRow
          label={t('AgentProxy.mode')}
          description={t('AgentProxy.modeDescription')}
          control={(labelId) => (
            <Segmented<GlobalProxyMode>
              labelId={labelId}
              value={mode}
              options={[
                { value: 'none', label: t('AgentProxy.modeNone') },
                { value: 'system', label: t('AgentProxy.modeSystem') },
                { value: 'manual', label: t('AgentProxy.modeManual') }
              ]}
              onChange={chooseMode}
            />
          )}
        />

        {mode === 'system' && (
          <div className="proxy-status-block">
            <div className="proxy-status-head">
              <div className="settings-entry-title">
                <span className="settings-row-label">{t('AgentProxy.systemDetected')}</span>
                <span className="settings-state-pill" data-state={status?.os.available ? 'ok' : 'warning'}>
                  {checkingStatus && !status ? t('AgentProxy.systemRefreshing') : status?.os.available ? t('AgentProxy.systemAvailable') : t('AgentProxy.systemNotFound')}
                </span>
              </div>
              <button type="button" className="button ghost proxy-refresh-button" disabled={checkingStatus} onClick={() => void loadStatus(true)}>
                <RefreshIcon />
                {checkingStatus ? t('AgentProxy.systemRefreshing') : t('AgentProxy.systemRefresh')}
              </button>
            </div>
            {status?.os.available ? (
              <div className="proxy-status-values">
                {proxySourceLabel(status.os.source) && <p className="settings-row-description">{proxySourceLabel(status.os.source)}</p>}
                <ul className="proxy-summary-list mono">
                  {osLines.map((line) => <li key={line}>{line}</li>)}
                </ul>
              </div>
            ) : (
              <p className="settings-row-description">{t('AgentProxy.systemNotFoundHint')}</p>
            )}
          </div>
        )}

        {mode === 'manual' && (
          <form className="proxy-manual-form" onSubmit={(event) => void saveManual(event)}>
            {!manual.advanced && (
              <div className="proxy-field">
                <label className="settings-row-label" htmlFor="proxy-simple-url">{t('AgentProxy.address')}</label>
                <p className="settings-row-description">{t('AgentProxy.addressDescription')}</p>
                <input
                  id="proxy-simple-url"
                  className="input mono"
                  type="text"
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="http://127.0.0.1:7897"
                  value={manual.url}
                  onChange={(event) => updateManual({ url: event.target.value })}
                />
                {fieldError('url') && <p className="proxy-field-error" role="alert">{fieldError('url')}</p>}
              </div>
            )}

            <SettingsRow
              label={t('AgentProxy.advanced')}
              description={t('AgentProxy.advancedDescription')}
              control={(labelId) => <Toggle labelId={labelId} checked={manual.advanced} onChange={toggleAdvanced} />}
            />

            {manual.advanced && (
              <div className="proxy-advanced-grid">
                <div className="proxy-field">
                  <label className="settings-row-label mono" htmlFor="proxy-http">HTTP_PROXY</label>
                  <input
                    id="proxy-http"
                    className="input mono"
                    type="text"
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="http://127.0.0.1:7897"
                    value={manual.httpProxy}
                    onChange={(event) => updateManual({ httpProxy: event.target.value })}
                  />
                  {fieldError('httpProxy') && <p className="proxy-field-error" role="alert">{fieldError('httpProxy')}</p>}
                </div>

                <div className="proxy-field">
                  <label className="settings-row-label mono" htmlFor="proxy-https">HTTPS_PROXY</label>
                  <input
                    id="proxy-https"
                    className="input mono"
                    type="text"
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="http://127.0.0.1:7897"
                    value={manual.httpsProxy}
                    onChange={(event) => updateManual({ httpsProxy: event.target.value })}
                  />
                  {fieldError('httpsProxy') && <p className="proxy-field-error" role="alert">{fieldError('httpsProxy')}</p>}
                </div>

                <div className="proxy-field">
                  <label className="settings-row-label mono" htmlFor="proxy-all">ALL_PROXY</label>
                  <input
                    id="proxy-all"
                    className="input mono"
                    type="text"
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="socks5://127.0.0.1:7897"
                    value={manual.allProxy}
                    onChange={(event) => updateManual({ allProxy: event.target.value })}
                  />
                  {fieldError('allProxy') && <p className="proxy-field-error" role="alert">{fieldError('allProxy')}</p>}
                </div>

                <div className="proxy-field">
                  <label className="settings-row-label mono" htmlFor="proxy-no">NO_PROXY</label>
                  <input
                    id="proxy-no"
                    className="input mono"
                    type="text"
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="localhost,127.0.0.1,::1,.local"
                    value={manual.noProxy}
                    onChange={(event) => updateManual({ noProxy: event.target.value })}
                  />
                  <p className="settings-row-description">{t('AgentProxy.noProxyHint')}</p>
                  {fieldError('noProxy') && <p className="proxy-field-error" role="alert">{fieldError('noProxy')}</p>}
                </div>
              </div>
            )}

            {hiddenFieldError && <p className="proxy-field-error" role="alert">{hiddenFieldError}</p>}

            <div className="proxy-form-footer">
              <span className="settings-row-description" role="status">
                {dirty ? t('AgentProxy.unsavedChanges') : savedNotice ? t('AgentProxy.saved') : ''}
              </span>
              <div className="settings-inline-actions">
                {dirty && <button type="button" className="button ghost" disabled={saving} onClick={resetManual}>{t('AgentProxy.reset')}</button>}
                <button type="submit" className="button primary" disabled={saving || !dirty || !validation.ok}>
                  {saving ? t('AgentProxy.saving') : t('AgentProxy.save')}
                </button>
              </div>
            </div>
          </form>
        )}

        {status?.env.present && (
          <p className="proxy-env-note settings-row-description">
            {t('AgentProxy.envDetectedNote', { summary: envSummary })}
          </p>
        )}

        <div className="proxy-test-block">
          <SettingsRow
            label={t('AgentProxy.testTitle')}
            description={mode === 'none' ? t('AgentProxy.testDisabledNone') : t('AgentProxy.testDescription')}
            control={() => (
              <button type="button" className="button" disabled={testing || mode === 'none' || (mode === 'manual' && !validation.ok)} onClick={() => void runTest()}>
                {testing ? t('AgentProxy.testing') : t('AgentProxy.testButton')}
              </button>
            )}
          />
          {testResult && (
            <div className="proxy-test-result" role="status" aria-live="polite" data-ok={testResult.ok || undefined}>
              <span className="settings-state-pill" data-state={testResult.ok ? 'ok' : 'error'}>
                {testResult.ok ? t('AgentProxy.testOk') : t('AgentProxy.testFailed')}
              </span>
              <div className="proxy-test-result-copy">
                {testResult.ok ? (
                  <p className="settings-row-description mono">
                    {t('AgentProxy.testOkDetail', { proxy: testResult.proxyUsed ?? '-', status: testResult.statusCode ?? '-', latency: testResult.latencyMs })}
                  </p>
                ) : (
                  <>
                    <p className="settings-row-description">{proxyTestErrorText(testResult.errorCode)}</p>
                    {testResult.proxyUsed && (
                      <p className="settings-row-description mono">
                        {t('AgentProxy.testFailedVia', { proxy: testResult.proxyUsed, latency: testResult.latencyMs })}
                      </p>
                    )}
                    {testResult.message && testResult.errorCode === 'network-error' && (
                      <p className="settings-row-description mono">{testResult.message}</p>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </SettingsGroup>

      <SettingsGroup title={t('AgentProxy.cliTitle')}>
        <p className="settings-note">{t('AgentProxy.cliDescription')}</p>
        {installed.map((agent) => (
          <CliPolicyRow
            key={agent}
            agent={agent}
            policy={agentProxyPolicy(saved, agent)}
            globalReady={savedGlobalReady}
            envPresent={status?.env.present ?? false}
            installed
            saving={saving}
            onChange={(next) => void setCliPolicy(agent, next)}
          />
        ))}
        {missing.length > 0 && (
          <details className="settings-disclosure proxy-missing-clis" open={hasCustomMissingPolicy || undefined}>
            <summary>{t('AgentProxy.notInstalledGroup', { count: missing.length })}</summary>
            {missing.map((agent) => (
              <CliPolicyRow
                key={agent}
                agent={agent}
                policy={agentProxyPolicy(saved, agent)}
                globalReady={savedGlobalReady}
                envPresent={status?.env.present ?? false}
                installed={false}
                saving={saving}
                onChange={(next) => void setCliPolicy(agent, next)}
              />
            ))}
          </details>
        )}
      </SettingsGroup>

      <details className="settings-disclosure">
        <summary>{t('AgentProxy.helpSummary')}</summary>
        <p>{t('AgentProxy.helpPriority')}</p>
        <p>{t('AgentProxy.helpScope')}</p>
        <p>{t('AgentProxy.helpTun')}</p>
      </details>
    </div>
  )
}
