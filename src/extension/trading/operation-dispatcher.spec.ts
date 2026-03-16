import { describe, it, expect, beforeEach } from 'vitest'
import Decimal from 'decimal.js'
import { Contract, Order, OrderState, UNSET_DOUBLE, UNSET_DECIMAL } from '@traderalice/ibkr'
import { createOperationDispatcher } from './operation-dispatcher.js'
import { MockBroker, makeContract, makePlaceOrderResult } from './__test__/mock-broker.js'
import type { Operation } from './git/types.js'
import './contract-ext.js'

describe('createOperationDispatcher', () => {
  let account: MockBroker
  let dispatch: (op: Operation) => Promise<unknown>

  beforeEach(() => {
    account = new MockBroker()
    dispatch = createOperationDispatcher(account)
  })

  // ==================== placeOrder ====================

  describe('placeOrder', () => {
    it('calls account.placeOrder with contract and order', async () => {
      const contract = makeContract({ symbol: 'AAPL' })
      const order = new Order()
      order.action = 'BUY'
      order.orderType = 'MKT'
      order.totalQuantity = new Decimal(10)
      order.tif = 'DAY'

      const op: Operation = { action: 'placeOrder', contract, order }

      const result = await dispatch(op) as Record<string, unknown>

      expect(account.placeOrder).toHaveBeenCalledTimes(1)
      const [passedContract, passedOrder] = account.placeOrder.mock.calls[0]
      expect(passedContract.symbol).toBe('AAPL')
      expect(passedOrder.action).toBe('BUY')
      expect(passedOrder.orderType).toBe('MKT')
      expect(passedOrder.totalQuantity.toNumber()).toBe(10)
      expect(result.success).toBe(true)
    })

    it('passes aliceId and extra contract fields', async () => {
      const contract = makeContract({
        aliceId: 'alpaca-AAPL',
        symbol: 'AAPL',
        secType: 'STK',
        currency: 'USD',
        exchange: 'NASDAQ',
      })
      const order = new Order()
      order.action = 'BUY'
      order.orderType = 'LMT'
      order.totalQuantity = new Decimal(5)
      order.lmtPrice = 150

      const op: Operation = { action: 'placeOrder', contract, order }

      await dispatch(op)

      const [passedContract, passedOrder] = account.placeOrder.mock.calls[0]
      expect(passedContract.aliceId).toBe('alpaca-AAPL')
      expect(passedContract.secType).toBe('STK')
      expect(passedContract.currency).toBe('USD')
      expect(passedContract.exchange).toBe('NASDAQ')
      expect(passedOrder.lmtPrice).toBe(150)
    })

    it('returns PlaceOrderResult on success', async () => {
      account.placeOrder.mockResolvedValue(makePlaceOrderResult({
        orderId: 'ord-123',
        execution: { avgPrice: 155, shares: 10 } as any,
        orderState: (() => { const os = new OrderState(); os.status = 'Filled'; return os })(),
      }))

      const contract = makeContract({ symbol: 'AAPL' })
      const order = new Order()
      order.action = 'BUY'
      order.orderType = 'MKT'
      order.totalQuantity = new Decimal(10)

      const op: Operation = { action: 'placeOrder', contract, order }

      const result = await dispatch(op) as Record<string, unknown>
      expect(result.success).toBe(true)
      expect(result.orderId).toBe('ord-123')
    })

    it('returns pending PlaceOrderResult when orderState is Submitted', async () => {
      account.placeOrder.mockResolvedValue(makePlaceOrderResult({
        orderId: 'ord-456',
        orderState: (() => { const os = new OrderState(); os.status = 'Submitted'; return os })(),
      }))

      const contract = makeContract({ symbol: 'AAPL' })
      const order = new Order()
      order.action = 'BUY'
      order.orderType = 'LMT'
      order.totalQuantity = new Decimal(10)
      order.lmtPrice = 140

      const op: Operation = { action: 'placeOrder', contract, order }

      const result = await dispatch(op) as Record<string, unknown>
      expect(result.success).toBe(true)
      expect(result.orderId).toBe('ord-456')
    })

    it('returns error on failure', async () => {
      account.placeOrder.mockResolvedValue({ success: false, error: 'Insufficient funds' })

      const contract = makeContract({ symbol: 'AAPL' })
      const order = new Order()
      order.action = 'BUY'
      order.orderType = 'MKT'
      order.totalQuantity = new Decimal(10)

      const op: Operation = { action: 'placeOrder', contract, order }

      const result = await dispatch(op) as Record<string, unknown>
      expect(result.success).toBe(false)
      expect(result.error).toBe('Insufficient funds')
    })
  })

  // ==================== closePosition ====================

  describe('closePosition', () => {
    it('calls account.closePosition with contract and optional qty', async () => {
      const contract = makeContract({ symbol: 'AAPL' })
      const op: Operation = {
        action: 'closePosition',
        contract,
        quantity: new Decimal(5),
      }

      await dispatch(op)

      expect(account.closePosition).toHaveBeenCalledTimes(1)
      const [passedContract, qty] = account.closePosition.mock.calls[0]
      expect(passedContract.symbol).toBe('AAPL')
      expect(qty.toNumber()).toBe(5)
    })

    it('passes undefined qty for full close', async () => {
      const contract = makeContract({ symbol: 'AAPL' })
      const op: Operation = {
        action: 'closePosition',
        contract,
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
        orderId: 'ord-789',
      }

      const result = await dispatch(op)

      expect(account.cancelOrder).toHaveBeenCalledWith('ord-789', undefined)
      expect(result).toBe(true)
    })

    it('returns false on cancel failure', async () => {
      account.cancelOrder.mockResolvedValue(false)

      const op: Operation = {
        action: 'cancelOrder',
        orderId: 'ord-789',
      }

      const result = await dispatch(op)
      expect(result).toBe(false)
    })
  })

  // ==================== modifyOrder ====================

  describe('modifyOrder', () => {
    it('calls account.modifyOrder with orderId and changes', async () => {
      const changes: Partial<Order> = { lmtPrice: 155, totalQuantity: new Decimal(20) } as any
      const op: Operation = {
        action: 'modifyOrder',
        orderId: 'ord-123',
        changes,
      }

      const result = await dispatch(op) as Record<string, unknown>

      expect(account.modifyOrder).toHaveBeenCalledTimes(1)
      const [orderId, passedChanges] = account.modifyOrder.mock.calls[0]
      expect(orderId).toBe('ord-123')
      expect(passedChanges.lmtPrice).toBe(155)
      expect(result.success).toBe(true)
    })

    it('returns PlaceOrderResult on success', async () => {
      account.modifyOrder.mockResolvedValue(makePlaceOrderResult({
        orderId: 'ord-123',
        orderState: (() => { const os = new OrderState(); os.status = 'Submitted'; return os })(),
      }))

      const op: Operation = {
        action: 'modifyOrder',
        orderId: 'ord-123',
        changes: { lmtPrice: 160 } as Partial<Order>,
      }

      const result = await dispatch(op) as Record<string, unknown>
      expect(result.success).toBe(true)
      expect(result.orderId).toBe('ord-123')
    })

    it('returns error on failure', async () => {
      account.modifyOrder.mockResolvedValue({ success: false, error: 'Order not found' })

      const op: Operation = {
        action: 'modifyOrder',
        orderId: 'ord-999',
        changes: { lmtPrice: 100 } as Partial<Order>,
      }

      const result = await dispatch(op) as Record<string, unknown>
      expect(result.success).toBe(false)
      expect(result.error).toBe('Order not found')
    })
  })

  // ==================== unknown action ====================

  describe('unknown action', () => {
    it('throws for unknown operation action', async () => {
      const op = {
        action: 'somethingWeird' as never,
      } as Operation

      await expect(dispatch(op)).rejects.toThrow('Unknown operation action')
    })
  })
})
