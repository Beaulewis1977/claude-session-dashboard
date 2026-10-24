import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  canOpenTerminal,
  isTailscaleAddress,
  keyFingerprint,
  parsePublicKey,
  parseSshdLogins,
  posixWord,
  remoteCommand,
  shQuote,
  sshCommand,
  sshUrl,
  windowsToMnt,
  type SshShellInfo,
  type TerminalAccessInfo
} from '../src/shared/terminal'
import { buildShellCommand } from '../src/main/core/launch'
import { JsonStore } from '../src/main/core/json-store'
import { parseAction } from '../src/main/ipc-terminal'
import { DeviceRegistry, type MobileFile } from '../src/main/mobile/devices'
import { allowedHosts } from '../src/main/mobile/network'
import { RemoteLauncher } from '../src/main/mobile/remote-launch'
import { rpcMethod, RPC } from '../src/main/mobile/rpc'
import { MobileServer } from '../src/main/mobile/server'
import { fakePc, type FakePc } from '../src/main/terminal/fake'
import {
  encodedCommand,
  firewallAddScript,
  scriptText,
  shownText,
  TAILSCALE_RANGES
} from '../src/main/terminal/scripts'
import { parseProbe } from '../src/main/terminal/host'
import { passwordAuthSetting, setPasswordAuth } from '../src/main/terminal/sshd-config'
import {
  emptyTerminalFile,
  shellKind,
  sshUserName,
  startTypeFor,
  TerminalService,
  type TerminalDeps,
  type TerminalFile
} from '../src/main/terminal/service'
import { FIXTURES, TOOLS } from './helpers'

// A throwaway test key (made with ssh-keygen; `ssh-keygen -lf` gives the fingerprint below).
const KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIED8g+pZcZaYnLeQS1BBDXSLK/6w0yJqzqRhWVG8RRmu iphone-15'
const KEY_FP = 'SHA256:Kdv0Vqz8APCLEpeC4chVMO+GgvG2ZPlMRJxYrAX1NuM'
const KEY_BLOB = KEY.split(' ')[1]

const PWSH: SshShellInfo = { kind: 'pwsh', path: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' }
const WSL: SshShellInfo = { kind: 'wsl', path: 'C:\\Windows\\System32\\bash.exe', distro: 'Ubuntu' }
const INFO: TerminalAccessInfo = {
  ready: true,
  host: 'ryzen-desktop.tail1234.ts.net',
  user: 'beau',
  port: 22,
  shell: PWSH
}

// ------------------------------------------------------------ command builders

describe('commands that land in a folder over SSH', () => {
  it('uses Set-Location for PowerShell, with paths with spaces and quotes', () => {
    expect(remoteCommand({ env: 'windows', cwd: 'C:\\My Projects\\web app' }, PWSH).command).toBe(
      "Set-Location -LiteralPath 'C:\\My Projects\\web app'; pwsh -NoLogo"
    )
    expect(
      remoteCommand({ env: 'windows', cwd: "C:\\Beau's code" }, { kind: 'powershell' }).command
    ).toBe("Set-Location -LiteralPath 'C:\\Beau''s code'; powershell -NoLogo")
  })

  it('cds into the Linux path for WSL, and uses wsl.exe for another distro', () => {
    expect(
      remoteCommand({ env: 'wsl', cwd: '/home/beau/my project', distro: 'Ubuntu' }, WSL).command
    ).toBe("cd '/home/beau/my project' && exec ${SHELL:-bash} -l")
    expect(
      remoteCommand({ env: 'wsl', cwd: '/home/beau/api', distro: 'Debian' }, WSL).command
    ).toBe('wsl.exe -d Debian --cd /home/beau/api')
    // A Windows folder from a WSL shell goes through /mnt.
    expect(remoteCommand({ env: 'windows', cwd: 'C:\\code\\My App' }, WSL).command).toBe(
      "cd '/mnt/c/code/My App' && exec ${SHELL:-bash} -l"
    )
    expect(remoteCommand({ env: 'windows', cwd: '\\\\nas\\share' }, WSL).note).toMatch(/network/)
  })

  it('opens a WSL session from a PowerShell login with wsl.exe', () => {
    expect(
      remoteCommand({ env: 'wsl', cwd: '/home/beau/my app', distro: 'Ubuntu-24.04' }, PWSH).command
    ).toBe("wsl.exe -d Ubuntu-24.04 --cd '/home/beau/my app'")
  })

  it('never uses double quotes for PowerShell or WSL (Windows OpenSSH would strip them)', () => {
    for (const shell of [PWSH, WSL])
      for (const t of [
        { env: 'windows' as const, cwd: 'C:\\a b\\c' },
        { env: 'wsl' as const, cwd: '/home/x/a b', distro: 'Ubuntu' }
      ])
        expect(remoteCommand(t, shell).command).not.toContain('"')
  })

  it('refuses folders Windows would mangle on the way to the shell', () => {
    expect(
      remoteCommand({ env: 'wsl', cwd: '/home/beau/a"b', distro: 'Ubuntu' }, PWSH).command
    ).toBeUndefined()
    expect(
      remoteCommand({ env: 'wsl', cwd: '/home/beau/a\\b', distro: 'Ubuntu' }, WSL).command
    ).toBeUndefined()
    expect(
      remoteCommand({ env: 'wsl', cwd: '/x', distro: 'bad name' }, PWSH).command
    ).toBeUndefined()
  })

  it('refuses control characters and missing folders', () => {
    expect(remoteCommand({ env: 'windows', cwd: 'C:\\a\nb' }, PWSH).command).toBeUndefined()
    expect(remoteCommand({ env: 'windows' }, PWSH).note).toMatch(/No folder/)
  })

  it('quotes the whole ssh command for a POSIX shell', () => {
    const remote = remoteCommand({ env: 'windows', cwd: "C:\\Beau's code" }, PWSH).command!
    const cmd = sshCommand(INFO, remote)
    expect(cmd).toBe(
      `ssh -t beau@ryzen-desktop.tail1234.ts.net "Set-Location -LiteralPath 'C:\\Beau''s code'; pwsh -NoLogo"`
    )
    expect(sshCommand(INFO, 'cd /x && ls')).toBe(
      "ssh -t beau@ryzen-desktop.tail1234.ts.net 'cd /x && ls'"
    )
    expect(sshCommand(INFO)).toBe('ssh beau@ryzen-desktop.tail1234.ts.net')
    expect(sshCommand({ ...INFO, port: 2222 })).toBe(
      'ssh -p 2222 beau@ryzen-desktop.tail1234.ts.net'
    )
    expect(shQuote('plain-word')).toBe('plain-word')
  })

  // A real bash must read each quoted word back as exactly the original text.
  const bash = ['C:\\Program Files\\Git\\bin\\bash.exe', '/bin/bash', '/usr/bin/bash'].find((p) =>
    existsSync(p)
  )
  it.skipIf(!bash)('quotes words so a POSIX shell reads them back exactly', () => {
    const samples = [
      "Set-Location -LiteralPath 'C:\\Beau''s code'; pwsh -NoLogo",
      "cd '/home/beau/my project' && exec ${SHELL:-bash} -l",
      "Set-Location -LiteralPath '\\\\nas\\share\\x\\'; pwsh",
      'a "b" `c` $d \\$e \\\\ f\\',
      "it's ! here",
      'plain'
    ]
    for (const s of samples) {
      // On stdin: Windows command-line quoting would get in the way otherwise.
      const out = execFileSync(bash!, ['-s'], {
        input: `printf %s ${posixWord(s)}\n`,
        encoding: 'utf8'
      })
      expect(out).toBe(s)
    }
  })

  it('builds ssh:// links with the user encoded', () => {
    expect(sshUrl(INFO)).toBe('ssh://beau@ryzen-desktop.tail1234.ts.net')
    expect(sshUrl({ ...INFO, user: 'CORP\\beau lewis', port: 2222 })).toBe(
      'ssh://CORP%5Cbeau%20lewis@ryzen-desktop.tail1234.ts.net:2222'
    )
  })

  it('maps drive paths to /mnt', () => {
    expect(windowsToMnt('D:\\Work\\x')).toBe('/mnt/d/Work/x')
    expect(windowsToMnt('\\\\server\\share')).toBeUndefined()
  })
})

describe('"Open terminal here" on the desktop', () => {
  it('opens Windows Terminal in a Windows folder with spaces', () => {
    const c = buildShellCommand({
      env: 'windows',
      cwd: 'C:\\My Projects\\web app',
      terminal: 'wt',
      tools: TOOLS
    })
    expect(c.command).toBe(TOOLS.wt)
    expect(c.args).toEqual(['-d', 'C:\\My Projects\\web app'])
  })

  it('opens PowerShell with the folder as a literal string', () => {
    const c = buildShellCommand({
      env: 'windows',
      cwd: "C:\\Beau's",
      terminal: 'powershell',
      tools: TOOLS
    })
    expect(c.args).toEqual(['-NoExit', '-Command', "Set-Location -LiteralPath 'C:\\Beau''s'"])
    expect(c.spawnCwd).toBe("C:\\Beau's")
  })

  it('opens cmd in the folder without passing the folder to cmd', () => {
    const c = buildShellCommand({ env: 'windows', cwd: 'C:\\a b', terminal: 'cmd', tools: TOOLS })
    expect(c.args).toEqual(['/k'])
    expect(c.spawnCwd).toBe('C:\\a b')
  })

  it('opens WSL in the Linux folder', () => {
    const wt = buildShellCommand({
      env: 'wsl',
      cwd: '/home/beau/my app',
      distro: 'Ubuntu',
      terminal: 'wt',
      tools: TOOLS
    })
    expect(wt.args).toEqual([TOOLS.wsl, '-d', 'Ubuntu', '--cd', '/home/beau/my app'])
    const ps = buildShellCommand({
      env: 'wsl',
      cwd: '/home/beau/my app',
      distro: 'Ubuntu',
      terminal: 'powershell',
      tools: TOOLS
    })
    expect(ps.args[2]).toBe(
      "& 'C:\\Windows\\System32\\wsl.exe' -d 'Ubuntu' --cd '/home/beau/my app'"
    )
  })

  it('falls back to PowerShell for folders Windows Terminal or cmd would misread', () => {
    const wt = buildShellCommand({ env: 'windows', cwd: 'C:\\a;b', terminal: 'wt', tools: TOOLS })
    expect(wt.terminal).toBe('powershell')
    expect(wt.terminalReason).toBeTruthy()
    const unc = buildShellCommand({
      env: 'windows',
      cwd: '\\\\nas\\x',
      terminal: 'cmd',
      tools: TOOLS
    })
    expect(unc.terminal).toBe('powershell')
    expect(() =>
      buildShellCommand({ env: 'wsl', cwd: '/x"y', distro: 'Ubuntu', terminal: 'wt', tools: TOOLS })
    ).toThrow()
    expect(() =>
      buildShellCommand({
        env: 'wsl',
        cwd: '/x',
        distro: 'bad name;',
        terminal: 'wt',
        tools: TOOLS
      })
    ).toThrow(/distro/)
  })
})

// ------------------------------------------------------------ keys, logins, addresses

describe('public keys', () => {
  it('accepts an OpenSSH public key and gives the same fingerprint as ssh-keygen', async () => {
    const k = parsePublicKey(`  ${KEY}\n`)
    expect(k.ok).toBe(true)
    if (!k.ok) return
    expect(k.type).toBe('ssh-ed25519')
    expect(k.comment).toBe('iphone-15')
    expect(k.line).toBe(KEY)
    expect(await keyFingerprint(k.base64)).toBe(KEY_FP)
  })

  it('refuses options, private keys, several keys and damaged keys', () => {
    expect(parsePublicKey(`command="rm -rf /" ${KEY}`).ok).toBe(false)
    expect(parsePublicKey('-----BEGIN OPENSSH PRIVATE KEY-----\nabc').ok).toBe(false)
    expect(parsePublicKey(`${KEY}\n${KEY}`).ok).toBe(false)
    expect(parsePublicKey(KEY.replace('AAAAC3', 'AAAAB3')).ok).toBe(false)
    expect(parsePublicKey('ssh-ed25519 AAAA').ok).toBe(false)
    expect(parsePublicKey(42).ok).toBe(false)
  })

  it('cuts the comment down to plain characters', () => {
    const k = parsePublicKey(`ssh-ed25519 ${KEY_BLOB} me@phone; $(evil) "x"`)
    expect(k.ok && k.comment).toBe('me@phone evil x')
  })
})

describe('sshd logins', () => {
  it('reads accepted logins from the event log, newest first', () => {
    const logins = parseSshdLogins([
      {
        at: '2026-10-23T10:00:00Z',
        message: 'sshd: Accepted password for beau from 192.168.1.20 port 51000 ssh2'
      },
      {
        at: '2026-10-23T11:00:00Z',
        message: `sshd: Accepted publickey for beau from 100.101.102.103 port 50122 ssh2: ED25519 ${KEY_FP}`
      },
      { at: '2026-10-23T12:00:00Z', message: 'sshd: Failed password for beau from 1.2.3.4' }
    ])
    expect(logins).toHaveLength(2)
    expect(logins[0]).toMatchObject({
      method: 'publickey',
      from: '100.101.102.103',
      tailscale: true,
      fingerprint: KEY_FP
    })
    expect(logins[1].tailscale).toBe(false)
  })

  it('knows Tailscale addresses', () => {
    expect(isTailscaleAddress('100.64.0.1')).toBe(true)
    expect(isTailscaleAddress('100.127.255.255')).toBe(true)
    expect(isTailscaleAddress('100.128.0.1')).toBe(false)
    expect(isTailscaleAddress('192.168.1.2')).toBe(false)
    expect(isTailscaleAddress('fd7a:115c:a1e0::1')).toBe(true)
    expect(isTailscaleAddress('fe80::1')).toBe(false)
  })
})

// ------------------------------------------------------------ scripts

describe('the firewall rule', () => {
  const s = firewallAddScript({
    program: 'C:\\Windows\\System32\\OpenSSH\\sshd.exe',
    interfaceAlias: 'Tailscale'
  })

  it('allows only sshd, port 22, from Tailscale addresses, on the Tailscale adapter', () => {
    const q = s.parts[0].params
    expect(q).toMatchObject({
      Name: 'CSD-SSH-Tailscale',
      Port: '22',
      Remote: ['100.64.0.0/10', 'fd7a:115c:a1e0::/48'],
      Program: 'C:\\Windows\\System32\\OpenSSH\\sshd.exe',
      Interface: 'Tailscale'
    })
    expect(TAILSCALE_RANGES).toEqual(['100.64.0.0/10', 'fd7a:115c:a1e0::/48'])
    expect(s.parts[0].body).toContain('RemoteAddress = [string[]]$q.Remote')
    expect(s.parts[0].body).toContain("Direction = 'Inbound'")
    expect(s.parts[0].body).not.toMatch(/funnel|Any'?\s*;?\s*RemoteAddress\s*=\s*'Any/i)
    expect(s.elevate).toBe(true)
  })

  it('refuses odd adapter names and program paths', () => {
    // Never a rule without the adapter: other networks can use 100.64.0.0/10 too.
    expect(() =>
      firewallAddScript({ program: 'C:\\x\\sshd.exe', interfaceAlias: "x'; Remove-Item" })
    ).toThrow(/adapter/)
    expect(() => firewallAddScript({ program: 'C:\\x\\sshd.exe', interfaceAlias: '' })).toThrow()
    expect(() => firewallAddScript({ program: 'sshd.exe', interfaceAlias: 'Tailscale' })).toThrow()
    expect(() =>
      firewallAddScript({ program: 'C:\\x\\sshd.exe', interfaceAlias: 'Tailscale', port: 0 })
    ).toThrow()
  })

  it('passes inputs as base64 data, never as script text', () => {
    const text = scriptText(s, 'C:\\Users\\beau\\AppData\\Roaming\\ClaudeSessionDashboard\\r.json')
    expect(text).not.toContain('100.64.0.0/10')
    expect(text).toContain('FromBase64String')
    expect(text.length).toBeLessThan(20_000)
    expect(encodedCommand('a')).toBe(Buffer.from('a', 'utf16le').toString('base64'))
    // The confirmation shows the inputs and the commands.
    expect(shownText(s)).toContain('$q.Remote = 100.64.0.0/10, fd7a:115c:a1e0::/48')
    expect(shownText(s)).toContain('New-NetFirewallRule')
  })
})

describe('sshd_config', () => {
  const fixture = async (): Promise<string> =>
    (await readFile(join(FIXTURES, 'ssh', 'sshd_config'), 'utf8')).replace(/\r\n/g, '\n')

  it('sets PasswordAuthentication after the commented default, before Match', async () => {
    const text = await fixture()
    expect(passwordAuthSetting(text)).toBe('yes')
    const next = setPasswordAuth(text, 'no')
    expect(passwordAuthSetting(next)).toBe('no')
    const lines = next.split('\n')
    const i = lines.indexOf('PasswordAuthentication no')
    expect(lines[i - 1]).toBe('#PasswordAuthentication yes')
    expect(i).toBeLessThan(lines.findIndex((l) => l.startsWith('Match Group')))
    // Only one line was added; everything else is unchanged.
    expect(lines.filter((_, j) => j !== i).join('\n')).toBe(text)
  })

  it('changes an active line in place and keeps CRLF', () => {
    const text =
      'Port 22\r\nPasswordAuthentication yes\r\nMatch User x\r\n  PasswordAuthentication yes\r\n'
    const next = setPasswordAuth(text, 'no')
    expect(next).toBe(
      'Port 22\r\nPasswordAuthentication no\r\nMatch User x\r\n  PasswordAuthentication yes\r\n'
    )
    expect(setPasswordAuth(next, 'no')).toBe(next)
  })

  it('ignores settings inside Match blocks and adds a global one before them', () => {
    const text = 'Port 22\nMatch User x\n  PasswordAuthentication no\n'
    expect(passwordAuthSetting(text)).toBe('yes')
    expect(setPasswordAuth(text, 'no')).toBe(
      'Port 22\nPasswordAuthentication no\n\nMatch User x\n  PasswordAuthentication no\n'
    )
    expect(setPasswordAuth('Port 22\n', 'no')).toBe('Port 22\nPasswordAuthentication no\n')
  })
})

// ------------------------------------------------------------ the service

describe('terminal access service', () => {
  let dir: string
  let store: JsonStore<TerminalFile>
  let pc: FakePc
  let svc: TerminalService
  let tsUp = true
  let config: Buffer

  const make = (over: Partial<TerminalDeps> = {}): TerminalService =>
    new TerminalService({
      store,
      dataDir: dir,
      supported: false,
      simulated: true,
      run: pc.run,
      probe: pc.probe,
      tailscale: async () => ({
        installed: true,
        loggedIn: tsUp,
        dnsName: tsUp ? 'ryzen-desktop.tail1234.ts.net' : undefined
      }),
      exists: async () => true,
      user: 'beau',
      env: {
        SystemRoot: 'C:\\Windows',
        ProgramFiles: 'C:\\Program Files',
        ProgramData: 'C:\\ProgramData',
        USERPROFILE: 'C:\\Users\\beau'
      },
      ...over
    })

  /** Prepare and confirm a change, as the dialog's OK button does. */
  const run = async (a: Parameters<TerminalService['prepare']>[0]) => {
    const p = await svc.prepare(a)
    if ('error' in p) return { ok: false, error: p.error }
    return svc.apply(p.token)
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'csd-term-'))
    store = new JsonStore<TerminalFile>(join(dir, 'terminal.json'), dir, emptyTerminalFile)
    config = await readFile(join(FIXTURES, 'ssh', 'sshd_config'))
    pc = fakePc({ config })
    tsUp = true
    svc = make()
  })
  afterEach(async () => {
    await store.flush()
    await rm(dir, { recursive: true, force: true })
  })

  it('shows the script first and changes nothing until confirmed', async () => {
    const p = await svc.prepare({ kind: 'install' })
    expect('token' in p && p.script).toContain('Add-WindowsCapability')
    expect(pc.ran).toHaveLength(0)
    expect((await svc.apply('wrong')).ok).toBe(false)
    expect(pc.ran).toHaveLength(0)
    expect('token' in p && (await svc.apply(p.token)).ok).toBe(true)
    // A token works once.
    expect('token' in p && (await svc.apply(p.token)).ok).toBe(false)
  })

  it('is not ready (phone buttons hidden) until sshd runs, the rule is in, and Tailscale is up', async () => {
    const hidden = async (): Promise<boolean> =>
      !canOpenTerminal(await svc.phoneInfo(), { cwd: 'C:\\x' })
    expect(await hidden()).toBe(true)
    expect((await run({ kind: 'install' })).ok).toBe(true)
    // sshd never starts while something outside Tailscale could reach it.
    expect((await run({ kind: 'service-on' })).error).toMatch(/Tailscale first/)
    expect((await run({ kind: 'firewall-add' })).ok).toBe(true)
    expect((await run({ kind: 'service-on' })).error).toMatch(/Tailscale first/)
    expect((await run({ kind: 'default-rule-disable' })).ok).toBe(true)
    expect(await hidden()).toBe(true)
    const notReady = await svc.phoneInfo()
    expect(notReady.host).toBeUndefined()
    expect(notReady.user).toBeUndefined()
    expect((await run({ kind: 'service-on' })).ok).toBe(true)
    expect(await hidden()).toBe(false)
    // Windows' "any address" rule back on (by hand): not ready, buttons hidden.
    pc.state.defaultRule = { enabled: true }
    expect((await svc.status()).ready).toBe(false)
    pc.state.defaultRule = { enabled: false }
    await svc.status()
    expect(await svc.phoneInfo()).toMatchObject({
      ready: true,
      host: 'ryzen-desktop.tail1234.ts.net',
      user: 'beau',
      port: 22
    })
    tsUp = false
    expect((await svc.status()).ready).toBe(false)
    // An imported conversation never gets the buttons.
    expect(canOpenTerminal({ ...INFO }, { cwd: 'C:\\x', availability: 'imported' })).toBe(false)
    expect(canOpenTerminal({ ...INFO }, { cwd: undefined })).toBe(false)
    expect(canOpenTerminal(null, { cwd: 'C:\\x' })).toBe(false)
  })

  it('backs up the DefaultShell value and restores it (unset → removed)', async () => {
    await run({ kind: 'install' })
    expect((await run({ kind: 'shell-set', shell: 'pwsh' })).ok).toBe(true)
    expect(pc.state.shell).toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe')
    // A second change keeps the value from before the first one.
    expect((await run({ kind: 'shell-set', shell: 'wsl' })).ok).toBe(true)
    expect(store.value.shell).toEqual({
      prevValue: undefined,
      value: 'C:\\Windows\\System32\\bash.exe'
    })
    const p = await svc.prepare({ kind: 'shell-restore' })
    expect('token' in p && p.script).toContain('Remove-ItemProperty')
    expect('token' in p && (await svc.apply(p.token)).ok).toBe(true)
    expect(pc.state.shell).toBeUndefined()
    expect(store.value.shell).toBeUndefined()
  })

  it('restores a DefaultShell that was set before', async () => {
    pc.state.shell = 'C:\\Windows\\System32\\cmd.exe'
    await run({ kind: 'shell-set', shell: 'powershell' })
    await run({ kind: 'shell-restore' })
    expect(pc.state.shell).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(shellKind(pc.state.shell)).toBe('cmd')
  })

  it('backs up sshd_config before turning password login off, and restores it byte for byte', async () => {
    await run({ kind: 'install' })
    expect((await run({ kind: 'password-off' })).ok).toBe(true)
    expect(passwordAuthSetting(pc.state.config!.toString('utf8'))).toBe('no')
    const backup = store.value.sshdConfig!.backupFile
    expect(backup.startsWith(dir)).toBe(true)
    expect((await readFile(backup)).equals(config)).toBe(true)
    expect((await svc.status()).passwordAuth).toBe('no')
    expect((await run({ kind: 'password-restore' })).ok).toBe(true)
    expect(pc.state.config!.equals(config)).toBe(true)
    expect(store.value.sshdConfig).toBeUndefined()
  })

  it('won’t restore sshd_config over changes made after the wizard’s', async () => {
    await run({ kind: 'install' })
    await run({ kind: 'password-off' })
    pc.state.config = Buffer.concat([pc.state.config!, Buffer.from('\n# my own edit\n')])
    const r = await run({ kind: 'password-restore' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/changed after/)
    expect(pc.state.config.toString()).toContain('# my own edit')
  })

  it('refuses an sshd_config that changed between showing and running', async () => {
    await run({ kind: 'install' })
    const p = await svc.prepare({ kind: 'password-off' })
    pc.state.config = Buffer.from('Port 2222\n')
    const r = 'token' in p ? await svc.apply(p.token) : { ok: false }
    expect(r.ok).toBe(false)
    expect(pc.state.config.toString()).toBe('Port 2222\n')
  })

  it('adds a key to the administrators file and removes only that line', async () => {
    await run({ kind: 'install' })
    pc.state.keys.push('ssh-rsa AAAAexisting old-laptop')
    const p = await svc.prepare({ kind: 'key-add', key: KEY })
    expect('token' in p && p.script).toContain(
      'C:\\ProgramData\\ssh\\administrators_authorized_keys'
    )
    expect('token' in p && p.script).toContain("'S-1-5-32-544', 'S-1-5-18'")
    expect('token' in p && p.script).toContain('SetAccessRuleProtection($true, $false)')
    expect('token' in p && (await svc.apply(p.token)).ok).toBe(true)
    expect(store.value.keys[0]).toMatchObject({
      fingerprint: KEY_FP,
      comment: 'iphone-15',
      admin: true
    })
    expect((await run({ kind: 'key-add', key: KEY })).error).toMatch(/already/)
    expect((await svc.status()).lastLogin?.method).toBe('publickey')
    expect((await run({ kind: 'key-remove', fingerprint: KEY_FP })).ok).toBe(true)
    expect(pc.state.keys).toEqual(['ssh-rsa AAAAexisting old-laptop'])
  })

  it('takes a key from a phone only while the PC is waiting, and only after Allow', async () => {
    expect((await svc.proposeKey('iPhone', KEY)).ok).toBe(false)
    svc.listen(true)
    expect((await svc.proposeKey('iPhone', 'not a key')).ok).toBe(false)
    const r = await svc.proposeKey('iPhone', KEY)
    expect(r).toEqual({ ok: true, fingerprint: KEY_FP })
    expect((await svc.status()).pendingKey).toMatchObject({ device: 'iPhone', fingerprint: KEY_FP })
    expect(pc.ran).toHaveLength(0)
    await run({ kind: 'install' })
    expect((await run({ kind: 'key-pending' })).ok).toBe(true)
    expect(store.value.keys).toHaveLength(1)
    expect((await svc.status()).pendingKey).toBeUndefined()
    svc.listen(false)
    expect((await svc.proposeKey('iPhone', KEY)).ok).toBe(false)
  })

  it('turns everything off in one run, undoing only what the wizard changed', async () => {
    await run({ kind: 'install' })
    await run({ kind: 'firewall-add' })
    await run({ kind: 'default-rule-disable' })
    expect((await run({ kind: 'service-on' })).ok).toBe(true)
    await run({ kind: 'shell-set', shell: 'pwsh' })
    await run({ kind: 'key-add', key: KEY })
    await run({ kind: 'password-off' })
    pc.ran.length = 0
    const p = await svc.prepare({ kind: 'turn-off', uninstall: false, removeKeys: false })
    expect('token' in p && p.summary).toContain('SSH keys stay in place')
    expect('token' in p && (await svc.apply(p.token)).ok).toBe(true)
    expect(pc.ran).toHaveLength(1)
    expect(pc.ran[0].parts.map((x) => x.name)).toEqual([
      'sshd-config',
      'shell',
      'default-rule',
      'firewall',
      'service'
    ])
    expect(pc.state).toMatchObject({
      oursRule: false,
      defaultRule: { enabled: true },
      shell: undefined,
      sshdService: { status: 'Stopped', startType: 'Disabled' }
    })
    expect(pc.state.config!.equals(config)).toBe(true)
    expect(pc.state.keys).toHaveLength(1)
    const f = store.value
    expect([f.service, f.firewallRule, f.defaultRuleDisabled, f.shell, f.sshdConfig]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined
    ])
    expect(f.installedByApp).toBe(true)
    // Then the optional extras: remove the keys and uninstall.
    expect((await run({ kind: 'turn-off', uninstall: true, removeKeys: true })).ok).toBe(true)
    expect(pc.state.keys).toHaveLength(0)
    expect(pc.state.sshdExe).toBe(false)
    expect(store.value.installedByApp).toBeUndefined()
    expect(svc.history().some((e) => e.action === 'turn-off')).toBe(true)
  })

  it('puts the service back as it was when the wizard didn’t install OpenSSH', async () => {
    pc = fakePc({ config, installed: true })
    svc = make()
    await run({ kind: 'firewall-add' })
    await run({ kind: 'default-rule-disable' })
    expect((await run({ kind: 'service-on' })).ok).toBe(true)
    await run({ kind: 'turn-off', uninstall: true, removeKeys: false })
    expect(pc.state.sshdService).toEqual({ status: 'Stopped', startType: 'Manual' })
    expect(pc.state.sshdExe).toBe(true)
  })

  it('Undo leaves sshd running if it was running before', async () => {
    pc = fakePc({ config, installed: true })
    pc.state.sshdService = { status: 'Running', startType: 'Manual' }
    svc = make()
    await run({ kind: 'firewall-add' })
    await run({ kind: 'default-rule-disable' })
    await run({ kind: 'service-on' })
    expect(pc.state.sshdService).toEqual({ status: 'Running', startType: 'Automatic' })
    expect((await run({ kind: 'service-undo' })).ok).toBe(true)
    expect(pc.state.sshdService).toEqual({ status: 'Running', startType: 'Manual' })
  })

  it('never takes ownership of a key that was already in the file', async () => {
    await run({ kind: 'install' })
    pc.state.keys.push(KEY.replace('iphone-15', 'added-by-me'))
    const r = await run({ kind: 'key-add', key: KEY })
    expect(r.ok).toBe(true)
    expect(store.value.keys).toHaveLength(0)
    expect(svc.history()[0].detail).toMatch(/already in the file/)
    // So Turn off with "remove keys" leaves it alone.
    expect(pc.state.keys).toHaveLength(1)
  })

  it('refuses the firewall rule without the Tailscale adapter', async () => {
    pc.state.tsAlias = undefined
    expect((await run({ kind: 'firewall-add' })).error).toMatch(/adapter/)
    expect(pc.ran).toHaveLength(0)
  })

  it('won’t switch shells over a DefaultShellCommandOption it doesn’t manage', async () => {
    pc.state.shellOption = '-Command'
    expect((await run({ kind: 'shell-set', shell: 'wsl' })).error).toMatch(/CommandOption/)
  })

  it('forgets the undo records when Windows’ prompt is declined', async () => {
    svc = make({
      run: async () => ({ ok: false, cancelled: true, error: 'declined', parts: [] })
    })
    expect((await run({ kind: 'firewall-add' })).cancelled).toBe(true)
    expect(store.value.firewallRule).toBeUndefined()
    expect(svc.history()[0]).toMatchObject({ ok: false })
    expect(svc.history()[0].detail).toMatch(/declined/)
    // An answer that never came (timeout) keeps them: it may still have run.
    svc = make({
      run: async () => ({ ok: false, unknown: true, error: 'slow', parts: [] })
    })
    await run({ kind: 'firewall-add' })
    expect(store.value.firewallRule).toBe(true)
  })

  it('records an sshd_config change even if sshd then fails to restart', async () => {
    await run({ kind: 'install' })
    const real = pc.run
    svc = make({
      run: async (s) => {
        const r = await real(s)
        r.parts[0] = { ...r.parts[0], restartError: 'service hung' }
        return r
      }
    })
    expect((await run({ kind: 'password-off' })).ok).toBe(true)
    expect(store.value.sshdConfig).toBeDefined()
    expect(svc.history()[0].detail).toMatch(/didn’t restart: service hung/)
  })

  it('shows the exact sshd_config lines that change', async () => {
    await run({ kind: 'install' })
    const p = await svc.prepare({ kind: 'password-off' })
    expect('token' in p && p.summary).toContain('+ PasswordAuthentication no')
    expect('token' in p && p.summary).toMatch(/Line \d+:/)
  })

  it('logs every change, including declined or failed ones', async () => {
    await run({ kind: 'install' })
    await run({ kind: 'default-rule-disable' })
    const log = svc.history()
    expect(log.map((e) => e.action)).toEqual(['default-rule-disable', 'install'])
    expect(log.every((e) => e.ok)).toBe(true)
  })
})

describe('helpers', () => {
  it('maps service start types', () => {
    expect(startTypeFor('AutomaticDelayedStart')).toBe('Automatic')
    expect(startTypeFor('Disabled')).toBe('Disabled')
    expect(startTypeFor(undefined)).toBe('Manual')
  })

  it('names the login user', () => {
    expect(sshUserName({ USERDOMAIN: 'RYZEN', COMPUTERNAME: 'RYZEN' }, 'beau')).toBe('beau')
    expect(sshUserName({ USERDOMAIN: 'CORP', COMPUTERNAME: 'RYZEN' }, 'beau')).toBe('CORP\\beau')
    expect(sshUserName({ USERDOMAIN: 'AzureAD', COMPUTERNAME: 'RYZEN' }, 'beau')).toBe('beau')
  })

  it('reads the probe defensively', () => {
    const p = parseProbe(
      JSON.stringify({
        sshdService: { status: 'Running', startType: 'Automatic' },
        sshdExe: true,
        oursRule: true,
        defaultRule: { enabled: false },
        admin: true,
        configB64: Buffer.from('Port 22\n').toString('base64'),
        events: { at: '2026-10-23T10:00:00Z', message: 'x' },
        eventsOk: true
      })
    )
    expect(p.sshdService?.status).toBe('Running')
    expect(p.config?.toString()).toBe('Port 22\n')
    expect(p.events).toHaveLength(1)
    expect(parseProbe('not json')).toMatchObject({ sshdExe: false, oursRule: false, events: [] })
  })

  it('accepts only known changes from the window', () => {
    expect(parseAction({ kind: 'install', extra: 1 })).toEqual({ kind: 'install' })
    expect(parseAction({ kind: 'shell-set', shell: 'C:\\evil.exe' })).toBeUndefined()
    expect(parseAction({ kind: 'key-remove', fingerprint: KEY_FP })).toEqual({
      kind: 'key-remove',
      fingerprint: KEY_FP
    })
    expect(parseAction({ kind: 'key-remove', fingerprint: 'x' })).toBeUndefined()
    expect(parseAction({ kind: 'turn-off', uninstall: 'yes' })).toEqual({
      kind: 'turn-off',
      uninstall: false,
      removeKeys: false
    })
    expect(parseAction({ kind: 'rm' })).toBeUndefined()
    expect(parseAction(null)).toBeUndefined()
  })

  it('lets a phone read where to connect, and nothing that changes the setup', () => {
    expect(rpcMethod('getTerminalAccess')).toMatchObject({
      channel: 'terminal:phoneInfo',
      kind: 'read'
    })
    const channels = Object.values(RPC).map((m) => m.channel)
    for (const c of ['terminal:prepare', 'terminal:apply', 'terminal:listen', 'terminal:openHere'])
      expect(channels).not.toContain(c)
  })

  it('hashes like the elevated script', () => {
    expect(createHash('sha256').update('x').digest('hex')).toMatch(/^[0-9a-f]{64}$/)
  })
})

// ------------------------------------------------------------ the phone sends a key

describe('a phone offering its SSH key', () => {
  let server: MobileServer
  let reg: DeviceRegistry
  let port = 0
  let readOnly = false
  const offered: [string, unknown][] = []

  function post(
    path: string,
    body: unknown,
    token?: string
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body)
      const r = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path,
          method: 'POST',
          headers: {
            host: `127.0.0.1:${port}`,
            'content-type': 'application/json',
            ...(token ? { authorization: `Bearer ${token}` } : {})
          }
        },
        (res) => {
          let b = ''
          res.on('data', (c: Buffer) => (b += c.toString()))
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }))
        }
      )
      r.on('error', reject)
      r.end(data)
    })
  }

  beforeEach(async () => {
    readOnly = false
    offered.length = 0
    const dir = await mkdtemp(join(tmpdir(), 'csd-key-'))
    reg = new DeviceRegistry(
      new JsonStore<MobileFile>(join(dir, 'mobile.json'), dir, () => ({
        version: 1,
        devices: [],
        activity: []
      }))
    )
    const rl = new RemoteLauncher({
      session: () => undefined,
      preview: async () => {
        throw new Error('no')
      },
      launch: async () => ({ ok: false, restored: false, commandLine: '' }),
      settings: () => ({ terminal: 'wt', readOnly, confirmOnPc: false, branchConfirmed: false }),
      confirm: async () => false,
      deviceActive: () => true,
      log: () => undefined
    })
    server = new MobileServer({
      registry: reg,
      call: async () => null,
      launcher: rl,
      web: { file: async () => undefined },
      flags: () => ({ readOnly, confirmOnPc: false, mode: 'tailscale', appVersion: '1' }),
      hosts: () => allowedHosts({ bind: '127.0.0.1', port, httpsPort: 8443 }),
      changed: () => undefined,
      proposeKey: async (device, key) => {
        offered.push([device, key])
        return { ok: true, fingerprint: KEY_FP }
      }
    })
    await server.start({ host: '127.0.0.1', port: 0 })
    port = server.address()!.port
  })
  afterEach(async () => {
    await server.stop()
  })

  const pair = async (): Promise<string> => {
    const p = reg.startPairing(`http://127.0.0.1:${port}`)
    const r = await post('/api/pair', { code: p.code, name: 'Pixel' })
    return (JSON.parse(r.body) as { token: string }).token
  }

  it('needs a paired phone, is refused in read-only mode, and is logged', async () => {
    expect((await post('/api/ssh-key', { key: KEY })).status).toBe(401)
    const token = await pair()
    readOnly = true
    expect((await post('/api/ssh-key', { key: KEY }, token)).status).toBe(403)
    expect(offered).toHaveLength(0)
    readOnly = false
    const r = await post('/api/ssh-key', { key: KEY }, token)
    expect(r.status).toBe(200)
    expect(JSON.parse(r.body)).toEqual({ ok: true, fingerprint: KEY_FP })
    expect(offered).toEqual([['Pixel', KEY]])
    expect(reg.activity(5)[0]).toMatchObject({ action: 'ssh-key', device: 'Pixel', ok: true })
  })
})
