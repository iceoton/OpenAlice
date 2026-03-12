/**
 * Agent SDK session management — mirrors claude-code/session.ts 7-step flow.
 *
 * 1. appendUser → 2. compactIfNeeded → 3. readActive + toTextHistory
 * 4. build <chat_history> prompt → 5. askAgentSdk → 6. persist messages → 7. return
 */

import type { SessionStore } from '../../core/session.js'
import type { CompactionConfig } from '../../core/compaction.js'
import type { MediaAttachment } from '../../core/types.js'
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import type { AgentSdkConfig, AgentSdkOverride } from './query.js'
import type { ProviderEvent } from '../../core/ai-provider.js'
import { StreamableResult } from '../../core/ai-provider.js'
import { toTextHistory } from '../../core/session.js'
import { compactIfNeeded } from '../../core/compaction.js'
import { extractMediaFromToolResultContent } from '../../core/media.js'
import { createChannel } from '../../core/async-channel.js'
import { askAgentSdk } from './query.js'

// ==================== Types ====================

export interface AgentSdkSessionConfig {
  agentSdk: AgentSdkConfig
  compaction: CompactionConfig
  systemPrompt?: string
  maxHistoryEntries?: number
  historyPreamble?: string
  override?: AgentSdkOverride
  mcpServer?: McpSdkServerConfigWithInstance
}

export interface AgentSdkSessionResult {
  text: string
  media: MediaAttachment[]
}

// ==================== Defaults ====================

const DEFAULT_MAX_HISTORY = 50
const DEFAULT_PREAMBLE =
  'The following is the recent conversation history. Use it as context if it references earlier events or decisions.'

// ==================== Public ====================

/**
 * Call Agent SDK with full session management:
 * append user message → compact → build history prompt → call → persist messages.
 *
 * Returns a StreamableResult that emits tool_use / tool_result / done events.
 */
export function askAgentSdkWithSession(
  prompt: string,
  session: SessionStore,
  config: AgentSdkSessionConfig,
): StreamableResult {
  async function* generate(): AsyncGenerator<ProviderEvent> {
    const maxHistory = config.maxHistoryEntries ?? DEFAULT_MAX_HISTORY
    const preamble = config.historyPreamble ?? DEFAULT_PREAMBLE

    // 1. Append user message to session
    await session.appendUser(prompt, 'human')

    // 2. Compact if needed (using askAgentSdk as summarizer — single turn, no MCP)
    const compactionResult = await compactIfNeeded(
      session,
      config.compaction,
      async (summarizePrompt) => {
        const r = await askAgentSdk(summarizePrompt, {
          ...config.agentSdk,
          maxTurns: 1,
        }, config.override)
        return r.text
      },
    )

    // 3. Read active window and build text history
    const entries = compactionResult.activeEntries ?? await session.readActive()
    const textHistory = toTextHistory(entries).slice(-maxHistory)

    // 4. Build full prompt with <chat_history> if history exists
    let fullPrompt: string
    if (textHistory.length > 0) {
      const lines = textHistory.map((entry) => {
        const tag = entry.role === 'user' ? 'User' : 'Bot'
        return `[${tag}] ${entry.text}`
      })
      fullPrompt = [
        '<chat_history>',
        preamble,
        '',
        ...lines,
        '</chat_history>',
        '',
        prompt,
      ].join('\n')
    } else {
      fullPrompt = prompt
    }

    // 5. Call askAgentSdk — bridge callbacks to channel for streaming
    const channel = createChannel<ProviderEvent>()
    const media: MediaAttachment[] = []

    const resultPromise = askAgentSdk(
      fullPrompt,
      {
        ...config.agentSdk,
        systemPrompt: config.systemPrompt,
        onToolUse: ({ id, name, input }) => {
          channel.push({ type: 'tool_use', id, name, input })
        },
        onToolResult: ({ toolUseId, content }) => {
          media.push(...extractMediaFromToolResultContent(content))
          channel.push({ type: 'tool_result', tool_use_id: toolUseId, content })
        },
      },
      config.override,
      config.mcpServer,
    )

    resultPromise.then(() => channel.close()).catch((err) => channel.error(err instanceof Error ? err : new Error(String(err))))

    // Yield streamed events from channel
    yield* channel

    // 6. Persist intermediate messages (tool calls + results) to session
    const result = await resultPromise
    for (const msg of result.messages) {
      if (msg.role === 'assistant') {
        await session.appendAssistant(msg.content, 'agent-sdk')
      } else {
        await session.appendUser(msg.content, 'agent-sdk')
      }
    }

    // 7. Yield done event with unified result
    const prefix = result.ok ? '' : '[error] '
    yield { type: 'done', result: { text: prefix + result.text, media } }
  }

  return new StreamableResult(generate())
}
