# Switchboard

A live local dashboard for the agents running in [cmux](https://cmux.com), drawn as an Art Deco beachfront at sunset. Every git repository gets a building on the strip, and every agent is a person working there: at a desk while it works, waving at you when it needs you, relaxing when it's your move, dozing when it goes stale. Click anyone for their card to answer a permission or a question, approve a plan, reply, or jump to their terminal.

<img src="docs/screenshot.jpg" alt="Switchboard in demo mode at sunset: an Art Deco beachfront with palm trees, project signs over the buildings, pink light beams and badges over the agents that need you, the counts by state at the top right, and the rail of views and the minimap on the left">

## Run it

Start it from a cmux terminal, because cmux only accepts socket connections from its own terminals:

```bash
git clone https://github.com/mbonete/cmux-switchboard.git
cd cmux-switchboard
npm start                                 # http://localhost:4747
cmux browser open http://localhost:4747   # optional: open it as a cmux split
```

It needs Node 20 or later. `npm start` runs `server.mjs` with Node's built-in modules only, so there is nothing to install: the page is already built in `public/build`. `npm install` is only for working on the code (it brings the build tools). Use `PORT=5000 npm start` for another port.

To try it without cmux, or to take screenshots without showing your real sessions, run `npm run demo`. It serves made-up projects and agents in every state, and it reads and writes nothing on your machine.

The 3D city needs WebGPU or WebGL 2 (any current desktop browser). Without it, everything still works from the lists.

## Reading the city

| You see | It means |
| --- | --- |
| A pink beam over the building, someone waving, a badge over their head | **Needs you.** The badge says what for: a key is a permission, a speech bubble a question, a document a plan to approve, a terminal a prompt only the terminal can answer. |
| Someone at their desk, a small icon popping up for each tool call | **Working.** |
| Someone relaxing, with a check badge until you read the result | **Your move.** Finished and waiting for your next message. |
| Someone dozing | **Stale.** No activity for longer than "Stale after" (Settings). |

- **Buildings:** one per git repository, found with `git rev-parse --git-common-dir`, so worktrees join their repo. Sessions outside any repo meet at the **beach bar**. A building keeps its place across reloads.
- **Counts:** the top right shows how many agents are in each state; click one to jump to that group in the agent list.
- **Controls:** drag to move, Shift-drag or right-drag to turn, scroll or pinch to zoom toward the pointer. Click a person for their card, a building to go to it. Keys: `N` next agent that needs you, `F` focus, `T` cinematic tour, `W` `A` `S` `D` move, `Q` `E` turn, `+` `-` zoom, `1`–`6` views, `/` find an agent, `Esc` close. The Help view lists them all.
- **Calm:** after 45 seconds without input the city stops drawing until something changes, so a laptop stays cool. It still shows every change at once. Settings: "Keep the city lively" keeps the ambient motion going.
- **Quality:** Auto by default (it steps down when frames are slow); Cinematic, Balanced or Light in Settings.

Everything is also in the agent list (Agents, Inbox, Projects, Archive), which works with the keyboard and without the 3D view. With reduced motion on, the camera cuts instead of flying.

## What it tracks

| State | Meaning |
| --- | --- |
| Needs you | A permission, question or plan prompt is open; or the agent finished with a question; or there is an unread cmux notification. Longest wait first. |
| Working | The agent is mid-turn. Shows what it is doing now and how long the turn has run. |
| Your move | Finished and idle. Shows Claude's recap (the `※ recap` line) or the start of its last reply. |
| Stale | No activity for longer than the "Stale after" setting (2 days by default). |
| No agent | Terminals without an agent. |

The card also shows the project folder, git branch, model, context size, permission mode and any dev-server ports (as links).

## What you can do from a card

- **Open in cmux:** focuses that workspace and terminal and brings cmux to the front.
- **Allow once / Always allow / Deny**, **answer a question**, **approve a plan:** sent through cmux's Feed (`feed.permission.reply`, `feed.question.reply`, `feed.exit_plan.reply`). cmux holds these for about 120 seconds; after that the agent falls back to its terminal prompt and the card says to answer there.
- **Reply:** types your text into the agent's prompt and presses Enter (`cmux paste --submit`). The server re-checks first and refuses unless the agent is idle and its prompt box is empty, so it never mixes into a draft or interrupts a turn.
- **Mark read:** clears that workspace's cmux notifications. **Archive** hides a finished session from the lists.

## Where the data comes from

- `cmux current --json`: terminals, agents, session ids, working/idle state.
- `cmux rpc workspace.list`: titles, sidebar order, listening ports, last prompt.
- `cmux rpc feed.list`: open decisions and tool-call activity.
- `cmux rpc notification.list`: unread state.
- `cmux list-status`: the sidebar status per workspace (Running, Waiting, Needs permission).
- `cmux events --reconnect`: live hook events, used to refresh within a second.
- `~/.claude/projects/*/<session>.jsonl` (read-only, last 2 MB): last reply, recap, last prompt, model, context tokens, branch, the tool currently running, and pending questions or plans.
- It writes one file: `~/.config/cmux-switchboard/world.json` (which repo has which building).

## Safety

- Listens on `127.0.0.1` only and rejects requests whose `Host` is not `localhost` or `127.0.0.1` (blocks DNS rebinding).
- Every action needs a random token generated at startup, a JSON body and a same-origin `Origin`, so other websites can't trigger actions; no other page may frame it (blocks clickjacking).
- Permission replies offer only Once, Always and Deny. The Feed's "All tools" and "Bypass" modes are left out on purpose.
- Nothing is sent anywhere except to the local cmux socket. The page's security policy only lets it talk to its own server.

What the token does and doesn't protect against, and how to check that the prebuilt page matches the source: [SECURITY.md](SECURITY.md).

## Tested

Checked against cmux 0.65.2 and Claude Code 2.1.322 with a throwaway Haiku session: allowing a Bash permission, replying, and answering an AskUserQuestion prompt all worked from the dashboard. Approving a plan uses the same Feed mechanism but has not been tried. `npm test` runs the unit tests (server, sources, layout); `npm run test:browser` drives the city in headless Chrome.

## Support

Switchboard is free and open source. If you enjoy it, you can [buy me a coffee on Ko-fi](https://ko-fi.com/mbonete).

## License

MIT. See [LICENSE](LICENSE).

## Credits

- [Three.js](https://threejs.org) 0.187.0, MIT licence (bundled into `public/build`).
- [Anton](https://fonts.google.com/specimen/Anton) font, SIL Open Font Licence 1.1 (`public/fonts/anton.LICENSE`).
- [Yellowtail](https://fonts.google.com/specimen/Yellowtail) font, Apache Licence 2.0 (`public/fonts/yellowtail.LICENSE`).
- 3D models, textures, characters and animations: see [CREDITS.md](CREDITS.md).
