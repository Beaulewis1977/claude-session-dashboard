// Icons that repeat hundreds of times (each tool call, each message's
// actions) drawn once: the first use puts the icon into a hidden <symbol>,
// and every icon on the page is just <svg><use/></svg>. Same look (the
// symbol is the icon itself, in currentColor), a fraction of the DOM.

import type { ComponentType, SVGProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { cn } from '@/lib/utils'

type Icon = ComponentType<SVGProps<SVGSVGElement>>

const icons = new Map<string, Icon>()
let root: Root | undefined
let scheduled = false

function draw(): void {
  scheduled = false
  if (typeof document === 'undefined') return
  if (!root) {
    const host = document.createElement('div')
    host.setAttribute('aria-hidden', 'true')
    host.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden'
    document.body.appendChild(host)
    root = createRoot(host)
  }
  root.render(
    <svg width={0} height={0} aria-hidden>
      <defs>
        {[...icons].map(([id, Icon]) => (
          <symbol key={id} id={id} viewBox="0 0 24 24">
            <Icon width={24} height={24} />
          </symbol>
        ))}
      </defs>
    </svg>
  )
}

function register(id: string, icon: Icon): void {
  if (icons.has(id)) return
  icons.set(id, icon)
  if (!scheduled) {
    scheduled = true
    queueMicrotask(draw)
  }
}

/** A lucide icon drawn from the sprite. `name` must be unique per icon. */
export function SpriteIcon({
  icon,
  name,
  className
}: {
  icon: Icon
  name: string
  className?: string
}) {
  const id = `csd-icon-${name}`
  register(id, icon)
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      width={24}
      height={24}
      className={cn('lucide shrink-0', className)}
    >
      <use href={`#${id}`} />
    </svg>
  )
}
