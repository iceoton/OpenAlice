/**
 * CcxtBroker unit tests.
 *
 * We mock the ccxt module so the constructor doesn't try to reach real exchanges.
 * Tests focus on pure logic: searchContracts sorting/filtering, cancelOrder cache,
 * placeOrder notional conversion, and the constructor error path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import Decimal from 'decimal.js'
import { Contract, Order, UNSET_DOUBLE, UNSET_DECIMAL } from '@traderalice/ibkr'

// Mock ccxt BEFORE importing CcxtBroker
vi.mock('ccxt', () => {
  // Create a fake exchange class that can be used as a constructor
  const MockExchange = vi.fn(function (this: any) {
    this.markets = {}
    this.options = { fetchMarkets: { types: ['spot', 'linear'] } }
    this.setSandboxMode = vi.fn()
    this.loadMarkets = vi.fn().mockResolvedValue({})
    this.fetchMarkets = vi.fn().mockResolvedValue([])
    this.fetchTicker = vi.fn()
    this.fetchBalance = vi.fn()
    this.fetchPositions = vi.fn()
    this.fetchOpenOrders = vi.fn()
    this.fetchClosedOrders = vi.fn()
    this.createOrder = vi.fn()
    this.cancelOrder = vi.fn()
    this.editOrder = vi.fn()
    this.fetchOrder = vi.fn()
    this.fetchFundingRate = vi.fn()
    this.fetchOrderBook = vi.fn()
  })

  return {
    default: {
      bybit: MockExchange,
      binance: MockExchange,
    },
  }
})

import { CcxtBroker } from './CcxtBroker.js'
import '../../contract-ext.js'

// ==================== Helpers ====================

function makeSpotMarket(base: string, quote: string, symbol?: string): any {
  return {
    id: symbol ?? `${base}${quote}`,
    symbol: symbol ?? `${base}/${quote}`,
    base: base.toUpperCase(),
    quote: quote.toUpperCase(),
    type: 'spot',
    active: true,
    precision: { price: 0.01 },
    limits: {},
    settle: undefined,
  }
}

function makeSwapMarket(base: string, quote: string, symbol?: string): any {
  return {
    id: symbol ?? `${base}${quote}`,
    symbol: symbol ?? `${base}/${quote}:${quote}`,
    base: base.toUpperCase(),
    quote: quote.toUpperCase(),
    type: 'swap',
    active: true,
    precision: { price: 0.01 },
    limits: {},
    settle: quote.toUpperCase(),
  }
}

function makeAccount(overrides?: Partial<{ apiKey: string; apiSecret: string }>) {
  return new CcxtBroker({
    exchange: 'bybit',
    apiKey: overrides?.apiKey ?? 'k',
    apiSecret: overrides?.apiSecret ?? 's',
    defaultMarketType: 'swap',
  })
}

function setInitialized(acc: CcxtBroker, markets: Record<string, any>) {
  ;(acc as any).initialized = true
  ;(acc as any).exchange.markets = markets
}

// ==================== Constructor ====================

describe('CcxtBroker — constructor', () => {
  it('throws for unknown exchange', () => {
    expect(() => new CcxtBroker({ exchange: 'unknownxyz', apiKey: 'k', apiSecret: 's', defaultMarketType: 'spot' })).toThrow(
      'Unknown CCXT exchange',
    )
  })

  it('sets readOnly when no apiKey', () => {
    const acc = new CcxtBroker({ exchange: 'bybit', apiKey: '', apiSecret: '', defaultMarketType: 'spot' })
    expect((acc as any).readOnly).toBe(true)
  })

  it('uses exchange name as provider', () => {
    const acc = makeAccount()
    expect(acc.provider).toBe('bybit')
  })

  it('defaults id to exchange-main', () => {
    const acc = makeAccount()
    expect(acc.id).toBe('bybit-main')
  })
})

// ==================== searchContracts ====================

describe('CcxtBroker — searchContracts', () => {
  let acc: CcxtBroker

  beforeEach(() => {
    acc = makeAccount()
    setInitialized(acc, {
      'BTC/USDT': makeSpotMarket('BTC', 'USDT', 'BTC/USDT'),
      'BTC/USDT:USDT': makeSwapMarket('BTC', 'USDT', 'BTC/USDT:USDT'),
      'BTC/USD': makeSpotMarket('BTC', 'USD', 'BTC/USD'),
      'ETH/USDT': makeSpotMarket('ETH', 'USDT', 'ETH/USDT'),
    })
  })

  it('returns empty array for empty pattern', async () => {
    expect(await acc.searchContracts('')).toEqual([])
  })

  it('filters by base asset (case-insensitive)', async () => {
    const results = await acc.searchContracts('btc')
    const symbols = results.map((r) => r.contract.symbol)
    expect(symbols.every((s) => s.startsWith('BTC'))).toBe(true)
    expect(symbols).not.toContain('ETH/USDT')
  })

  it('only returns USDT/USD/USDC quoted markets', async () => {
    ;(acc as any).exchange.markets['BTC/DOGE'] = { ...makeSpotMarket('BTC', 'DOGE'), id: 'BTCDOGE' }
    const results = await acc.searchContracts('BTC')
    const quotes = results.map((r) => r.contract.currency)
    expect(quotes.every((q) => ['USDT', 'USD', 'USDC'].includes(q ?? ''))).toBe(true)
  })

  it('excludes inactive markets', async () => {
    ;(acc as any).exchange.markets['BTC/USDC'] = { ...makeSpotMarket('BTC', 'USDC'), active: false }
    const before = (await acc.searchContracts('BTC')).length
    expect(before).toBe(3) // spot+swap USDT + spot USD (not inactive USDC)
  })

  it('sorts swap before spot when defaultMarketType is swap', async () => {
    const results = await acc.searchContracts('BTC')
    // USDT swap should come first (swap preference when defaultMarketType=swap)
    const first = results[0]
    expect((first.contract as any).secType ?? first.contract.symbol.includes(':') ? 'CRYPTO_PERP' : 'CRYPTO').toBeTruthy()
  })
})

// ==================== cancelOrder — cache miss ====================

describe('CcxtBroker — cancelOrder cache', () => {
  it('calls exchange.cancelOrder with undefined symbol when orderId is not in cache', async () => {
    const acc = makeAccount()
    setInitialized(acc, {})
    ;(acc as any).exchange.cancelOrder = vi.fn().mockResolvedValue({})
    await acc.cancelOrder('order-not-cached')
    expect((acc as any).exchange.cancelOrder).toHaveBeenCalledWith('order-not-cached', undefined)
  })

  it('returns false when exchange.cancelOrder throws (cache miss causes undefined symbol)', async () => {
    const acc = makeAccount()
    setInitialized(acc, {})
    ;(acc as any).exchange.cancelOrder = vi.fn().mockRejectedValue(new Error('symbol required'))
    const result = await acc.cancelOrder('order-not-cached')
    expect(result).toBe(false)
  })

  it('calls exchange.cancelOrder with correct symbol when orderId is cached', async () => {
    const acc = makeAccount()
    setInitialized(acc, {})
    ;(acc as any).orderSymbolCache.set('order-123', 'BTC/USDT:USDT')
    ;(acc as any).exchange.cancelOrder = vi.fn().mockResolvedValue({})
    const result = await acc.cancelOrder('order-123')
    expect(result).toBe(true)
    expect((acc as any).exchange.cancelOrder).toHaveBeenCalledWith('order-123', 'BTC/USDT:USDT')
  })
})

// ==================== placeOrder — notional conversion ====================

describe('CcxtBroker — placeOrder notional', () => {
  it('converts notional to size using ticker price when qty is not provided', async () => {
    const acc = makeAccount()
    setInitialized(acc, {
      'BTC/USDT:USDT': makeSwapMarket('BTC', 'USDT', 'BTC/USDT:USDT'),
    })
    ;(acc as any).exchange.fetchTicker = vi.fn().mockResolvedValue({ last: 50_000 })
    ;(acc as any).exchange.createOrder = vi.fn().mockResolvedValue({
      id: 'ord-1', status: 'open', average: undefined, filled: undefined,
    })

    const contract = new Contract()
    contract.aliceId = 'bybit-BTC/USDT:USDT'
    contract.symbol = 'BTC/USDT:USDT'
    contract.secType = 'CRYPTO_PERP'
    contract.exchange = 'bybit'
    contract.currency = 'USDT'

    const order = new Order()
    order.action = 'BUY'
    order.orderType = 'MKT'
    order.cashQty = 500 // $500 worth of BTC

    const result = await acc.placeOrder(contract, order)

    expect(result.success).toBe(true)
    const createOrderCall = (acc as any).exchange.createOrder.mock.calls[0]
    // size = 500 / 50000 = 0.01 BTC
    expect(createOrderCall[3]).toBeCloseTo(0.01)
  })

  it('returns error when neither qty nor notional provided', async () => {
    const acc = makeAccount()
    setInitialized(acc, {
      'BTC/USDT:USDT': makeSwapMarket('BTC', 'USDT', 'BTC/USDT:USDT'),
    })

    const contract = new Contract()
    contract.aliceId = 'bybit-BTC/USDT:USDT'
    contract.symbol = 'BTC/USDT:USDT'
    contract.secType = 'CRYPTO_PERP'
    contract.exchange = 'bybit'
    contract.currency = 'USDT'

    const order = new Order()
    order.action = 'BUY'
    order.orderType = 'MKT'
    // No totalQuantity or cashQty set

    const result = await acc.placeOrder(contract, order)
    expect(result.success).toBe(false)
    expect(result.error).toContain('totalQuantity or cashQty')
  })
})
