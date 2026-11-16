import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import type { FsTarget, FsWriteIntent, FsEditRequest, FsVersion } from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { operationPolicy, runtimeConfig } from './policy'

export default class AntumiFileSystem extends SandboxedFileSystem {
  private readonly antumi = runtimeConfig()

  private async policy(target: FsTarget, policy?: SandboxExecutionPolicy): Promise<SandboxExecutionPolicy> {
    const current = await this.resolve(this.processPath(target))
    return operationPolicy(policy ?? this.ctx.sandboxPolicy.resolve(), this.processPath(current), this.antumi)
  }

  override async writeText(target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal, policy?: SandboxExecutionPolicy) {
    return super.writeText(target, content, expected, signal, await this.policy(target, policy))
  }

  override async editText(target: FsTarget, edit: FsEditRequest, expected?: { version: FsVersion }, signal?: AbortSignal, policy?: SandboxExecutionPolicy) {
    return super.editText(target, edit, expected, signal, await this.policy(target, policy))
  }

  override async patchText(target: FsTarget, hunks: Parameters<SandboxedFileSystem['patchText']>[1], expected?: { version: FsVersion }, signal?: AbortSignal, policy?: SandboxExecutionPolicy) {
    return super.patchText(target, hunks, expected, signal, await this.policy(target, policy))
  }

  override async deleteFile(target: FsTarget, expected?: { version: FsVersion }, signal?: AbortSignal, policy?: SandboxExecutionPolicy) {
    return super.deleteFile(target, expected, signal, await this.policy(target, policy))
  }

  // Upstream fences both ends against one workspace root, so a move across projects is refused rather than widened.
  override async moveFile(source: FsTarget, destination: FsTarget, options: Parameters<SandboxedFileSystem['moveFile']>[2], signal?: AbortSignal, policy?: SandboxExecutionPolicy) {
    const from = await this.policy(source, policy)
    const to = await this.policy(destination, policy)
    if (from.workspaceRoot !== to.workspaceRoot) throw new Error('Antumi: move files within one project at a time')
    return super.moveFile(source, destination, options, signal, to)
  }
}
