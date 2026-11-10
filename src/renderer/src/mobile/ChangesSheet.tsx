// The phone's view of a session's git links: its commits, files and pull
// request links, read-only (no diffs: those stay on the PC).

import { ChangesPanel } from '@/components/viewer/Changes'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import type { SessionSummary } from '@shared/types'

export function ChangesSheet({
  session,
  onClose,
  onSearch
}: {
  session: SessionSummary
  onClose: () => void
  /** "Sessions that touched this file" set the search: back to the list. */
  onSearch: () => void
}) {
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent title="Changes" description={session.title}>
        <div className="-mx-1 max-h-[75vh] overflow-y-auto">
          <ChangesPanel session={session} className="px-1 pt-1 pb-6" onSearch={onSearch} />
        </div>
      </SheetContent>
    </Sheet>
  )
}
