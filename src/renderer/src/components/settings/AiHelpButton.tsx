// "Copy AI help prompt": the app's diagnostics wrapped in a prompt that points
// an AI assistant at docs/AI-SETUP-GUIDE.md (see shared/ai-help.ts).

import { useState } from 'react'
import { toast } from 'sonner'
import { Sparkles } from 'lucide-react'
import { aiHelpPrompt } from '@shared/ai-help'
import { api } from '@/lib/api'
import { Button } from '../ui/button'

export function AiHelpButton({
  topic,
  diagnostics
}: {
  topic: 'phone' | 'terminal'
  diagnostics: () => Promise<string>
}) {
  const [busy, setBusy] = useState(false)
  return (
    <Button
      variant="outline"
      disabled={busy}
      onClick={() => {
        setBusy(true)
        void diagnostics()
          .then((d) => api.copyText(aiHelpPrompt(topic, d)))
          .then(() =>
            toast.success('AI help prompt copied', {
              description:
                'Paste it into Claude (or another assistant) and describe what happens. No secrets in it.'
            })
          )
          .catch((err: Error) => toast.error('Couldn’t copy', { description: err.message }))
          .finally(() => setBusy(false))
      }}
    >
      <Sparkles /> Copy AI help prompt
    </Button>
  )
}
