import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

export const isMac = navigator.userAgent.includes('Mac')
export const MOD = isMac ? '⌘' : 'Ctrl'
