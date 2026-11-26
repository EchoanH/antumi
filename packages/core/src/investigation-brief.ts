import { DEFAULT_INVESTIGATION_PROMPT, SOURCE_REPORT_TOOL, SOURCE_TASK_CREATE_TOOL, SOURCE_TASK_READ_TOOLS, untrustedSource, type SnapshotImagePath, type SourceSnapshot, type TaskSource } from '@antumi/protocol'

// What a conversation opened from an inbox issue reads first: the issue, fenced off as the
// tracker's words, and what to do with it. Opened by hand it starts read-only, so it stops at a
// finding and a proposed fix; the user decides whether to fix it there.
// pending: images still being downloaded, sent as a later message.
// automatic: the user's prompt, sent after this, says what to do, so the brief only hands over the issue.
export function investigationBrief(source: TaskSource, snapshot: SourceSnapshot, images: readonly SnapshotImagePath[], pending = 0, automatic = false): string {
  return [
    '# 待排查的问题',
    untrustedSource(source, snapshot, images),
    ...(pending > 0 ? [`附件里还有 ${pending} 张图片在下载，下载好后会作为下一条消息发给你。先根据文字排查；只有看图才能确定的地方，说明需要看图，不要猜。`] : []),
    ...(automatic ? [] : ['## 请这样排查', [
      '1. 先弄清问题：它说的现象是什么，能否从代码或现有记录里确认，缺什么信息就问我。',
      '2. 定位根因：复现路径、相关代码（给出文件和行号）、为什么会这样，以及影响范围。',
      '3. 给出结论和修复方案：改哪里、怎么改、有什么风险，以及怎么验证。',
      '4. 到这里停下，不要修改代码，等我确认后再修。'
    ].join('\n')])
  ].join('\n\n')
}

// An automatic investigation's first message: the user's prompt, then how it works with Antumi,
// which the user does not edit so that it always matches what core does.
export function automaticInstructions(prompt: string, tasks: boolean): string {
  const rules = tasks
    ? `需要改代码时，先用 ${SOURCE_TASK_READ_TOOLS[0]} 查已登记的项目、可用的执行 Agent 和服务商，用 ${SOURCE_TASK_READ_TOOLS[1]} 查模型和推理强度，再调用 ${SOURCE_TASK_CREATE_TOOL} 新建任务，由任务在独立工作区完成；不要在这个会话里改项目代码，也不要自己建 git worktree。一个事项只能新建一个任务，被退回时按错误修正后再试。PR 类事项不能新建任务，按上面的要求在这个会话里处理。`
    : '这个来源不允许新建任务：需要改代码时，给出方案，由用户决定。'
  return [
    prompt.trim() || DEFAULT_INVESTIGATION_PROMPT['zh-CN'],
    '## 和 Antumi 的配合',
    `${rules}事项的状态和评论由 Antumi 按回写规则处理，不要自己去改。结束前用 ${SOURCE_REPORT_TOOL} 写一条结论。`
  ].join('\n\n')
}
