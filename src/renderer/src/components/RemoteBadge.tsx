import { ExternalLink } from 'lucide-react'
import { api } from '@/lib/api'
import { isRemote, remoteTitle, type RemoteFields } from '@/lib/remote'
import { cn } from '@/lib/utils'
import { Badge } from './ui/badge'

/** The "📱 Remote" badge on session rows and in the viewer header. */
export function RemoteBadge({ session, compact }: { session: RemoteFields; compact?: boolean }) {
  if (!isRemote(session)) return null
  if (compact) {
    return (
      <span
        className="inline-flex items-center gap-0.5 rounded bg-info/10 px-1 text-[10px] font-medium text-info"
        title={remoteTitle(session)}
      >
        <span aria-hidden>📱</span> Remote
      </span>
    )
  }
  const url = session.remoteUrl
  return (
    <Badge
      variant="default"
      className={cn('border-info/25 bg-info/5 text-info', url && 'cursor-pointer hover:bg-info/10')}
      title={remoteTitle(session)}
      onClick={url ? () => void api.openExternal(url) : undefined}
      role={url ? 'link' : undefined}
    >
      <span aria-hidden>📱</span> Remote
      {url && <ExternalLink />}
    </Badge>
  )
}
