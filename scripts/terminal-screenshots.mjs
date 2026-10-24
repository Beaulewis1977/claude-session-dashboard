/* global window */
// Terminal access, end to end in fixtures mode (a stand-in PC: nothing real
// is installed or changed): walks the desktop wizard, then pairs a
// phone-sized browser and opens "Open terminal here" and "Send SSH key".
// Saves screenshots to docs/terminal/.
// Usage: npm run build && node scripts/terminal-screenshots.mjs

import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, chromium } from 'playwright'
import electronPath from 'electron'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'docs', 'terminal')
await mkdir(out, { recursive: true })

// A throwaway public key (only its fingerprint is ever shown).
const KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIED8g+pZcZaYnLeQS1BBDXSLK/6w0yJqzqRhWVG8RRmu iphone-15'

const args = [root, '--fixtures']
if (process.platform === 'linux') args.push('--no-sandbox')
const app = await electron.launch({
  executablePath: electronPath,
  args,
  env: { ...process.env, CSD_FIXTURES: '1' }
})
const desk = await app.firstWindow()
desk.on('pageerror', (e) => console.error('desktop page error:', e.message))
await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0]
  w.unmaximize()
  w.setContentSize(1440, 900)
  w.center()
})
await desk.waitForSelector('[role="option"]')
await desk.evaluate(() => window.csd.updateSettings({ theme: 'dark' }))
await desk.reload()
await desk.waitForSelector('[role="option"]')

const shot = async (name, page = desk) => {
  await page.waitForTimeout(500)
  await page.screenshot({ path: join(out, `${name}.png`) })
  console.log('saved', name)
}
/** Click a wizard button, then OK in the "exactly what will run" dialog. */
const change = async (button, ok, name) => {
  await desk.getByRole('button', { name: button }).click()
  const dlg = desk.getByRole('dialog').filter({ hasText: 'exactly what will run' })
  await dlg.waitFor()
  if (name) await shot(name)
  await dlg.getByRole('button', { name: ok, exact: true }).click()
  await dlg.waitFor({ state: 'detached' })
  await desk.waitForTimeout(700)
}
const step = async (title) => {
  await desk.getByRole('button', { name: new RegExp(`Step \\d+\\s*${title}`) }).click()
  await desk.waitForTimeout(400)
}

// Phone access on (its own port, so a running copy of the app can keep 47821).
await desk.evaluate(() => window.csd.mobileUpdate({ port: 47832, mode: 'tailscale' }))
const status = await desk.evaluate(() => window.csd.mobileStart())
if (!status.running) throw new Error(`Companion didn't start: ${status.error}`)

// Settings → Phone → Terminal access.
await desk.keyboard.press('Control+,')
await desk.waitForSelector('text=Terminal access')
await desk.locator('text=Terminal access ·').first().scrollIntoViewIfNeeded()
await shot('settings-off')

await desk.getByRole('button', { name: 'Set up terminal access…' }).click()
await desk.waitForSelector('text=Step 1')
await shot('wizard-tailscale')

await step('OpenSSH Server')
await shot('wizard-sshd')
await change('Install for me…', 'Install', 'confirm-install')

await step('Firewall: Tailscale only')
await change('Add the Tailscale-only rule…', 'Add rule', 'confirm-firewall')
await shot('wizard-firewall-default-rule')
await change('Turn off the “any address” rule…', 'Turn off rule')
await change('Now start sshd and set it to Automatic…', 'Start')
await shot('wizard-firewall')

await step('Default shell')
await desk.getByText('PowerShell 7', { exact: true }).click()
await change('Use this shell…', 'Use PowerShell 7', 'confirm-shell')
await shot('wizard-shell')

await step('Keys')
await desk.getByRole('button', { name: 'Get key from phone' }).click()
await desk.waitForTimeout(400)

// The phone: pair, send the key, open a terminal for a session.
const pairing = await desk.evaluate(() => window.csd.mobilePair())
const browser = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }))
const phoneCtx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  colorScheme: 'dark',
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
})
const phone = await phoneCtx.newPage()
phone.on('pageerror', (e) => console.error('phone page error:', e.message))
await phone.goto(`http://${status.listening}/#pair=${pairing.code}`)
await phone.getByRole('button', { name: 'Pair this phone' }).click()
await phone.waitForSelector('text=Live', { timeout: 15_000 })
await phone.getByRole('button', { name: 'Settings', exact: true }).click()
await phone.getByLabel('Public SSH key').fill(KEY)
await phone.locator('text=Send SSH key to PC').scrollIntoViewIfNeeded()
await shot('phone-send-key', phone)
await phone.getByRole('button', { name: 'Send to PC' }).click()
await phone.waitForSelector('text=Sent.')
await shot('phone-key-sent', phone)

await desk.waitForSelector('text=sent a ssh-ed25519 key')
await shot('wizard-key-from-phone')
await change('Allow…', 'Add key', 'confirm-key')
await shot('wizard-keys')
await change('Turn off password login…', 'Turn off password login', 'confirm-password')

await step('Phone app')
await shot('wizard-phone-app')
await step('Test')
await shot('wizard-test')

// Troubleshooting.
await desk.getByRole('button', { name: 'Troubleshooting' }).last().click()
await desk.waitForTimeout(400)
await shot('wizard-troubleshooting')
await desk.keyboard.press('Escape')
await desk.waitForTimeout(400)
await desk.locator('text=Terminal access ·').first().scrollIntoViewIfNeeded()
await desk.locator('summary', { hasText: 'Change log' }).click()
await shot('settings-ready')

// The phone now shows "Open terminal here".
await phone.reload()
await phone.waitForSelector('text=Live', { timeout: 15_000 })
await phone.locator('button', { hasText: 'Safari login loop' }).first().click()
await phone.getByRole('button', { name: 'Open terminal here' }).first().click()
await phone.waitForSelector('text=Open in SSH app')
await shot('phone-terminal-sheet', phone)
await phone.keyboard.press('Escape')

// A WSL project from the Sessions tab.
await phone.getByRole('button', { name: 'Sessions' }).last().click()
await phone.getByRole('button', { name: 'Filter and sort' }).click()
await phone
  .locator('button', { hasText: /^orders-api/ })
  .first()
  .click()
await phone.getByRole('button', { name: 'Done' }).click()
await phone.getByRole('button', { name: 'Open terminal here' }).click()
await phone.waitForSelector('text=Open in SSH app')
await shot('phone-terminal-project', phone)

// Turn it all off again.
await phone.keyboard.press('Escape')
await desk.getByRole('button', { name: 'Turn off terminal access…' }).click()
await shot('turn-off-options')
await desk.getByRole('button', { name: 'Continue…' }).click()
const dlg = desk.getByRole('dialog').filter({ hasText: 'exactly what will run' })
await dlg.waitFor()
await shot('confirm-turn-off')
await dlg.getByRole('button', { name: 'Turn off', exact: true }).click()
await desk.waitForTimeout(800)

// Desktop "Open terminal here" (fixtures: shows the command instead).
await desk.keyboard.press('Escape')
await desk.waitForSelector('[role="option"]')
await desk
  .locator('[role="option"]', { hasText: 'Safari login loop' })
  .first()
  .dispatchEvent('mousedown')
await desk.getByRole('button', { name: 'More actions' }).first().click()
await shot('desktop-menu')
await desk.getByRole('menuitem', { name: 'Open terminal here' }).click()
await shot('desktop-open-terminal')

await browser.close()
await app.close()
