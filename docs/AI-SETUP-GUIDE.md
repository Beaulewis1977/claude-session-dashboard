# AI setup guide: connecting a phone to Claude Session Dashboard

This guide is for an **AI assistant** (Claude Code or similar) helping someone connect their phone to
the dashboard on their Windows PC. People usually arrive with the app's **Copy AI help prompt** text
(Settings → Phone → Troubleshooting, or Terminal access → Troubleshooting), which includes the app's
own diagnostics.

There are three connections. Find out which one the person is stuck on:

| Connection                | What it does                                                                  | Set up in the app                                                |
| ------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **Phone companion**       | The dashboard in the phone's browser (read sessions, usage, resume on the PC) | Settings → Phone → **Connect your phone…**                       |
| **Remote Control**        | Continue a resumed session in the Claude app / claude.ai/code                 | Same wizard, last step                                           |
| **Terminal access (SSH)** | A real terminal on the PC from an SSH app (Termius, ConnectBot, …)            | Settings → Phone → Terminal access → **Set up terminal access…** |

All three run over the person's own **Tailscale** network (home Wi-Fi is an alternative for the
companion only).

## Rules for the assistant

1. **Read-only first.** Diagnose with the commands below before suggesting any change. They change
   nothing and need no administrator rights.
2. **Ask before any change** to the PC (installing, services, firewall, registry, files under
   `C:\ProgramData\ssh`), show the exact command, and say how to undo it.
3. **Prefer the app's setup screens for changes.** They show the exact script, ask Windows for
   administrator rights, log the change and give it an Undo. Changes made by hand aren't tracked by
   the app's Undo or "Turn off terminal access".
4. **Never** use Tailscale Funnel, open router ports, or allow SSH from any address; never delete or
   rewrite SSH keys or `sshd_config` lines the person added themselves; never run `tailscale serve
reset` or `tailscale up` (they can change unrelated settings).
5. **Never ask for secrets:** no private keys (`-----BEGIN … PRIVATE KEY-----`), passwords, pairing
   codes or tokens. Public keys (`ssh-ed25519 AAAA…`) and fingerprints (`SHA256:…`) are fine.
6. Run Windows tools by **absolute path** (e.g. `$env:SystemRoot\System32\OpenSSH\ssh.exe`): Git for
   Windows puts its own `ssh`, `whoami` and friends on PATH, which behave differently.
7. When you're done, explain what you changed (if anything) and how to undo it.

## Read-only diagnostics (PowerShell)

```powershell
# Tailscale on the PC: signed in? this PC's name? phones online?
& "C:\Program Files\Tailscale\tailscale.exe" status
& "C:\Program Files\Tailscale\tailscale.exe" ip -4
& "C:\Program Files\Tailscale\tailscale.exe" serve status        # companion: an https://…:8443 rule

# OpenSSH Server
Get-Service sshd | Format-List Status, StartType
(Get-ItemProperty HKLM:\SOFTWARE\OpenSSH -ErrorAction SilentlyContinue) | Format-List DefaultShell, DefaultShellCommandOption

# Firewall: the app's Tailscale-only rule, and Windows' default "any address" rule
foreach ($n in 'CSD-SSH-Tailscale', 'OpenSSH-Server-In-TCP') {
  $r = Get-NetFirewallRule -Name $n -ErrorAction SilentlyContinue
  if ($r) { "{0}: enabled={1} remote={2} if={3}" -f $n, $r.Enabled, (($r | Get-NetFirewallAddressFilter).RemoteAddress -join ','), (($r | Get-NetFirewallInterfaceFilter).InterfaceAlias -join ',') }
}

# sshd's log: logins, failed passwords and why connections closed (most useful single check)
Get-WinEvent -LogName 'OpenSSH/Operational' -MaxEvents 30 | Sort-Object TimeCreated |
  ForEach-Object { "{0:HH:mm:ss}  {1}" -f $_.TimeCreated, ($_.Message -replace '\s+', ' ') }

# Which password an SSH login would need, and whether the account is an administrator
Get-LocalUser -Name $env:USERNAME | Format-List Name, PrincipalSource
[bool]((& "$env:SystemRoot\System32\whoami.exe" /groups /fo csv /nh) -match 'S-1-5-32-544')   # True = administrator

# The PC's SSH host key fingerprints (what the phone app shows on first connect)
$o = "$env:SystemRoot\System32\OpenSSH"
& "$o\ssh-keyscan.exe" -t ed25519,ecdsa,rsa 127.0.0.1 2>$null | & "$o\ssh-keygen.exe" -l -f -

# Is the PC set to sleep? (A sleeping PC can't answer.)
powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE | Select-String 'Current AC'   # 0x00000000 = never
```

Notes:

- `administrators_authorized_keys` and the host key files are readable by administrators only, so
  reading them needs an elevated prompt. Usually you don't need to: sshd's log shows which key
  logged in (`Accepted publickey … SHA256:…`) and the keyscan above shows the host keys.
- If the Windows `ssh.exe` client complains about "Bad permissions" on `~/.ssh/config`, that's the
  person's own client config: test with `-F NUL` rather than changing it.
- The app's own diagnostics (in the prompt) already cover most of this, with no secrets.

## Terminal access (SSH): symptoms and fixes

| Symptom (in the SSH app or sshd's log)                                     | Cause                                                                                                                      | Fix                                                                                                                                                                                               |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Times out, nothing in sshd's log                                           | Phone not on Tailscale; PC asleep or off; another VPN on the phone (Android runs one VPN at a time); firewall rule missing | Turn Tailscale on on the phone; wake the PC / turn off sleep; check the `CSD-SSH-Tailscale` rule (wizard step 3)                                                                                  |
| `Failed password for <user>`                                               | Wrong password for the **Windows account**                                                                                 | Local account: its own Windows password. Microsoft account: the Microsoft account password. Never the PIN, never the SSH app's own account or vault password. Easiest: use a key (wizard step 5). |
| `Permission denied (publickey)` / no `Accepted` line                       | The app uses a key the PC doesn't have                                                                                     | Compare the key fingerprint in the app with the wizard's Keys list; add the **public** key in step 5. For administrator accounts only `C:\ProgramData\ssh\administrators_authorized_keys` counts. |
| Key added with the SSH app's "Export key to host" doesn't work             | It wrote `~/.ssh/authorized_keys`, which Windows ignores for administrators                                                | Add the key through the wizard instead                                                                                                                                                            |
| "Trust this host?" fingerprint doesn't match what you expected             | The PC has three host keys (ED25519, ECDSA, RSA) and apps show one of them, sometimes as MD5                               | Compare with the keyscan list above (or the wizard's step 6). If none match, **don't connect** and investigate what answers at that address.                                                      |
| Connects by the PC's LAN address but not… / refused on the LAN address     | SSH answers over Tailscale only, by design                                                                                 | Use the Tailscale host name (`<pc>.<tailnet>.ts.net`) or its `100.x` address                                                                                                                      |
| Lands in cmd.exe, or the folder command fails                              | Default shell not set, or set to another shell                                                                             | Wizard step 4. The phone's "Copy command" is built for the shell set there.                                                                                                                       |
| `sshd` won't start after a change                                          | `sshd_config` problem                                                                                                      | If the wizard changed it: Keys step → Undo (restores the backup). Otherwise check the log.                                                                                                        |
| Server still lists `keyboard-interactive` after turning password login off | Normal on Windows OpenSSH: it has no keyboard-interactive back end, so it can't be used to log in                          | Nothing to do                                                                                                                                                                                     |

Notes on reachability: the app's rule allows sshd only from `100.64.0.0/10` and
`fd7a:115c:a1e0::/48` on the Tailscale adapter, and turns Windows' default "any address" rule off.
Tailscale's own `Tailscale-In` rule allows anything addressed to the PC's Tailscale IP (Tailscale
filters that itself), so WSL and other VMs **on the same PC** can reach it too; LAN devices can't.

## Phone companion and Remote Control: symptoms and fixes

| Symptom                                                  | Fix                                                                                                                                                        |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phone can't open the `https://<pc>.ts.net:8443/` address | Tailscale on on the phone; phone access turned on in Settings → Phone; `tailscale serve status` shows the app's rule.                                      |
| "Tailscale needs HTTPS" / serve fails                    | Turn on HTTPS certificates (and MagicDNS) in the Tailscale admin console, then **Try again** in the wizard.                                                |
| Port already in use                                      | Change the local port or Tailscale HTTPS port under Settings → Phone → Advanced.                                                                           |
| "This phone is not paired"                               | It was revoked or unused for 30 days: show a new pairing code and pair again.                                                                              |
| Remote Control doesn't start                             | Claude Code 2.1.51+ (`claude update`), signed in with a Claude subscription (`claude auth login`), and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` not set. |
| Home Wi-Fi mode: certificate warning or no live updates  | Expected with the self-signed certificate (compare its fingerprint with Settings → Phone). Tailscale mode avoids both.                                     |

## Undo

- **Terminal access:** each change has an Undo in its wizard step; **Turn off terminal access** in
  Settings → Phone undoes everything the wizard changed (optionally removing the keys it added and
  uninstalling OpenSSH if it installed it). The Change log lists every change.
- **Phone companion:** turning phone access off removes only the app's own `tailscale serve` rule.
