// How an Ask answer is shown and copied.

import { modelLabel } from '../usage/pricing'
import { ASK_EFFORT_LABEL, ASK_MODEL_LABEL, type AskSessionsItem } from './types'

/** `[S3]` → a link the answer view renders as a citation chip. */
export function linkCitations(answer: string): string {
  return answer.replace(/\[(S\d{1,3})\](?!\()/g, '[$1](#cite-$1)')
}

/** "Sonnet (Sonnet 5.5) · High effort": what was picked, and the model that answered. */
export function itemModelLabel(
  i: Pick<AskSessionsItem, 'modelChoice' | 'effort' | 'model'>
): string {
  const picked = i.modelChoice ? ASK_MODEL_LABEL[i.modelChoice] : undefined
  const answered = i.model ? modelLabel(i.model) : undefined
  const model =
    picked && answered && !answered.toLowerCase().startsWith(picked.toLowerCase())
      ? `${picked} (${answered})`
      : picked === ASK_MODEL_LABEL.default && answered
        ? answered
        : (answered ?? picked ?? '')
  const effort = i.effort && i.effort !== 'default' ? ASK_EFFORT_LABEL[i.effort] + ' effort' : ''
  return [model, effort].filter(Boolean).join(' · ')
}

/** The answer as Markdown to paste elsewhere: citations as [1], [2] with the sources listed. */
export function answerForCopy(i: AskSessionsItem): string {
  if (i.mode === 'local' && i.local) {
    const l = i.local
    const lines = [`**Q:** ${i.question}`, '', l.headline]
    if (l.table?.rows.length) {
      lines.push(
        '',
        `| ${l.table.columns.join(' | ')} |`,
        `| ${l.table.columns.map(() => '---').join(' | ')} |`
      )
      for (const r of l.table.rows)
        lines.push(`| ${r.map((c) => c.replace(/\|/g, '\\|')).join(' | ')} |`)
    }
    if (l.sessions?.length)
      lines.push('', ...l.sessions.map((s) => `- ${s.title}${s.detail ? ` (${s.detail})` : ''}`))
    if (l.commits?.length)
      lines.push(
        '',
        ...l.commits.map(
          (c) => `- ${c.sha.slice(0, 7)} ${c.subject}${c.detail ? ` (${c.detail})` : ''}`
        )
      )
    lines.push('', `_Answered on this PC: ${l.interpretation}._`)
    return lines.join('\n')
  }
  const order: string[] = []
  const text = (i.answer ?? '').replace(/\[(S\d{1,3})\]/g, (_m, sid: string) => {
    if (!order.includes(sid)) order.push(sid)
    return `[${order.indexOf(sid) + 1}]`
  })
  const sources = order.map((sid, n) => {
    const c = i.citations?.[sid]
    return `[${n + 1}] ${c ? `${c.title}${c.date ? `, ${c.date}` : ''}${c.sha ? ` (commit ${c.sha.slice(0, 7)})` : ''}` : sid}`
  })
  return [
    `**Q:** ${i.question}`,
    '',
    text || 'Not found in your sessions.',
    ...(sources.length ? ['', 'Sources:', ...sources] : [])
  ].join('\n')
}
