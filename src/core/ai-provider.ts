/**
 * AIProvider — unified abstraction over AI backends.
 *
 * Each provider (Vercel AI SDK, Claude Code CLI, …) implements this interface
 * with its own session management flow.  ProviderRouter reads the runtime
 * config and delegates to the correct implementation.
 */

import type { SessionStore } from './session.js'
import type { MediaAttachment } from './types.js'
import { readAIProviderConfig } from './config.js'

// ==================== Provider Events ====================

/** Streaming event emitted by AI providers during generation. */
export type ProviderEvent =
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string }
  | { type: 'text'; text: string }
  | { type: 'done'; result: ProviderResult }

// ==================== StreamableResult ====================

/**
 * A result that is both PromiseLike (for backward-compatible `await`)
 * and AsyncIterable (for real-time event streaming).
 *
 * Internally drains the source AsyncIterable in the background, buffering
 * events. Multiple consumers can iterate independently (each gets its own cursor).
 */
export class StreamableResult implements PromiseLike<ProviderResult>, AsyncIterable<ProviderEvent> {
  private _events: ProviderEvent[] = []
  private _done = false
  private _result: ProviderResult | null = null
  private _error: Error | null = null
  private _waiters: Array<() => void> = []
  private _promise: Promise<ProviderResult>

  constructor(source: AsyncIterable<ProviderEvent>) {
    this._promise = this._drain(source)
  }

  private async _drain(source: AsyncIterable<ProviderEvent>): Promise<ProviderResult> {
    try {
      for await (const event of source) {
        this._events.push(event)
        if (event.type === 'done') this._result = event.result
        this._notify()
      }
    } catch (err) {
      this._error = err instanceof Error ? err : new Error(String(err))
      this._notify()
      throw this._error
    } finally {
      this._done = true
      this._notify()
    }
    if (!this._result) throw new Error('StreamableResult: stream ended without done event')
    return this._result
  }

  private _notify(): void {
    for (const w of this._waiters.splice(0)) w()
  }

  then<T1 = ProviderResult, T2 = never>(
    onfulfilled?: ((value: ProviderResult) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): Promise<T1 | T2> {
    return this._promise.then(onfulfilled, onrejected)
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<ProviderEvent> {
    let cursor = 0
    while (true) {
      while (cursor < this._events.length) {
        yield this._events[cursor++]
      }
      if (this._done) return
      if (this._error) throw this._error
      await new Promise<void>((resolve) => this._waiters.push(resolve))
    }
  }
}

// ==================== Types ====================

export interface AskOptions {
  /**
   * Preamble text describing the conversation context.
   * Claude Code: injected inside the `<chat_history>` text block.
   * Vercel AI SDK: not used (native ModelMessage[] carries the history directly).
   */
  historyPreamble?: string
  /**
   * System prompt override for this call.
   * Claude Code: passed as `--system-prompt` to the CLI.
   * Vercel AI SDK: replaces the agent's `instructions` for this call (triggers agent re-creation if changed).
   */
  systemPrompt?: string
  /**
   * Max text history entries to include in context.
   * Claude Code: limits entries in the `<chat_history>` block. Default: 50.
   * Vercel AI SDK: not used (compaction via `compactIfNeeded` controls context size).
   */
  maxHistoryEntries?: number
  /**
   * Tool names to disable for this call, in addition to the global disabled list.
   * Claude Code: merged into `disallowedTools` CLI option.
   * Vercel AI SDK: filtered out from the tool map before the agent is created.
   */
  disabledTools?: string[]
  /**
   * AI provider to use for this call, overriding the global ai-provider.json config.
   * Falls back to global config if not specified.
   */
  provider?: 'claude-code' | 'vercel-ai-sdk' | 'agent-sdk'
  /**
   * Vercel AI SDK model override — per-request provider/model/baseUrl/apiKey.
   * Only used when the active backend is 'vercel-ai-sdk'.
   */
  vercelAiSdk?: {
    provider: string
    model: string
    baseUrl?: string
    apiKey?: string
  }
  /**
   * Agent SDK model override — per-request model/apiKey/baseUrl.
   * Only used when the active backend is 'agent-sdk'.
   */
  agentSdk?: {
    model?: string
    apiKey?: string
    baseUrl?: string
  }
}

export interface ProviderResult {
  text: string
  media: MediaAttachment[]
}

/** Unified AI provider — each backend implements its own session handling. */
export interface AIProvider {
  /** Stateless prompt — no session context. */
  ask(prompt: string): Promise<ProviderResult>
  /** Prompt with session history and compaction. Returns StreamableResult for real-time event access. */
  askWithSession(prompt: string, session: SessionStore, opts?: AskOptions): StreamableResult
}

// ==================== Router ====================

/** Reads runtime AI config and delegates to the correct provider. */
export class ProviderRouter implements AIProvider {
  constructor(
    private vercel: AIProvider,
    private claudeCode: AIProvider | null,
    private agentSdk: AIProvider | null = null,
  ) {}

  async ask(prompt: string): Promise<ProviderResult> {
    const config = await readAIProviderConfig()
    if (config.backend === 'agent-sdk' && this.agentSdk) {
      return this.agentSdk.ask(prompt)
    }
    if (config.backend === 'claude-code' && this.claudeCode) {
      return this.claudeCode.ask(prompt)
    }
    return this.vercel.ask(prompt)
  }

  askWithSession(prompt: string, session: SessionStore, opts?: AskOptions): StreamableResult {
    // Per-request provider override takes precedence over global config
    if (opts?.provider === 'agent-sdk' && this.agentSdk) {
      return this.agentSdk.askWithSession(prompt, session, opts)
    }
    if (opts?.provider === 'claude-code' && this.claudeCode) {
      return this.claudeCode.askWithSession(prompt, session, opts)
    }
    if (opts?.provider === 'vercel-ai-sdk') {
      return this.vercel.askWithSession(prompt, session, opts)
    }
    // Fall back to global config — need async resolution, wrap in StreamableResult
    const resolve = async function* (self: ProviderRouter): AsyncGenerator<ProviderEvent> {
      const config = await readAIProviderConfig()
      let provider: AIProvider
      if (config.backend === 'agent-sdk' && self.agentSdk) {
        provider = self.agentSdk
      } else if (config.backend === 'claude-code' && self.claudeCode) {
        provider = self.claudeCode
      } else {
        provider = self.vercel
      }
      yield* provider.askWithSession(prompt, session, opts)
    }
    return new StreamableResult(resolve(this))
  }
}
