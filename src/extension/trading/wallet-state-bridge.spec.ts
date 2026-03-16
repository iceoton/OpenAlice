import { describe, it, expect, beforeEach } from 'vitest'
import { Contract, Order, OrderState } from '@traderalice/ibkr'
import Decimal from 'decimal.js'
import { createWalletStateBridge } from './wallet-state-bridge.js'
import { MockBroker, makePosition, makeOpenOrder } from './__test__/mock-broker.js'
import './contract-ext.js'

describe('createWalletStateBridge', () => {
  let account: MockBroker

  beforeEach(() => {
    account = new MockBroker()
  })

  it('returns a function', () => {
    const bridge = createWalletStateBridge(account)
    expect(typeof bridge).toBe('function')
  })

  it('assembles GitState from account data', async () => {
    account.setAccountInfo({ totalCashValue: 50_000, netLiquidation: 55_000, unrealizedPnL: 3_000, realizedPnL: 800 })
    account.setPositions([makePosition()])

    const filledState = new OrderState()
    filledState.status = 'Filled'
    const submittedState = new OrderState()
    submittedState.status = 'Submitted'
    const cancelledState = new OrderState()
    cancelledState.status = 'Cancelled'

    account.setOrders([
      makeOpenOrder({ orderState: filledState }),
      makeOpenOrder({ orderState: submittedState }),
      makeOpenOrder({ orderState: cancelledState }),
    ])

    const bridge = createWalletStateBridge(account)
    const state = await bridge()

    expect(state.totalCashValue).toBe(50_000)
    expect(state.netLiquidation).toBe(55_000)
    expect(state.unrealizedPnL).toBe(3_000)
    expect(state.realizedPnL).toBe(800)
    expect(state.positions).toHaveLength(1)
    // Only Submitted/PreSubmitted orders are pending
    expect(state.pendingOrders).toHaveLength(1)
    expect(state.pendingOrders[0].orderState.status).toBe('Submitted')
  })

  it('calls all three account methods in parallel', async () => {
    const bridge = createWalletStateBridge(account)
    await bridge()

    expect(account.getAccount).toHaveBeenCalledTimes(1)
    expect(account.getPositions).toHaveBeenCalledTimes(1)
    expect(account.getOrders).toHaveBeenCalledTimes(1)
  })

  it('returns empty pendingOrders when no orders are pending', async () => {
    const filledState = new OrderState()
    filledState.status = 'Filled'
    const cancelledState = new OrderState()
    cancelledState.status = 'Cancelled'

    account.setOrders([
      makeOpenOrder({ orderState: filledState }),
      makeOpenOrder({ orderState: cancelledState }),
    ])

    const bridge = createWalletStateBridge(account)
    const state = await bridge()

    expect(state.pendingOrders).toHaveLength(0)
  })
})
