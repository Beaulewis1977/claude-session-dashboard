// Generic icons for each coding agent (no product logos).

import { Hexagon, Sparkle, type LucideIcon } from 'lucide-react'
import type { ProviderId } from '@shared/provider'

export const PROVIDER_ICON: Record<ProviderId, LucideIcon> = {
  claude: Sparkle,
  codex: Hexagon
}
