import type { ProjectChoice } from '@antumi/protocol'
import { useCore } from '../core-store'
import { t } from '../i18n'
import { projectName } from '../project-names'
import { ProjectIcon } from './ProjectIcon'

export function projectChoiceTitle(choice: ProjectChoice): string {
  return [choice.path, choice.worktree && t('ProjectChoices.worktree'), choice.branch,
    choice.source && t('ProjectChoices.source', { path: choice.source })].filter(Boolean).join('\n')
}

export function ProjectChoiceLabel({ choice, location, badge = false }: {
  choice: ProjectChoice
  location: string
  badge?: boolean
}) {
  const owner = useCore((s) => choice.worktree
    ? Object.values(s.conversations).find((conversation) => conversation.projectPaths.includes(choice.path))?.title
    : undefined)
  return (
    <>
      <ProjectIcon path={choice.source ?? choice.path} />
      <span className="menu-item-name project-choice-name">{projectName(choice.source ?? choice.path)}</span>
      {badge && choice.worktree && <span className="project-copy-badge">{t('ProjectChoices.copy')}</span>}
      <span className="menu-item-path project-location" title={[projectChoiceTitle(choice), owner].filter(Boolean).join('\n')}>
        {choice.worktree ? choice.branch ?? t('ProjectChoices.detached') : location}
      </span>
    </>
  )
}
