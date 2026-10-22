import type { Account } from '@shared/usage/credits'

/** Accounts that can run sessions (Admin keys can't call the Messages API). */
export function launchAccounts(accounts: Account[] | undefined): Account[] {
  return (accounts ?? []).filter((a) => a.kind === 'standard')
}

/** 'subscription' or a standard account id; anything else falls back to the subscription. */
export function validBilling(value: string | undefined, accounts: Account[]): string {
  return value && launchAccounts(accounts).some((a) => a.id === value) ? value : 'subscription'
}
