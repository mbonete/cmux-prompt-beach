// One icon set for the HTML interface and the markers painted into the 3D world,
// plus each agent's look (person and car colours), shared by the world and the list.
// 24×24 grid, drawn as strokes (1.8 in HTML, scaled for the world).

const circle = (cx, cy, r) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${r * 2} 0a${r} ${r} 0 1 0 ${-r * 2} 0`;

export const ICONS = {
  call: ['M6.6 3.8h2.6l1.5 4-2 1.3a10.8 10.8 0 0 0 6.2 6.2l1.3-2 4 1.5v2.6a2 2 0 0 1-2.2 2A15.8 15.8 0 0 1 4.6 6a2 2 0 0 1 2-2.2z'],
  missed: ['M6.6 3.8h2.6l1.5 4-2 1.3a10.8 10.8 0 0 0 6.2 6.2l1.3-2 4 1.5v2.6a2 2 0 0 1-2.2 2A15.8 15.8 0 0 1 4.6 6a2 2 0 0 1 2-2.2z', 'M15 3.5l5 5', 'M20 3.5l-5 5'],
  text: ['M4.5 6.5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H11l-4.5 3.5V16.5h0a2 2 0 0 1-2-2z', 'M8.5 9.5h7', 'M8.5 12.5h4.5'],
  mail: ['M4 6.5h16v11H4z', 'M4.5 7l7.5 6 7.5-6'],
  terminal: ['M4 5.5h16v13H4z', 'M7.5 10l3 2.5-3 2.5', 'M12.8 15.2h3.8'],
  key: [circle(8, 15.5, 4.2), 'M11.2 12.4 19.5 4.1', 'M15.8 7.8l2.6 2.6', 'M13.6 10l2 2'],
  question: ['M9.1 9.2a3 3 0 1 1 4.2 2.8c-.9.4-1.3 1.1-1.3 2v.6', 'M12 18.2v.1'],
  folder: ['M3.5 7.2c0-.9.7-1.7 1.7-1.7h4.1l2 2.1h7.5c.9 0 1.7.7 1.7 1.7v8c0 .9-.8 1.7-1.7 1.7H5.2c-1 0-1.7-.8-1.7-1.7z'],
  branch: [circle(7, 5.8, 2.1), circle(7, 18.2, 2.1), circle(17, 8.2, 2.1), 'M7 8v8', 'M17 10.4c0 4-5.6 3.4-9.2 6'],
  plug: ['M9 3.5V8', 'M15 3.5V8', 'M6.8 8h10.4v2.8a5.2 5.2 0 0 1-10.4 0z', 'M12 16v4.5'],
  chip: ['M7.5 7.5h9v9h-9z', 'M10 3.5v4', 'M14 3.5v4', 'M10 16.5v4', 'M14 16.5v4', 'M3.5 10h4', 'M3.5 14h4', 'M16.5 10h4', 'M16.5 14h4'],
  layers: ['M12 4.5 20 8.6l-8 4.1-8-4.1z', 'M4 12.4l8 4.1 8-4.1', 'M4 16.2l8 4.1 8-4.1'],
  shield: ['M12 3.5 18.8 6v5c0 4.3-2.9 7.6-6.8 9.5-3.9-1.9-6.8-5.2-6.8-9.5V6z'],
  close: ['M6.5 6.5l11 11', 'M17.5 6.5l-11 11'],
  open: ['M7 17 17 7', 'M9 7h8v8'],
  send: ['M4.5 12 19.5 4.5 15 19.5l-3.2-6.3z', 'M11.8 13.2l7.7-8.7'],
  check: ['M5 12.6l4.4 4.4L19 7.4'],
  doc: ['M7 3.5h7l4.5 4.5v12.5H7z', 'M14 3.5V8h4.5', 'M10 13h5.5', 'M10 16.5h5.5'],
  frame: ['M4 9V4h5', 'M15 4h5v5', 'M20 15v5h-5', 'M9 20H4v-5'],
  plus: ['M12 5.5v13', 'M5.5 12h13'],
  minus: ['M5.5 12h13'],
  rotate: ['M19.5 11.5a7.5 7.5 0 1 1-2.2-5.3', 'M19.5 4.5v5h-5'],
  list: ['M4.5 6.5h15', 'M4.5 12h15', 'M4.5 17.5h15'],
  car: ['M5 15.5v-3l1.8-4.2c.3-.7 1-1.1 1.7-1.1h7c.7 0 1.4.4 1.7 1.1l1.8 4.2v3', 'M4 15.5h16v2.5H4z', 'M6.5 12.4h11', 'M7.5 18v1.5', 'M16.5 18v1.5'],
  moon: ['M19.5 14.6A8 8 0 0 1 9.4 4.5a8 8 0 1 0 10.1 10.1z'],
  sun: [circle(12, 12, 4), 'M12 2.8v2', 'M12 19.2v2', 'M2.8 12h2', 'M19.2 12h2', 'M5.5 5.5l1.4 1.4', 'M17.1 17.1l1.4 1.4', 'M5.5 18.5l1.4-1.4', 'M17.1 6.9l1.4-1.4'],
  sunset: ['M3 17.5h18', 'M6.5 17.5a5.5 5.5 0 0 1 11 0', 'M12 6v2.4', 'M5.2 9.6l1.6 1.4', 'M18.8 9.6l-1.6 1.4', 'M8 20.5h8'],
  pin: [circle(12, 10, 2.6), 'M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0 1 13 0c0 4.8-6.5 11-6.5 11z'],
  dnd: [circle(12, 12, 8), 'M8 12h8'],
};

export function icon(name, cls = 'i') {
  const paths = (ICONS[name] || []).map((d) => `<path d="${d}"/>`).join('');
  return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths}</svg>`;
}

// ------------------------------------------------------------------ looks

const SKIN = ['#f6d2b8', '#e9b892', '#cf9469', '#a76b45', '#7c4a2d', '#5a3522'];
const HAIR = ['#1d1612', '#3a2517', '#6a4126', '#c69a5b', '#ead283', '#8c2f30', '#2a2a2e', '#dcdcdc', '#ff5fa2'];
const SHIRT = ['#ff5fa2', '#2fd8ff', '#ffd23f', '#7cff8a', '#ff8a3d', '#b18cff', '#fbf6ec', '#1fb5a8', '#ff4d4d'];
const SHORTS = ['#2b3a67', '#efe5d0', '#38343f', '#5b8bd9', '#c4a484', '#1f6f63'];
const CARS = ['#ff6fae', '#35d6e8', '#fff1d6', '#ffb347', '#9b7bff', '#e8433f', '#2fe6a5', '#f7f7f2', '#ffe066'];

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function look(id) {
  const h = hash(String(id));
  const at = (list, shift) => list[(h >>> shift) % list.length];
  return { skin: at(SKIN, 0), hair: at(HAIR, 3), shirt: at(SHIRT, 7), shorts: at(SHORTS, 11), car: at(CARS, 15), hairStyle: (h >>> 19) % 3 };
}

// The contact portrait: a person in their own colours, ringed in the state colour.
export function portrait(id, lane, cls = 'face') {
  const l = look(id);
  const asleep = lane === 'stale' || lane === 'shells';
  const hair =
    l.hairStyle === 0
      ? `<path d="M10.2 13.6c0-4 2.6-6.2 5.8-6.2s5.8 2.2 5.8 6.2c-1.4-1.9-3.6-2.6-5.8-2.6s-4.4.7-5.8 2.6z" fill="${l.hair}"/>`
      : l.hairStyle === 1
        ? `<path d="M9.8 15.5c-.5-5.4 2-8.4 6.2-8.4s6.7 3 6.2 8.4c-.6-2.4-1.8-4-6.2-4.2-4.4.2-5.6 1.8-6.2 4.2z" fill="${l.hair}"/>`
        : `<circle cx="16" cy="9.8" r="3.4" fill="${l.hair}"/><path d="M10.4 13.2c.6-2.6 2.8-4 5.6-4s5 1.4 5.6 4c-1.6-1.2-3.4-1.6-5.6-1.6s-4 .4-5.6 1.6z" fill="${l.hair}"/>`;
  const eyes = asleep
    ? '<path d="M12.6 15.4h2.4M17 15.4h2.4" stroke="#2a1d1a" stroke-width="1.1" stroke-linecap="round"/>'
    : '<rect x="11.6" y="13.9" width="8.8" height="2.6" rx="1.3" fill="#141018"/>';
  return `<svg class="${cls}" data-lane="${lane}" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><circle class="f-ring" cx="16" cy="16" r="14.6"/><clipPath id="c${hash(id)}"><circle cx="16" cy="16" r="13.6"/></clipPath><g clip-path="url(#c${hash(id)})"><rect width="32" height="32" class="f-bg"/><path d="M5.5 32c.6-6.4 4.8-9.6 10.5-9.6s9.9 3.2 10.5 9.6z" fill="${l.shirt}"/><rect x="14" y="18.6" width="4" height="4.6" rx="1.6" fill="${l.skin}"/><ellipse cx="16" cy="14.2" rx="5.6" ry="6.1" fill="${l.skin}"/>${hair}${eyes}</g></svg>`;
}
