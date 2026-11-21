# Server reference: snapshot, ticks, endpoints

This is what the world v2 client can rely on from `server.mjs`. Fields marked **new** were added for world v2; everything else is unchanged from v1.

## Security

Every request must carry `Host: localhost:<port>` or `127.0.0.1:<port>`; anything else gets `421`. Every `/api/*` request that has an `Origin` header must have this server's origin (`http://localhost:<port>` or `http://127.0.0.1:<port>`), or it gets `403`.

The token is generated at each start and written into `index.html` in place of `__SWITCHBOARD_TOKEN__`. The client sends it:

- as `?token=` on `/api/stream` (because EventSource can't set headers)
- as `X-Switchboard-Token` on every other API call

A restarted server has a new token, so the stream is then refused with `403` for good and the page has to reload.

Every response carries this CSP, plus `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`:

```
default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'
```

## The page and static files

| Request | Served |
| --- | --- |
| `GET`/`HEAD /` | `public/index.html` with the token filled in. `Cache-Control: no-store`. `503` if the page has not been built. |
| `GET`/`HEAD /build/**` | `public/build/`. `Cache-Control: public, max-age=31536000, immutable` (hashed bundles only, please). |
| `GET`/`HEAD /assets/**`, `/fonts/**` | `public/assets/`, `public/fonts/`. `Cache-Control: public, max-age=3600`. |
| `GET`/`HEAD /<icon>` | An `.svg`, `.png`, `.webp`, `.jpg` or `.jpeg` sitting directly in `public/` (a favicon). `Cache-Control: no-cache`. |

The allowed extensions and their MIME types:

| Extension | MIME type |
| --- | --- |
| `.js` | `text/javascript; charset=utf-8` |
| `.css` | `text/css; charset=utf-8` |
| `.woff2` | `font/woff2` |
| `.gltf` | `model/gltf+json` |
| `.bin` | `application/octet-stream` |
| `.webp` | `image/webp` |
| `.png` | `image/png` |
| `.jpg`, `.jpeg` | `image/jpeg` |
| `.svg` | `image/svg+xml` |
| `.hdr` | `image/vnd.radiance` |
| `.exr` | `image/x-exr` |
| `.json` | `application/json; charset=utf-8` |
| `.mp3` | `audio/mpeg` |
| `.ogg` | `audio/ogg` |
| `.wav` | `audio/wav` |

Anything else is a `404`, and so are:

- source maps (`.map`) and `.html` files other than `/`
- dotfiles and dot-folders
- directories (there are no listings)
- paths with `..`, `.`, empty segments, backslashes, null bytes or control characters
- encoded `/`, `\`, `.` or NUL (`%2f`, `%5c`, `%2e`, `%00`), and double encoding
- symlinks whose real path leaves `public/` or lands on a dotfile

Static responses carry an `ETag` and answer `If-None-Match` with `304`. `HEAD` returns the headers, including `Content-Length`, without a body. The query string is ignored, so `?v=2` cache-busting works.

## `GET /api/stream?token=…` (Server-Sent Events)

| Event | When | Data |
| --- | --- | --- |
| `snapshot` | On connect, then whenever anything in it changes (at most about once a second, plus a check every 5 s). | the snapshot below |
| `tick` | On every agent hook event (tool calls, stop, prompt submit, …). | the tick below |

The server sends `retry: 2000` and a comment line every 20 s.

### Tick

```jsonc
{
  "surfaceId": "1F152931-BB98-4AAE-B1FA-7D462F0770D1",   // matches item.surfaceId (cmux ids are upper-case UUIDs)
  "hook": "PreToolUse",                                    // the Claude Code hook name: PreToolUse, Stop, UserPromptSubmit, Notification, SessionStart, …
  "tool": { "name": "Bash", "category": "command" }        // new; only on PreToolUse/PostToolUse, and only when the hook named a tool
}
```

- **Categories:**

  | Claude Code tool | Category |
  | --- | --- |
  | `Edit`, `Write`, `MultiEdit`, `NotebookEdit` | `edit` |
  | `Bash` (also `BashOutput`, `KillShell`) | `command` |
  | `Grep`, `Glob` (also `LS`) | `search` |
  | `WebFetch`, `WebSearch` | `web` |
  | `Read` (also `NotebookRead`) | `read` |
  | anything else (`Task`, `TodoWrite`, `Skill`, MCP tools, …) | `other` |

- **`tool.name`:** MCP tools are shown as `server · tool`, e.g. `Linear · list_issues`.
- **One icon per tool call:** pop it on `PreToolUse`. cmux hooks `PreToolUse` for every tool, but `PostToolUse` only for `PushNotification`. A `PermissionRequest` repeats the tool of the `PreToolUse` before it, so it carries no `tool`.
- **Demo:** sends `PreToolUse` with a tool every 2.5–9 s per working agent, `UserPromptSubmit` when a new task starts and `Stop` when one finishes.

## Snapshot

```jsonc
{
  "generatedAt": "2026-11-21T10:00:00.000Z",
  "source": "cmux",                 // new: "cmux" or "demo"
  "demo": true,                     // only in demo mode
  "cmux": { "ok": true, "eventsLive": true },          // ok: false + "error": "…" when the source failed (items are the last good ones)
  "items": [ /* Item, in no particular order; sort by `order` for the sidebar order */ ],
  "pulse": { "start": "<iso>", "binMs": 300000, "bins": [ /* 36 counts of tool calls, last 3 h */ ] },
  "world": { /* World, new */ }
}
```

### Item

One per cmux terminal. Terminals without an agent are `phase: "shell"`; they belong in the list only, not in the 3D world.

```jsonc
{
  "surfaceId": "<uuid>",            // the terminal; the id used by ticks, actions and /api/conversation
  "workspaceId": "<uuid>",
  "workspaceRef": "workspace:3" | null,
  "order": 3,                        // cmux sidebar order
  "title": "Checkout page redesign", // the workspace title: show this, never a made-up name
  "subtitle": "…" | null,
  "here": false,                     // the workspace selected in cmux right now
  "cwd": "/Users/…/storefront" | null,
  "project": "storefront" | null,    // basename of cwd
  "repo": { "key": "/Users/…/storefront/.git", "name": "storefront", "kind": "web" } | null,   // kind is new
  "branch": "redesign/checkout" | null,
  "ports": [3000],                   // listening dev-server ports
  "agent": { "kind": "claude", "sessionId": "<uuid>", "state": "working" | "idle" | … } | null,
  "phase": "blocked" | "working" | "idle" | "shell",
  "blocked": Blocked | null,         // set when phase is "blocked"
  "statusLabel": "Needs input" | null,   // cmux's sidebar status
  "model": "opus 5.5" | null,
  "mode": "plan" | "acceptEdits" | … | null,
  "contextTokens": 81234 | null,
  "lastPrompt": "…" | null,          // what the person last typed (600 chars max)
  "lastPromptAt": "<iso>" | null,
  "reply": { "text": "…", "at": "<iso>" } | null,   // the agent's latest text, if newer than the last prompt
  "recap": { "text": "…", "at": "<iso>" } | null,   // Claude's "※ recap", if newer than the last prompt
  "question": "Should I also add redirects?" | null, // idle with a reply ending in a question
  "now": { "name": "Edit", "detail": "SummaryCard.tsx", "command": null } | null,   // while working
  "turnStartedAt": "<iso>" | null,   // while working
  "lastActivityAt": "<iso>" | null,  // from transcript timestamps; use it for "stale"
  "unread": 0,                       // unread cmux notifications for this terminal
  "activity": [ /* 36 bins */ ] | null,

  // new for world v2
  "plot": 0..31 | "hangout" | "overflow" | null,
  "spot": 0..5 | null,
  "archived": false
}
```

#### Blocked

| `kind` | Fields | Answer with |
| --- | --- | --- |
| `permission` | `tool: { name, detail, command }` | `permission` |
| `question` | `questions: [{ header, question, multiSelect, options: [{ label, description }] }]` | `question` |
| `plan` | `plan` (Markdown) | `plan` |
| `terminal` | `label`, `tool` | nothing: only the terminal can answer (offer Open in cmux) |

- **Common fields:** every kind has `requestId` (a UUID or null) and `since`.
- **`deadline`:** Feed decisions (non-null `requestId`) also have a `deadline` about 120 s after `since`. After that, cmux hands the decision back to the terminal.
- **No `requestId`:** a question or plan without one was read from the transcript and cannot be answered from the page.

#### Plot, spot, archived (new)

- **`plot`:**
  - `0`–`31`: the repo's own plot.
  - `"hangout"`: an agent outside any git repo.
  - `"overflow"`: the shared co-working building for repos beyond 32.
  - `null`: a shell in a repo that has no plot.
  - **Shells never claim a plot or a spot.** They show their repo's plot if it has one.
- **`spot`:** the agent's place on its plot.
  - Each agent takes the lowest free spot (`0`–`5`) and keeps it while it lives.
  - A freed spot goes to the longest-waiting agent without one.
  - The 7th agent and beyond on a plot get `null`: draw them as the "+N" sign.
  - An agent that disappears keeps its spot reserved for 2 minutes, in case it was a hiccup or a restart.
  - Spots belong to the repo, so they move with it when the repo moves to another plot.
  - Hidden (archived) agents have `spot: null` and give their spot up.
- **`archived`:** true when the session is archived **and** does not need you.
  - **Needs you** means `phase === "blocked"`, or `phase === "idle"` with `unread > 0` or a `question`.
  - An archived session that needs you shows up again with `archived: false`, and hides again once it no longer does.
  - A new prompt typed after archiving (`lastPromptAt` later than the archive time) un-archives it for good.
  - Archiving never touches cmux.
  - Archiving a session that needs you right now (an unread result, say) has no visible effect until that is dealt with. Mark it read first if that is the intent.
- **`repo.kind`:** one of `web`, `mobile`, `docs`, `data`, `other`, for the plot icon. It is read from a few files at the repo root (main worktree), cached 10 minutes, and given up after 1.5 s. The first rule that matches wins:
  1. **mobile:** `expo`, `react-native`, `@capacitor/core` or `@nativescript/core` deps; `ios/` or `android/`; `pubspec.yaml`; an Android Gradle build at the root; `app.json` with `expo`.
  2. **docs:** `@docusaurus/core`, `vitepress`, `nextra` or `@astrojs/starlight` deps.
  3. **web:** `react`, `next`, `vite`, `svelte`, `vue`, `nuxt`, `astro`, `@angular/core` or `solid-js` deps.
  4. **data:** `*.ipynb`, `notebooks/`, `dags/`, `dbt_project.yml`; or Python manifests naming pandas, polars, dbt, airflow, dagster, prefect, pyspark, duckdb, scikit-learn or jupyter.
  5. **docs:** `mkdocs.yml`, `book.toml`, `book/`, `docusaurus.config.*`, Sphinx; or a folder of prose with no code manifest.
  6. **web:** Django, Flask or FastAPI, Rails, or a root `index.html`.
  7. **other:** anything else.

### World (new)

```jsonc
{
  "plotCount": 32,
  "spotsPerPlot": 6,
  "plots": {                         // keyed by repo key (item.repo.key); every repo that owns a plot or waits in overflow
    "/Users/…/storefront/.git": {
      "plot": 0,                     // 0..31 or "overflow"
      "name": "storefront",
      "kind": "web",
      "firstSeen": "<iso>",
      "lastSeen": null,              // null while the repo has a session; otherwise when it last had one
      "active": true,                // has at least one session (archived ones count)
      "agents": 8                    // visible (non-archived) agents
    }
  },
  "free": [12, 13, 14, 15, …],          // plot numbers nobody owns: targets for movePlot
  "archived": [{ "sessionId": "<uuid>", "at": "<iso>" }]   // the Archive view; join on item.agent.sessionId
}
```

- **New repos:** a repo with an agent takes the lowest free plot, in the order the repos were first seen, and keeps it.
- **Dormant repos:** a repo with no sessions shows `active: false` and a `lastSeen` (dim its tag). After 7 days it is dropped and its plot is free again.
- **Overflow:** when all 32 plots are taken, new repos get `"overflow"`. When a plot frees, the overflow repo seen first moves into it.
- **Where it is saved:**
  - Real mode: `~/.config/cmux-switchboard/world.json` (folder 0700, file 0600, written atomically), or `SWITCHBOARD_WORLD_FILE`.
  - Demo: kept in memory and never written.

## `GET /api/conversation?surfaceId=<uuid>` (new)

Needs `X-Switchboard-Token`. Answers with `Cache-Control: no-store`.

```jsonc
{
  "surfaceId": "<uuid>",
  "sessionId": "<uuid>",
  "available": true,                 // false when the agent has no readable transcript (then messages is [])
  "messages": [                      // oldest first
    { "role": "user", "text": "rebuild the checkout card…", "at": "<iso>" },
    { "role": "assistant", "text": "Reading the current card first.", "at": "<iso>" },
    { "role": "assistant", "text": "Done. …", "at": "<iso>" }
  ],
  "truncated": false                 // true when older conversation exists that is not included
}
```

- **What is included:** the last 20 prompts the person typed, each followed by the agent's last 3 text blocks in that turn. The final block is the answer.
- **What is left out:** tool calls and their output, injected context, subagents, synthetic messages and `/compact` summaries.
- **Clipping:** prompts are cut at 2,000 characters and replies at 4,000. The whole response stays under 80,000 characters by dropping the oldest messages.
- **Source:** the last 2 MB of the transcript, cached until the file changes. The conversation can start with an assistant message whose prompt is older than that.
- **Errors:**
  - `400`: not a UUID.
  - `403`: missing token or a foreign `Origin`.
  - `404`: no such terminal, or no agent in it.

## `POST /api/action`

Needs `X-Switchboard-Token`, `Content-Type: application/json`, a body under 64 KB, and a same-origin `Origin` if one is sent. Success is `{ "ok": true }` (the demo may add a `note`). Failure is an HTTP error with `{ "error": "<message to show>" }`.

| `action` | Body | Notes |
| --- | --- | --- |
| `jump` | `workspaceId`, `surfaceId` | Focuses the terminal in cmux and brings cmux forward. |
| `reply` | `workspaceId`, `surfaceId`, `text` | Refused (`409`) unless the agent is idle and its prompt box is empty. 8,000 characters max. |
| `permission` | `requestId`, `mode`: `once` \| `always` \| `deny` | |
| `plan` | `requestId`, `mode`: `manual` \| `autoAccept` \| `deny` | |
| `question` | `requestId`, `selections`: string[] | Option labels. |
| `markRead` | `workspaceId` | Clears that workspace's cmux notifications. |
| `archive` (new) | `sessionId` | `404` if no running session has that id. |
| `unarchive` (new) | `sessionId` | Fine if it was not archived. |
| `movePlot` (new) | `repoKey`, `plot` (integer 0–31) | Only to a free plot (`409` if taken). `404` for an unknown repo. `400` for anything that is not an integer from 0 to 31. |

World actions update the snapshot and push it at once.

## Environment

| Variable | Effect |
| --- | --- |
| `PORT` | Port (default 4747). |
| `SWITCHBOARD_DEMO=1` or `--demo` | Made-up sessions; nothing talks to cmux or writes the world file. |
| `SWITCHBOARD_WORLD_FILE` | Where the world state is saved (default `~/.config/cmux-switchboard/world.json`). |
| `SWITCHBOARD_PUBLIC_DIR` | Serve another build folder (the tests use it). |
| `CMUX_BIN` | Path to the cmux CLI. |
