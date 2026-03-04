import { describe, it, expect, beforeEach } from 'vitest'
import { createOperationDispatcher } from './operation-dispatcher.js'
import { MockTradingAccount, makeOrderResult } from './__test__/mock-account.js'
import type { Operation } from './git/types.js'

describe('createOperationDispatcher', () => {
  let account: MockTradingAccount
  let dispatch: (op: Operation) => Promise<unknown>

  beforeEach(() => {
    account = new MockTradingAccount()
    dispatch = createOperationDispatcher(account)
  })

  // ==================== placeOrder ====================

  describe('placeOrder', () => {
    it('calls account.placeOrder with constructed contract and order params', async () => {
      const op: Operation = {
        action: 'placeOrder',
        params: {
          symbol: 'AAPL',
          side: 'buy',
          type: 'market',
          qty: 10,
          timeInForce: 'day',
        },
      }

      const result = await dispatch(op) as Record<string, unknown>

      expect(account.placeOrder).toHaveBeenCalledTimes(1)
      const call = account.placeOrder.mock.calls[0][0]
      expect(call.contract.symbol).toBe('AAPL')
      expect(call.side).toBe('buy')
      expect(call.type).toBe('market')
      expect(call.qty).toBe(10)
      expect(result.success).toBe(true)
    })

    it('passes aliceId and extra contract fields', async () => {
      const op: Operation = {
        action: 'placeOrder',
        params: {
          aliceId: 'alpaca-AAPL',
          symbol: 'AAPL',
          secType: 'STK',
          currency: 'USD',
          exchange: 'NASDAQ',
          side: 'buy',
          type: 'limit',
          qty: 5,
          price: 150,
        },
      }

      await dispatch(op)

      const call = account.placeOrder.mock.calls[0][0]
      expect(call.contract.aliceId).toBe('alpaca-AAPL')
      expect(call.contract.secType).toBe('STK')
      expect(call.contract.currency).toBe('USD')
      expect(call.contract.exchange).toBe('NASDAQ')
      expect(call.price).toBe(150)
    })

    it('returns order info on success with filled status', async () => {
      account.placeOrder.mockResolvedValue(makeOrderResult({
        orderId: 'ord-123',
        filledPrice: 155,
        filledQty: 10,
      }))

      const op: Operation = {
        action: 'placeOrder',
        params: { symbol: 'AAPL', side: 'buy', type: 'market', qty: 10 },
      }

      const result = await dispatch(op) as Record<string, unknown>
      expect(result.success).toBe(true)
      const order = result.order as Record<string, unknown>
      expect(order.id).toBe('ord-123')
      expect(order.status).toBe('filled')
      expect(order.filledPrice).toBe(155)
    })

    it('returns pending status when no filledPrice', async () => {
      account.placeOrder.mockResolvedValue(makeOrderResult({
        orderId: 'ord-456',
        filledPrice: undefined,
        filledQty: undefined,
      }))

      const op: Operation = {
        action: 'placeOrder',
        params: { symbol: 'AAPL', side: 'buy', type: 'limit', qty: 10, price: 140 },
      }

      const result = await dispatch(op) as Record<string, unknown>
      const order = result.order as Record<string, unknown>
      expect(order.status).toBe('pending')
    })

    it('returns error on failure', async () => {
      account.placeOrder.mockResolvedValue({ success: false, error: 'Insufficient funds' })

      const op: Operation = {
        action: 'placeOrder',
        params: { symbol: 'AAPL', side: 'buy', type: 'market', qty: 10 },
      }

      const result = await dispatch(op) as Record<string, unknown>
      expect(result.success).toBe(false)
      expect(result.error).toBe('Insufficient funds')
      expect(result.order).toBeUndefined()
    })
  })

  // ==================== closePosition ====================

  describe('closePosition', () => {
    it('calls account.closePosition with contract and optional qty', async () => {
      const op: Operation = {
        action: 'closePosition',
        params: { symbol: 'AAPL', qty: 5 },
      }

      await dispatch(op)

      expect(account.closePosition).toHaveBeenCalledTimes(1)
      const [contract, qty] = account.closePosition.mock.calls[0]
      expect(contract.symbol).toBe('AAPL')
      expect(qty).toBe(5)
    })

    it('passes undefined qty for full close', async () => {
      const op: Operation = {
        action: 'closePosition',
        params: { symbol: 'AAPL' },
      }

      await dispatch(op)

      const [, qty] = account.closePosition.mock.calls[0]
      expect(qty).toBeUndefined()
    })
  })

  // ==================== cancelOrder ====================

  describe('cancelOrder', () => {
    it('calls account.cancelOrder and returns success', async () => {
      const op: Operation = {
        action: 'cancelOrder',
        params: { orderId: 'ord-789' },
      }

      const result = await dispatch(op) as Record<string, unknown>

      expect(account.cancelOrder).toHaveBeenCalledWith('ord-789')
      expect(result.success).toBe(true)
    })

    it('returns error message on cancel failure', async () => {
      account.cancelOrder.mockResolvedValue(false)

      const op: Operation = {
        action: 'cancelOrder',
        params: { orderId: 'ord-789' },
      }

      const result = await dispatch(op) as Record<string, unknown>
      expect(result.success).toBe(false)
      expect(result.error).toContain('Failed to cancel')
    })
  })

  // ==================== modifyOrder ====================

  describe('modifyOrder', () => {
    it('calls account.modifyOrder with orderId and changes', async () => {
      const op: Operation = {
        action: 'modifyOrder',
        params: { orderId: 'ord-123', price: 155, qty: 20 },
      }

      const result = await dispatch(op) as Record<string, unknown>

      expect(account.modifyOrder).toHaveBeenCalledTimes(1)
      const [orderId, changes] = account.modifyOrder.mock.calls[0]
      expect(orderId).toBe('ord-123')
      expect(changes.price).toBe(155)
      expect(changes.qty).toBe(20)
      expect(result.success).toBe(true)
    })

    it('returns order info on success', async () => {
      account.modifyOrder.mockResolvedValue(makeOrderResult({
        orderId: 'ord-123',
        filledPrice: undefined,
        filledQty: undefined,
      }))

      const op: Operation = {
        action: 'modifyOrder',
        params: { orderId: 'ord-123', price: 160 },
      }

      const result = await dispatch(op) as Record<string, unknown>
      expect(result.success).toBe(true)
      const order = result.order as Record<string, unknown>
      expect(order.id).toBe('ord-123')
      expect(order.status).toBe('pending')
    })

    it('returns error on failure', async () => {
      account.modifyOrder.mockResolvedValue({ success: false, error: 'Order not found' })

      const op: Operation = {
        action: 'modifyOrder',
        params: { orderId: 'ord-999', price: 100 },
      }

      const result = await dispatch(op) as Record<string, unknown>
      expect(result.success).toBe(false)
      expect(result.error).toBe('Order not found')
      expect(result.order).toBeUndefined()
    })
  })

  // ==================== unknown action ====================

  describe('unknown action', () => {
    it('throws for unknown operation action', async () => {
      const op: Operation = {
        action: 'syncOrders' as never,
        params: {},
      }

      await expect(dispatch(op)).rejects.toThrow('Unknown operation action')
    })
  })
})
