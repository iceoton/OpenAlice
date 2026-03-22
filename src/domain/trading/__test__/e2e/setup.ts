/**
 * E2E test setup — shared, lazily-initialized broker instances.
 *
 * Uses the same code path as main.ts: readAccountsConfig → createBroker.
 * Only selects accounts on sandbox/paper/demoTrading platforms.
 *
 * Singleton: first call loads config + inits all brokers. Subsequent calls
 * return the same instances. Requires fileParallelism: false in vitest config.
 */

import { readAccountsConfig } from '@/core/config.js'
import type { IBroker } from '../../brokers/types.js'
import { createBroker } from '../../brokers/factory.js'

export interface TestAccount {
  id: string
  label: string
  provider: 'ccxt' | 'alpaca'
  broker: IBroker
}

// ==================== Lazy singleton ====================

let cached: Promise<TestAccount[]> | null = null

/**
 * Get initialized test accounts. First call loads config + inits brokers.
 * Subsequent calls return the same instances (module-level cache).
 */
export function getTestAccounts(): Promise<TestAccount[]> {
  if (!cached) cached = initAll()
  return cached
}

async function initAll(): Promise<TestAccount[]> {
  const accounts = await readAccountsConfig()
  const result: TestAccount[] = []

  for (const acct of accounts) {
    const isSafe =
      (acct.type === 'ccxt' && (acct.sandbox || acct.demoTrading)) ||
      (acct.type === 'alpaca' && acct.paper)
    if (!isSafe) continue
    if (!acct.apiKey) continue

    const broker = createBroker(acct)

    try {
      await broker.init()
    } catch (err) {
      console.warn(`e2e setup: ${acct.id} init failed, skipping:`, err)
      continue
    }

    result.push({
      id: acct.id,
      label: acct.label ?? acct.id,
      provider: acct.type,
      broker,
    })
  }

  return result
}

/** Filter test accounts by provider type. */
export function filterByProvider(accounts: TestAccount[], provider: 'ccxt' | 'alpaca'): TestAccount[] {
  return accounts.filter(a => a.provider === provider)
}
