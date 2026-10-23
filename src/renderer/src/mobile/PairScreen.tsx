import { useState } from 'react'
import { Link2, Loader2, ShieldCheck } from 'lucide-react'
import { phone } from '@/lib/web-api'
import { ClaudeMark } from '@/components/brand'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/** The code from the QR code's link (#pair=XXXX-XXXX), removed from the address bar. */
function codeFromLink(): string {
  const m = location.hash.match(/pair=([A-Za-z0-9-]{4,20})/)
  if (m) history.replaceState(null, '', location.pathname)
  return m?.[1] ?? ''
}

function defaultName(): string {
  const ua = navigator.userAgent
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/iPad/.test(ua)) return 'iPad'
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet'
  return 'Browser'
}

export function PairScreen() {
  const [code, setCode] = useState(codeFromLink)
  const [name, setName] = useState(defaultName)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const pair = async (): Promise<void> => {
    if (busy || !code.trim()) return
    setBusy(true)
    setError(undefined)
    try {
      await phone.pair(code.trim(), name.trim())
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-surface px-6 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      <ClaudeMark className="size-12 rounded-2xl" />
      <h1 className="mt-5 text-center text-[22px] font-semibold tracking-[-0.015em]">
        Connect to your PC
      </h1>
      <p className="mt-2 max-w-sm text-center text-[14px] leading-relaxed text-muted-foreground">
        On your PC, open <span className="font-medium text-foreground">Settings → Phone</span> and
        scan the pairing QR code, or type the code shown there.
      </p>
      <form
        className="mt-7 w-full max-w-sm space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          void pair()
        }}
      >
        <label className="block">
          <span className="mb-1.5 block text-[13px] font-medium">Pairing code</span>
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="XXXX-XXXX"
            autoCapitalize="characters"
            autoComplete="one-time-code"
            spellCheck={false}
            className="h-12 text-center font-mono text-[20px] tracking-[0.2em]"
            aria-invalid={!!error}
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-[13px] font-medium">Name for this phone</span>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            className="h-11 text-[15px]"
          />
        </label>
        {error && (
          <div
            role="alert"
            className="rounded-lg bg-destructive/10 px-3 py-2 text-[13px] text-destructive"
          >
            {error}
          </div>
        )}
        <Button
          type="submit"
          variant="primary"
          className="h-12 w-full text-[15px]"
          disabled={busy || !code.trim()}
        >
          {busy ? <Loader2 className="animate-spin" /> : <Link2 />} Pair this phone
        </Button>
      </form>
      <div className="mt-8 flex max-w-sm items-start gap-2 text-[12px] leading-relaxed text-muted-foreground">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" />
        The code works once and expires in 5 minutes. This phone gets its own key, which you can
        revoke on the PC at any time.
      </div>
    </div>
  )
}
