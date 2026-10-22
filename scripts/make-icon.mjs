// Renders resources/icon.svg to resources/icon.png (512x512) with Playwright's Chromium.
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const svg = await readFile(join(root, 'resources', 'icon.svg'), 'utf8')
// CHROMIUM_PATH lets you use an existing Chromium instead of Playwright's download.
const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}
)
const page = await browser.newPage({ viewport: { width: 512, height: 512 } })
await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`)
await page
  .locator('svg')
  .screenshot({ path: join(root, 'resources', 'icon.png'), omitBackground: true })
await browser.close()
console.log('wrote resources/icon.png')
