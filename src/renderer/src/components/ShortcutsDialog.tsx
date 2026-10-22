import { useApp } from '@/lib/store'
import { SHORTCUTS } from '@/lib/shortcuts'
import { Dialog, DialogContent, DialogHeader } from './ui/dialog'
import { Shortcut } from './ui/kbd'

export function ShortcutsDialog() {
  const open = useApp((s) => s.shortcutsOpen)
  const set = useApp((s) => s.set)
  return (
    <Dialog open={open} onOpenChange={(o) => set({ shortcutsOpen: o })}>
      <DialogContent className="max-w-[640px]" onOpenAutoFocus={(e) => e.preventDefault()}>
        <DialogHeader
          title="Keyboard shortcuts"
          description="Everything can be done from the keyboard."
        />
        <div className="grid grid-cols-2 gap-x-8 gap-y-5 px-5 pt-3 pb-6">
          {SHORTCUTS.map((g) => (
            <div key={g.group} className={g.group === 'Selected session' ? 'row-span-2' : ''}>
              <div className="mb-2 text-2xs font-medium tracking-wide text-subtle-foreground uppercase">
                {g.group}
              </div>
              <div className="space-y-1.5">
                {g.items.map(([keys, label]) => (
                  <div key={label} className="flex items-center justify-between gap-3 text-[13px]">
                    <span className="text-foreground/85">{label}</span>
                    <Shortcut keys={keys} />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
