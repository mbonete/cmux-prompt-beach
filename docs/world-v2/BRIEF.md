# World v2: build brief

Internal brief shared by everyone building world v2 (people and agents). It records what was decided with the product owner on 2026-11-21 and the contracts between the parts. PRODUCT.md and DESIGN.md stay the public description; this file is the working agreement.

**Never name the game the look pays homage to**, here, in code, in commits or in the UI. Never use the name, logo or look of the "video game for AI agents" product that inspired the concept either (robot or astronaut crews, hex plots, colonies, planet themes, a "?" bubble as the attention signal, the KayKit or Kenney packs).

## What we are building

A premium, browser-based 3D coastal city at golden hour where each live coding agent (a Claude Code session running in cmux) is a person living and working on their project's plot. It is the dashboard: you see at a glance who needs you, who is working, whose move it is and who went stale, and you act from the page.

Quality bar: cinematic stylised realism (realistic proportions, PBR materials, rich sky lighting, soft shadows, haze, bloom, colour grading). Not toy-like, not flat low-poly, not photoreal. 60 fps on a MacBook Air M3 at full window size, with automatic quality presets.

## Settled decisions

**Data and app**
- Same repo; replaces the city v1 view. Keep the server, the real cmux data, every action (allow/deny, answer, approve plan, reply, mark read, open in cmux), demo mode and a keyboard-usable list that works without 3D.
- Sources: cmux + Claude Code only, behind a source adapter so other agents can be added later.
- Server stays dependency-free Node. Client is Vite + TypeScript; the built output in `public/` is committed so `npm start` works with no install and offline.
- The strict CSP stays unchanged: `script-src 'self'`, `style-src 'self'` (no inline styles; set styles through CSSOM), `img-src 'self' data:`, `connect-src 'self'`, `font-src 'self'`. Therefore: no WebAssembly decoders, no blob: workers, no embedded GLB images.

**Assets**
- CC0, CC-BY (credited) or MIT only. About 40 MB first load, about 150 MB of repo growth, no Git LFS.
- Raw downloads live in `assets-src/` (git-ignored). The repo holds the recipe (`tools/assets/`) and the optimised outputs (`public/assets/`).

**The city**
- A hand-designed district with about 16 plots of different character: beach café, Deco hotel, diner, marina office, rooftop, trailer under palms, surf shop, juice kiosk, motel court, MiMo office and so on.
  - Each git repo takes the next free plot and keeps it.
  - Sessions outside any repo share a beach bar (the hangout).
  - Repos beyond 16 share a co-working building.
  - A repo with no sessions keeps its plot for 7 days, its tag dimmed, then the plot is freed.
  - A repo can be moved to a free plot from the Projects list.
- Each plot has 6 spots (desk, lounger, bar stool, bench, steps and so on). Agents take the next free spot and keep it; a 7th agent and beyond shows a "+N" sign.
- Plot name tags show the repo name and an icon picked automatically: web = globe, mobile = phone, docs = book, data = pipeline, anything else = branch. Each repo gets a stable neon outline colour.
- Background life: beachgoers, traffic, boats, a helicopter and a blimp. Only agents stand on a glowing plot, carry a tag and can be clicked. Background life thins out on Light quality and stops with reduced motion.
- No per-agent cars; vehicles are background traffic only.

**Agents**
- One person per agent. Looks come from a cast of about 20 people, chosen from the session id and unique among active agents. Tags show the session title, never a made-up name.
- What each state looks like:

| State | Colour | Person | Plot |
| --- | --- | --- | --- |
| Working | `#2fd8ff` | Seated at their spot, typing on a laptop. A small icon pops up on each tool call: pencil = edit, terminal = command, magnifier = search, globe = web. | Lit normally |
| Needs you | `#ff3f8e` | Stands, turns to the camera and waves. Small badge by kind: key = permission, speech bubble with "…" = question, document = plan, terminal = only the terminal can answer. | Outline pulses pink; a tall light beam, visible from anywhere |
| Finished, unread | counts as needs you | A short fist pump when the job ends, then sits back with a green check badge until read | |
| Your move (idle, read) | `#5dffa8` | Relaxes on the plot: lounger, coffee, leaning back. No badge. | |
| Stale | `#a49dbd` | Dozes on a lounger or hammock | Lights dim |
| Terminal without an agent | | Not in the world; list only | |

**Never missing who needs you**
- the light beam
- arrows at the screen edge for off-screen agents (clicking one flies there)
- minimap blips pinned to the edge
- the Inbox badge and the tab-title count
- an optional chime

No OS notifications.

**Camera and interface**
- **Camera:** cinematic three-quarter view, tilt 25°–65° (start about 40°). Drag to pan, right-drag or two fingers to rotate, wheel or pinch to zoom, F or double-click to focus. Clicking an agent flies to a framed close-up (no tighter than waist-up). After 2 minutes idle, slow drifting shots cut to whoever needs you; any input returns. Off with reduced motion and switchable in Settings.
- **Agent card:** an anchored card next to the character for the quick read and the main action, plus Open in cmux. **Expand** opens a side panel with the recent conversation, the reply box (idle only), details, Mark read and Archive.
- **Screen layout:**
  - top left: the Prompt Beach wordmark (our own)
  - left rail: Map, Projects, Agents, Inbox, Archive, Settings
  - top right: counts, the time-of-day picker (Day / Sunset / Night / Auto) with the clock, sound, help
  - bottom left: minimap
  - bottom right: a controls hint that hides once used
- **Settings:** quality (Auto / Cinematic / Balanced / Light), Stale after, sound and chime (muted by default), idle camera, reduced motion.
- **Events:** small toasts at the top centre ("Checkout redesign: finished"); clicking one flies to the agent. No big banners.
- **Archive** hides a session in Prompt Beach only and never touches cmux. An archived session comes back automatically when it needs you.
- **Loading screen:** title screen with the wordmark over a soft-focus city and a progress bar.
- **Review checkpoints:** (1) look-dev, (2) feature-complete on real sessions, (3) final.

## Art direction

**Mood.** A sun-soaked Florida-style coast at golden hour, sliding into neon night.
- warm low sun, long soft shadows, humid haze over the water
- teal-orange colour grade, saturated but never garish
- wet-look asphalt reflections at dusk
- neon that blooms at night

The city must feel lived-in: palms moving gently, rippling water, people on the beach.

**Architecture: Miami Beach Art Deco and MiMo, done our own way**
- pastel stucco: mint, peach, flamingo pink, butter yellow, powder blue, lilac
- white "eyebrow" sunshades over the windows, rounded corners, vertical fins and stepped parapets
- porthole windows, glass block, horizontal speed lines, terrazzo
- striped awnings, louvred shutters
- neon tube trim on signage and edges

Low-rise (1 to 3 storeys) in the district; a pastel skyline of towers beyond.

**Palette**
- sky: gold → coral → magenta → violet
- sea: turquoise to deep teal
- sand: warm cream
- vegetation: lush green
- accents: neon in the state colours plus warm white

**People.** Realistic adults in casual coastal clothes. Animation must look natural: motion capture, eased blends, no foot sliding.

**Not this.** Cartoon, chibi or blocky; flat-shaded low poly; anything resembling the reference game's logo, characters, place names or map; robots.

## World conventions

- **Axes and scale:** metres; glTF is Y-up. World origin is the centre of the promenade in front of the first plot row.
  - The ocean lies toward **−Z**, the city extends inland toward **+Z**, and the skyline sits across a bay toward **+X**.
  - The default camera sits on the +Z side, high, looking toward −Z, so the sun sets over the sea in the background.
- **Plot footprint:** 20 m (X) × 16 m (Z). The plot origin is its centre at ground level. The plot's front (terrace, street side) faces **+Z** in local space; the building sits toward −Z. The layout may rotate plots in 90° steps.
- **People:** about 1.6–1.9 m tall. Standard furniture: seat height 0.46 m, desk or table top 0.74 m. The character pipeline reports what the motion-capture clips actually assume; buildings must match those values.

## Asset format (everyone)

- **File format:** glTF 2.0 as `.gltf` + `.bin` with **external WebP textures**, because a CSP that allows only `img-src 'self'` cannot load embedded GLB images.
- **Allowed:** `EXT_texture_webp` (needed to reference WebP images; no decoder), `KHR_mesh_quantization`, `KHR_texture_transform`, `KHR_materials_emissive_strength`, `KHR_materials_clearcoat`, `KHR_materials_transmission` and `KHR_materials_ior`.
- **Not allowed:** Draco, `EXT_meshopt_compression`, KTX2/Basis.
- **Textures:**
  - power of two
  - the glTF ORM packing: R = occlusion, G = roughness, B = metalness
  - WebP quality 85–92 (normals ≥ 90)
- **Size by role:**
  - characters: 1024
  - props: 512–1024
  - tiling ground: 1024–2048
- **Triangle budgets:**
  - character LOD0 ≤ 10k
  - prop ≤ 15k (add LOD1 above 10k)
  - plot building ≤ 25k
  - background building ≤ 6k
  - skyline tower ≤ 3k
- **Pivots:** at the base centre (props, buildings) or the feet (people).
- **In every output folder:**
  - `manifest.json`: per asset files, tris, bytes, bounds and notes
  - `credits.json`: `[{ asset, author, source, licence, url, changes }]`
- **Previews and scratch renders** go to `assets-src/_previews/<area>/`, never into `public/`.

## Contracts

**Characters** (`tools/assets/characters/` → `public/assets/characters/`)
- `<AvatarId>/<AvatarId>.gltf`: a skinned mesh (LOD0 named `lod0`, LOD1 about 2.5k named `lod1`) with the original Biped bone names.
- `anims/m.gltf`, `anims/f.gltf`: skeleton plus clips with canonical names:
  - **Locomotion:** `idle`, `idle_look`, `walk` (in place)
  - **Table:** `sit_down_table`, `work_table`, `sit_table_idle`, `sit_table_relaxed`, `sit_table_yawn`, `stand_up_table`
  - **Chair:** `sit_down_chair`, `sit_chair_relaxed`, `sit_chair_yawn`, `stand_up_chair`
  - **Gestures:** `wave`, `phone_talk`, `phone_text`, `cheer`, `cheer_alt`, `fist_pump`, `drink`, `headphones`, `stretch`
  - **Lying down:** `sleep`, `lay_to_idle`, `sitting_writing`
- The manifest lists, per avatar, its skeleton (`m` or `f`), height and alpha materials. Per clip it lists duration, whether it loops, and root displacement (start → end) for transitions. It also records the seat and table heights the clips assume.

**Environment** (`tools/assets/env/` → `public/assets/env/`)
- `sky/`: HDRIs prepared for background and image-based lighting, with each HDRI's sun direction (azimuth, elevation) in the manifest.
- `textures/<set>/`: tiling PBR sets with the real-world size they cover.
- `props/<id>/`: converted props.

**Street kit** (`tools/assets/street/` → `public/assets/street/`): lamps (with a `bulb` globe), a lifeguard tower, umbrellas, loungers, towels, cars (`carpaint` tinted per instance, `headlight`, `taillight`), boats (`extras.waterline`), a helicopter (`rotor`, `tail_rotor` nodes) and a blimp. The client's `world/life/` places and moves them.

**Buildings** (`tools/assets/deco/` → `public/assets/buildings/`)
- Produced by a deterministic headless Blender script.
- Plot buildings `plot_<type>.gltf`, background buildings `bg_<n>.gltf`, skyline towers `tower_<n>.gltf`.
- Inside each plot building:
  - empties `spot_0`…`spot_5`: +Z forward is the direction the person faces; custom property `spot_kind` ∈ desk | lounger | stool | bench | steps | standing
  - empties `tag_anchor` and `beam_anchor`
  - empties `prop:<env prop id>` where the client places a shared prop
- Material names: `stucco` (its base colour is the pastel tint; the client may override per plot), `trim`, `glass`, `glass_block`, `metal`, `terrazzo`, `wood`, `awning`, `roof`, `concrete`, `planter`, `water`, `neon_accent`, `interior`, and `bulb` (festoon bulbs, sconces, lanterns and sign bulbs: the client drives its emission with a night level and turns it off on vacant plots).
- Empties `light_0`…`light_n` (2–4 per plot) at each main light source, with extras `light_radius` (metres, 2–6), `light_color` (warm hex) and `floor_y` (local height of the floor under it): the client draws a soft fake light pool there at night, no real lights.
- Empties `palm_0`…`palm_n` at a trunk base with extra `palm_height` (5–11 m): the client plants its own procedural palm there.
- `manifest.json` carries `layout`: `{ plots: [16 type ids by plot index], hangout, overflow }`, which the client follows. `check.mjs` enforces the layout rules (no equal neighbours, the hotel on the front row, at most two of a type).
- Every agent spot must stay visible from the +Z side at 27°–45° tilt (`visibility.py` checks it on each build): no canopy, umbrella or awning over a seated person.
- The plot's state outline is drawn by the client, not baked into the building.

**Server** (`server.mjs`, `server/`, `demo.mjs`, `test/`): see the server task. The client relies on:
- `/` → `index.html` with the token placeholder filled in
- static files under `/build/`, `/assets/` and `/fonts/`
- the SSE `snapshot` and `tick` events
- `POST /api/action`

## Ownership (to avoid edit collisions)

| Area | Owner |
| --- | --- |
| `client/`, `vite.config.ts`, `tsconfig.json`, `package.json`, `docs/world-v2/`, final `CREDITS.md` | lead |
| `tools/assets/characters/`, `public/assets/characters/` | characters |
| `tools/assets/env/`, `public/assets/env/` | environment |
| `tools/assets/deco/`, `public/assets/buildings/` | buildings |
| `server.mjs`, `server/`, `demo.mjs`, `test/` | server |

Nobody commits; the lead commits at milestones. Need a dependency or a change in someone else's area? Say so in your report rather than making it.

**Tools available**
- Blender 5.2: `blender -b --python <script>`
- Node 22, `npx gltf-transform` (4.5.1), `sharp`, ImageMagick (`magick`) and ffmpeg

Raw sources are in `assets-src/` (see `tools/assets/sources.json`).
