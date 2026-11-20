# Design

Switchboard's visual world since the 2026-11-20 redesign: **a sun-soaked coastal city at golden hour**, a homage to the open-world crime-game genre that never names the game (see PRODUCT.md, Brand Commitments). The 3D city is the dashboard; HTML panels float over it like a game HUD. Stylised low-poly Three.js with strong colour grading, never photoreal.

## City (public/world.js)

- **Grid:** square blocks of identical lots, 4 wide, filling row by row from the beach inland. Lot 12 units, streets 5. The beach road runs along row 0, then sand and sea in front. A swamp with cypress, still water and airboats sits behind the last row, and low pastel blocks without signs line either side.
- **One lot per git repository**, kept across reloads (`localStorage`). A closed repo's lot gets a "For Sale" sign until the next new repo takes it, so nothing else moves. Sessions outside a repo share the **hangout** motel.
- **Building style by row band:** row 0 Art Deco beachfront hotels (pastel body, white eyebrow ledges, corner pilasters, a roof fin); row 1 downtown towers (concrete frame, tall glass band); row 2+ stilt houses with a pond, dock and airboat. The hangout lot is a single-storey motel with a pool and a pylon sign.
- **One floor per agent** (cap 6, then a "+N" sign). Each floor has a window band and a neon trim in the agent's state.
- **Roof sign:** the repo name in Yellowtail neon (a billboard sprite with a glow halo), coloured from a fixed neon set by the repo's hash.
- **Dispatch tower** on the beach (white, cyan band): its light pulses on every tool call. Clicking it shows everything.

### Agents: floor + car + person

Each agent has a look (skin, hair, outfit, car colour) hashed from its id, shared by the 3D person, their car and the list portrait (`look()` / `portrait()` in `icons.js`).

| State | Colour | Floor | Car | Person |
| --- | --- | --- | --- | --- |
| Needs you | `#ff3f8e` pink | neon trim blinks | pulled over (or parked) with hazards | beside the car on the phone, waves now and then |
| Working | `#2fd8ff` cyan | windows lit warm | driving the grid, brake lights on each tool call | in the car |
| Your move | `#5dffa8` mint | windows softly lit | parked at the kerb out front | at the hotel door |
| Stale | `#a49dbd` lavender | blinds down | under a cover | inside |

**Needs-you marker:** a pink light column, a ground ring, and a screen-size badge that says how the agent reaches you: call = permission, text = question, mail = plan, missed call = unread result, terminal = a prompt only the terminal can answer.

### Times of day

Day, Sunset (default) and Night change the sky gradient, sun, hemisphere light, fog, ground colours, window and neon strength, and street-lamp glows. The city and its states read the same in all three.

### Camera

Steep and high: overview pitch 1.02 rad, close-up 1.08 rad at distance 58, FOV 30°. Moves are damped. The projection centre shifts into the area the panels leave free, and "show everything" fits the occupied blocks plus the beach into it. A selected agent is followed until the user pans.

## HUD (public/styles.css)

- **Panels:** deep purple glass `rgba(24,13,38,.88)` with a pink hairline and a soft shadow.
- **Type:** Anton (OFL, self-hosted) for the display voice: uppercase counters, headings, chips and banners. Yellowtail (Apache 2.0) only for the neon signs. System sans for reading text, monospace only for commands, branches and models.
- **Wordmark:** "SWITCHBOARD" in Anton with the sunset gradient (yellow → orange → pink → violet).
- **Layout:** top row has the wordmark, the four state counters and activity plus the time-of-day picker. The agent list sits on the left above the round minimap (sunset-gradient bezel, rotates with the camera, needs-you blips pinned to the edge). The phone is on the right, the camera bar at the bottom centre.
- **Phone (the agent card):** a bezel with a status bar (clock, carrier, signal bars = recent tool calls) and a contact header with a portrait. Its content changes by state:
  - incoming-call screen with a countdown ring and round Decline/Answer
  - text thread with quick-reply chips
  - a light paper email for plans
  - missed-call and Do-Not-Disturb strips
  - a texting composer for idle agents
  - an Open in cmux button in its dock
- **Moments:** a big "JOB DONE" banner in the sunset gradient when a job finishes, and an incoming-call notification (bottom right) when an agent starts needing you.
- **Under 760 px:** the list becomes a drawer behind the **Agents** button, the phone becomes a bottom sheet, and the minimap shrinks.

## Motion

People walk to and from their cars and doors. Cars drive the grid on the right-hand lane. Needs-you neon blinks and markers bob. The signature moment is selecting an agent: the camera flies to them while the phone slides in. `prefers-reduced-motion` stops all of it: cars stay parked, people stand where their state puts them, and the camera cuts. The renderer drops to 30 fps (10 with reduced motion) once the camera settles and the pointer is idle.
