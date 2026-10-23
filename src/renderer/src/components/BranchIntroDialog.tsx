import { FilePlus2, GitBranchPlus, ShieldCheck, Wrench } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader } from './ui/dialog'

function Point({ icon: Icon, children }: { icon: typeof FilePlus2; children: React.ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span>{children}</span>
    </li>
  )
}

/** Shown the first time someone uses "Branch from here". */
export function BranchIntroDialog() {
  const intro = useApp((s) => s.branchIntro)
  const set = useApp((s) => s.set)
  if (!intro) return null

  const close = (): void => set({ branchIntro: null })
  const accept = async (): Promise<void> => {
    const settings = await api.updateSettings({ branchConfirmed: true })
    set({
      settings,
      branchIntro: null,
      resume: { key: intro.key, fork: false, branch: intro.branch }
    })
  }

  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-w-[520px]">
        <DialogHeader
          icon={
            <div className="flex size-8 items-center justify-center rounded-lg bg-accent-soft text-primary">
              <GitBranchPlus className="size-4" />
            </div>
          }
          title="Branch from a message"
          description="Continue the conversation from an earlier point, in a new session."
        />
        <div className="px-5 pt-3 pb-5">
          <p className="text-[13px] leading-relaxed text-foreground/85">
            Claude Code can&apos;t resume a session at a chosen message, so the app makes a copy of
            the conversation up to that message and resumes the copy.
          </p>
          <ul className="mt-3.5 space-y-2.5 text-[13px] leading-relaxed text-foreground/85">
            <Point icon={FilePlus2}>
              It <strong className="font-semibold">adds one new session file</strong> to the same
              project folder in <span className="font-mono text-[12px]">.claude/projects</span>,
              with a new session id. Nothing else in{' '}
              <span className="font-mono text-[12px]">.claude</span> is touched.
            </Point>
            <Point icon={ShieldCheck}>
              It never changes or deletes an existing file. The original session stays exactly as it
              is, and you can still resume it.
            </Point>
            <Point icon={Wrench}>
              A tool call always stays together with its result. If a message&apos;s tools finish
              later, the branch includes their results, or starts a little earlier. You&apos;ll see
              where before anything is created.
            </Point>
          </ul>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void accept()} autoFocus>
            <GitBranchPlus /> Continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
