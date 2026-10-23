import {
  AppWindow,
  Braces,
  CircleHelp,
  Cloud,
  Code,
  MessagesSquare,
  Sparkles,
  SquareTerminal,
  Terminal,
  Workflow,
  type LucideIcon
} from 'lucide-react'
import type { SourceLabel } from '@shared/source-label'

export const SOURCE_ICON: Record<SourceLabel, LucideIcon> = {
  'terminal-windows': Terminal,
  'terminal-wsl': SquareTerminal,
  vscode: Code,
  jetbrains: Braces,
  desktop: AppWindow,
  sdk: Workflow,
  cloud: Cloud,
  unknown: CircleHelp,
  'ask-claude': Sparkles,
  'claude-ai': MessagesSquare
}
