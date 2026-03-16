import { describe, it, expect, vi, beforeEach } from 'vitest'
import Decimal from 'decimal.js'
import { Contract, Order } from '@traderalice/ibkr'
import { wireAccountTrading, createAlpacaFromConfig, createCcxtFromConfig } from './factory.js'
import { MockBroker, makeContract, makePlaceOrderResult } from './__test__/mock-broker.js'
import type { Operation } from './git/types.js'
import './contract-ext.js'

vi.mock('./providers/alpaca/index.js', () => ({
  AlpacaBroker: vi.fn(function (this: any, cfg: unknown) { this._config = cfg; this.id = 'alpaca-mock'; this.provider = 'alpaca' }),
}))

vi.mock('./providers/ccxt/index.js', () => ({
  CcxtBroker: vi.fn(function (this: any, cfg: unknown) { this._config = cfg; this.id = 'ccxt-mock'; this.provider = 'ccxt' }),
}))

function makeBuyOp(symbol = 'AAPL'): Operation {
  const contract = makeContract({ symbol })
  const order = new Order()
  order.action = 'BUY'
  order.orderType = 'MKT'
  order.totalQuantity = new Decimal(10)
  return { action: 'placeOrder', contract, order }
}

describe('wireAccountTrading', () => {
  let account: MockBroker

  beforeEach(() => {
    account = new MockBroker()
  })

  it('returns AccountSetup with account, git, and getGitState', () => {
    const setup = wireAccountTrading(account, {})

    expect(setup.account).toBe(account)
    expect(setup.git).toBeDefined()
    expect(typeof setup.getGitState).toBe('function')
  })

  it('creates a functional git that can add/commit/push', async () => {
    account.placeOrder.mockResolvedValue(makePlaceOrderResult())

    const { git } = wireAccountTrading(account, {})

    git.add(makeBuyOp())
    git.commit('Buy AAPL')
    const result = await git.push()

    expect(result.operationCount).toBe(1)
    expect(account.placeOrder).toHaveBeenCalled()
  })

  it('wires guards that can reject operations', async () => {
    const { git } = wireAccountTrading(account, {
      guards: [{ type: 'symbol-whitelist', options: { symbols: ['GOOG'] } }],
    })

    git.add(makeBuyOp('AAPL'))
    git.commit('Should be blocked')
    const result = await git.push()

    // Guard should reject AAPL (not in whitelist)
    expect(result.rejected).toHaveLength(1)
    expect(account.placeOrder).not.toHaveBeenCalled()
  })

  it('calls onCommit callback after push', async () => {
    const onCommit = vi.fn()
    account.placeOrder.mockResolvedValue(makePlaceOrderResult())

    const { git } = wireAccountTrading(account, { onCommit })

    git.add(makeBuyOp())
    git.commit('Buy')
    await git.push()

    expect(onCommit).toHaveBeenCalledTimes(1)
    const state = onCommit.mock.calls[0][0]
    expect(state.commits).toHaveLength(1)
  })

  it('restores from saved state', async () => {
    account.placeOrder.mockResolvedValue(makePlaceOrderResult())

    // Create initial state
    const { git: git1 } = wireAccountTrading(account, {})
    git1.add(makeBuyOp())
    git1.commit('First trade')
    await git1.push()
    const savedState = git1.exportState()

    // Restore
    const { git: git2 } = wireAccountTrading(account, { savedState })
    expect(git2.status().commitCount).toBe(1)
    expect(git2.log()[0].message).toBe('First trade')
  })

  it('getGitState returns state from account', async () => {
    const { getGitState } = wireAccountTrading(account, {})
    const state = await getGitState()

    expect(state.totalCashValue).toBe(100_000)
    expect(state.netLiquidation).toBe(105_000)
    expect(account.getAccount).toHaveBeenCalled()
    expect(account.getPositions).toHaveBeenCalled()
    expect(account.getOrders).toHaveBeenCalled()
  })
})

// ==================== createAlpacaFromConfig ====================

describe('createAlpacaFromConfig', () => {
  it('returns null when provider.type is none', () => {
    const result = createAlpacaFromConfig({ provider: { type: 'none' } } as any)
    expect(result).toBeNull()
  })

  it('returns AlpacaBroker instance when provider.type is alpaca', () => {
    const result = createAlpacaFromConfig({
      provider: { type: 'alpaca', apiKey: 'key123', secretKey: 'secret456', paper: true },
    } as any)
    expect(result).not.toBeNull()
    expect((result as any)._config).toMatchObject({ apiKey: 'key123', secretKey: 'secret456', paper: true })
  })

  it('passes empty strings for missing apiKey/secretKey', () => {
    const result = createAlpacaFromConfig({
      provider: { type: 'alpaca', paper: false },
    } as any)
    expect((result as any)._config.apiKey).toBe('')
    expect((result as any)._config.secretKey).toBe('')
  })
})

// ==================== createCcxtFromConfig ====================

describe('createCcxtFromConfig', () => {
  it('returns null when provider.type is none', () => {
    const result = createCcxtFromConfig({ provider: { type: 'none' } } as any)
    expect(result).toBeNull()
  })

  it('returns CcxtBroker instance with exchange config', () => {
    const result = createCcxtFromConfig({
      provider: {
        type: 'bybit',
        exchange: 'bybit',
        apiKey: 'k',
        apiSecret: 's',
        sandbox: true,
        demoTrading: false,
        defaultMarketType: 'swap',
      },
    } as any)
    expect(result).not.toBeNull()
    expect((result as any)._config).toMatchObject({ exchange: 'bybit', sandbox: true })
  })

  it('passes empty strings for missing apiKey/apiSecret', () => {
    const result = createCcxtFromConfig({
      provider: { type: 'bybit', exchange: 'bybit' },
    } as any)
    expect((result as any)._config.apiKey).toBe('')
    expect((result as any)._config.apiSecret).toBe('')
  })
})
