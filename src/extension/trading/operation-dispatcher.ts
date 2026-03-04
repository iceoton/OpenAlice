/**
 * Unified Operation Dispatcher
 *
 * Bridges TradingGit's Operation → ITradingAccount method calls.
 * Used as the TradingGitConfig.executeOperation callback.
 *
 * Return values match the structure expected by TradingGit.parseOperationResult:
 * - placeOrder/modifyOrder/closePosition: { success, order?: { id, status, filledPrice, filledQty } }
 * - cancelOrder: { success, error? }
 */

import type { Contract } from './contract.js'
import type { ITradingAccount, OrderType, TimeInForce, OrderRequest } from './interfaces.js'
import type { Operation } from './git/types.js'

export function createOperationDispatcher(account: ITradingAccount) {
  return async (op: Operation): Promise<unknown> => {
    switch (op.action) {
      case 'placeOrder': {
        const contract: Partial<Contract> = {}
        if (op.params.aliceId) contract.aliceId = op.params.aliceId as string
        if (op.params.symbol) contract.symbol = op.params.symbol as string
        if (op.params.secType) contract.secType = op.params.secType as Contract['secType']
        if (op.params.currency) contract.currency = op.params.currency as string
        if (op.params.exchange) contract.exchange = op.params.exchange as string

        const result = await account.placeOrder({
          contract: contract as Contract,
          side: op.params.side as 'buy' | 'sell',
          type: op.params.type as OrderType,
          qty: op.params.qty as number | undefined,
          notional: op.params.notional as number | undefined,
          price: op.params.price as number | undefined,
          stopPrice: op.params.stopPrice as number | undefined,
          trailingAmount: op.params.trailingAmount as number | undefined,
          trailingPercent: op.params.trailingPercent as number | undefined,
          reduceOnly: op.params.reduceOnly as boolean | undefined,
          timeInForce: (op.params.timeInForce as TimeInForce) ?? 'day',
          goodTillDate: op.params.goodTillDate as string | undefined,
          extendedHours: op.params.extendedHours as boolean | undefined,
          parentId: op.params.parentId as string | undefined,
          ocaGroup: op.params.ocaGroup as string | undefined,
        })

        return {
          success: result.success,
          error: result.error,
          order: result.success
            ? {
                id: result.orderId,
                status: result.filledPrice ? 'filled' : 'pending',
                filledPrice: result.filledPrice,
                filledQty: result.filledQty,
              }
            : undefined,
        }
      }

      case 'modifyOrder': {
        const orderId = op.params.orderId as string
        const changes: Partial<OrderRequest> = {}
        if (op.params.qty != null) changes.qty = op.params.qty as number
        if (op.params.price != null) changes.price = op.params.price as number
        if (op.params.stopPrice != null) changes.stopPrice = op.params.stopPrice as number
        if (op.params.trailingAmount != null) changes.trailingAmount = op.params.trailingAmount as number
        if (op.params.trailingPercent != null) changes.trailingPercent = op.params.trailingPercent as number
        if (op.params.type) changes.type = op.params.type as OrderType
        if (op.params.timeInForce) changes.timeInForce = op.params.timeInForce as TimeInForce
        if (op.params.goodTillDate) changes.goodTillDate = op.params.goodTillDate as string

        const result = await account.modifyOrder(orderId, changes)

        return {
          success: result.success,
          error: result.error,
          order: result.success
            ? {
                id: result.orderId,
                status: result.filledPrice ? 'filled' : 'pending',
                filledPrice: result.filledPrice,
                filledQty: result.filledQty,
              }
            : undefined,
        }
      }

      case 'closePosition': {
        const contract: Partial<Contract> = {}
        if (op.params.aliceId) contract.aliceId = op.params.aliceId as string
        if (op.params.symbol) contract.symbol = op.params.symbol as string
        if (op.params.secType) contract.secType = op.params.secType as Contract['secType']

        const qty = op.params.qty as number | undefined
        const result = await account.closePosition(contract as Contract, qty)

        return {
          success: result.success,
          error: result.error,
          order: result.success
            ? {
                id: result.orderId,
                status: result.filledPrice ? 'filled' : 'pending',
                filledPrice: result.filledPrice,
                filledQty: result.filledQty,
              }
            : undefined,
        }
      }

      case 'cancelOrder': {
        const orderId = op.params.orderId as string
        const success = await account.cancelOrder(orderId)
        return { success, error: success ? undefined : 'Failed to cancel order' }
      }

      default:
        throw new Error(`Unknown operation action: ${op.action}`)
    }
  }
}
