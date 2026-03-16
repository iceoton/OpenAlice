/**
 * Unified Trading Tool Factory — multi-account source routing
 *
 * Creates ONE set of AI tools that route to accounts via `source` parameter.
 * Query tools default to all accounts (aggregated with source tags).
 * Staging mutations (placeOrder, closePosition, cancelOrder) require explicit `source`.
 * Git-flow mutations (tradingCommit, tradingPush, tradingSync) default to all accounts.
 *
 * AI tool inputs → IBKR Order/Contract objects → git.add() staging.
 */

import { tool } from 'ai'
import { z } from 'zod'
import Decimal from 'decimal.js'
import { Contract, Order } from '@traderalice/ibkr'
import type { AccountManager } from './account-manager.js'
import type { IBroker } from './interfaces.js'
import type { ITradingGit } from './git/interfaces.js'
import type { GitState, OrderStatusUpdate } from './git/types.js'
import './contract-ext.js'

// ==================== IBKR field mapping ====================

/** Map human-readable order type → IBKR short code. */
function toIbkrOrderType(type: string): string {
  switch (type) {
    case 'market': return 'MKT'
    case 'limit': return 'LMT'
    case 'stop': return 'STP'
    case 'stop_limit': return 'STP LMT'
    case 'trailing_stop': return 'TRAIL'
    case 'trailing_stop_limit': return 'TRAIL LIMIT'
    case 'moc': return 'MOC'
    default: return type.toUpperCase()
  }
}

/** Map human-readable TIF → IBKR short code. */
function toIbkrTif(tif: string): string {
  return tif.toUpperCase() // day→DAY, gtc→GTC, ioc→IOC, etc.
}

// ==================== Resolver interface ====================

export interface AccountResolver {
  accountManager: AccountManager
  getGit: (accountId: string) => ITradingGit | undefined
  getGitState: (accountId: string) => Promise<GitState> | undefined
}

// ==================== Exported helpers (used by provider tools) ====================

export interface ResolvedAccount {
  account: IBroker
  id: string
}

export function resolveAccounts(
  mgr: AccountManager,
  source?: string,
): ResolvedAccount[] {
  const summaries = mgr.listAccounts()
  if (!source) {
    return summaries
      .map((s) => ({ account: mgr.getAccount(s.id)!, id: s.id }))
      .filter((r) => r.account)
  }
  // Try id match first, then provider match
  const byId = mgr.getAccount(source)
  if (byId) return [{ account: byId, id: source }]

  const byProvider = summaries
    .filter((s) => s.provider === source)
    .map((s) => ({ account: mgr.getAccount(s.id)!, id: s.id }))
    .filter((r) => r.account)
  return byProvider
}

export function resolveOne(
  mgr: AccountManager,
  source: string,
): ResolvedAccount {
  const results = resolveAccounts(mgr, source)
  if (results.length === 0) {
    throw new Error(`No account found matching source "${source}". Use listAccounts to see available accounts.`)
  }
  if (results.length > 1) {
    throw new Error(
      `Multiple accounts match source "${source}": ${results.map((r) => r.id).join(', ')}. Use account id for exact match.`,
    )
  }
  return results[0]
}

function requireGit(resolver: AccountResolver, accountId: string): ITradingGit {
  const git = resolver.getGit(accountId)
  if (!git) throw new Error(`No git instance for account "${accountId}"`)
  return git
}

const sourceDesc = (required: boolean, extra?: string) => {
  const base = `Account source — matches account id (e.g. "alpaca-paper") or provider (e.g. "alpaca", "ccxt").`
  const req = required
    ? ' Required for this operation.'
    : ' Optional — omit to query all accounts.'
  return base + req + (extra ? ` ${extra}` : '')
}

// ==================== Tool factory ====================

export function createTradingTools(resolver: AccountResolver) {
  const { accountManager } = resolver

  return {
    // ==================== Discovery ====================

    listAccounts: tool({
      description:
        'List all registered trading accounts with their id, provider, label, and capabilities. ' +
        'Use this to discover available `source` values for other tools.',
      inputSchema: z.object({}),
      execute: () => {
        return accountManager.listAccounts()
      },
    }),

    // ==================== Contract Search (IBKR: reqMatchingSymbols) ====================

    searchContracts: tool({
      description: `Search broker accounts for tradeable contracts matching a pattern.

This is a BROKER-LEVEL search — it queries your connected trading accounts to find
what contracts are available to trade and on which account. Returns contract details
with source attribution.

When to use:
- You need to discover which account can trade a symbol (e.g. "Is BTC on ccxt or alpaca?")
- You want to find the exact broker contract format (e.g. "BTC" → "BTC/USDT:USDT" on ccxt)
- You're unsure if a symbol is tradeable on a specific account

When NOT to use:
- You already have the symbol and just need a price → use getQuote directly
- You want to research companies or market data → use marketSearchForResearch instead
- You're about to place an order with a known symbol → placeOrder handles routing itself`,
      inputSchema: z.object({
        pattern: z.string().describe('Symbol or keyword to search (e.g. "AAPL", "BTC", "TSLA")'),
        source: z.string().optional().describe(sourceDesc(false)),
      }),
      execute: async ({ pattern, source }) => {
        const targets = resolveAccounts(accountManager, source)
        if (targets.length === 0) return { error: 'No accounts available.' }

        const allResults: Array<Record<string, unknown>> = []

        for (const { account, id } of targets) {
          try {
            const descriptions = await account.searchContracts(pattern)
            for (const desc of descriptions) {
              allResults.push({
                source: id,
                ...desc,
              })
            }
          } catch {
            // Skip accounts that fail to search
          }
        }

        if (allResults.length === 0) return { results: [], message: `No contracts found matching "${pattern}".` }
        return allResults
      },
    }),

    // ==================== Contract Details (IBKR: reqContractDetails) ====================

    getContractDetails: tool({
      description: `Get full contract specification from a specific broker account.

Returns detailed broker-level information: supported order types, valid exchanges,
price increments (minTick), trading hours, and contract classification.

Use this when you need broker-specific contract specs (e.g. what order types are
supported, minimum tick size). NOT needed for general company info — use
equityGetProfile for that.`,
      inputSchema: z.object({
        source: z.string().describe(sourceDesc(true)),
        symbol: z.string().optional().describe('Symbol to look up (e.g. "AAPL", "BTC")'),
        aliceId: z.string().optional().describe('Alice contract ID for exact match'),
        secType: z.string().optional().describe('Security type filter (e.g. "STK", "CRYPTO")'),
        currency: z.string().optional().describe('Currency filter (e.g. "USD", "USDT")'),
      }),
      execute: async ({ source, symbol, aliceId, secType, currency }) => {
        const { account, id } = resolveOne(accountManager, source)

        const query = new Contract()
        if (symbol) query.symbol = symbol
        if (aliceId) query.aliceId = aliceId
        if (secType) query.secType = secType
        if (currency) query.currency = currency

        const details = await account.getContractDetails(query)
        if (!details) return { error: `No contract details found.` }
        return { source: id, ...details }
      },
    }),

    // ==================== Account info (query, aggregatable) ====================

    getAccount: tool({
      description:
        'Query trading account info (netLiquidation, totalCashValue, buyingPower, unrealizedPnL, realizedPnL).',
      inputSchema: z.object({
        source: z.string().optional().describe(sourceDesc(false)),
      }),
      execute: async ({ source }) => {
        const targets = resolveAccounts(accountManager, source)
        if (targets.length === 0) return { error: 'No accounts available.' }

        const results = await Promise.all(
          targets.map(async ({ account, id }) => {
            const info = await account.getAccount()
            return { source: id, ...info }
          }),
        )
        return results.length === 1 ? results[0] : results
      },
    }),

    // ==================== Portfolio (query, aggregatable) ====================

    getPortfolio: tool({
      description: `Query current portfolio holdings.

Each holding includes:
- symbol, side, quantity, avgCost, marketPrice
- marketValue: Current market value
- unrealizedPnL: Unrealized profit/loss

IMPORTANT: If result is an empty array [], you have no holdings.`,
      inputSchema: z.object({
        source: z.string().optional().describe(sourceDesc(false)),
        symbol: z
          .string()
          .optional()
          .describe('Filter by ticker (e.g. "AAPL"), or omit for all holdings'),
      }),
      execute: async ({ source, symbol }) => {
        const targets = resolveAccounts(accountManager, source)
        if (targets.length === 0) return { positions: [], message: 'No accounts available.' }

        const allPositions: Array<Record<string, unknown>> = []

        for (const { account, id } of targets) {
          const positions = await account.getPositions()
          const accountInfo = await account.getAccount()

          const totalMarketValue = positions.reduce((sum, p) => sum + p.marketValue, 0)

          for (const pos of positions) {
            if (symbol && symbol !== 'all' && pos.contract.symbol !== symbol) continue

            const percentOfEquity =
              accountInfo.netLiquidation > 0 ? (pos.marketValue / accountInfo.netLiquidation) * 100 : 0
            const percentOfPortfolio =
              totalMarketValue > 0 ? (pos.marketValue / totalMarketValue) * 100 : 0

            allPositions.push({
              source: id,
              symbol: pos.contract.symbol,
              side: pos.side,
              quantity: pos.quantity.toNumber(),
              avgCost: pos.avgCost,
              marketPrice: pos.marketPrice,
              marketValue: pos.marketValue,
              unrealizedPnL: pos.unrealizedPnL,
              realizedPnL: pos.realizedPnL,
              leverage: pos.leverage,
              margin: pos.margin,
              liquidationPrice: pos.liquidationPrice,
              percentageOfEquity: `${percentOfEquity.toFixed(1)}%`,
              percentageOfPortfolio: `${percentOfPortfolio.toFixed(1)}%`,
            })
          }
        }

        if (allPositions.length === 0) {
          return { positions: [], message: 'No open positions.' }
        }
        return allPositions
      },
    }),

    // ==================== Orders (query, aggregatable) ====================

    getOrders: tool({
      description: 'Query order history (filled, pending, cancelled)',
      inputSchema: z.object({
        source: z.string().optional().describe(sourceDesc(false)),
      }),
      execute: async ({ source }) => {
        const targets = resolveAccounts(accountManager, source)
        if (targets.length === 0) return []

        const results = await Promise.all(
          targets.map(async ({ account, id }) => {
            const orders = await account.getOrders()
            return orders.map((o) => ({ source: id, ...o }))
          }),
        )
        return results.flat()
      },
    }),

    // ==================== Quote (query, optional source) ====================

    getQuote: tool({
      description: `Query the latest quote/price for a contract.

Returns real-time market data from the broker:
- last: last traded price
- bid/ask: current best bid and ask
- volume: today's trading volume

Use searchContracts first to get the aliceId, then pass it here.`,
      inputSchema: z.object({
        aliceId: z.string().describe('Contract identifier from searchContracts (e.g. "alpaca-AAPL", "bybit-BTCUSDT")'),
        source: z.string().optional().describe(sourceDesc(false)),
      }),
      execute: async ({ aliceId, source }) => {
        const targets = resolveAccounts(accountManager, source)
        if (targets.length === 0) return { error: 'No accounts available.' }

        const query = new Contract()
        query.aliceId = aliceId

        const results: Array<Record<string, unknown>> = []
        for (const { account, id } of targets) {
          try {
            const quote = await account.getQuote(query)
            results.push({ source: id, ...quote })
          } catch {
            // Skip accounts that don't support this contract
          }
        }

        if (results.length === 0) return { error: `No account could quote aliceId "${aliceId}".` }
        return results.length === 1 ? results[0] : results
      },
    }),

    // ==================== Market Clock (query, optional source) ====================

    getMarketClock: tool({
      description:
        'Get current market clock status (isOpen, nextOpen, nextClose). Use this to check if the market is currently open for trading.',
      inputSchema: z.object({
        source: z.string().optional().describe(sourceDesc(false)),
      }),
      execute: async ({ source }) => {
        const targets = resolveAccounts(accountManager, source)
        if (targets.length === 0) return { error: 'No accounts available.' }

        const results = await Promise.all(
          targets.map(async ({ account, id }) => {
            const clock = await account.getMarketClock()
            return { source: id, ...clock }
          }),
        )
        return results.length === 1 ? results[0] : results
      },
    }),

    // ==================== Trading Log (query, aggregatable) ====================

    tradingLog: tool({
      description: `View your trading decision history (like "git log --stat").

IMPORTANT: Check this BEFORE making new trading decisions to:
- Review what you planned in recent commits
- Avoid contradicting your own strategy
- Maintain consistency across rounds

Returns recent trading commits in reverse chronological order (newest first).`,
      inputSchema: z.object({
        source: z.string().optional().describe(sourceDesc(false)),
        limit: z.number().int().positive().optional().describe('Number of recent commits (default: 10)'),
        symbol: z.string().optional().describe('Filter commits by symbol'),
      }),
      execute: ({ source, limit, symbol }) => {
        const targets = resolveAccounts(accountManager, source)
        if (targets.length === 0) return []

        const allEntries: Array<Record<string, unknown>> = []
        for (const { id } of targets) {
          const git = resolver.getGit(id)
          if (!git) continue
          const entries = git.log({ limit, symbol })
          for (const entry of entries) {
            allEntries.push({ source: id, ...entry })
          }
        }

        allEntries.sort((a, b) => {
          const ta = new Date(a.timestamp as string).getTime()
          const tb = new Date(b.timestamp as string).getTime()
          return tb - ta
        })

        return limit ? allEntries.slice(0, limit) : allEntries
      },
    }),

    // ==================== Trading Show ====================

    tradingShow: tool({
      description: `View details of a specific trading commit (like "git show <hash>").`,
      inputSchema: z.object({
        hash: z.string().describe('Commit hash to inspect (8 characters)'),
      }),
      execute: ({ hash }) => {
        const summaries = accountManager.listAccounts()
        for (const s of summaries) {
          const git = resolver.getGit(s.id)
          if (!git) continue
          const commit = git.show(hash)
          if (commit) return { source: s.id, ...commit }
        }
        return { error: `Commit ${hash} not found in any account` }
      },
    }),

    // ==================== Trading Status ====================

    tradingStatus: tool({
      description: `View current trading staging area status (like "git status").`,
      inputSchema: z.object({
        source: z.string().optional().describe(sourceDesc(false)),
      }),
      execute: ({ source }) => {
        const targets = resolveAccounts(accountManager, source)
        if (targets.length === 0) return []

        const results: Array<Record<string, unknown>> = []
        for (const { id } of targets) {
          const git = resolver.getGit(id)
          if (!git) continue
          results.push({ source: id, ...git.status() })
        }
        return results.length === 1 ? results[0] : results
      },
    }),

    // ==================== Simulate Price Change ====================

    simulatePriceChange: tool({
      description: `Simulate price changes to see portfolio impact BEFORE making decisions (dry run).

IMPORTANT: This is READ-ONLY - it does NOT modify your actual holdings.`,
      inputSchema: z.object({
        source: z.string().optional().describe(sourceDesc(false)),
        priceChanges: z
          .array(z.object({
            symbol: z.string().describe('Ticker or "all"'),
            change: z.string().describe('"@150" for absolute, "+10%" or "-5%" for relative'),
          }))
          .describe('Array of price changes to simulate'),
      }),
      execute: async ({ source, priceChanges }) => {
        const targets = resolveAccounts(accountManager, source)
        if (targets.length === 0) return { error: 'No accounts available.' }

        const results: Array<Record<string, unknown>> = []
        for (const { id } of targets) {
          const git = resolver.getGit(id)
          if (!git) continue
          const result = await git.simulatePriceChange(priceChanges)
          results.push({ source: id, ...result })
        }
        return results.length === 1 ? results[0] : results
      },
    }),

    // ==================== Place Order (mutation, source required) ====================

    placeOrder: tool({
      description: `Stage an order (will execute on tradingPush).

BEFORE placing orders, you SHOULD:
1. Check tradingLog({ source }) to review your history for THIS source
2. Check getPortfolio to see current holdings
3. Verify this trade aligns with your stated strategy

Supports two modes:
- qty-based: Specify number of shares (supports fractional, e.g. 0.5)
- notional-based: Specify USD amount (e.g. $1000 of AAPL)

For SELLING holdings, use closePosition tool instead.

NOTE: This stages the operation. Call tradingCommit + tradingPush to execute.`,
      inputSchema: z.object({
        source: z.string().describe(sourceDesc(true)),
        aliceId: z.string().describe('Contract identifier from searchContracts (e.g. "alpaca-AAPL", "bybit-BTCUSDT")'),
        symbol: z.string().optional().describe('Human-readable symbol for logging. Optional.'),
        side: z.enum(['buy', 'sell']).describe('Buy or sell'),
        type: z
          .enum(['market', 'limit', 'stop', 'stop_limit', 'trailing_stop', 'trailing_stop_limit', 'moc'])
          .describe('Order type'),
        qty: z.number().positive().optional().describe('Number of shares. Mutually exclusive with notional.'),
        notional: z.number().positive().optional().describe('Dollar amount. Mutually exclusive with qty.'),
        price: z.number().positive().optional().describe('Limit price'),
        stopPrice: z.number().positive().optional().describe('Stop trigger price'),
        trailingAmount: z.number().positive().optional().describe('Trailing stop offset in dollars'),
        trailingPercent: z.number().positive().optional().describe('Trailing stop percentage'),
        timeInForce: z.enum(['day', 'gtc', 'ioc', 'fok', 'opg', 'gtd']).default('day').describe('Time in force'),
        goodTillDate: z.string().optional().describe('Expiration date for GTD orders'),
        extendedHours: z.boolean().optional().describe('Allow pre-market and after-hours'),
        parentId: z.string().optional().describe('Parent order ID for bracket orders'),
        ocaGroup: z.string().optional().describe('One-Cancels-All group name'),
      }),
      execute: ({
        source, aliceId, symbol, side, type, qty, notional,
        price, stopPrice, trailingAmount, trailingPercent,
        timeInForce, goodTillDate, extendedHours, parentId, ocaGroup,
      }) => {
        const { id } = resolveOne(accountManager, source)
        const git = requireGit(resolver, id)

        // Build IBKR Contract
        const contract = new Contract()
        contract.aliceId = aliceId
        if (symbol) contract.symbol = symbol

        // Build IBKR Order
        const order = new Order()
        order.action = side === 'buy' ? 'BUY' : 'SELL'
        order.orderType = toIbkrOrderType(type)
        order.tif = toIbkrTif(timeInForce)

        if (qty != null) order.totalQuantity = new Decimal(qty)
        if (notional != null) order.cashQty = notional
        if (price != null) order.lmtPrice = price
        if (stopPrice != null) order.auxPrice = stopPrice
        if (trailingAmount != null) order.auxPrice = trailingAmount
        if (trailingPercent != null) order.trailingPercent = trailingPercent
        if (goodTillDate != null) order.goodTillDate = goodTillDate
        if (extendedHours) order.outsideRth = true
        if (parentId != null) order.parentId = parseInt(parentId, 10) || 0
        if (ocaGroup != null) order.ocaGroup = ocaGroup

        return git.add({ action: 'placeOrder', contract, order })
      },
    }),

    // ==================== Modify Order (mutation, source required) ====================

    modifyOrder: tool({
      description: `Stage an order modification (will execute on tradingPush).

NOTE: This stages the operation. Call tradingCommit + tradingPush to execute.`,
      inputSchema: z.object({
        source: z.string().describe(sourceDesc(true)),
        orderId: z.string().describe('Order ID to modify'),
        qty: z.number().positive().optional().describe('New quantity'),
        price: z.number().positive().optional().describe('New limit price'),
        stopPrice: z.number().positive().optional().describe('New stop trigger price'),
        trailingAmount: z.number().positive().optional().describe('New trailing stop offset'),
        trailingPercent: z.number().positive().optional().describe('New trailing stop percentage'),
        type: z
          .enum(['market', 'limit', 'stop', 'stop_limit', 'trailing_stop', 'trailing_stop_limit', 'moc'])
          .optional()
          .describe('New order type'),
        timeInForce: z.enum(['day', 'gtc', 'ioc', 'fok', 'opg', 'gtd']).optional().describe('New time in force'),
        goodTillDate: z.string().optional().describe('New expiration date'),
      }),
      execute: ({ source, orderId, qty, price, stopPrice, trailingAmount, trailingPercent, type, timeInForce, goodTillDate }) => {
        const { id } = resolveOne(accountManager, source)
        const git = requireGit(resolver, id)

        const changes: Partial<Order> = {}
        if (qty != null) changes.totalQuantity = new Decimal(qty)
        if (price != null) changes.lmtPrice = price
        if (stopPrice != null) changes.auxPrice = stopPrice
        if (trailingAmount != null) changes.auxPrice = trailingAmount
        if (trailingPercent != null) changes.trailingPercent = trailingPercent
        if (type != null) changes.orderType = toIbkrOrderType(type)
        if (timeInForce != null) changes.tif = toIbkrTif(timeInForce)
        if (goodTillDate != null) changes.goodTillDate = goodTillDate

        return git.add({ action: 'modifyOrder', orderId, changes })
      },
    }),

    // ==================== Close Position (mutation, source required) ====================

    closePosition: tool({
      description: `Stage a position close (will execute on tradingPush).

NOTE: This stages the operation. Call tradingCommit + tradingPush to execute.`,
      inputSchema: z.object({
        source: z.string().describe(sourceDesc(true)),
        aliceId: z.string().describe('Contract identifier'),
        symbol: z.string().optional().describe('Human-readable symbol. Optional.'),
        qty: z.number().positive().optional().describe('Number of shares to sell (default: sell all)'),
      }),
      execute: ({ source, aliceId, symbol, qty }) => {
        const { id } = resolveOne(accountManager, source)
        const git = requireGit(resolver, id)

        const contract = new Contract()
        contract.aliceId = aliceId
        if (symbol) contract.symbol = symbol

        return git.add({
          action: 'closePosition',
          contract,
          quantity: qty != null ? new Decimal(qty) : undefined,
        })
      },
    }),

    // ==================== Cancel Order (mutation, source required) ====================

    cancelOrder: tool({
      description: `Stage an order cancellation (will execute on tradingPush).

NOTE: This stages the operation. Call tradingCommit + tradingPush to execute.`,
      inputSchema: z.object({
        source: z.string().describe(sourceDesc(true)),
        orderId: z.string().describe('Order ID to cancel'),
      }),
      execute: ({ source, orderId }) => {
        const { id } = resolveOne(accountManager, source)
        const git = requireGit(resolver, id)
        return git.add({ action: 'cancelOrder', orderId })
      },
    }),

    // ==================== Trading Commit ====================

    tradingCommit: tool({
      description: `Commit staged trading operations with a message (like "git commit -m").

This does NOT execute the trades yet - call tradingPush after this.`,
      inputSchema: z.object({
        source: z.string().optional().describe(sourceDesc(false, 'If omitted, commits all accounts with staged operations.')),
        message: z.string().describe('Commit message explaining your trading decision'),
      }),
      execute: ({ source, message }) => {
        const targets = resolveAccounts(accountManager, source)
        const results: Array<Record<string, unknown>> = []

        for (const { id } of targets) {
          const git = resolver.getGit(id)
          if (!git) continue
          const status = git.status()
          if (status.staged.length === 0) continue
          results.push({ source: id, ...git.commit(message) })
        }

        if (results.length === 0) return { message: 'No staged operations to commit.' }
        return results.length === 1 ? results[0] : results
      },
    }),

    // ==================== Trading Push ====================

    tradingPush: tool({
      description: `Execute all committed trading operations (like "git push").

IMPORTANT: You must call tradingCommit first before pushing.`,
      inputSchema: z.object({
        source: z.string().optional().describe(sourceDesc(false, 'If omitted, pushes all accounts with committed operations.')),
      }),
      execute: async ({ source }) => {
        const targets = resolveAccounts(accountManager, source)
        const results: Array<Record<string, unknown>> = []

        for (const { id } of targets) {
          const git = resolver.getGit(id)
          if (!git) continue
          const status = git.status()
          if (!status.pendingMessage) continue
          const result = await git.push()
          results.push({ source: id, ...result })
        }

        if (results.length === 0) return { message: 'No committed operations to push.' }
        return results.length === 1 ? results[0] : results
      },
    }),

    // ==================== Trading Sync ====================

    tradingSync: tool({
      description: `Sync pending order statuses from broker (like "git pull").

Use this after placing limit/stop orders to check if they've been filled.`,
      inputSchema: z.object({
        source: z.string().optional().describe(sourceDesc(false, 'If omitted, syncs all accounts with pending orders.')),
      }),
      execute: async ({ source }) => {
        const targets = resolveAccounts(accountManager, source)
        const results: Array<Record<string, unknown>> = []

        for (const { id, account } of targets) {
          const git = resolver.getGit(id)
          if (!git) continue
          const gitState = resolver.getGitState(id)
          if (!gitState) continue

          const pendingOrders = git.getPendingOrderIds()
          if (pendingOrders.length === 0) continue

          const brokerOrders = await account.getOrders()
          const updates: OrderStatusUpdate[] = []

          for (const { orderId, symbol } of pendingOrders) {
            const brokerOrder = brokerOrders.find((o) => String(o.order.orderId) === orderId || o.order.permId === parseInt(orderId, 10))
            if (!brokerOrder) continue

            const status = brokerOrder.orderState.status
            if (status !== 'Submitted' && status !== 'PreSubmitted') {
              updates.push({
                orderId,
                symbol,
                previousStatus: 'pending',
                currentStatus: status === 'Filled' ? 'filled' : status === 'Cancelled' ? 'cancelled' : 'rejected',
              })
            }
          }

          if (updates.length === 0) continue

          const state = await gitState
          const result = await git.sync(updates, state)
          results.push({ source: id, ...result })
        }

        if (results.length === 0) return { message: 'No pending orders to sync.', updatedCount: 0 }
        return results.length === 1 ? results[0] : results
      },
    }),
  }
}
