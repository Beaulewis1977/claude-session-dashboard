import { MOD } from './utils'

export const SHORTCUTS: { group: string; items: [string, string][] }[] = [
  {
    group: 'General',
    items: [
      [`${MOD}+K`, 'Command palette'],
      ['/', 'Search sessions'],
      [`${MOD}+,`, 'Settings'],
      [`${MOD}+U`, 'Usage & limits'],
      [`${MOD}+B`, 'Toggle sidebar'],
      ['F5', 'Rescan sources'],
      ['?', 'Keyboard shortcuts']
    ]
  },
  {
    group: 'Session list',
    items: [
      ['↑+↓', 'Previous / next session'],
      ['J+K', 'Next / previous session'],
      ['Home+End', 'First / last session'],
      ['Esc', 'Clear search']
    ]
  },
  {
    group: 'Pick several sessions',
    items: [
      [`${MOD}+Click`, 'Add or remove a session'],
      ['Shift+Click', 'Pick a range'],
      ['Space', 'Pick / unpick the focused session'],
      ['Shift+↑', 'Extend the range up'],
      ['Shift+↓', 'Extend the range down'],
      [`${MOD}+↑`, 'Move the focus up, keep the picks'],
      [`${MOD}+↓`, 'Move the focus down, keep the picks'],
      [`${MOD}+A`, 'Pick every session in the list'],
      ['Esc', 'Clear the picks']
    ]
  },
  {
    group: 'Selected session',
    items: [
      [`${MOD}+Enter`, 'Resume'],
      [`${MOD}+Shift+Enter`, 'Fork'],
      [`${MOD}+F`, 'Find in session'],
      ['F2', 'Rename'],
      ['D', 'Edit description'],
      ['T', 'Add tag'],
      ['H', 'Hide / unhide'],
      [`${MOD}+E`, 'Export to Markdown'],
      [`${MOD}+Shift+C`, 'Copy resume command']
    ]
  }
]
