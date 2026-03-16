/**
 * AI tool factories for CCXT exchanges.
 *
 * Registered dynamically when a CCXT account comes online.
 */

import { tool } from 'ai'
import { z } from 'zod'
import { resolveAccounts } from '../../adapter.js'
import type { AccountResolver } from '../../adapter.js'
import { CcxtBroker } from './CcxtBroker.js'

export function createCcxtProviderTools(resolver: AccountResolver) {
  const { accountManager } = resolver

  /** Resolve to exactly one CcxtBroker. Returns error object if unable. */
  const resolveCcxtOne = (source?: string): { account: CcxtBroker; id: string } | { error: string } => {
    const targets = resolveAccounts(accountManager, source)
      .filter((t): t is { account: CcxtBroker; id: string } => t.account instanceof CcxtBroker)
    if (targets.length === 0) return { error: 'No CCXT account available.' }
    if (targets.length > 1) {
      return { error: `Multiple CCXT accounts: ${targets.map(t => t.id).join(', ')}. Specify source.` }
    }
    return targets[0]
  }

  const sourceDesc =
    'Account source — matches account id or provider name. Auto-resolves if only one CCXT account exists.'

  return {
    getFundingRate: tool({
      description: `Query the current funding rate for a perpetual contract.

Returns:
- fundingRate: current/latest funding rate (e.g. 0.0001 = 0.01%)
- nextFundingTime: when the next funding payment occurs
- previousFundingRate: the previous period's rate

Positive rate = longs pay shorts. Negative rate = shorts pay longs.
Use searchContracts first to get the aliceId.`,
      inputSchema: z.object({
        aliceId: z.string().describe('Contract identifier from searchContracts (e.g. "bybit-BTCUSDT")'),
        source: z.string().optional().describe(sourceDesc),
      }),
      execute: async ({ aliceId, source }) => {
        const resolved = resolveCcxtOne(source)
        if ('error' in resolved) return resolved
        const { account, id } = resolved
        const { Contract } = await import('@traderalice/ibkr')
        const contract = new Contract()
        contract.aliceId = aliceId
        const result = await account.getFundingRate(contract)
        return { source: id, ...result }
      },
    }),

    getOrderBook: tool({
      description: `Query the order book (market depth) for a contract.

Returns bids and asks sorted by price. Each level is [price, amount].
Use this to evaluate liquidity and potential slippage before placing large orders.
Use searchContracts first to get the aliceId.`,
      inputSchema: z.object({
        aliceId: z.string().describe('Contract identifier from searchContracts (e.g. "bybit-BTCUSDT")'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Number of price levels per side (default: 20)'),
        source: z.string().optional().describe(sourceDesc),
      }),
      execute: async ({ aliceId, limit, source }) => {
        const resolved = resolveCcxtOne(source)
        if ('error' in resolved) return resolved
        const { account, id } = resolved
        const { Contract } = await import('@traderalice/ibkr')
        const contract = new Contract()
        contract.aliceId = aliceId
        const result = await account.getOrderBook(contract, limit ?? 20)
        return { source: id, ...result }
      },
    }),

  }
}
