import type { Account, CreditsState } from '@shared/usage/credits'

/** Accounts that can run sessions (Admin keys can't call the Messages API). */
export function launchAccounts(accounts: Account[] | undefined): Account[] {
  return (accounts ?? []).filter((a) => a.kind === 'standard')
}

/** 'subscription' or a standard account id; anything else falls back to the subscription. */
export function validBilling(value: string | undefined, accounts: Account[]): string {
  return value && launchAccounts(accounts).some((a) => a.id === value) ? value : 'subscription'
}

/**
 * Shown instead of the API credits card when there's nothing to track yet:
 * no API key, or a key without a credit grant (and no API spending). Null
 * when the credits card has something to show.
 */
export function creditsEmptyText(credits: CreditsState | null | undefined): string | null {
  if (!credits) return null
  if (credits.summaries.some((s) => s.granted > 0 || s.spent > 0)) return null
  const hasKey = credits.accounts.some((a) => a.kind === 'standard')
  return hasKey
    ? 'Track API credits: add the amount you have'
    : 'Track API credits: add a key and the amount you have'
}
