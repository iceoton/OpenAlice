/**
 * ClaudeCodeProvider — AIProvider implementation backed by the Claude Code CLI.
 *
 * Thin adapter: delegates to askClaudeCodeWithSession which owns the full
 * session management flow (append → compact → build <chat_history> → call CLI → persist).
 *
 * Agent config (evolutionMode, allowedTools, disallowedTools) is re-read from
 * disk on every request so that Web UI changes take effect without restart.
 */

import { resolve } from 'node:path'
import { type AIProvider, type AskOptions, type ProviderResult, type ProviderEvent, StreamableResult } from '../../core/ai-provider.js'
import type { SessionStore } from '../../core/session.js'
import type { CompactionConfig } from '../../core/compaction.js'
import type { ClaudeCodeConfig } from './types.js'
import { readAgentConfig } from '../../core/config.js'
import { askClaudeCode } from './provider.js'
import { askClaudeCodeWithSession } from './session.js'

export class ClaudeCodeProvider implements AIProvider {
  constructor(
    private compaction: CompactionConfig,
    private systemPrompt?: string,
  ) {}

  /** Re-read agent config from disk to pick up hot-reloaded settings. */
  private async resolveConfig(): Promise<ClaudeCodeConfig> {
    const agent = await readAgentConfig()
    return {
      ...agent.claudeCode,
      evolutionMode: agent.evolutionMode,
      cwd: agent.evolutionMode ? process.cwd() : resolve('data/brain'),
    }
  }

  async ask(prompt: string): Promise<ProviderResult> {
    const config = await this.resolveConfig()
    const result = await askClaudeCode(prompt, config)
    return { text: result.text, media: [] }
  }

  askWithSession(prompt: string, session: SessionStore, opts?: AskOptions): StreamableResult {
    // resolveConfig is async, so we wrap in a StreamableResult via an async generator
    // that awaits config resolution before delegating to the session function.
    const self = this
    async function* generate(): AsyncGenerator<ProviderEvent> {
      const config = await self.resolveConfig()
      const claudeCode = opts?.disabledTools?.length
        ? { ...config, disallowedTools: [...(config.disallowedTools ?? []), ...opts.disabledTools] }
        : config
      yield* askClaudeCodeWithSession(prompt, session, {
        claudeCode,
        compaction: self.compaction,
        historyPreamble: opts?.historyPreamble,
        systemPrompt: opts?.systemPrompt ?? self.systemPrompt,
        maxHistoryEntries: opts?.maxHistoryEntries,
      })
    }
    return new StreamableResult(generate())
  }
}
