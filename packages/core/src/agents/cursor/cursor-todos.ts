import { z } from 'zod'
import type { ChatTodo } from '@antumi/protocol'

const Status = z.union([z.string(), z.number()]).transform((value) => typeof value === 'string' ? value.replace(/^TODO_STATUS_/, '').toLowerCase() : value)
const Todo = z.looseObject({ id: z.string(), content: z.string(), status: Status.optional() })
const Todos = z.looseObject({ todos: z.array(Todo), merge: z.boolean().optional() })
const Tool = z.looseObject({ toolCallId: z.string(), title: z.string().optional(), rawInput: z.unknown().optional() })
const Input = z.looseObject({ _toolName: z.string().optional() })

// ACP's raw input omits merge; the completed call's extension carries it. Keep steps by id
// until that authoritative update arrives, so an incremental input never drops other steps.
export class CursorTodos {
  readonly method = 'cursor/update_todos'
  private readonly calls = new Set<string>()
  private readonly entries = new Map<string, z.infer<typeof Todo>>()

  tool(update: unknown): ChatTodo[] | null {
    const tool = Tool.safeParse(update).data
    if (!tool) return null
    const name = Input.safeParse(tool.rawInput).data?._toolName
    if (name === 'updateTodos' || name === 'readTodos' || tool.title === 'Read TODOs') this.calls.add(tool.toolCallId)
    if (!this.calls.has(tool.toolCallId)) return null
    return this.update(tool.rawInput) ?? this.list()
  }

  update(params: unknown): ChatTodo[] | null {
    const input = Todos.safeParse(params).data
    if (!input) return null
    if (input.merge === false || (input.merge === undefined && input.todos.length === 0)) this.entries.clear()
    for (const todo of input.todos) this.entries.set(todo.id, todo)
    return this.list()
  }

  private list(): ChatTodo[] {
    return [...this.entries.values()]
      .filter((todo) => todo.status !== 4 && todo.status !== 'cancelled')
      .map((todo) => ({
        content: todo.content,
        status: todo.status === 3 || todo.status === 'completed' ? 'completed' : todo.status === 2 || todo.status === 'in_progress' ? 'in_progress' : 'pending',
        activeForm: null
      }))
  }
}
