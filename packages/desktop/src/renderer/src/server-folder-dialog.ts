import { create } from 'zustand'

// Choosing a folder or file on the machine core runs on when that is not this one (a server over
// SSH, docs/REMOTE.md): the system's dialog only sees this computer, so the app lists the server's
// folders through core instead.

export type ServerFolderRequest = {
  title?: string
  // Where to begin, as core names it; the server's home when missing or gone.
  start?: string
  // Files of these extensions are chosen instead of a folder: ['zip'].
  files?: readonly string[]
}

type Asking = ServerFolderRequest & { answer(path: string | null): void }

export const useServerFolderDialog = create<{ asking: Asking | null }>()(() => ({ asking: null }))

// A second question while one is open declines the first.
export function askServerFolder(request: ServerFolderRequest): Promise<string | null> {
  useServerFolderDialog.getState().asking?.answer(null)
  return new Promise((resolve) => {
    const asking: Asking = {
      ...request,
      answer: (path) => {
        if (useServerFolderDialog.getState().asking === asking) useServerFolderDialog.setState({ asking: null })
        resolve(path)
      }
    }
    useServerFolderDialog.setState({ asking })
  })
}

// The folder above, in core's (POSIX) spelling; null at the root.
export function parentFolder(path: string): string | null {
  if (path === '/' || !path.startsWith('/')) return null
  const trimmed = path.replace(/\/+$/, '')
  const at = trimmed.lastIndexOf('/')
  return at <= 0 ? '/' : trimmed.slice(0, at)
}

// The folders from the root down to `path`, for the path bar: [['/', '/'], ['home', '/home'], …].
export function pathSteps(path: string): [name: string, path: string][] {
  const steps: [string, string][] = [['/', '/']]
  let at = ''
  for (const part of path.split('/').filter(Boolean)) {
    at = `${at}/${part}`
    steps.push([part, at])
  }
  return steps
}

export function choosable(name: string, files: readonly string[] | undefined): boolean {
  const lower = name.toLowerCase()
  return files?.some((extension) => lower.endsWith(`.${extension.toLowerCase()}`)) ?? false
}
