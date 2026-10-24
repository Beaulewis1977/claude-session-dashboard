// "Copy AI help prompt" (both Troubleshooting panels): a ready prompt for an
// AI assistant (Claude Code or similar) helping someone connect their phone.
// It points the assistant at docs/AI-SETUP-GUIDE.md, which holds the
// diagnostics and the safety rules, and carries the app's own diagnostics
// (no tokens, codes, keys or e-mail in them).

export const AI_GUIDE_URL =
  'https://github.com/Beaulewis1977/claude-session-dashboard/blob/main/docs/AI-SETUP-GUIDE.md'

const TOPIC = {
  phone:
    'connect my phone to the Claude Session Dashboard on my Windows PC (phone companion, Tailscale, Remote Control)',
  terminal:
    'set up terminal access (SSH over Tailscale with Windows OpenSSH) from my phone to my Windows PC'
} as const

export function aiHelpPrompt(topic: keyof typeof TOPIC, diagnostics: string): string {
  return [
    `Please help me ${TOPIC[topic]}.`,
    '',
    `First read this guide and follow its rules: ${AI_GUIDE_URL}`,
    'Start with the read-only checks it lists. Ask me before you change anything on my PC, and make changes through the app’s own setup screens where it says so.',
    '',
    'What happens when I try (describe it, or paste the exact error):',
    '<your answer here>',
    '',
    'Diagnostics from the app (no secrets in them):',
    '```',
    diagnostics.trim(),
    '```'
  ].join('\n')
}
