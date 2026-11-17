import { t } from '../i18n'
import { openOverview, useOverview, useCore } from '../core-store'
import { CountBadge } from './CountBadge'
import { DashboardIcon } from './icons'

export function OverviewEntry() {
  const open = useCore((s) => s.overviewOpen)
  const count = useOverview().counts.mine
  return (
    <button type="button" className="inbox-entry overview-entry" aria-current={open}
      title={t('OverviewEntry.overview', { value1: count ? t('OverviewEntry.itemsNeedYourResponse', { count: count }) : '' })}
      aria-label={t('OverviewEntry.overview', { value1: count ? t('OverviewEntry.itemsNeedYourResponse', { count: count }) : '' })} onClick={openOverview}>
      <DashboardIcon />
      <span className="sidebar-navigation-label">{t('OverviewEntry.overview_1276')}</span>
      <CountBadge count={count} />
    </button>
  )
}
