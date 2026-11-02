// Continue fresh in the launch dialog: what the new session starts from (the
// handoff file with the summary) and how it gets there.

import { useState } from 'react'
import { ChevronDown, ChevronRight, FileText, Info, TriangleAlert, Zap } from 'lucide-react'
import type { ContinueFreshPreview } from '@shared/types'

export const ContinueIcon = Zap

export function ContinueFreshCard({
  preview,
  error,
  messageCount
}: {
  preview?: ContinueFreshPreview
  error?: string
  messageCount: number
}) {
  const [show, setShow] = useState(false)
  return (
    <div className="space-y-3">
      <p className="text-xs leading-relaxed text-muted-foreground">
        Starts a <strong className="font-medium text-foreground/85">new session</strong> in this
        folder whose first message is this session&apos;s summary, instead of reloading all{' '}
        {messageCount} messages. Much lighter on your limits. The original session stays untouched,
        and the new one is linked to it as &ldquo;continued from&rdquo;.
      </p>
      {error ? (
        <div className="flex items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs">
          <TriangleAlert className="mt-px size-4 shrink-0 text-destructive" />
          {error}
        </div>
      ) : !preview ? (
        <div className="h-[86px] animate-pulse rounded-lg border border-border bg-secondary/60" />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          {preview.newSince > 0 && (
            <div className="flex items-start gap-2 border-b border-warning/25 bg-warning-soft px-3 py-2 text-xs text-foreground/85">
              <TriangleAlert className="mt-px size-3.5 shrink-0 text-warning" />
              The session has {preview.newSince} new message{preview.newSince === 1 ? '' : 's'}{' '}
              since the summary was written. Regenerate it first to include them.
            </div>
          )}
          <div className="flex items-center gap-2 px-3 py-2 text-xs">
            <Zap className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="shrink-0 font-medium">{preview.name}</span>
            <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
              {preview.newSessionId}
            </span>
          </div>
          <div className="border-t border-border px-3 py-2 text-xs">
            <div className="flex items-start gap-2 text-muted-foreground">
              <Info className="mt-px size-3.5 shrink-0" />
              <span>
                The summary is written to a new file in the app&apos;s data folder, and the first
                message{' '}
                {preview.mode === 'mention'
                  ? 'attaches it with an @-mention'
                  : 'asks Claude to read it (its folder is added with --add-dir)'}
                , so the summary never goes on a command line. Nothing is written to Claude&apos;s
                files.
              </span>
            </div>
            <div
              className="selectable mt-1 truncate pl-[22px] font-mono text-[11px] text-muted-foreground"
              title={preview.handoffPath}
            >
              {preview.sessionPath}
            </div>
            <button
              type="button"
              onClick={() => setShow((v) => !v)}
              className="mt-1.5 ml-[22px] inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
              aria-expanded={show}
            >
              {show ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
              <FileText className="size-3.5" /> The handoff
            </button>
            {show && (
              <pre className="selectable mt-1.5 max-h-56 overflow-auto rounded-md border border-code-border bg-code-bg px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-foreground/90">
                {preview.handoff}
              </pre>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
