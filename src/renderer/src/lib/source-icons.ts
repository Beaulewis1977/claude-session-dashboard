import {
  AppWindow,
  Braces,
  BriefcaseBusiness,
  CircleHelp,
  Cloud,
  Code,
  GitFork,
  LaptopMinimal,
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
  desktop: LaptopMinimal,
  cowork: BriefcaseBusiness,
  sdk: Workflow,
  cloud: Cloud,
  unknown: CircleHelp,
  'ask-claude': Sparkles,
  'claude-ai': MessagesSquare,
  'codex-cli': Terminal,
  'codex-vscode': Code,
  'codex-desktop': AppWindow,
  'codex-exec': Workflow,
  'codex-subagent': GitFork,
  'codex-claude-code': Sparkles,
  'codex-unknown': CircleHelp
}
