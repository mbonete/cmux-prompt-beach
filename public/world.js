// The Switchboard city: a sun-soaked coastal grid where every git repository owns one lot,
// every agent is a lit hotel floor plus a person and their car, and what they are doing
// shows the agent's state at a glance.

import * as THREE from '/vendor/three.module.js';
import { ICONS, look } from '/icons.js';

// ------------------------------------------------------------------ layout

const LOT = 12;
const STREET = 5;
const PITCH = LOT + STREET;
const COLS = 4;
const PAD = 0.2; // lot pads sit this high
const LOBBY_H = 2.4;
const FLOOR_H = 2.05;
const MAX_FLOORS = 6;
const LANE = 1.15;
const SHORE = 34;
const FOV = 30;
const ROAD_Y = 0.11;

const lotPos = (i) => ({ x: ((i % COLS) - (COLS - 1) / 2) * PITCH, z: -Math.floor(i / COLS) * PITCH, row: Math.floor(i / COLS), col: i % COLS });
const streetZ = (k) => LOT / 2 + STREET / 2 - k * PITCH; // k = 0 is the beach road
const streetX = (j) => (j - COLS / 2) * PITCH;

export const STATE_COLORS = {
  needs: 0xff3f8e,
  working: 0x2fd8ff,
  move: 0x5dffa8,
  stale: 0x8a84a3,
  shells: 0x5d5670,
};

const NEONS = [0xff4fa3, 0x2fe0ff, 0xc77dff, 0xff8a3d, 0x8dff6a, 0xffe14a];
const PASTELS = [0xffb3c9, 0xa8e6cf, 0xcdb4ff, 0xffd3a5, 0x9fe3e8, 0xfff1a8, 0xffc7a8];

const THEMES = {
  day: {
    sky: [[0, 0xffe8c8], [0.35, 0x9fd4ff], [1, 0x4aa8f0]],
    fog: 0xffe6cc,
    hemi: [0xdcefff, 0xd8c39a, 1.2],
    sun: [0xfff3df, 2.7],
    sunPos: [70, 120, 90],
    grass: 0x86c46a,
    pad: 0xf1e9dc,
    road: 0x44434d,
    sand: 0xf4dcae,
    ocean: 0x1fb3c9,
    swamp: 0x5d7f45,
    water: 0x3f7f72,
    windows: 0.35,
    neon: 1.1,
    lamps: 0,
    exposure: 1.0,
  },
  sunset: {
    sky: [[0, 0xffb25b], [0.3, 0xff5a8a], [0.7, 0x7a2f7a], [1, 0x2a1650]],
    fog: 0xff9a7c,
    hemi: [0xffd8c4, 0x6a4a72, 1.45],
    sun: [0xffc694, 2.3],
    sunPos: [90, 55, 150],
    grass: 0x93c46c,
    pad: 0xf7e6d8,
    road: 0x463b4d,
    sand: 0xf6cfa0,
    ocean: 0x2f6c99,
    swamp: 0x4f6a3e,
    water: 0x3b6475,
    windows: 1,
    neon: 1.6,
    lamps: 0.55,
    exposure: 1.05,
  },
  night: {
    sky: [[0, 0x3d1a4f], [0.4, 0x1c0f38], [1, 0x07051a]],
    fog: 0x24103a,
    hemi: [0x4a4a9a, 0x140a20, 0.65],
    sun: [0x9fb4ff, 0.9],
    sunPos: [-60, 90, 50],
    grass: 0x2d4a37,
    pad: 0x6f6680,
    road: 0x1d1b26,
    sand: 0x7a6a86,
    ocean: 0x0e1d40,
    swamp: 0x203626,
    water: 0x18343f,
    windows: 1.8,
    neon: 2.2,
    lamps: 1,
    exposure: 1.1,
  },
};

// ------------------------------------------------------------------ helpers

function strHash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const damp = (dt, rate) => 1 - Math.exp(-dt * rate);

function angleLerp(a, b, t) {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

const hex = (n) => `#${n.toString(16).padStart(6, '0')}`;

// Merge many transformed primitives into one vertex-coloured geometry (one draw call).
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _c = new THREE.Color();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

function merge(parts) {
  const geos = [];
  let count = 0;
  for (const p of parts) {
    _m.compose(_p.set(p.x || 0, p.y || 0, p.z || 0), _q.setFromEuler(_e.set(p.rx || 0, p.ry || 0, p.rz || 0)), _s.set(p.sx ?? 1, p.sy ?? 1, p.sz ?? 1));
    const g = (p.geo.index ? p.geo.toNonIndexed() : p.geo.clone()).applyMatrix4(_m);
    geos.push([g, p.color]);
    count += g.attributes.position.count;
  }
  const pos = new Float32Array(count * 3);
  const nor = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  let o = 0;
  for (const [g, color] of geos) {
    const n = g.attributes.position.count;
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    _c.set(color);
    for (let i = 0; i < n; i++) {
      col[(o + i) * 3] = _c.r;
      col[(o + i) * 3 + 1] = _c.g;
      col[(o + i) * 3 + 2] = _c.b;
    }
    o += n;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.computeBoundingSphere();
  return out;
}

function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

const glowTexture = () =>
  canvasTexture(64, 64, (g, s) => {
    const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.3, 'rgba(255,255,255,0.45)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, s, s);
  });

const columnTexture = () =>
  canvasTexture(4, 128, (g, w, h) => {
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.55, 'rgba(255,255,255,0.35)');
    grad.addColorStop(1, 'rgba(255,255,255,0.9)');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
  });

const blindsTexture = () =>
  canvasTexture(64, 64, (g, w, h) => {
    g.fillStyle = '#d8cbb2';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#a99a80';
    for (let y = 0; y < h; y += 8) g.fillRect(0, y, w, 2);
  });

function neonSign(text, color) {
  return canvasTexture(1024, 300, (g, w, h) => {
    let size = 190;
    g.font = `${size}px "Yellowtail", cursive`;
    while (g.measureText(text).width > w - 120 && size > 60) {
      size -= 8;
      g.font = `${size}px "Yellowtail", cursive`;
    }
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const css = hex(color);
    g.shadowColor = css;
    for (const blur of [60, 28, 12]) {
      g.shadowBlur = blur;
      g.fillStyle = css;
      g.fillText(text, w / 2, h / 2 + 6);
    }
    g.shadowBlur = 0;
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(255,255,255,0.85)';
    g.strokeText(text, w / 2, h / 2 + 6);
  });
}

function boardTexture(lines, bg, fg) {
  return canvasTexture(512, 300, (g, w, h) => {
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    g.strokeStyle = fg;
    g.lineWidth = 14;
    g.strokeRect(14, 14, w - 28, h - 28);
    g.fillStyle = fg;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = '120px "Anton", Impact, sans-serif';
    g.fillText(lines[0], w / 2, h * 0.42);
    if (lines[1]) {
      g.font = '46px "Anton", Impact, sans-serif';
      g.fillText(lines[1], w / 2, h * 0.78);
    }
  });
}

const BADGE_ICON = { permission: 'call', question: 'text', plan: 'mail', terminal: 'terminal', result: 'missed' };

function badgeTexture(kind) {
  return canvasTexture(160, 160, (g, s) => {
    g.beginPath();
    g.arc(s / 2, s / 2, 62, 0, Math.PI * 2);
    g.shadowColor = 'rgba(255, 63, 142, 0.95)';
    g.shadowBlur = 22;
    g.fillStyle = '#ff3f8e';
    g.fill();
    g.shadowBlur = 0;
    g.lineWidth = 7;
    g.strokeStyle = '#fff4f9';
    g.stroke();
    g.save();
    g.translate(s / 2 - 42, s / 2 - 42);
    g.scale(3.5, 3.5);
    g.lineWidth = 2.2;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.strokeStyle = '#ffffff';
    for (const d of ICONS[BADGE_ICON[kind] || 'missed']) g.stroke(new Path2D(d));
    g.restore();
  });
}

// ------------------------------------------------------------------ shared kit

function makeKit() {
  const geo = {
    box: new THREE.BoxGeometry(1, 1, 1),
    cyl: new THREE.CylinderGeometry(1, 1, 1, 10),
    cyl6: new THREE.CylinderGeometry(1, 1, 1, 6),
    cone: new THREE.ConeGeometry(1, 1, 7),
    cone4: new THREE.ConeGeometry(1, 1, 4),
    sphere: new THREE.SphereGeometry(1, 14, 10),
    capsule: new THREE.CapsuleGeometry(1, 1, 4, 8),
    disc: new THREE.CircleGeometry(1, 28),
    ring: new THREE.RingGeometry(0.8, 1, 40),
    column: new THREE.CylinderGeometry(1, 1, 1, 24, 1, true),
    plane: new THREE.PlaneGeometry(1, 1),
  };
  const glass = 0x1c2740;
  const mat = {
    vc: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72, metalness: 0.04 }),
    vcFlat: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true }),
    head: new THREE.MeshBasicMaterial({ color: 0xfff6d8, toneMapped: false }),
    win: {
      needs: new THREE.MeshStandardMaterial({ color: glass, emissive: 0xffc77a, emissiveIntensity: 1, roughness: 0.25, metalness: 0.5 }),
      working: new THREE.MeshStandardMaterial({ color: glass, emissive: 0xffd58a, emissiveIntensity: 1, roughness: 0.25, metalness: 0.5 }),
      move: new THREE.MeshStandardMaterial({ color: glass, emissive: 0xffe6bd, emissiveIntensity: 0.5, roughness: 0.25, metalness: 0.5 }),
      stale: null,
      empty: new THREE.MeshStandardMaterial({ color: glass, roughness: 0.25, metalness: 0.5 }),
    },
    trim: {},
  };
  const kit = { geo, mat, glow: glowTexture(), column: columnTexture(), blinds: blindsTexture(), badges: {}, signs: [] };
  mat.win.stale = new THREE.MeshStandardMaterial({ color: 0xffffff, map: kit.blinds, roughness: 0.9 });
  for (const [state, color] of Object.entries(STATE_COLORS)) {
    const lit = state !== 'stale' && state !== 'shells';
    mat.trim[state] = new THREE.MeshStandardMaterial({ color: lit ? color : 0x3a3446, emissive: color, emissiveIntensity: lit ? 2 : 0, toneMapped: !lit });
  }
  // Shared resources are never disposed when a lot is rebuilt.
  for (const g of Object.values(geo)) g.userData.shared = true;
  for (const m of [mat.vc, mat.vcFlat, mat.head, ...Object.values(mat.win), ...Object.values(mat.trim)]) m.userData.shared = true;
  return kit;
}

// ------------------------------------------------------------------ the world

export function createWorld(container, { onSelect, onHover, reducedMotion, theme = 'sunset' }) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  } catch {
    return null;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.domElement.className = 'world-canvas';
  renderer.domElement.setAttribute('aria-hidden', 'true');
  container.appendChild(renderer.domElement);

  const labelsLayer = document.createElement('div');
  labelsLayer.className = 'world-labels';
  container.appendChild(labelsLayer);

  const kit = makeKit();
  const badgeMat = (kind) => {
    if (!kit.badges[kind]) kit.badges[kind] = new THREE.SpriteMaterial({ map: badgeTexture(kind), sizeAttenuation: false, depthTest: false, transparent: true });
    return kit.badges[kind];
  };

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.5, 3000);
  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
  const sun = new THREE.DirectionalLight(0xffffff, 2.5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.04;
  scene.add(hemi, sun, sun.target);

  const env = new THREE.Group();
  const city = new THREE.Group();
  scene.add(env, city);
  const pickables = [];

  const state = {
    theme: THEMES[theme] ? theme : 'sunset',
    reduced: Boolean(reducedMotion),
    lots: [], // index -> lot
    lotOf: new Map(), // repo key -> lot index
    units: new Map(), // agent id -> unit
    rows: 1,
    selected: null,
    hovered: null,
    follow: false,
    hqFlash: 0,
    blink: 0,
    orderSeq: 0,
  };

  // Lots keep their place across reloads.
  const remembered = (() => {
    try {
      return JSON.parse(localStorage.getItem('switchboard.lots') || '{}');
    } catch {
      return {};
    }
  })();
  const remember = () => {
    try {
      const out = {};
      for (const [key, i] of state.lotOf) out[key] = i;
      localStorage.setItem('switchboard.lots', JSON.stringify(out));
    } catch {
      // Not persisted; positions still hold for this visit.
    }
  };

  // ------------------------------------------------------------ camera rig

  let viewW = 1;
  let viewH = 1;
  const insets = { left: 0, right: 0, top: 0, bottom: 0 };
  const offset = { x: 0, y: 0 };
  let lastInteract = 0;
  const poke = () => {
    lastInteract = performance.now();
  };

  const cam = {
    cur: { x: 0, z: 0, dist: 120, yaw: 0.28, pitch: 1.02 },
    des: { x: 0, z: 0, dist: 120, yaw: 0.28, pitch: 1.02 },
  };

  function applyOffset(k) {
    const tx = (insets.left - insets.right) / 2;
    const ty = (insets.top - insets.bottom) / 2;
    const nx = offset.x + (tx - offset.x) * k;
    const ny = offset.y + (ty - offset.y) * k;
    if (Math.abs(nx - offset.x) < 0.05 && Math.abs(ny - offset.y) < 0.05 && camera.view) return;
    offset.x = nx;
    offset.y = ny;
    camera.setViewOffset(viewW, viewH, -offset.x, -offset.y, viewW, viewH);
  }

  function placeCamera() {
    const c = cam.cur;
    const cp = Math.cos(c.pitch);
    camera.position.set(c.x + c.dist * cp * Math.sin(c.yaw), c.dist * Math.sin(c.pitch), c.z + c.dist * cp * Math.cos(c.yaw));
    camera.lookAt(c.x, 0, c.z);
  }

  function clampDesired() {
    const d = cam.des;
    d.dist = Math.min(320, Math.max(14, d.dist));
    d.pitch = Math.min(1.35, Math.max(0.6, d.pitch));
    d.x = Math.max(-90, Math.min(90, d.x));
    d.z = Math.max(streetZ(state.rows) - 40, Math.min(SHORE + 20, d.z));
  }

  const snap = () => Object.assign(cam.cur, cam.des);

  function flyTo(x, z, dist, pitch = 0.98) {
    poke();
    Object.assign(cam.des, { x, z, dist, pitch });
    clampDesired();
    if (state.reduced) snap();
  }

  // Fit the occupied blocks plus the beach into the area the panels leave free.
  function frameAll(instant = false) {
    const used = state.lots.map((l, i) => (l?.key || l?.forSale ? i : -1)).filter((i) => i >= 0);
    const rows = used.length ? Math.max(...used.map((i) => lotPos(i).row)) + 1 : 1;
    const pts = [];
    for (const x of [streetX(0), streetX(COLS)]) for (const z of [streetZ(0) + 13, streetZ(rows)]) pts.push([x, z]);
    const yaw = cam.des.yaw;
    const pitch = 1.02;
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    let u0 = Infinity;
    let u1 = -Infinity;
    let v0 = Infinity;
    let v1 = -Infinity;
    for (const [x, z] of pts) {
      const u = x * rx + z * rz;
      const v = x * fx + z * fz;
      u0 = Math.min(u0, u);
      u1 = Math.max(u1, u);
      v0 = Math.min(v0, v);
      v1 = Math.max(v1, v);
    }
    const cu = (u0 + u1) / 2;
    const cv = (v0 + v1) / 2;
    const tan = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
    const freeW = Math.max(160, viewW - insets.left - insets.right);
    const freeH = Math.max(160, viewH - insets.top - insets.bottom);
    const hFit = (u1 - u0) / 2 / (tan * camera.aspect * (freeW / viewW));
    const vFit = (((v1 - v0) / 2) * Math.sin(pitch) + 6) / (tan * (freeH / viewH));
    Object.assign(cam.des, { x: cu * rx + cv * fx, z: cu * rz + cv * fz, dist: Math.max(hFit, vFit) * 1.12, pitch });
    state.follow = false;
    clampDesired();
    poke();
    if (instant || state.reduced) snap();
  }

  // ------------------------------------------------------------ environment

  function clearGroup(g) {
    for (const child of [...g.children]) {
      g.remove(child);
      child.traverse?.((o) => {
        if (!o.isSprite && o.geometry && !o.geometry.userData.shared) o.geometry.dispose();
        if (o.material && !Array.isArray(o.material) && !o.material.userData.shared) o.material.dispose();
      });
    }
  }

  const lampGlows = [];

  function palmParts(parts, x, z, h, lean, seed) {
    const r = rng(seed);
    const segs = 6;
    let px = x;
    let pz = z;
    let py = 0;
    const dirA = r() * Math.PI * 2;
    for (let i = 0; i < segs; i++) {
      const seg = h / segs;
      const k = (i / segs) ** 2 * lean;
      const nx = x + Math.cos(dirA) * k;
      const nz = z + Math.sin(dirA) * k;
      parts.push({ geo: kit.geo.cyl6, x: (px + nx) / 2, y: py + seg / 2, z: (pz + nz) / 2, sx: 0.2 - i * 0.015, sy: seg * 1.05, sz: 0.2 - i * 0.015, color: i % 2 ? 0x8a6a48 : 0x9c7a55 });
      px = nx;
      pz = nz;
      py += seg;
    }
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + r() * 0.4;
      const len = 2.4 + r() * 0.8;
      parts.push({ geo: kit.geo.cone4, x: px + Math.cos(a) * len * 0.42, y: py - 0.35, z: pz + Math.sin(a) * len * 0.42, sx: 0.42, sy: len, sz: 0.1, rz: Math.PI / 2 + 0.5, ry: -a, color: i % 2 ? 0x2f8a4b : 0x3fa35a });
    }
    parts.push({ geo: kit.geo.sphere, x: px, y: py - 0.1, z: pz, sx: 0.32, sy: 0.25, sz: 0.32, color: 0x6b4a2c });
  }

  function buildEnvironment() {
    clearGroup(env);
    lampGlows.length = 0;
    const t = THEMES[state.theme];
    const R = state.rows;
    const backZ = streetZ(R) - STREET / 2;
    const wide = 1400;

    // Sky dome with several gradient stops.
    const skyGeo = new THREE.SphereGeometry(2200, 32, 16);
    const p = skyGeo.attributes.position;
    const cols = [];
    const stops = t.sky.map(([at, c]) => [at, new THREE.Color(c)]);
    for (let i = 0; i < p.count; i++) {
      const k = Math.min(1, Math.max(0, p.getY(i) / 2200 + 0.05));
      let c = stops[stops.length - 1][1];
      for (let s = 0; s < stops.length - 1; s++) {
        if (k <= stops[s + 1][0]) {
          c = stops[s][1].clone().lerp(stops[s + 1][1], (k - stops[s][0]) / (stops[s + 1][0] - stops[s][0]));
          break;
        }
      }
      cols.push(c.r, c.g, c.b);
    }
    skyGeo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    env.add(new THREE.Mesh(skyGeo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false })));

    // Ground: grass inland, sand, sea.
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(wide * 2, wide * 2), new THREE.MeshStandardMaterial({ color: t.grass, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    env.add(ground);
    const beachFront = streetZ(0) + STREET / 2;
    const sand = new THREE.Mesh(new THREE.PlaneGeometry(wide * 2, SHORE - beachFront + 2), new THREE.MeshStandardMaterial({ color: t.sand, roughness: 1 }));
    sand.rotation.x = -Math.PI / 2;
    sand.position.set(0, 0.03, (SHORE + beachFront) / 2);
    sand.receiveShadow = true;
    const ocean = new THREE.Mesh(new THREE.PlaneGeometry(wide * 2, wide), new THREE.MeshStandardMaterial({ color: t.ocean, roughness: 0.2, metalness: 0.25 }));
    ocean.rotation.x = -Math.PI / 2;
    ocean.position.set(0, 0.04, SHORE + wide / 2);
    const foam = new THREE.Mesh(kit.geo.box, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, transparent: true, opacity: 0.8 }));
    foam.scale.set(wide * 2, 0.06, 1.1);
    foam.position.set(0, 0.07, SHORE + 0.3);
    env.add(sand, ocean, foam);

    // Swamp behind the last row: dark ground, still water, cypress, airboats.
    const swamp = new THREE.Mesh(new THREE.PlaneGeometry(wide * 2, 600), new THREE.MeshStandardMaterial({ color: t.swamp, roughness: 1 }));
    swamp.rotation.x = -Math.PI / 2;
    swamp.position.set(0, 0.01, backZ - 302);
    swamp.receiveShadow = true;
    env.add(swamp);
    const wet = [];
    const dry = [];
    const r = rng(R * 977 + 13);
    for (let i = 0; i < 26; i++) {
      const x = (r() - 0.5) * 220;
      const z = backZ - 10 - r() * 150;
      const s = 5 + r() * 12;
      wet.push({ geo: kit.geo.disc, x, y: 0.04, z, rx: -Math.PI / 2, sx: s, sy: s * (0.5 + r() * 0.5), sz: 1, color: t.water });
    }
    for (let i = 0; i < 120; i++) {
      const x = (r() - 0.5) * 260;
      const z = backZ - 6 - r() * 170;
      const h = 3 + r() * 5;
      dry.push({ geo: kit.geo.cyl6, x, y: h * 0.3, z, sx: 0.22, sy: h * 0.6, sz: 0.22, color: 0x5a4632 });
      dry.push({ geo: kit.geo.cone, x, y: h * 0.75, z, sx: 1.3 + r(), sy: h * 0.75, sz: 1.3 + r(), color: r() < 0.5 ? 0x3d6b3a : 0x4e7d43 });
    }
    for (let i = 0; i < 5; i++) {
      const x = -60 + i * 30 + r() * 10;
      const z = backZ - 14 - r() * 30;
      const ry = r() * Math.PI;
      dry.push({ geo: kit.geo.box, x, y: 0.25, z, sx: 1.6, sy: 0.35, sz: 3.6, ry, color: 0xe8e2d0 });
      dry.push({ geo: kit.geo.cyl, x: x - Math.sin(ry) * 1.6, y: 1.1, z: z - Math.cos(ry) * 1.6, sx: 0.9, sy: 0.25, sz: 0.9, rx: Math.PI / 2, ry, color: 0x3a3a3a });
    }
    const wetMesh = new THREE.Mesh(merge(wet), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.15, metalness: 0.3 }));
    const dryMesh = new THREE.Mesh(merge(dry), kit.mat.vcFlat);
    dryMesh.castShadow = true;
    env.add(wetMesh, dryMesh);

    // Streets, lot pads and the low-rise city either side of the grid.
    const flat = [];
    for (let k = 0; k <= R; k++) {
      const z = streetZ(k);
      flat.push({ geo: kit.geo.box, x: 0, y: 0.05, z, sx: 260, sy: 0.1, sz: STREET, color: t.road });
      for (let x = -128; x < 128; x += 4) flat.push({ geo: kit.geo.box, x: x + 1, y: 0.11, z, sx: 1.6, sy: 0.02, sz: 0.16, color: 0xf2d27a });
    }
    for (let j = 0; j <= COLS; j++) {
      const x = streetX(j);
      const z0 = streetZ(R) - STREET / 2;
      const z1 = streetZ(0) + STREET / 2;
      flat.push({ geo: kit.geo.box, x, y: 0.06, z: (z0 + z1) / 2, sx: STREET, sy: 0.1, sz: z1 - z0, color: t.road });
      for (let z = z0 + 2; z < z1 - 2; z += 4) flat.push({ geo: kit.geo.box, x, y: 0.12, z, sx: 0.16, sy: 0.02, sz: 1.6, color: 0xf2d27a });
    }
    for (let i = 0; i < R * COLS; i++) {
      const lp = lotPos(i);
      flat.push({ geo: kit.geo.box, x: lp.x, y: PAD / 2, z: lp.z, sx: LOT + 0.6, sy: PAD, sz: LOT + 0.6, color: t.pad });
    }
    const bg = rng(R * 31 + 7);
    for (let k = 0; k < R; k++) {
      for (const side of [-1, 1]) {
        for (let n = 1; n <= 3; n++) {
          const x = side * (streetX(COLS) + n * PITCH - PITCH / 2);
          const z = -k * PITCH;
          flat.push({ geo: kit.geo.box, x, y: PAD / 2, z, sx: LOT + 0.6, sy: PAD, sz: LOT + 0.6, color: t.pad });
          const h = 2 + Math.floor(bg() * 2) * 1.6;
          const color = new THREE.Color(PASTELS[Math.floor(bg() * PASTELS.length)]).lerp(new THREE.Color(t.pad), 0.45).getHex();
          flat.push({ geo: kit.geo.box, x, y: PAD + h / 2, z: z - 0.5, sx: 8 + bg() * 2, sy: h, sz: 7, color });
          flat.push({ geo: kit.geo.box, x, y: PAD + h + 0.1, z: z - 0.5, sx: 8.6, sy: 0.2, sz: 7.4, color: 0xfaf6ee });
        }
      }
    }
    const flatMesh = new THREE.Mesh(merge(flat), kit.mat.vc);
    flatMesh.receiveShadow = true;
    flatMesh.castShadow = true;
    env.add(flatMesh);

    // Palms on the beach road and the avenues; street lamps at the crossings.
    const palms = [];
    const pr = rng(4242 + R);
    for (let x = -130; x <= 130; x += 7 + pr() * 4) palmParts(palms, x, beachFront + 1.6, 6 + pr() * 3, 1.2 + pr(), Math.floor(pr() * 1e6));
    for (let i = 0; i < 26; i++) {
      const x = (pr() - 0.5) * 200;
      if (Math.abs(x) < 5) continue;
      palmParts(palms, x, beachFront + 8 + pr() * 14, 5 + pr() * 4, 1 + pr() * 1.6, Math.floor(pr() * 1e6));
    }
    for (let j = 0; j <= COLS; j++) {
      for (let k = 0; k < R; k++) palmParts(palms, streetX(j) + STREET / 2 + 0.8, streetZ(k) - PITCH / 2, 5.5 + pr() * 2, 0.6, Math.floor(pr() * 1e6));
    }
    for (let j = 0; j <= COLS; j++) {
      for (let k = 0; k <= R; k++) {
        const x = streetX(j) - STREET / 2 - 0.4;
        const z = streetZ(k) - STREET / 2 - 0.4;
        palms.push({ geo: kit.geo.cyl6, x, y: 2.2, z, sx: 0.09, sy: 4.4, sz: 0.09, color: 0x2a2633 });
        palms.push({ geo: kit.geo.box, x: x + 0.5, y: 4.35, z, sx: 1.1, sy: 0.12, sz: 0.25, color: 0x2a2633 });
        const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: kit.glow, color: 0xffc27a, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: t.lamps }));
        glow.position.set(x + 0.95, 4.2, z);
        glow.scale.setScalar(3.4);
        glow.visible = t.lamps > 0;
        lampGlows.push(glow);
        env.add(glow);
      }
    }
    const palmMesh = new THREE.Mesh(merge(palms), kit.mat.vcFlat);
    palmMesh.castShadow = true;
    env.add(palmMesh);

    // Lights, fog, exposure, emissive strength.
    hemi.color.setHex(t.hemi[0]);
    hemi.groundColor.setHex(t.hemi[1]);
    hemi.intensity = t.hemi[2];
    sun.color.setHex(t.sun[0]);
    sun.intensity = t.sun[1];
    scene.fog = new THREE.Fog(t.fog, 200, 900);
    scene.background = new THREE.Color(t.fog);
    renderer.toneMappingExposure = t.exposure;
    for (const k of ['needs', 'working']) kit.mat.win[k].emissiveIntensity = t.windows;
    kit.mat.win.move.emissiveIntensity = t.windows * 0.45;
    tuneSigns();
    fitShadow();
  }

  function tuneSigns() {
    const t = THEMES[state.theme];
    for (const s of kit.signs) {
      s.material.color.setScalar(Math.min(1.6, t.neon) / 1.6 + 0.35);
      if (s.userData.halo) s.userData.halo.material.opacity = Math.max(0, (t.neon - 1) * 0.5);
    }
  }

  function fitShadow() {
    const t = THEMES[state.theme];
    const span = Math.max(60, state.rows * PITCH + 50);
    const cz = (streetZ(0) + streetZ(state.rows)) / 2;
    const dir = new THREE.Vector3(...t.sunPos).normalize();
    sun.position.set(dir.x * 200, dir.y * 200, cz + dir.z * 200);
    sun.target.position.set(0, 0, cz);
    const sc = sun.shadow.camera;
    sc.left = -span;
    sc.right = span;
    sc.top = span;
    sc.bottom = -span;
    sc.near = 10;
    sc.far = 500;
    sc.updateProjectionMatrix();
  }

  // ------------------------------------------------------------ HQ: the dispatch tower on the beach

  const hq = new THREE.Group();
  (function buildHQ() {
    const parts = [];
    const x = 0;
    const z = streetZ(0) + STREET / 2 + 9;
    parts.push({ geo: kit.geo.box, x, y: 0.3, z, sx: 5, sy: 0.6, sz: 5, color: 0xf4efe6 });
    parts.push({ geo: kit.geo.cyl, x, y: 2.4, z, sx: 1.4, sy: 3.6, sz: 1.4, color: 0xffffff });
    parts.push({ geo: kit.geo.cyl, x, y: 4.5, z, sx: 2.4, sy: 0.8, sz: 2.4, color: 0x2fd8ff });
    parts.push({ geo: kit.geo.cyl, x, y: 5.2, z, sx: 2.6, sy: 0.25, sz: 2.6, color: 0xffffff });
    parts.push({ geo: kit.geo.cyl6, x, y: 7.2, z, sx: 0.08, sy: 4, sz: 0.08, color: 0xd9d9d9 });
    for (let i = 0; i < 3; i++) parts.push({ geo: kit.geo.box, x, y: 6.2 + i * 0.9, z, sx: 1.6 - i * 0.4, sy: 0.06, sz: 0.06, color: 0xd9d9d9 });
    const mesh = new THREE.Mesh(merge(parts), kit.mat.vc);
    mesh.castShadow = true;
    hq.add(mesh);
    const light = new THREE.Sprite(new THREE.SpriteMaterial({ map: kit.glow, color: 0xff3f8e, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    light.position.set(x, 9.3, z);
    light.scale.setScalar(3);
    hq.add(light);
    hq.userData.light = light;
    hq.traverse((o) => {
      o.userData.hq = true;
    });
    scene.add(hq);
    pickables.push(hq);
  })();

  // ------------------------------------------------------------ lots

  function styleOf(index, hangout) {
    if (hangout) return 'motel';
    const row = lotPos(index).row;
    return row === 0 ? 'deco' : row === 1 ? 'tower' : 'stilt';
  }

  function makeSign(text, color, w = 10) {
    const mat = new THREE.SpriteMaterial({ map: neonSign(text, color), transparent: true, depthWrite: false, toneMapped: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(w, w * 0.293, 1);
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: kit.glow, color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.3 }));
    halo.scale.set(w * 1.1, w * 0.5, 1);
    sprite.userData.halo = halo;
    kit.signs.push(sprite);
    return sprite;
  }

  function dropSign(sprite) {
    const i = kit.signs.indexOf(sprite);
    if (i >= 0) kit.signs.splice(i, 1);
    sprite.material.map?.dispose();
  }

  // (Re)build a lot's building for its current floor count.
  function buildLot(lot) {
    for (const s of lot.ownSigns) dropSign(s);
    lot.ownSigns = [];
    clearGroup(lot.group);
    const pi = pickables.indexOf(lot.group);
    if (pi >= 0) pickables.splice(pi, 1);
    lot.floors = [];

    const { x, z } = lotPos(lot.index);
    const n = Math.min(MAX_FLOORS, lot.agentCount);
    const parts = [];
    const style = lot.style;
    const tone = lot.tone;
    const by = z - 0.8; // building centre, a little back from the street
    let top = PAD;
    let signY = 0;
    let signX = x;
    let signZ = by + 1;
    let signW = 12;
    const floorSlots = [];

    if (lot.forSale || !lot.key) {
      parts.push({ geo: kit.geo.box, x, y: PAD + 0.02, z, sx: LOT - 0.6, sy: 0.04, sz: LOT - 0.6, color: 0xd8c39a });
      if (lot.forSale) {
        const board = new THREE.Mesh(kit.geo.plane, new THREE.MeshStandardMaterial({ map: boardTexture(['FOR SALE', 'lot open'], '#fff6e8', '#e2366f'), roughness: 0.8 }));
        board.scale.set(4, 2.35, 1);
        board.position.set(x, 2.6, z + 3);
        board.castShadow = true;
        lot.group.add(board);
        parts.push({ geo: kit.geo.box, x: x - 1.6, y: 1.3, z: z + 2.95, sx: 0.15, sy: 2.6, sz: 0.15, color: 0xffffff });
        parts.push({ geo: kit.geo.box, x: x + 1.6, y: 1.3, z: z + 2.95, sx: 0.15, sy: 2.6, sz: 0.15, color: 0xffffff });
      }
      palmParts(parts, x - 3.5, z - 2.5, 6, 1, lot.index * 17 + 3);
    } else if (style === 'deco') {
      const W = 9;
      const D = 7;
      const lobby = new THREE.Color(tone).lerp(new THREE.Color(0xffffff), 0.35).getHex();
      parts.push({ geo: kit.geo.box, x, y: PAD + LOBBY_H / 2, z: by, sx: W + 0.4, sy: LOBBY_H, sz: D + 0.4, color: lobby });
      parts.push({ geo: kit.geo.box, x, y: PAD + 1.9, z: by + D / 2 + 0.9, sx: 3.8, sy: 0.18, sz: 1.8, color: 0xffffff });
      parts.push({ geo: kit.geo.box, x, y: PAD + 0.8, z: by + D / 2 + 0.22, sx: 1.8, sy: 1.6, sz: 0.1, color: 0x1d2235 });
      for (let f = 0; f < n; f++) {
        const y0 = PAD + LOBBY_H + f * FLOOR_H;
        parts.push({ geo: kit.geo.box, x, y: y0 + FLOOR_H / 2, z: by, sx: W, sy: FLOOR_H, sz: D, color: tone });
        parts.push({ geo: kit.geo.box, x, y: y0 + FLOOR_H - 0.05, z: by, sx: W + 0.55, sy: 0.16, sz: D + 0.55, color: 0xffffff });
        floorSlots.push({ y: y0 + FLOOR_H * 0.52, w: W - 1.4, h: 0.9, d: D + 0.06, x, z: by, trimZ: by + D / 2 + 0.06, trimY: y0 + 0.42 });
      }
      top = PAD + LOBBY_H + n * FLOOR_H;
      const H = top - PAD;
      for (const sx of [-1, 1]) parts.push({ geo: kit.geo.box, x: x + sx * (W / 2 - 0.25), y: PAD + H / 2, z: by + D / 2 + 0.05, sx: 0.5, sy: H, sz: 0.5, color: 0xffffff });
      parts.push({ geo: kit.geo.box, x, y: top + 0.15, z: by, sx: W + 0.3, sy: 0.3, sz: D + 0.3, color: 0xffffff });
      parts.push({ geo: kit.geo.box, x, y: top + 1.3, z: by + D / 2 - 0.4, sx: 1.2, sy: 2.4, sz: 0.8, color: 0xffffff });
      for (let s = 0; s < 3; s++) parts.push({ geo: kit.geo.box, x, y: top + 0.6 + s * 0.65, z: by + D / 2 + 0.02, sx: 1.25, sy: 0.14, sz: 0.1, color: tone });
      signY = top + 3.6;
    } else if (style === 'tower') {
      const W = 8.4;
      const D = 6.6;
      parts.push({ geo: kit.geo.box, x, y: PAD + LOBBY_H / 2, z: by, sx: W, sy: LOBBY_H, sz: D, color: 0x2a3550 });
      parts.push({ geo: kit.geo.box, x, y: PAD + LOBBY_H - 0.1, z: by, sx: W + 0.4, sy: 0.2, sz: D + 0.4, color: 0xe9e4dc });
      for (let f = 0; f < n; f++) {
        const y0 = PAD + LOBBY_H + f * FLOOR_H;
        parts.push({ geo: kit.geo.box, x, y: y0 + FLOOR_H / 2, z: by, sx: W, sy: FLOOR_H, sz: D, color: 0xe2ddd4 });
        floorSlots.push({ y: y0 + FLOOR_H * 0.5, w: W - 0.7, h: 1.35, d: D + 0.06, x, z: by, trimZ: by + D / 2 + 0.06, trimY: y0 + 0.2 });
      }
      top = PAD + LOBBY_H + n * FLOOR_H;
      parts.push({ geo: kit.geo.box, x, y: top + 0.2, z: by, sx: W + 0.2, sy: 0.4, sz: D + 0.2, color: 0xcfc8bd });
      parts.push({ geo: kit.geo.box, x: x + 2, y: top + 0.9, z: by - 1, sx: 2.2, sy: 1, sz: 1.8, color: 0xb8b2a8 });
      parts.push({ geo: kit.geo.cyl6, x: x - 2.6, y: top + 2.4, z: by - 1.6, sx: 0.08, sy: 4, sz: 0.08, color: 0xcccccc });
      signY = top + 2.6;
    } else if (style === 'stilt') {
      const W = 8;
      const D = 6;
      const stilt = 1.8;
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) parts.push({ geo: kit.geo.cyl6, x: x + sx * (W / 2 - 0.4), y: PAD + stilt / 2, z: by + sz * (D / 2 - 0.4), sx: 0.22, sy: stilt, sz: 0.22, color: 0x6b4f35 });
      parts.push({ geo: kit.geo.box, x, y: PAD + stilt, z: by + 0.8, sx: W + 1.6, sy: 0.18, sz: D + 2.4, color: 0x9a7650 });
      // Pond, dock and an airboat in the yard.
      parts.push({ geo: kit.geo.disc, x: x + 3.4, y: PAD + 0.03, z: z + 3.6, rx: -Math.PI / 2, sx: 2.4, sy: 1.6, sz: 1, color: THEMES[state.theme].water });
      parts.push({ geo: kit.geo.box, x: x + 3.4, y: PAD + 0.4, z: z + 2.3, sx: 0.5, sy: 0.12, sz: 2.4, color: 0x9a7650 });
      parts.push({ geo: kit.geo.box, x: x + 3.4, y: PAD + 0.2, z: z + 4, sx: 1.1, sy: 0.25, sz: 2, color: 0xe8e2d0 });
      parts.push({ geo: kit.geo.cyl, x: x + 3.4, y: PAD + 0.85, z: z + 3.1, sx: 0.6, sy: 0.15, sz: 0.6, rx: Math.PI / 2, color: 0x333333 });
      for (let f = 0; f < n; f++) {
        const y0 = PAD + stilt + 0.1 + f * FLOOR_H;
        parts.push({ geo: kit.geo.box, x, y: y0 + FLOOR_H / 2, z: by, sx: W, sy: FLOOR_H, sz: D, color: tone });
        parts.push({ geo: kit.geo.box, x, y: y0 + FLOOR_H - 0.06, z: by, sx: W + 0.3, sy: 0.12, sz: D + 0.3, color: 0x7a5a3c });
        floorSlots.push({ y: y0 + FLOOR_H * 0.55, w: W - 2, h: 0.8, d: D + 0.06, x, z: by, trimZ: by + D / 2 + 0.06, trimY: y0 + 0.3 });
      }
      top = PAD + stilt + 0.1 + n * FLOOR_H;
      parts.push({ geo: kit.geo.cone4, x, y: top + 0.9, z: by, sx: W * 0.75, sy: 1.8, sz: D * 0.75, ry: Math.PI / 4, color: 0x8a5a3a });
      signY = top + 3;
    } else {
      // Motel: one room per agent side by side, a pool, and a pylon sign.
      const roomW = 1.75;
      const rooms = Math.max(1, n);
      const W = rooms * roomW + 2.6;
      const left = x - W / 2;
      parts.push({ geo: kit.geo.box, x: left + 1.3, y: PAD + 1.5, z: by - 1, sx: 2.6, sy: 3, sz: 5, color: 0xfff1a8 });
      for (let f = 0; f < rooms; f++) {
        const rx = left + 2.6 + f * roomW + roomW / 2;
        parts.push({ geo: kit.geo.box, x: rx, y: PAD + 1.2, z: by - 1, sx: roomW - 0.08, sy: 2.4, sz: 5, color: f % 2 ? tone : 0xfaf3e6 });
        parts.push({ geo: kit.geo.box, x: rx - 0.35, y: PAD + 0.85, z: by + 1.52, sx: 0.55, sy: 1.6, sz: 0.06, color: 0x2a2f45 });
        if (f < n) floorSlots.push({ y: PAD + 1.4, w: 0.65, h: 0.75, d: 5.06, x: rx + 0.4, z: by - 1, trimZ: by + 1.55, trimY: PAD + 2.25, trimW: roomW - 0.2 });
      }
      parts.push({ geo: kit.geo.box, x, y: PAD + 2.5, z: by - 1, sx: W + 0.4, sy: 0.2, sz: 5.8, color: 0xffffff });
      parts.push({ geo: kit.geo.box, x: x - 1, y: PAD + 0.08, z: z + 3.6, sx: 5, sy: 0.08, sz: 2.6, color: 0x39c6e0 });
      parts.push({ geo: kit.geo.box, x: x + W / 2 + 0.3, y: 3.4, z: z + 4.3, sx: 0.3, sy: 6.8, sz: 0.3, color: 0x2a2633 });
      top = PAD + 2.6;
      signY = 7.4;
      signX = x + W / 2 + 0.3;
      signZ = z + 4.3;
      signW = 7;
    }

    const mesh = new THREE.Mesh(merge(parts), kit.mat.vc);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    lot.group.add(mesh);
    lot.group.userData.lotIndex = lot.index;
    pickables.push(lot.group);

    // Per-agent floors: a window band and a neon trim, coloured by state.
    for (const slot of floorSlots) {
      const win = new THREE.Mesh(kit.geo.box, kit.mat.win.empty);
      win.scale.set(slot.w, slot.h, slot.d);
      win.position.set(slot.x, slot.y, slot.z);
      const trim = new THREE.Mesh(kit.geo.box, kit.mat.trim.stale);
      trim.scale.set(slot.trimW ?? slot.w + 0.6, 0.1, 0.1);
      trim.position.set(slot.x, slot.trimY, slot.trimZ);
      lot.group.add(win, trim);
      lot.floors.push({ win, trim, slot });
    }

    if (lot.key && !lot.forSale) {
      const sign = makeSign(lot.name, lot.neon, signW);
      sign.position.set(signX, signY, signZ);
      sign.userData.halo.position.copy(sign.position);
      lot.group.add(sign.userData.halo, sign);
      lot.ownSigns.push(sign);
      if (lot.agentCount > MAX_FLOORS) {
        const more = makeSign(`+${lot.agentCount - MAX_FLOORS}`, 0xffffff, 3.4);
        more.position.set(signX + 5.4, signY - 0.6, signZ);
        more.userData.halo.visible = false;
        lot.group.add(more);
        lot.ownSigns.push(more);
      }
      tuneSigns();
    }
    lot.top = top;
    lot.builtFor = `${lot.agentCount}|${lot.forSale}|${lot.style}|${lot.key}`;
  }

  function ensureLot(index) {
    let lot = state.lots[index];
    if (!lot) {
      const group = new THREE.Group();
      city.add(group);
      lot = { index, key: null, name: '', group, floors: [], ownSigns: [], agentCount: 0, forSale: false, style: 'deco', tone: PASTELS[index % PASTELS.length], neon: NEONS[index % NEONS.length], builtFor: '' };
      state.lots[index] = lot;
    }
    return lot;
  }

  function relink() {
    for (const u of state.units.values()) {
      u.floor = u.lot?.floors[u.rank] || null;
      applyLook(u);
    }
  }

  // ------------------------------------------------------------ agents: floor + car + person

  function personParts(l) {
    const P = (geo, x, y, z, sx, sy, sz, color, extra = {}) => ({ geo, x, y, z, sx, sy, sz, color, ...extra });
    const g = kit.geo;
    const torso = merge([P(g.capsule, 0, 0, 0, 0.2, 0.26, 0.15, l.shirt), P(g.box, 0, -0.26, 0, 0.36, 0.14, 0.24, l.shorts)]);
    const leg = merge([P(g.capsule, 0, -0.2, 0, 0.075, 0.26, 0.075, l.skin), P(g.box, 0, -0.4, 0.04, 0.12, 0.07, 0.2, 0xf4f4f4), P(g.cyl, 0, -0.03, 0, 0.09, 0.14, 0.09, l.shorts)]);
    const arm = merge([P(g.capsule, 0, -0.2, 0, 0.06, 0.24, 0.06, l.skin), P(g.cyl, 0, -0.02, 0, 0.085, 0.12, 0.085, l.shirt)]);
    const hairParts =
      l.hairStyle === 0
        ? [P(g.sphere, 0, 0.06, -0.02, 0.2, 0.17, 0.2, l.hair)]
        : l.hairStyle === 1
          ? [P(g.sphere, 0, 0.05, -0.03, 0.21, 0.2, 0.21, l.hair), P(g.box, 0, -0.08, -0.13, 0.36, 0.3, 0.1, l.hair)]
          : [P(g.sphere, 0, 0.06, -0.02, 0.2, 0.15, 0.2, l.hair), P(g.sphere, 0, 0.2, -0.1, 0.1, 0.1, 0.1, l.hair)];
    const head = merge([P(g.sphere, 0, 0, 0, 0.18, 0.2, 0.18, l.skin), ...hairParts, P(g.box, 0, 0.0, 0.16, 0.3, 0.06, 0.04, 0x141018)]);
    return { torso, leg, arm, head };
  }

  function makePerson(l) {
    const parts = personParts(l);
    const root = new THREE.Group();
    const rig = new THREE.Group();
    root.add(rig);
    const mk = (geo) => {
      const m = new THREE.Mesh(geo, kit.mat.vc);
      m.castShadow = true;
      return m;
    };
    const legs = [-1, 1].map((s) => {
      const pivot = new THREE.Group();
      pivot.position.set(s * 0.09, 0.47, 0);
      pivot.add(mk(s < 0 ? parts.leg : parts.leg.clone()));
      rig.add(pivot);
      return pivot;
    });
    const torso = mk(parts.torso);
    torso.position.y = 0.78;
    rig.add(torso);
    const arms = [-1, 1].map((s) => {
      const pivot = new THREE.Group();
      pivot.position.set(s * 0.25, 0.98, 0);
      pivot.add(mk(s < 0 ? parts.arm : parts.arm.clone()));
      rig.add(pivot);
      return pivot;
    });
    const head = new THREE.Group();
    head.position.y = 1.27;
    head.add(mk(parts.head));
    rig.add(head);
    const phone = new THREE.Mesh(kit.geo.box, new THREE.MeshStandardMaterial({ color: 0x15121c, emissive: 0x4fd0ff, emissiveIntensity: 0.6 }));
    phone.scale.set(0.05, 0.16, 0.09);
    phone.position.set(0, -0.42, 0.05);
    arms[1].add(phone);
    root.scale.setScalar(1.15);
    return { root, rig, legs, arms, head, phone, torso };
  }

  function makeCar(l) {
    const g = kit.geo;
    const body = merge([
      { geo: g.box, y: 0.42, sx: 1.12, sy: 0.42, sz: 2.35, color: l.car },
      { geo: g.box, y: 0.8, z: -0.12, sx: 1.0, sy: 0.38, sz: 1.15, color: 0x1b2232 },
      { geo: g.box, y: 1.0, z: -0.12, sx: 1.02, sy: 0.05, sz: 1.17, color: l.car },
      { geo: g.box, y: 0.26, z: 1.2, sx: 1.16, sy: 0.14, sz: 0.1, color: 0xf2f2f2 },
      { geo: g.box, y: 0.26, z: -1.2, sx: 1.16, sy: 0.14, sz: 0.1, color: 0xf2f2f2 },
      ...[-1, 1].flatMap((sx) => [-1, 1].map((sz) => ({ geo: g.cyl, x: sx * 0.55, y: 0.26, z: sz * 0.74, sx: 0.26, sy: 0.18, sz: 0.26, rz: Math.PI / 2, color: 0x16151a }))),
    ]);
    const root = new THREE.Group();
    const bodyMesh = new THREE.Mesh(body, kit.mat.vc);
    bodyMesh.castShadow = true;
    root.add(bodyMesh);
    const heads = new THREE.Mesh(merge([-1, 1].map((sx) => ({ geo: g.box, x: sx * 0.38, y: 0.46, z: 1.18, sx: 0.24, sy: 0.12, sz: 0.06, color: 0xffffff }))), kit.mat.head);
    const tailMat = new THREE.MeshStandardMaterial({ color: 0x7a0f1a, emissive: 0xff2b3d, emissiveIntensity: 0.6 });
    const tails = new THREE.Mesh(merge([-1, 1].map((sx) => ({ geo: g.box, x: sx * 0.38, y: 0.46, z: -1.18, sx: 0.24, sy: 0.12, sz: 0.06, color: 0xffffff }))), tailMat);
    const hazards = new THREE.Mesh(
      merge([-1, 1].flatMap((sx) => [-1, 1].map((sz) => ({ geo: g.box, x: sx * 0.56, y: 0.5, z: sz * 1.12, sx: 0.08, sy: 0.1, sz: 0.14, color: 0xffffff })))),
      new THREE.MeshBasicMaterial({ color: 0xffa21f, toneMapped: false }),
    );
    hazards.visible = false;
    const cover = new THREE.Mesh(
      merge([
        { geo: g.box, y: 0.48, sx: 1.25, sy: 0.85, sz: 2.5, color: 0x9aa6b8 },
        { geo: g.box, y: 0.95, z: -0.1, sx: 1.05, sy: 0.3, sz: 1.4, color: 0x9aa6b8 },
      ]),
      kit.mat.vcFlat,
    );
    cover.castShadow = true;
    cover.visible = false;
    root.add(heads, tails, hazards, cover);
    return { root, bodyMesh, heads, tails, tailMat, hazards, cover };
  }

  // Marker for an agent that needs you: a light column, a ground ring and a badge that
  // keeps the same size on screen at any zoom.
  function makeMarker(id) {
    const g = new THREE.Group();
    const column = new THREE.Mesh(
      kit.geo.column,
      new THREE.MeshBasicMaterial({ map: kit.column, color: STATE_COLORS.needs, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false }),
    );
    column.scale.set(1.5, 7, 1.5);
    column.position.y = 3.5;
    column.rotation.x = Math.PI;
    const ring = new THREE.Mesh(kit.geo.ring, new THREE.MeshBasicMaterial({ color: STATE_COLORS.needs, transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.06;
    ring.scale.setScalar(1.7);
    const badge = new THREE.Sprite(badgeMat('result'));
    badge.scale.set(0.034, 0.034, 1);
    badge.center.set(0.5, 0);
    badge.position.y = 7.4;
    badge.renderOrder = 10;
    badge.userData.unitId = id;
    g.add(column, ring, badge);
    return { group: g, column, ring, badge };
  }

  const selRing = new THREE.Mesh(kit.geo.ring, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthWrite: false, toneMapped: false }));
  selRing.rotation.x = -Math.PI / 2;
  selRing.visible = false;
  scene.add(selRing);

  const floorOutline = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ color: 0xffffff, toneMapped: false }));
  floorOutline.visible = false;
  scene.add(floorOutline);

  // Parked along the kerb in front of its lot, facing west.
  function homeSpot(u) {
    const lp = lotPos(u.lot.index);
    const slot = u.rank % MAX_FLOORS;
    return { pos: new THREE.Vector3(lp.x + 4.6 - slot * 1.9, 0, streetZ(lp.row) - LANE), heading: -Math.PI / 2 };
  }

  function doorSpot(u) {
    const lp = lotPos(u.lot.index);
    const spread = ((u.rank % 3) - 1) * 0.8;
    const front = { deco: lp.z + 3.9, tower: lp.z + 3.4, stilt: lp.z + 5.7, motel: lp.z + 1.3 }[u.lot.style] ?? lp.z + 3.9;
    return new THREE.Vector3(lp.x + spread, PAD, front);
  }

  // Beside the driver's door, on the kerb side of the car.
  function curbside(u) {
    const h = u.carHeading;
    return u.carPos.clone().add(new THREE.Vector3(-Math.cos(h), 0, Math.sin(h)).multiplyScalar(1.3)).setY(PAD);
  }

  function makeUnit(entry) {
    const l = look(entry.id);
    const person = makePerson(l);
    const car = makeCar(l);
    person.root.userData.unitId = entry.id;
    car.root.userData.unitId = entry.id;
    city.add(person.root, car.root);
    pickables.push(person.root, car.root);
    return {
      id: entry.id,
      person,
      car,
      lot: null,
      rank: 0,
      floor: null,
      lane: null,
      beacon: null,
      title: entry.title,
      laneLabel: entry.laneLabel,
      marker: null,
      carPos: new THREE.Vector3(),
      carHeading: -Math.PI / 2,
      carMode: 'parked', // parked | out | home | stopped
      route: [],
      seg: null,
      prevInter: null,
      personPos: new THREE.Vector3(),
      personHeading: 0,
      personMode: 'hidden', // hidden | walk | stand
      personTarget: null,
      personAfter: null,
      flash: 0,
      phase: Math.random() * 10,
      placed: false,
      order: 0,
    };
  }

  function removeUnit(u) {
    city.remove(u.person.root, u.car.root);
    for (const o of [u.person.root, u.car.root]) {
      const i = pickables.indexOf(o);
      if (i >= 0) pickables.splice(i, 1);
    }
    if (u.marker) city.remove(u.marker.group);
    state.units.delete(u.id);
    if (state.hovered === u.id) state.hovered = null;
  }

  // ------------------------------------------------------------ sync from data

  function sync(entries) {
    const byRepo = new Map();
    for (const e of entries) {
      const key = e.repoKey || '__hangout';
      if (!byRepo.has(key)) byRepo.set(key, { name: e.repoKey ? e.repoName : 'hangout', list: [] });
      byRepo.get(key).list.push(e);
    }

    // Closed repos put their lot up for sale; new repos take a remembered lot or the first free one.
    for (const [key, index] of [...state.lotOf]) {
      if (byRepo.has(key)) continue;
      state.lotOf.delete(key);
      const lot = state.lots[index];
      if (lot) {
        lot.key = null;
        lot.forSale = true;
        lot.agentCount = 0;
      }
    }
    const taken = new Set(state.lotOf.values());
    for (const key of byRepo.keys()) {
      if (state.lotOf.has(key)) continue;
      let index = Number.isInteger(remembered[key]) && !taken.has(remembered[key]) ? remembered[key] : -1;
      if (index < 0) {
        index = 0;
        while (taken.has(index)) index += 1;
      }
      state.lotOf.set(key, index);
      taken.add(index);
    }
    remember();

    const maxIndex = Math.max(-1, ...state.lotOf.values(), ...state.lots.map((l, i) => (l?.forSale ? i : -1)));
    const rows = Math.max(1, Math.ceil((maxIndex + 1) / COLS));
    const rowsChanged = rows !== state.rows;
    state.rows = rows;

    for (let i = 0; i < rows * COLS; i++) ensureLot(i);
    for (const [key, { name, list }] of byRepo) {
      const lot = ensureLot(state.lotOf.get(key));
      lot.key = key;
      lot.name = name;
      lot.forSale = false;
      lot.agentCount = list.length;
      lot.style = styleOf(lot.index, key === '__hangout');
      lot.neon = key === '__hangout' ? 0xffe14a : NEONS[strHash(key) % NEONS.length];
      lot.tone = PASTELS[strHash(key) % PASTELS.length];
    }
    for (const lot of state.lots) {
      if (!lot) continue;
      if (!lot.key && !lot.forSale) lot.agentCount = 0;
      if (`${lot.agentCount}|${lot.forSale}|${lot.style}|${lot.key}` !== lot.builtFor) buildLot(lot);
    }

    // Units keep their rank (and floor) in order of first sight within the repo.
    const seen = new Set();
    for (const [key, { list }] of byRepo) {
      const lot = state.lots[state.lotOf.get(key)];
      const pairs = list.map((e) => {
        let u = state.units.get(e.id);
        if (!u) {
          u = makeUnit(e);
          u.order = ++state.orderSeq;
          state.units.set(e.id, u);
        }
        return [u, e];
      });
      pairs.sort((a, b) => a[0].order - b[0].order);
      pairs.forEach(([u, e], rank) => {
        seen.add(u.id);
        const moved = u.lot !== lot || u.rank !== rank;
        u.lot = lot;
        u.rank = rank;
        u.floor = lot.floors[rank] || null;
        u.title = e.title;
        u.laneLabel = e.laneLabel;
        u.lane = e.lane;
        u.beacon = e.beacon;
        if (!u.placed || moved) placeUnit(u);
        applyLook(u);
      });
    }
    for (const [id, u] of state.units) if (!seen.has(id)) removeUnit(u);

    if (rowsChanged || !env.children.length) buildEnvironment();
    if (state.selected && !state.units.has(state.selected)) select(null);
  }

  // Put a unit where its state says it should be, without animation.
  function placeUnit(u) {
    const home = homeSpot(u);
    u.carPos.copy(home.pos);
    u.carHeading = home.heading;
    u.carMode = 'parked';
    u.route = [];
    u.seg = null;
    if (u.lane === 'move') {
      u.personMode = 'stand';
      u.personPos.copy(doorSpot(u));
      u.personHeading = 0;
    } else if (u.lane === 'needs') {
      u.personMode = 'stand';
      u.personPos.copy(curbside(u));
    } else {
      u.personMode = 'hidden';
    }
    u.placed = true;
  }

  function applyLook(u) {
    const lane = u.lane;
    if (u.floor) {
      u.floor.win.material = kit.mat.win[lane] || kit.mat.win.empty;
      u.floor.trim.material = kit.mat.trim[lane] || kit.mat.trim.stale;
      u.floor.win.userData.unitId = u.id;
      u.floor.trim.userData.unitId = u.id;
    }
    const needs = lane === 'needs';
    if (needs && !u.marker) {
      u.marker = makeMarker(u.id);
      city.add(u.marker.group);
    }
    if (u.marker) {
      u.marker.group.visible = needs;
      if (needs) u.marker.badge.material = badgeMat(u.beacon || 'result');
    }
  }

  // ------------------------------------------------------------ driving

  const inter = (j, k) => new THREE.Vector3(streetX(j), 0, streetZ(k));
  const nearestJ = (x) => Math.max(0, Math.min(COLS, Math.round(x / PITCH + COLS / 2)));
  const nearestK = (z) => Math.max(0, Math.min(state.rows, Math.round((LOT / 2 + STREET / 2 - z) / PITCH)));

  // Keep to the right-hand lane between two street-centre points.
  function setSegment(u, a, b) {
    const d = b.clone().sub(a).setY(0).normalize();
    const off = new THREE.Vector3(-d.z, 0, d.x).multiplyScalar(LANE);
    u.seg = { a: a.clone().add(off), b: b.clone().add(off), center: b.clone(), t: 0 };
    u.seg.a = u.carPos.clone();
    u.seg.len = Math.max(0.01, u.seg.a.distanceTo(u.seg.b));
  }

  function wander(u, from) {
    const j = nearestJ(from.x);
    const k = nearestK(from.z);
    const options = [
      [j + 1, k],
      [j - 1, k],
      [j, k + 1],
      [j, k - 1],
    ].filter(([a, b]) => a >= 0 && a <= COLS && b >= 0 && b <= state.rows);
    const back = u.prevInter;
    const fresh = options.filter(([a, b]) => !back || a !== back[0] || b !== back[1]);
    const pool = fresh.length ? fresh : options;
    const [nj, nk] = pool[Math.floor(Math.random() * pool.length)];
    u.prevInter = [j, k];
    return inter(nj, nk);
  }

  function routeHome(u, from) {
    const lp = lotPos(u.lot.index);
    const tj = lp.col + 1;
    const tk = lp.row;
    let j = nearestJ(from.x);
    let k = nearestK(from.z);
    const pts = [];
    while (k !== tk) {
      k += Math.sign(tk - k);
      pts.push(inter(j, k));
    }
    while (j !== tj) {
      j += Math.sign(tj - j);
      pts.push(inter(j, k));
    }
    pts.push('park');
    return pts;
  }

  function updateCar(u, dt) {
    const lane = u.lane;
    const personIn = u.personMode === 'hidden';

    if (state.reduced) {
      const home = homeSpot(u);
      u.carPos.copy(home.pos);
      u.carHeading = home.heading;
      u.carMode = 'parked';
      u.seg = null;
    } else if (u.carMode === 'parked') {
      if (lane === 'working' && personIn) {
        // Pull out westward to the corner, then roam.
        const lp = lotPos(u.lot.index);
        setSegment(u, inter(lp.col + 1, lp.row), inter(lp.col, lp.row));
        u.prevInter = [lp.col + 1, lp.row];
        u.carMode = 'out';
      }
    } else if (u.carMode === 'out') {
      if (lane === 'needs') u.carMode = 'stopped';
      else if (lane !== 'working') {
        u.route = routeHome(u, u.seg.center);
        u.carMode = 'home';
      }
    } else if (u.carMode === 'stopped') {
      if (lane === 'working' && personIn) u.carMode = 'out';
      else if (lane !== 'working' && lane !== 'needs' && personIn) {
        u.route = routeHome(u, u.seg.center);
        u.carMode = 'home';
      }
    } else if (u.carMode === 'home' && lane === 'working' && personIn) {
      u.carMode = 'out';
      u.route = [];
    }

    if ((u.carMode === 'out' || u.carMode === 'home') && u.seg) {
      u.seg.t += (6.5 * dt) / u.seg.len;
      if (u.seg.t >= 1) {
        u.carPos.copy(u.seg.b);
        const from = u.seg.center;
        if (u.seg.final) {
          u.carMode = 'parked';
          u.seg = null;
        } else if (u.carMode === 'out') {
          setSegment(u, from, wander(u, from));
        } else {
          const next = u.route.shift();
          if (next === 'park' || next === undefined) {
            const spot = homeSpot(u).pos;
            u.seg = { a: u.carPos.clone(), b: spot.clone(), center: from, t: 0, final: true };
            u.seg.len = Math.max(0.01, u.seg.a.distanceTo(u.seg.b));
          } else {
            setSegment(u, from, next);
          }
        }
      }
      if (u.seg) {
        const target = u.seg.a.clone().lerp(u.seg.b, Math.min(1, u.seg.t));
        const d = target.clone().sub(u.carPos);
        if (d.lengthSq() > 1e-6) u.carHeading = angleLerp(u.carHeading, Math.atan2(d.x, d.z), damp(dt, 9));
        u.carPos.copy(target);
      }
    }
    if (u.carMode === 'parked' && !state.reduced) {
      const home = homeSpot(u);
      u.carHeading = angleLerp(u.carHeading, home.heading, damp(dt, 6));
    }

    const c = u.car;
    c.root.position.set(u.carPos.x, ROAD_Y, u.carPos.z);
    c.root.rotation.y = u.carHeading;
    const covered = lane === 'stale' && u.carMode === 'parked';
    c.cover.visible = covered;
    c.bodyMesh.visible = !covered;
    c.heads.visible = !covered;
    c.tails.visible = !covered;
    const hazard = lane === 'needs' && (u.carMode === 'stopped' || u.carMode === 'parked');
    c.hazards.visible = hazard && (state.reduced || Math.floor(state.blink * 2.2) % 2 === 0);
    if (u.flash > 0) u.flash = Math.max(0, u.flash - dt * 2.4);
    c.tailMat.emissiveIntensity = 0.6 + u.flash * 5;
  }

  // ------------------------------------------------------------ people

  const tmp = new THREE.Vector3();

  function updatePerson(u, dt, time) {
    const lane = u.lane;
    const p = u.person;
    const door = doorSpot(u);
    const carStill = u.carMode === 'parked' || u.carMode === 'stopped';

    if (state.reduced) {
      if (lane === 'move') {
        u.personMode = 'stand';
        u.personPos.copy(door);
      } else if (lane === 'needs') {
        u.personMode = 'stand';
        u.personPos.copy(curbside(u));
      } else {
        u.personMode = 'hidden';
      }
    } else if (lane === 'working') {
      if (u.personMode !== 'hidden' && !(u.personMode === 'walk' && u.personAfter === 'hide')) {
        u.personMode = 'walk';
        u.personTarget = curbside(u);
        u.personAfter = 'hide';
      }
    } else if (lane === 'needs') {
      if (u.personMode === 'hidden' && carStill) {
        u.personMode = 'stand';
        u.personPos.copy(curbside(u));
      } else if (u.personMode === 'walk' && u.personAfter !== 'phone') {
        u.personTarget = curbside(u);
        u.personAfter = 'phone';
      }
    } else if (lane === 'move') {
      if (u.personMode === 'hidden' && u.carMode === 'parked') {
        u.personPos.copy(curbside(u));
        u.personMode = 'walk';
        u.personTarget = door.clone();
        u.personAfter = 'stand';
      } else if (u.personMode === 'stand' && u.personPos.distanceToSquared(door) > 0.05) {
        u.personMode = 'walk';
        u.personTarget = door.clone();
        u.personAfter = 'stand';
      }
    } else if (u.personMode !== 'hidden' && u.personAfter !== 'hide') {
      // Stale: go inside.
      u.personMode = 'walk';
      u.personTarget = door.clone();
      u.personAfter = 'hide';
    }

    let walking = false;
    if (u.personMode === 'walk' && u.personTarget) {
      tmp.subVectors(u.personTarget, u.personPos).setY(0);
      const dist = tmp.length();
      if (dist < 0.06) {
        u.personPos.copy(u.personTarget);
        u.personMode = u.personAfter === 'hide' ? 'hidden' : 'stand';
      } else {
        u.personPos.addScaledVector(tmp, Math.min(1, (2 * dt) / dist));
        u.personHeading = angleLerp(u.personHeading, Math.atan2(tmp.x, tmp.z), damp(dt, 10));
        walking = true;
      }
    }

    p.root.visible = u.personMode !== 'hidden';
    if (!p.root.visible) return;
    if (!walking) {
      let want = 0;
      if (lane === 'needs') {
        tmp.copy(camera.position).sub(u.personPos);
        want = Math.atan2(tmp.x, tmp.z);
      }
      u.personHeading = state.reduced ? want : angleLerp(u.personHeading, want, damp(dt, 5));
    }
    p.root.position.copy(u.personPos);
    p.rig.rotation.y = u.personHeading;

    const t = time + u.phase;
    const [la, ra] = p.arms;
    const [ll, rl] = p.legs;
    let bob = 0;
    let legSwing = 0;
    let laX = 0;
    let raX = 0;
    let laZ = 0.08;
    let raZ = -0.08;
    let headTurn = 0;
    p.phone.visible = false;
    if (!state.reduced && walking) {
      const s = Math.sin(t * 9);
      legSwing = s * 0.55;
      laX = -s * 0.5;
      raX = s * 0.5;
      bob = Math.abs(s) * 0.04;
    } else if (lane === 'needs') {
      // On the phone to you, with the odd wave.
      p.phone.visible = true;
      raX = -0.3;
      raZ = -2.5;
      const cycle = state.reduced ? 0 : t % 4;
      if (cycle > 2.6) laZ = 2.7 + Math.sin(cycle * 14) * 0.3;
      headTurn = state.reduced ? 0 : Math.sin(t * 1.4) * 0.15;
    } else if (!state.reduced) {
      bob = (Math.sin(t * 2.1) + 1) * 0.006;
      headTurn = Math.sin(t * 0.6) * 0.4;
      laZ = 0.12;
      raZ = -0.12;
    }
    p.rig.position.y = bob;
    p.head.rotation.y = headTurn;
    la.rotation.set(laX, 0, laZ);
    ra.rotation.set(raX, 0, raZ);
    ll.rotation.x = legSwing;
    rl.rotation.x = -legSwing;
  }

  const anchorOf = (u) => (u.personMode !== 'hidden' ? u.personPos : u.carPos);

  function updateMarker(u, time) {
    if (!u.marker || !u.marker.group.visible) return;
    const a = anchorOf(u);
    u.marker.group.position.set(a.x, 0.05, a.z);
    const pulse = state.reduced ? 0 : Math.sin(time * 3 + u.phase);
    u.marker.ring.scale.setScalar(1.7 + pulse * 0.12);
    u.marker.column.material.opacity = 0.75 + pulse * 0.2;
    u.marker.badge.position.y = state.reduced ? 7.4 : 7.4 + Math.sin(time * 2.4 + u.phase) * 0.25;
  }

  // ------------------------------------------------------------ selection + tags

  const tag = document.createElement('div');
  tag.className = 'world-tag';
  tag.hidden = true;
  tag.innerHTML = '<b></b><span></span>';
  labelsLayer.appendChild(tag);

  function select(id, { fly = true } = {}) {
    state.selected = id && state.units.has(id) ? id : null;
    selRing.visible = false;
    floorOutline.visible = false;
    if (!state.selected) {
      state.follow = false;
      return;
    }
    const u = state.units.get(state.selected);
    selRing.material.color.setHex(STATE_COLORS[u.lane] ?? 0xffffff);
    selRing.visible = true;
    if (fly) {
      const a = anchorOf(u);
      flyTo(a.x, a.z, 58, 1.08);
      state.follow = true;
    }
  }

  const v3 = new THREE.Vector3();
  function toScreen(x, y, z) {
    v3.set(x, y, z).project(camera);
    return { x: (v3.x * 0.5 + 0.5) * viewW, y: (-v3.y * 0.5 + 0.5) * viewH, on: v3.z < 1 && Math.abs(v3.x) < 1.2 && Math.abs(v3.y) < 1.2 };
  }

  function placeLabels() {
    const id = state.hovered || state.selected;
    const u = id && state.units.get(id);
    if (!u) {
      tag.hidden = true;
      return;
    }
    const a = anchorOf(u);
    const s = toScreen(a.x, u.marker?.group.visible ? 9.6 : 3.2, a.z);
    tag.hidden = !s.on;
    tag.dataset.lane = u.lane;
    tag.querySelector('b').textContent = u.title;
    tag.querySelector('span').textContent = u.laneLabel;
    tag.style.transform = `translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px) translate(-50%, -100%)`;
  }

  // ------------------------------------------------------------ minimap

  let mini = null;

  function attachMinimap(canvas, { onPick } = {}) {
    mini = { canvas, ctx: canvas.getContext('2d'), last: 0, scale: 1.2, blips: [] };
    canvas.addEventListener('click', (e) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const hit = mini.blips.find((b) => Math.hypot(b.x - mx, b.y - my) < 12);
      if (hit) {
        onPick?.(hit.id);
        return;
      }
      const w = mapToWorld(mx - rect.width / 2, my - rect.height / 2);
      state.follow = false;
      flyTo(w.x, w.z, cam.des.dist, cam.des.pitch);
    });
  }

  function mapToWorld(dx, dy) {
    const yaw = cam.cur.yaw;
    const wx = dx / mini.scale;
    const wy = dy / mini.scale;
    return { x: cam.cur.x + Math.cos(yaw) * wx + Math.sin(yaw) * wy, z: cam.cur.z - Math.sin(yaw) * wx + Math.cos(yaw) * wy };
  }

  function drawMinimap(now) {
    if (!mini || now - mini.last < 90) return;
    mini.last = now;
    const { canvas, ctx } = mini;
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    if (!W || !H) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(W * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
    }
    const t = THEMES[state.theme];
    const shade = (c, k) => hex(new THREE.Color(c).multiplyScalar(k).getHex());
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const R = Math.min(W, H) / 2;
    ctx.save();
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, R - 1, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = shade(t.grass, 0.5);
    ctx.fillRect(0, 0, W, H);
    const yaw = cam.cur.yaw;
    const s = mini.scale;
    const cx = cam.cur.x;
    const cz = cam.cur.z;
    const toMap = (x, z) => {
      const dx = x - cx;
      const dz = z - cz;
      return [W / 2 + (Math.cos(yaw) * dx - Math.sin(yaw) * dz) * s, H / 2 + (Math.sin(yaw) * dx + Math.cos(yaw) * dz) * s];
    };
    const poly = (pts, fill) => {
      ctx.beginPath();
      pts.forEach(([x, z], i) => {
        const [px, py] = toMap(x, z);
        if (i) ctx.lineTo(px, py);
        else ctx.moveTo(px, py);
      });
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
    };
    const beachFront = streetZ(0) + STREET / 2;
    const backZ = streetZ(state.rows) - STREET / 2;
    poly([[-600, SHORE], [600, SHORE], [600, SHORE + 600], [-600, SHORE + 600]], shade(t.ocean, 0.85));
    poly([[-600, beachFront], [600, beachFront], [600, SHORE], [-600, SHORE]], shade(t.sand, 0.75));
    poly([[-600, backZ], [600, backZ], [600, backZ - 600], [-600, backZ - 600]], shade(t.swamp, 0.6));
    ctx.strokeStyle = 'rgba(18, 12, 26, 0.9)';
    ctx.lineWidth = STREET * s;
    for (let k = 0; k <= state.rows; k++) {
      const a = toMap(-200, streetZ(k));
      const b = toMap(200, streetZ(k));
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
    }
    for (let j = 0; j <= COLS; j++) {
      const a = toMap(streetX(j), beachFront);
      const b = toMap(streetX(j), backZ);
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
    }
    for (const lot of state.lots) {
      if (!lot) continue;
      const { x, z } = lotPos(lot.index);
      const h = LOT / 2 - 0.5;
      poly([[x - h, z - h], [x + h, z - h], [x + h, z + h], [x - h, z + h]], lot.key ? shade(lot.tone, 0.9) : 'rgba(255,255,255,0.14)');
    }
    mini.blips = [];
    const edge = R - 9;
    for (const u of state.units.values()) {
      const a = anchorOf(u);
      let [px, py] = toMap(a.x, a.z);
      const dx = px - W / 2;
      const dy = py - H / 2;
      const d = Math.hypot(dx, dy);
      const needs = u.lane === 'needs';
      if (d > edge) {
        if (!needs) continue;
        px = W / 2 + (dx / d) * edge;
        py = H / 2 + (dy / d) * edge;
      }
      ctx.beginPath();
      if (needs) {
        const pulse = state.reduced ? 0 : (Math.sin(now / 220) + 1) * 1.6;
        ctx.arc(px, py, 5.5 + pulse, 0, Math.PI * 2);
        ctx.fillStyle = hex(STATE_COLORS.needs);
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#fff';
        ctx.stroke();
      } else {
        ctx.arc(px, py, 3.2, 0, Math.PI * 2);
        ctx.fillStyle = hex(STATE_COLORS[u.lane] ?? 0xffffff);
        ctx.fill();
      }
      if (u.id === state.selected) {
        ctx.beginPath();
        ctx.arc(px, py, 9.5, 0, Math.PI * 2);
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#fff';
        ctx.stroke();
      }
      mini.blips.push({ id: u.id, x: px, y: py });
    }
    ctx.restore();
    ctx.beginPath();
    ctx.moveTo(W / 2, H / 2 - 9);
    ctx.lineTo(W / 2 + 6, H / 2 + 6);
    ctx.lineTo(W / 2, H / 2 + 3);
    ctx.lineTo(W / 2 - 6, H / 2 + 6);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.fill();
  }

  // ------------------------------------------------------------ input

  const ray = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const pointers = new Map();
  let drag = null;
  let hoverPending = null;

  function setPointer(e) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  }

  function pick(e) {
    setPointer(e);
    ray.setFromCamera(pointer, camera);
    const badges = [];
    for (const u of state.units.values()) if (u.marker?.group.visible) badges.push(u.marker.badge);
    const hits = ray.intersectObjects(badges.concat(pickables), true);
    for (const h of hits) {
      let o = h.object;
      if (!o.visible) continue;
      while (o) {
        if (o.userData.unitId) return { id: o.userData.unitId };
        if (Number.isInteger(o.userData.lotIndex)) return { lot: o.userData.lotIndex };
        if (o.userData.hq) return { hq: true };
        o = o.parent;
      }
    }
    return null;
  }

  function groundPoint(e) {
    setPointer(e);
    ray.setFromCamera(pointer, camera);
    return ray.ray.intersectPlane(groundPlane, new THREE.Vector3());
  }

  const el = renderer.domElement;
  el.addEventListener('contextmenu', (e) => e.preventDefault());

  el.addEventListener('pointerdown', (e) => {
    poke();
    el.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      drag = { pinch: Math.hypot(a.x - b.x, a.y - b.y), moved: true };
      return;
    }
    drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, rotate: e.button === 2 || e.shiftKey || e.altKey, moved: false };
  });

  el.addEventListener('pointermove', (e) => {
    poke();
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!drag) {
      hoverPending = e;
      return;
    }
    if (drag.pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      cam.des.dist *= drag.pinch / Math.max(1, d);
      drag.pinch = d;
      clampDesired();
      snap();
      return;
    }
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 5) return;
    drag.moved = true;
    drag.x = e.clientX;
    drag.y = e.clientY;
    state.follow = false;
    if (drag.rotate) {
      cam.des.yaw -= dx * 0.006;
      cam.des.pitch += dy * 0.004;
    } else {
      const upp = (2 * cam.cur.dist * Math.tan(THREE.MathUtils.degToRad(FOV / 2))) / viewH;
      const yaw = cam.cur.yaw;
      const sp = Math.max(0.35, Math.sin(cam.cur.pitch));
      cam.des.x += -Math.cos(yaw) * dx * upp - (Math.sin(yaw) * (dy * upp)) / sp;
      cam.des.z += Math.sin(yaw) * dx * upp - (Math.cos(yaw) * (dy * upp)) / sp;
    }
    clampDesired();
    snap();
    el.classList.add('dragging');
  });

  const endDrag = (e) => {
    pointers.delete(e.pointerId);
    el.classList.remove('dragging');
    if (!drag) return;
    const wasClick = !drag.moved && e.type === 'pointerup' && e.button === 0;
    drag = pointers.size ? drag : null;
    if (!wasClick) return;
    const hit = pick(e);
    if (hit?.id) onSelect?.(hit.id);
    else if (Number.isInteger(hit?.lot)) {
      const { x, z } = lotPos(hit.lot);
      state.follow = false;
      flyTo(x, z + 2, 52, 1.0);
    } else if (hit?.hq) frameAll();
    else onSelect?.(null);
  };
  el.addEventListener('pointerup', endDrag);
  el.addEventListener('pointercancel', endDrag);
  el.addEventListener('pointerleave', () => {
    hoverPending = null;
    if (state.hovered) {
      state.hovered = null;
      onHover?.(null);
    }
    el.style.cursor = '';
  });

  el.addEventListener('dblclick', (e) => {
    const g = groundPoint(e);
    if (!g) return;
    state.follow = false;
    flyTo(g.x, g.z, Math.max(20, cam.des.dist * 0.5), cam.des.pitch);
  });

  el.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      poke();
      const k = e.ctrlKey ? 0.012 : 0.0016;
      const f = Math.exp(Math.max(-0.5, Math.min(0.5, e.deltaY * k)));
      const before = cam.des.dist;
      cam.des.dist = Math.min(320, Math.max(14, before * f));
      const g = groundPoint(e);
      if (g && f < 1) {
        const pull = 1 - cam.des.dist / before;
        cam.des.x += (g.x - cam.des.x) * pull;
        cam.des.z += (g.z - cam.des.z) * pull;
        state.follow = false;
      }
      clampDesired();
      if (state.reduced) snap();
    },
    { passive: false },
  );

  function updateHover() {
    if (!hoverPending || drag) return;
    const hit = pick(hoverPending);
    hoverPending = null;
    const id = hit?.id || null;
    el.style.cursor = hit ? 'pointer' : '';
    if (id !== state.hovered) {
      state.hovered = id;
      onHover?.(id);
    }
  }

  // ------------------------------------------------------------ loop

  function resize() {
    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;
    viewW = w;
    viewH = h;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.setViewOffset(viewW, viewH, -offset.x, -offset.y, viewW, viewH);
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  const clock = new THREE.Timer();
  let raf = 0;
  let lastRender = 0;
  function settled() {
    const c = cam.cur;
    const d = cam.des;
    return Math.abs(c.x - d.x) + Math.abs(c.z - d.z) + Math.abs(c.dist - d.dist) < 0.05 && Math.abs(c.yaw - d.yaw) + Math.abs(c.pitch - d.pitch) < 0.002;
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    // Full frame rate while things move under the user's hand; 30 fps otherwise,
    // since this page may stay open all day in a split.
    const idle = now - lastInteract > 2500 && settled() && !state.follow;
    const gap = idle ? (state.reduced ? 100 : 32) : 0;
    if (now - lastRender < gap) return;
    lastRender = now;
    clock.update(now);
    const dt = Math.min(0.05, clock.getDelta());
    const time = clock.getElapsed();
    state.blink += dt;

    for (const u of state.units.values()) {
      updateCar(u, dt);
      updatePerson(u, dt, time);
      updateMarker(u, time);
    }
    kit.mat.trim.needs.emissiveIntensity = state.reduced ? 2.4 : Math.sin(time * 6) > 0 ? 3 : 1;

    if (state.selected) {
      const u = state.units.get(state.selected);
      if (u) {
        const a = anchorOf(u);
        selRing.position.set(a.x, 0.14, a.z);
        selRing.scale.setScalar(u.personMode !== 'hidden' ? 0.9 : 1.7);
        if (!state.reduced) selRing.rotation.z += dt * 0.8;
        if (u.floor) {
          const { slot } = u.floor;
          floorOutline.position.set(slot.x, slot.y, slot.z);
          floorOutline.scale.set(slot.w + 0.5, slot.h + 0.5, slot.d + 0.3);
          floorOutline.visible = true;
        } else {
          floorOutline.visible = false;
        }
        if (state.follow) {
          cam.des.x = a.x;
          cam.des.z = a.z;
        }
      }
    }

    const k = state.reduced ? 1 : damp(dt, 5.5);
    const c = cam.cur;
    const d = cam.des;
    c.x += (d.x - c.x) * k;
    c.z += (d.z - c.z) * k;
    c.dist += (d.dist - c.dist) * k;
    c.pitch += (d.pitch - c.pitch) * k;
    c.yaw = angleLerp(c.yaw, d.yaw, k);
    applyOffset(k);
    placeCamera();
    if (scene.fog) {
      scene.fog.near = c.dist * 1.3 + 30;
      scene.fog.far = c.dist * 1.3 + 700;
    }

    if (state.hqFlash > 0) state.hqFlash = Math.max(0, state.hqFlash - dt * 2.5);
    hq.userData.light.scale.setScalar(2.6 + (state.reduced ? 0.6 : 0.6 + Math.sin(time * 2) * 0.3 + state.hqFlash) * 2);

    updateHover();
    renderer.render(scene, camera);
    placeLabels();
    drawMinimap(now);
  }
  raf = requestAnimationFrame(frame);

  // Signs are painted on canvases: repaint them once the display fonts have loaded.
  Promise.all([document.fonts.load('80px "Yellowtail"'), document.fonts.load('80px "Anton"')])
    .then(() => {
      for (const lot of state.lots) if (lot) buildLot(lot);
      relink();
    })
    .catch(() => {});

  buildEnvironment();
  frameAll(true);

  return {
    sync,
    select,
    attachMinimap,
    frameAll: () => frameAll(false),
    tick(id) {
      state.hqFlash = 1;
      const u = state.units.get(id);
      if (u && !state.reduced) u.flash = 1;
    },
    setTheme(name) {
      if (!THEMES[name] || name === state.theme) return;
      state.theme = name;
      buildEnvironment();
      for (const lot of state.lots) if (lot?.style === 'stilt' && lot.key) buildLot(lot);
      relink();
    },
    setReducedMotion(on) {
      state.reduced = Boolean(on);
    },
    setInsets(next) {
      poke();
      Object.assign(insets, next);
      if (state.reduced) applyOffset(1);
    },
    zoom(f) {
      poke();
      cam.des.dist *= f;
      clampDesired();
      if (state.reduced) snap();
    },
    rotate(a) {
      poke();
      cam.des.yaw += a;
      if (state.reduced) snap();
    },
    pan(dx, dz) {
      poke();
      const yaw = cam.des.yaw;
      const s = cam.des.dist * 0.08;
      state.follow = false;
      cam.des.x += (Math.cos(yaw) * dx + Math.sin(yaw) * dz) * s;
      cam.des.z += (-Math.sin(yaw) * dx + Math.cos(yaw) * dz) * s;
      clampDesired();
      if (state.reduced) snap();
    },
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.dispose();
    },
  };
}
