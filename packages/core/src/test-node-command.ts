import { copyFileSync, existsSync, linkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// Exercise real process launch with an isolated PATH on both Unix and Windows. A Windows
// launcher needs a recognised Node shim; an extensionless shebang file is not executable there.
export function writeTestNodeCommand(bin: string, command: string, script: string): string {
  if (process.platform !== 'win32') {
    const file = path.join(bin, command)
    writeFileSync(file, ['#!' + process.execPath, script].join('\n'), { mode: 0o755 })
    return file
  }
  const node = path.join(bin, 'node.exe')
  if (!existsSync(node)) {
    try { linkSync(process.execPath, node) }
    catch { copyFileSync(process.execPath, node) }
  }
  const scriptName = command + '.cjs'
  const file = path.join(bin, command + '.cmd')
  const windowsScript = '"%~dp0\\' + scriptName + '"'
  writeFileSync(path.join(bin, scriptName), script)
  writeFileSync(file, [
    '@IF EXIST "%~dp0\\node.exe" (',
    '  "%~dp0\\node.exe" ' + windowsScript + ' %*',
    ') ELSE (',
    '  @SET PATHEXT=%PATHEXT:;.JS;=;%',
    '  node ' + windowsScript + ' %*',
    ')'
  ].join('\r\n'))
  return file
}
