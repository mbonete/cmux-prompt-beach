// Switchboard's own icon set: 24 × 24 stroke paths, drawn with currentColor.

export const ICONS = {
  // Tool calls
  edit: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/>',
  command: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m7 9 3 3-3 3M12.5 15H17"/>',
  search: '<circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5 5"/>',
  web: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.6 2.5 3.8 5.3 3.8 8.5s-1.2 6-3.8 8.5c-2.6-2.5-3.8-5.3-3.8-8.5S9.4 6 12 3.5Z"/>',
  read: '<path d="M12 6.5C10 5 7 4.5 4 5v13c3-.5 6 0 8 1.5 2-1.5 5-2 8-1.5V5c-3-.5-6 0-8 1.5Z"/><path d="M12 6.5v13"/>',
  other: '<circle cx="6" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="18" cy="12" r="1.4"/>',
  // Asks
  permission: '<circle cx="8" cy="14" r="4"/><path d="m11 11 8-8M16 6l2.5 2.5M14 8l2 2"/>',
  question: '<path d="M5 18.5V7a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H8.5L5 18.5Z"/><path d="M9 10.5h.01M12 10.5h.01M15 10.5h.01" stroke-width="2.6"/>',
  plan: '<path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20V3.5Z"/><path d="M14 3.5V8h4M10 12h5M10 15.5h5"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m7 9 3 3-3 3M12.5 15H17"/>',
  result: '<circle cx="12" cy="12" r="8.5"/><path d="m8 12.3 2.7 2.7L16.2 9.4"/>',
  // Repo kinds
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.6 2.5 3.8 5.3 3.8 8.5s-1.2 6-3.8 8.5c-2.6-2.5-3.8-5.3-3.8-8.5S9.4 6 12 3.5Z"/>',
  mobile: '<rect x="7" y="3" width="10" height="18" rx="2.5"/><path d="M11 17.5h2"/>',
  book: '<path d="M12 6.5C10 5 7 4.5 4 5v13c3-.5 6 0 8 1.5 2-1.5 5-2 8-1.5V5c-3-.5-6 0-8 1.5Z"/><path d="M12 6.5v13"/>',
  pipeline: '<circle cx="5.5" cy="6.5" r="2"/><circle cx="18.5" cy="12" r="2"/><circle cx="5.5" cy="17.5" r="2"/><path d="M7.5 6.5h3.5a3 3 0 0 1 3 3v0a2.5 2.5 0 0 0 2.5 2.5M7.5 17.5h3.5a3 3 0 0 0 3-3v0a2.5 2.5 0 0 1 2.5-2.5"/>',
  branch: '<circle cx="6" cy="5.5" r="2"/><circle cx="6" cy="18.5" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7.5v9M18 10c0 4-6 3.5-11 7"/>',
  // Rail and HUD
  map: '<path d="M9 4.5 3.5 6.5v13l5.5-2 6 2 5.5-2v-13l-5.5 2-6-2Z"/><path d="M9 4.5v13M15 6.5v13"/>',
  building: '<path d="M5 20.5V8.5l7-4.5 7 4.5v12"/><path d="M3 20.5h18M9.5 20.5v-4a2.5 2.5 0 0 1 5 0v4M9 11h.01M15 11h.01"/>',
  people: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19.5c.6-3.3 2.8-5.2 5.5-5.2s4.9 1.9 5.5 5.2"/><path d="M15.5 5.2a3.2 3.2 0 0 1 0 5.6M17.2 14.6c1.8.6 3 2.3 3.3 4.9"/>',
  inbox: '<path d="M4 13.5 6.3 6a1.5 1.5 0 0 1 1.4-1h8.6a1.5 1.5 0 0 1 1.4 1L20 13.5V18a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18v-4.5Z"/><path d="M4 13.5h4.5l1.2 2.2h4.6l1.2-2.2H20"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  help: '<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.4a2.5 2.5 0 0 1 4.8 1c0 1.7-2.4 2.1-2.4 3.6M12 17h.01"/>',
  volume: '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4Z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  mute: '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4Z"/><path d="m16 9.5 5 5M21 9.5l-5 5"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  arrow: '<path d="M12 4.5 19 19l-7-3.6L5 19l7-14.5Z"/>',
  focus: '<path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15"/><circle cx="12" cy="12" r="2.5"/>',
  move: '<path d="M12 3v18M3 12h18M12 3 9.5 5.5M12 3l2.5 2.5M12 21l-2.5-2.5M12 21l2.5-2.5M3 12l2.5-2.5M3 12l2.5 2.5M21 12l-2.5-2.5M21 12l-2.5 2.5"/>',
  restore: '<rect x="3.5" y="4" width="17" height="4.5" rx="1"/><path d="M5 8.5V19a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8.5M12 17.5v-6M9.5 14 12 11.5l2.5 2.5"/>',
  warning: '<path d="M10.7 4.6a1.5 1.5 0 0 1 2.6 0l7.6 13.2a1.5 1.5 0 0 1-1.3 2.2H4.4a1.5 1.5 0 0 1-1.3-2.2l7.6-13.2Z"/><path d="M12 10v4M12 17h.01"/>',
  pin: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z"/><circle cx="12" cy="10" r="2.3"/>',
  reply: '<path d="M9.5 7.5 4.5 12l5 4.5"/><path d="M5 12h9a5.5 5.5 0 0 1 5.5 5.5V19"/>',
  collapse: '<path d="M10 4v6H4M14 20v-6h6M10 10 4 4M14 14l6 6"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  key: '<circle cx="8" cy="14" r="4"/><path d="m11 11 8-8M16 6l2.5 2.5M14 8l2 2"/>',
  film: '<rect x="3" y="7" width="12.5" height="10" rx="2"/><path d="m15.5 11 5.5-3v8l-5.5-3"/>',
  // UI
  open: '<path d="M14 4h6v6M20 4l-9 9M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  expand: '<path d="M14 4h6v6M10 20H4v-6M20 4l-6.5 6.5M4 20l6.5-6.5"/>',
  archive: '<rect x="3.5" y="4" width="17" height="4.5" rx="1"/><path d="M5 8.5V19a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8.5M10 12.5h4"/>',
  send: '<path d="M4 12 20 4l-4.5 16-3.5-6.5L4 12Z"/><path d="m12 13.5 3.5-3.5"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
} as const;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName, cls = 'i') {
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}

export const KIND_ICON: Record<string, IconName> = { web: 'globe', mobile: 'mobile', docs: 'book', data: 'pipeline', other: 'branch' };
