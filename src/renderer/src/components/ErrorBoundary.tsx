import { Component, type ErrorInfo, type ReactNode } from 'react'
import { TriangleAlert } from 'lucide-react'

/**
 * Keeps a part of the UI that fails to render (say, an odd entry in a session
 * file) from taking the whole window down: that part shows `fallback` instead.
 */
export class ErrorBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('Render failed', error, info.componentStack)
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

export function RenderFailed({ what }: { what: string }) {
  return (
    <div className="flex items-center gap-1.5 px-1 text-xs text-subtle-foreground italic">
      <TriangleAlert className="size-3.5 shrink-0" />
      {what} can&apos;t be shown.
    </div>
  )
}
