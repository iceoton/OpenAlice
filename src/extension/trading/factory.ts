/**
 * Trading Account Factory
 *
 * Wires an IBroker with TradingGit, guards, and operation dispatcher.
 * Also provides config-to-account creation helpers.
 */

import type { IBroker } from './interfaces.js'
import './contract-ext.js'
import type { ITradingGit } from './git/interfaces.js'
import type { GitExportState, GitState } from './git/types.js'
import { TradingGit } from './git/TradingGit.js'
import { createOperationDispatcher } from './operation-dispatcher.js'
import { createWalletStateBridge } from './wallet-state-bridge.js'
import { createGuardPipeline, resolveGuards } from './guards/index.js'
import { AlpacaBroker } from './providers/alpaca/index.js'
import { CcxtBroker } from './providers/ccxt/index.js'
import type { Config } from '../../core/config.js'

// ==================== AccountSetup ====================

export interface AccountSetup {
  account: IBroker
  git: ITradingGit
  getGitState: () => Promise<GitState>
}

// ==================== Wiring ====================

/**
 * Wire an IBroker with TradingGit + guards + dispatcher.
 * Does NOT call account.init() — caller is responsible for lifecycle.
 */
export function wireAccountTrading(
  account: IBroker,
  options: {
    guards?: Array<{ type: string; options?: Record<string, unknown> }>
    savedState?: GitExportState
    onCommit?: (state: GitExportState) => void | Promise<void>
  },
): AccountSetup {
  const getGitState = createWalletStateBridge(account)
  const dispatcher = createOperationDispatcher(account)
  const guards = resolveGuards(options.guards ?? [])
  const guardedDispatcher = createGuardPipeline(dispatcher, account, guards)

  const git = options.savedState
    ? TradingGit.restore(options.savedState, {
        executeOperation: guardedDispatcher,
        getGitState,
        onCommit: options.onCommit,
      })
    : new TradingGit({
        executeOperation: guardedDispatcher,
        getGitState,
        onCommit: options.onCommit,
      })

  return { account, git, getGitState }
}

// ==================== Config → Account helpers ====================

/**
 * Create an AlpacaBroker from securities config section.
 * Returns null if provider type is 'none'.
 */
export function createAlpacaFromConfig(
  config: Config['securities'],
): AlpacaBroker | null {
  if (config.provider.type === 'none') return null
  const { apiKey, secretKey, paper } = config.provider
  return new AlpacaBroker({
    apiKey: apiKey ?? '',
    secretKey: secretKey ?? '',
    paper,
  })
}

/**
 * Create a CcxtBroker from crypto config section.
 * Returns null if provider type is 'none'.
 */
export function createCcxtFromConfig(
  config: Config['crypto'],
): CcxtBroker | null {
  if (config.provider.type === 'none') return null
  const p = config.provider
  return new CcxtBroker({
    exchange: p.exchange,
    apiKey: p.apiKey ?? '',
    apiSecret: p.apiSecret ?? '',
    password: p.password,
    sandbox: p.sandbox,
    demoTrading: p.demoTrading,
    defaultMarketType: p.defaultMarketType,
    options: p.options,
  })
}
