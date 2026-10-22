import { cn } from '@/lib/utils'

/** A sunburst mark in Claude's clay colour, used for the app and assistant avatar. */
export function ClaudeMark({ className }: { className?: string }) {
  const rays = Array.from({ length: 10 }, (_, i) => (i * 360) / 10)
  return (
    <span
      className={cn(
        'inline-flex items-center justify-center rounded-[7px] bg-gradient-to-br from-[#e48a68] to-[#c15f3c] shadow-[inset_0_1px_0_rgb(255_255_255/0.25)]',
        className
      )}
      aria-hidden
    >
      <svg viewBox="0 0 24 24" className="size-[62%]" fill="none">
        {rays.map((deg, i) => (
          <rect
            key={deg}
            x="11"
            y={i % 2 ? 4.4 : 2.4}
            width="2"
            height={i % 2 ? 8.6 : 10.6}
            rx="1"
            fill="white"
            transform={`rotate(${deg} 12 12)`}
          />
        ))}
      </svg>
    </span>
  )
}
