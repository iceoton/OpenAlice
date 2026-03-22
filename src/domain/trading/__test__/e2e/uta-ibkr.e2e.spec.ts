/**
 * UTA — IBKR paper lifecycle e2e.
 *
 * Two groups:
 * - Order lifecycle (any time): limit order stage → commit → push → cancel
 * - Full fill flow (market hours): market order → fill → verify → close
 *
 * Run: pnpm test:e2e
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { getTestAccounts, filterByProvider } from './setup.js'
import { UnifiedTradingAccount } from '../../UnifiedTradingAccount.js'
import type { IBroker } from '../../brokers/types.js'
import '../../contract-ext.js'

let broker: IBroker | null = null
let marketOpen = false

beforeAll(async () => {
  const all = await getTestAccounts()
  const ibkr = filterByProvider(all, 'ibkr')[0]
  if (!ibkr) return
  broker = ibkr.broker
  const clock = await broker.getMarketClock()
  marketOpen = clock.isOpen
  console.log(`UTA IBKR: market ${marketOpen ? 'OPEN' : 'CLOSED'}`)
}, 60_000)

// ==================== Order lifecycle (any time) ====================

describe('UTA — IBKR order lifecycle', () => {
  beforeEach(({ skip }) => { if (!broker) skip('no IBKR paper account') })

  it('limit order: stage → commit → push → cancel', async () => {
    const uta = new UnifiedTradingAccount(broker!)

    // Stage a limit buy at $1 (won't fill)
    const addResult = uta.stagePlaceOrder({
      aliceId: `${uta.id}|AAPL`,
      symbol: 'AAPL',
      side: 'buy',
      type: 'limit',
      price: 1.00,
      qty: 1,
      timeInForce: 'gtc',
    })
    expect(addResult.staged).toBe(true)

    const commitResult = uta.commit('e2e: limit buy 1 AAPL @ $1')
    expect(commitResult.prepared).toBe(true)
    console.log(`  committed: hash=${commitResult.hash}`)

    const pushResult = await uta.push()
    console.log(`  pushed: submitted=${pushResult.submitted.length}, status=${pushResult.submitted[0]?.status}`)
    expect(pushResult.submitted).toHaveLength(1)
    expect(pushResult.rejected).toHaveLength(0)
    expect(pushResult.submitted[0].orderId).toBeDefined()

    const orderId = pushResult.submitted[0].orderId!

    // Cancel the order
    uta.stageCancelOrder({ orderId })
    uta.commit('e2e: cancel limit order')
    const cancelPush = await uta.push()
    console.log(`  cancel pushed: submitted=${cancelPush.submitted.length}, status=${cancelPush.submitted[0]?.status}`)
    expect(cancelPush.submitted).toHaveLength(1)

    // Verify log has 2 commits
    expect(uta.log().length).toBeGreaterThanOrEqual(2)
  }, 30_000)
})

// ==================== Full fill flow (market hours only) ====================

describe('UTA — IBKR fill flow (AAPL)', () => {
  beforeEach(({ skip }) => {
    if (!broker) skip('no IBKR paper account')
    if (!marketOpen) skip('market closed')
  })

  it('buy → sync → verify → close → sync → verify', async () => {
    const uta = new UnifiedTradingAccount(broker!)

    // Record initial state
    const initialPositions = await broker!.getPositions()
    const initialAaplQty = initialPositions.find(p => p.contract.symbol === 'AAPL')?.quantity.toNumber() ?? 0
    console.log(`  initial AAPL qty=${initialAaplQty}`)

    // === Stage + Commit + Push: buy 1 AAPL ===
    const addResult = uta.stagePlaceOrder({
      aliceId: `${uta.id}|AAPL`,
      symbol: 'AAPL',
      side: 'buy',
      type: 'market',
      qty: 1,
    })
    expect(addResult.staged).toBe(true)

    const commitResult = uta.commit('e2e: buy 1 AAPL')
    expect(commitResult.prepared).toBe(true)
    console.log(`  committed: hash=${commitResult.hash}`)

    const pushResult = await uta.push()
    console.log(`  pushed: submitted=${pushResult.submitted.length}, status=${pushResult.submitted[0]?.status}`)
    expect(pushResult.submitted).toHaveLength(1)
    expect(pushResult.rejected).toHaveLength(0)
    expect(pushResult.submitted[0].orderId).toBeDefined()

    // === Sync: depends on whether fill was synchronous ===
    if (pushResult.submitted[0].status === 'submitted') {
      const sync1 = await uta.sync({ delayMs: 3000 })
      console.log(`  sync1: updatedCount=${sync1.updatedCount}`)
      expect(sync1.updatedCount).toBe(1)
      expect(sync1.updates[0].currentStatus).toBe('filled')
    } else {
      console.log(`  sync1: skipped (already ${pushResult.submitted[0].status} at push time)`)
    }

    // === Verify: position exists ===
    const state1 = await uta.getState()
    const aaplPos = state1.positions.find(p => p.contract.symbol === 'AAPL')
    expect(aaplPos).toBeDefined()
    expect(aaplPos!.quantity.toNumber()).toBe(initialAaplQty + 1)

    // === Close 1 AAPL ===
    uta.stageClosePosition({ aliceId: `${uta.id}|AAPL`, qty: 1 })
    uta.commit('e2e: close 1 AAPL')
    const closePush = await uta.push()
    console.log(`  close pushed: status=${closePush.submitted[0]?.status}`)
    expect(closePush.submitted).toHaveLength(1)

    if (closePush.submitted[0].status === 'submitted') {
      const sync2 = await uta.sync({ delayMs: 3000 })
      expect(sync2.updatedCount).toBe(1)
    }

    // === Verify: position back to initial ===
    const finalPositions = await broker!.getPositions()
    const finalAaplQty = finalPositions.find(p => p.contract.symbol === 'AAPL')?.quantity.toNumber() ?? 0
    expect(finalAaplQty).toBe(initialAaplQty)

    expect(uta.log().length).toBeGreaterThanOrEqual(2)
  }, 60_000)
})
