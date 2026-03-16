/**
 * Unified Wallet State Bridge
 *
 * IBroker → GitState assembly.
 * Used as the TradingGitConfig.getGitState callback.
 */

import type { IBroker } from './interfaces.js'
import type { GitState } from './git/types.js'

export function createWalletStateBridge(account: IBroker) {
  return async (): Promise<GitState> => {
    const [accountInfo, positions, orders] = await Promise.all([
      account.getAccount(),
      account.getPositions(),
      account.getOrders(),
    ])

    return {
      netLiquidation: accountInfo.netLiquidation,
      totalCashValue: accountInfo.totalCashValue,
      unrealizedPnL: accountInfo.unrealizedPnL,
      realizedPnL: accountInfo.realizedPnL,
      positions,
      pendingOrders: orders.filter(o => o.orderState.status === 'Submitted' || o.orderState.status === 'PreSubmitted'),
    }
  }
}
