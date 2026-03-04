/**
 * Unified Trading interfaces — IBKR-style Account model
 *
 * Merges the concepts from crypto-trading (ICryptoTradingEngine) and
 * securities-trading (ISecuritiesTradingEngine) into a single Account interface.
 * All providers (Alpaca, CCXT, IBKR, ...) implement ITradingAccount.
 */

import type { Contract, SecType } from './contract.js'

// ==================== Position ====================

/**
 * Unified position/holding.
 * Stocks are the special case: side='long', leverage=1, no margin/liquidation.
 */
export interface Position {
  contract: Contract
  side: 'long' | 'short'
  qty: number
  avgEntryPrice: number
  currentPrice: number
  marketValue: number
  unrealizedPnL: number
  unrealizedPnLPercent: number
  costBasis: number
  leverage: number
  margin?: number
  liquidationPrice?: number
}

// ==================== Orders ====================

/** IBKR-aligned order types. Providers return error for unsupported types. */
export type OrderType =
  | 'market'
  | 'limit'
  | 'stop'
  | 'stop_limit'
  | 'trailing_stop'
  | 'trailing_stop_limit'
  | 'moc'

/** IBKR-aligned time-in-force values. */
export type TimeInForce = 'day' | 'gtc' | 'ioc' | 'fok' | 'opg' | 'gtd'

export interface OrderRequest {
  contract: Contract
  side: 'buy' | 'sell'
  type: OrderType
  qty?: number
  notional?: number
  price?: number                // limit price (IBKR: lmtPrice)
  stopPrice?: number            // stop trigger price (IBKR: auxPrice for STP)
  trailingAmount?: number       // trailing stop absolute offset (IBKR: auxPrice for TRAIL)
  trailingPercent?: number      // trailing stop percentage
  reduceOnly?: boolean
  timeInForce?: TimeInForce
  goodTillDate?: string         // ISO date for GTD orders
  extendedHours?: boolean       // IBKR: outsideRth
  parentId?: string             // bracket order: child references parent
  ocaGroup?: string             // One-Cancels-All group name
}

export interface OrderResult {
  success: boolean
  orderId?: string
  error?: string
  message?: string
  filledPrice?: number
  filledQty?: number
}

export interface Order {
  id: string
  contract: Contract
  side: 'buy' | 'sell'
  type: OrderType
  qty: number
  price?: number
  stopPrice?: number
  trailingAmount?: number
  trailingPercent?: number
  reduceOnly?: boolean
  timeInForce?: TimeInForce
  goodTillDate?: string
  extendedHours?: boolean
  parentId?: string
  ocaGroup?: string
  status: 'pending' | 'filled' | 'cancelled' | 'rejected' | 'partially_filled'
  filledPrice?: number
  filledQty?: number
  filledAt?: Date
  createdAt: Date
  rejectReason?: string
}

// ==================== Account info ====================

export interface AccountInfo {
  cash: number
  equity: number
  unrealizedPnL: number
  realizedPnL: number
  portfolioValue?: number
  buyingPower?: number
  totalMargin?: number
  dayTradeCount?: number
  dayTradingBuyingPower?: number
}

// ==================== Market data ====================

export interface Quote {
  contract: Contract
  last: number
  bid: number
  ask: number
  volume: number
  high?: number
  low?: number
  timestamp: Date
}

export interface FundingRate {
  contract: Contract
  fundingRate: number
  nextFundingTime?: Date
  previousFundingRate?: number
  timestamp: Date
}

/** [price, amount] */
export type OrderBookLevel = [price: number, amount: number]

export interface OrderBook {
  contract: Contract
  bids: OrderBookLevel[]
  asks: OrderBookLevel[]
  timestamp: Date
}

export interface MarketClock {
  isOpen: boolean
  nextOpen?: Date
  nextClose?: Date
  timestamp?: Date
}

// ==================== Account capabilities ====================

export interface AccountCapabilities {
  supportedSecTypes: SecType[]
  supportedOrderTypes: OrderType[]
}

// ==================== ITradingAccount ====================

export interface ITradingAccount {
  /** Unique account ID, e.g. "alpaca-paper", "bybit-main". */
  readonly id: string

  /** Provider name, e.g. "alpaca", "ccxt". */
  readonly provider: string

  /** User-facing display name. */
  readonly label: string

  // ---- Lifecycle ----

  init(): Promise<void>
  close(): Promise<void>

  // ---- Contract resolution ----

  resolveContract(query: Partial<Contract>): Promise<Contract[]>

  // ---- Trading operations ----

  placeOrder(order: OrderRequest): Promise<OrderResult>
  modifyOrder(orderId: string, changes: Partial<OrderRequest>): Promise<OrderResult>
  cancelOrder(orderId: string): Promise<boolean>
  closePosition(contract: Contract, qty?: number): Promise<OrderResult>

  // ---- Queries ----

  getAccount(): Promise<AccountInfo>
  getPositions(): Promise<Position[]>
  getOrders(): Promise<Order[]>
  getQuote(contract: Contract): Promise<Quote>
  getMarketClock(): Promise<MarketClock>

  // ---- Capabilities ----

  getCapabilities(): AccountCapabilities
}

// ==================== Wallet state ====================

export interface WalletState {
  cash: number
  equity: number
  unrealizedPnL: number
  realizedPnL: number
  positions: Position[]
  pendingOrders: Order[]
}
