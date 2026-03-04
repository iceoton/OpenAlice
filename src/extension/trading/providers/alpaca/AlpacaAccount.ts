/**
 * AlpacaAccount — ITradingAccount adapter for Alpaca
 *
 * Direct implementation against @alpacahq/alpaca-trade-api SDK.
 * Supports US equities (STK). Contract resolution uses Alpaca's ticker
 * as nativeId — unambiguous for stocks, extensible when options arrive.
 */

import Alpaca from '@alpacahq/alpaca-trade-api'
import type { Contract } from '../../contract.js'
import type {
  ITradingAccount,
  AccountCapabilities,
  AccountInfo,
  Position,
  Order,
  OrderRequest,
  OrderResult,
  Quote,
  MarketClock,
} from '../../interfaces.js'

export interface AlpacaAccountConfig {
  id?: string
  label?: string
  apiKey: string
  secretKey: string
  paper: boolean
}

// ==================== Alpaca SDK raw shapes ====================

interface AlpacaAccountRaw {
  cash: string
  portfolio_value: string
  equity: string
  buying_power: string
  daytrade_count: number
  daytrading_buying_power: string
}

interface AlpacaPositionRaw {
  symbol: string
  side: string
  qty: string
  avg_entry_price: string
  current_price: string
  market_value: string
  unrealized_pl: string
  unrealized_plpc: string
  cost_basis: string
}

interface AlpacaOrderRaw {
  id: string
  symbol: string
  side: string
  type: string
  qty: string | null
  notional: string | null
  limit_price: string | null
  stop_price: string | null
  time_in_force: string
  extended_hours: boolean
  status: string
  filled_avg_price: string | null
  filled_qty: string | null
  filled_at: string | null
  created_at: string
  reject_reason: string | null
}

interface AlpacaSnapshotRaw {
  LatestTrade: { Price: number; Timestamp: string }
  LatestQuote: { BidPrice: number; AskPrice: number; Timestamp: string }
  DailyBar: { Volume: number }
}

interface AlpacaClockRaw {
  is_open: boolean
  next_open: string
  next_close: string
  timestamp: string
}

// ==================== AlpacaAccount ====================

export class AlpacaAccount implements ITradingAccount {
  readonly id: string
  readonly provider = 'alpaca'
  readonly label: string

  private client!: InstanceType<typeof Alpaca>
  private readonly config: AlpacaAccountConfig

  constructor(config: AlpacaAccountConfig) {
    this.config = config
    this.id = config.id ?? (config.paper ? 'alpaca-paper' : 'alpaca-live')
    this.label = config.label ?? (config.paper ? 'Alpaca Paper' : 'Alpaca Live')
  }

  // ---- Lifecycle ----

  async init(): Promise<void> {
    this.client = new Alpaca({
      keyId: this.config.apiKey,
      secretKey: this.config.secretKey,
      paper: this.config.paper,
    })

    const account = await this.client.getAccount() as AlpacaAccountRaw
    console.log(
      `AlpacaAccount[${this.id}]: connected (paper=${this.config.paper}, equity=$${parseFloat(account.equity).toFixed(2)})`,
    )
  }

  async close(): Promise<void> {
    // Alpaca SDK has no explicit close
  }

  // ---- Contract resolution ----

  async resolveContract(query: Partial<Contract>): Promise<Contract[]> {
    // If aliceId is provided, parse it directly
    if (query.aliceId) {
      const nativeId = this.parseAliceId(query.aliceId)
      if (!nativeId) return []
      return [this.makeContract(nativeId)]
    }

    if (!query.symbol) return []

    // For now Alpaca only supports STK — if secType is specified and not STK, no match
    if (query.secType && query.secType !== 'STK') return []

    // Alpaca tickers are unique for stocks — symbol alone is sufficient
    // In the future when options are added, we'd filter by secType/strike/right/etc.
    return [this.makeContract(query.symbol.toUpperCase())]
  }

  // ---- Trading operations ----

  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    const symbol = this.resolveSymbol(order.contract)
    if (!symbol) {
      return { success: false, error: 'Cannot resolve contract to Alpaca symbol' }
    }

    try {
      const alpacaOrder: Record<string, unknown> = {
        symbol,
        side: order.side,
        type: order.type === 'trailing_stop' ? 'trailing_stop' : order.type,
        time_in_force: order.timeInForce ?? 'day',
      }

      if (order.qty != null) {
        alpacaOrder.qty = order.qty
      } else if (order.notional != null) {
        alpacaOrder.notional = order.notional
      }

      if (order.price != null) alpacaOrder.limit_price = order.price
      if (order.stopPrice != null) alpacaOrder.stop_price = order.stopPrice
      if (order.trailingAmount != null) alpacaOrder.trail_price = order.trailingAmount
      if (order.trailingPercent != null) alpacaOrder.trail_percent = order.trailingPercent
      if (order.extendedHours != null) alpacaOrder.extended_hours = order.extendedHours

      const result = await this.client.createOrder(alpacaOrder) as AlpacaOrderRaw
      const isFilled = result.status === 'filled'

      return {
        success: true,
        orderId: result.id,
        filledPrice: isFilled && result.filled_avg_price ? parseFloat(result.filled_avg_price) : undefined,
        filledQty: isFilled && result.filled_qty ? parseFloat(result.filled_qty) : undefined,
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async modifyOrder(orderId: string, changes: Partial<OrderRequest>): Promise<OrderResult> {
    try {
      const patch: Record<string, unknown> = {}
      if (changes.qty != null) patch.qty = changes.qty
      if (changes.price != null) patch.limit_price = changes.price
      if (changes.stopPrice != null) patch.stop_price = changes.stopPrice
      if (changes.trailingAmount != null) patch.trail = changes.trailingAmount
      if (changes.trailingPercent != null) patch.trail = changes.trailingPercent
      if (changes.timeInForce) patch.time_in_force = changes.timeInForce

      const result = await this.client.replaceOrder(orderId, patch) as AlpacaOrderRaw
      const isFilled = result.status === 'filled'

      return {
        success: true,
        orderId: result.id,
        filledPrice: isFilled && result.filled_avg_price ? parseFloat(result.filled_avg_price) : undefined,
        filledQty: isFilled && result.filled_qty ? parseFloat(result.filled_qty) : undefined,
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    try {
      await this.client.cancelOrder(orderId)
      return true
    } catch {
      return false
    }
  }

  async closePosition(contract: Contract, qty?: number): Promise<OrderResult> {
    const symbol = this.resolveSymbol(contract)
    if (!symbol) {
      return { success: false, error: 'Cannot resolve contract to Alpaca symbol' }
    }

    // Partial close → reverse market order
    if (qty != null) {
      const positions = await this.getPositions()
      const pos = positions.find(p => p.contract.symbol === symbol)
      if (!pos) return { success: false, error: `No position for ${symbol}` }

      return this.placeOrder({
        contract,
        side: pos.side === 'long' ? 'sell' : 'buy',
        type: 'market',
        qty,
        timeInForce: 'day',
      })
    }

    // Full close → native Alpaca API
    try {
      const result = await this.client.closePosition(symbol) as AlpacaOrderRaw
      const isFilled = result.status === 'filled'
      return {
        success: true,
        orderId: result.id,
        filledPrice: isFilled && result.filled_avg_price ? parseFloat(result.filled_avg_price) : undefined,
        filledQty: isFilled && result.filled_qty ? parseFloat(result.filled_qty) : undefined,
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  // ---- Queries ----

  async getAccount(): Promise<AccountInfo> {
    const account = await this.client.getAccount() as AlpacaAccountRaw

    // Alpaca account API doesn't provide unrealizedPnL — aggregate from positions
    const positions = await this.client.getPositions() as AlpacaPositionRaw[]
    const unrealizedPnL = positions.reduce((sum, p) => sum + parseFloat(p.unrealized_pl), 0)

    return {
      cash: parseFloat(account.cash),
      equity: parseFloat(account.equity),
      unrealizedPnL,
      realizedPnL: 0, // Alpaca account API doesn't provide this; tracked by TradingGit
      portfolioValue: parseFloat(account.portfolio_value),
      buyingPower: parseFloat(account.buying_power),
      dayTradeCount: account.daytrade_count,
      dayTradingBuyingPower: parseFloat(account.daytrading_buying_power),
    }
  }

  async getPositions(): Promise<Position[]> {
    const raw = await this.client.getPositions() as AlpacaPositionRaw[]

    return raw.map(p => ({
      contract: this.makeContract(p.symbol),
      side: p.side === 'long' ? 'long' as const : 'short' as const,
      qty: parseFloat(p.qty),
      avgEntryPrice: parseFloat(p.avg_entry_price),
      currentPrice: parseFloat(p.current_price),
      marketValue: Math.abs(parseFloat(p.market_value)),
      unrealizedPnL: parseFloat(p.unrealized_pl),
      unrealizedPnLPercent: parseFloat(p.unrealized_plpc) * 100,
      costBasis: parseFloat(p.cost_basis),
      leverage: 1,
    }))
  }

  async getOrders(): Promise<Order[]> {
    const orders = await this.client.getOrders({
      status: 'all',
      limit: 100,
      until: undefined,
      after: undefined,
      direction: undefined,
      nested: undefined,
      symbols: undefined,
    }) as AlpacaOrderRaw[]

    return orders.map(o => this.mapOrder(o))
  }

  async getQuote(contract: Contract): Promise<Quote> {
    const symbol = this.resolveSymbol(contract)
    if (!symbol) throw new Error('Cannot resolve contract to Alpaca symbol')

    const snapshot = await this.client.getSnapshot(symbol) as AlpacaSnapshotRaw

    return {
      contract: this.makeContract(symbol),
      last: snapshot.LatestTrade.Price,
      bid: snapshot.LatestQuote.BidPrice,
      ask: snapshot.LatestQuote.AskPrice,
      volume: snapshot.DailyBar.Volume,
      timestamp: new Date(snapshot.LatestTrade.Timestamp),
    }
  }

  // ---- Capabilities ----

  getCapabilities(): AccountCapabilities {
    return {
      supportedSecTypes: ['STK'],
      supportedOrderTypes: ['market', 'limit', 'stop', 'stop_limit', 'trailing_stop'],
    }
  }

  async getMarketClock(): Promise<MarketClock> {
    const clock = await this.client.getClock() as AlpacaClockRaw
    return {
      isOpen: clock.is_open,
      nextOpen: new Date(clock.next_open),
      nextClose: new Date(clock.next_close),
      timestamp: new Date(clock.timestamp),
    }
  }

  // ==================== Internal ====================

  /** Extract native symbol from aliceId, or null if not ours. */
  private parseAliceId(aliceId: string): string | null {
    const prefix = `${this.provider}-`
    if (!aliceId.startsWith(prefix)) return null
    return aliceId.slice(prefix.length)
  }

  /** Build a fully qualified Contract for an Alpaca ticker. */
  private makeContract(ticker: string): Contract {
    return {
      aliceId: `${this.provider}-${ticker}`,
      symbol: ticker,
      secType: 'STK',
      exchange: 'SMART',
      currency: 'USD',
    }
  }

  /**
   * Resolve a Contract to an Alpaca ticker symbol.
   * Accepts: aliceId, or symbol (+ optional secType check).
   */
  private resolveSymbol(contract: Contract): string | null {
    if (contract.aliceId) {
      return this.parseAliceId(contract.aliceId)
    }
    if (contract.symbol) {
      // If secType is specified and not STK, not our domain
      if (contract.secType && contract.secType !== 'STK') return null
      return contract.symbol.toUpperCase()
    }
    return null
  }

  private mapOrder(o: AlpacaOrderRaw): Order {
    const symbol = o.symbol
    return {
      id: o.id,
      contract: this.makeContract(symbol),
      side: o.side as 'buy' | 'sell',
      type: o.type as Order['type'],
      qty: parseFloat(o.qty ?? o.notional ?? '0'),
      price: o.limit_price ? parseFloat(o.limit_price) : undefined,
      stopPrice: o.stop_price ? parseFloat(o.stop_price) : undefined,
      timeInForce: o.time_in_force as Order['timeInForce'],
      extendedHours: o.extended_hours,
      status: this.mapOrderStatus(o.status),
      filledPrice: o.filled_avg_price ? parseFloat(o.filled_avg_price) : undefined,
      filledQty: o.filled_qty ? parseFloat(o.filled_qty) : undefined,
      filledAt: o.filled_at ? new Date(o.filled_at) : undefined,
      createdAt: new Date(o.created_at),
      rejectReason: o.reject_reason ?? undefined,
    }
  }

  private mapOrderStatus(alpacaStatus: string): Order['status'] {
    switch (alpacaStatus) {
      case 'filled':
        return 'filled'
      case 'new':
      case 'accepted':
      case 'pending_new':
      case 'accepted_for_bidding':
        return 'pending'
      case 'canceled':
      case 'expired':
      case 'replaced':
        return 'cancelled'
      case 'partially_filled':
        return 'partially_filled'
      case 'done_for_day':
      case 'suspended':
      case 'rejected':
        return 'rejected'
      default:
        return 'pending'
    }
  }
}
