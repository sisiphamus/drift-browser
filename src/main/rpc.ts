// One command registry, called by the UI over IPC and by the CLI over the socket.

export type Handler = (params: Record<string, unknown>) => unknown | Promise<unknown>
export type CommandInfo = { name: string; help: string; args: string }

export class Rpc {
  private handlers = new Map<string, { fn: Handler; info: CommandInfo }>()

  register(name: string, help: string, args: string, fn: Handler) {
    this.handlers.set(name, { fn, info: { name, help, args } })
  }

  has(name: string) {
    return this.handlers.has(name)
  }

  async call(name: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const h = this.handlers.get(name)
    if (!h) throw new Error(`unknown command: ${name}`)
    return await h.fn(params)
  }

  list(): CommandInfo[] {
    return [...this.handlers.values()].map((h) => h.info).sort((a, b) => a.name.localeCompare(b.name))
  }
}
