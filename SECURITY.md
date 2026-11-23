# Security

Prompt Beach reads your agents' transcripts and can act on your agents: it can answer their permission prompts (including "Always allow") and type replies into idle ones. This page says what protects that, what doesn't, and how to check what you run.

## What it does on your machine

- **Runs:** `node server.mjs` with Node's built-in modules only. There are no install hooks, and `npm start` needs no `npm install`.
- **Reads:** cmux state through the `cmux` command, the last 2 MB of each session's transcript in `~/.claude/projects/` (read-only), and a few files at each repository's root to recognise its kind. It runs `git rev-parse --git-common-dir` in each folder your agents work in.
- **Writes:** `~/.config/prompt-beach/world.json` only (repo paths and names, session ids; file mode 0600).
- **Network:** it makes no outbound connections. The server listens on `127.0.0.1` only. The page's Content-Security-Policy allows scripts, styles, fonts and connections from its own server only.
- **Child processes:** `cmux` and `git`, always with an argument list, never through a shell. Session and request ids are checked to be UUIDs; reply text goes in through stdin, capped and with control characters refused.

`npm run demo` serves made-up data and reads or writes nothing on your machine.

## What protects the actions

- **Other websites** can't use it: requests must carry `Host: localhost` or `127.0.0.1` (no DNS rebinding), a same-origin `Origin`, a JSON body and a random token generated at startup; the server sends no CORS headers, and `frame-ancestors 'none'` / `X-Frame-Options: DENY` stop other pages from framing it (no clickjacking).
- **Not protected against: programs running as you.** The token is in the page the server sends to anyone who asks on `127.0.0.1`, so any local program (or another account on the same Mac, or a browser extension with localhost access) can read it and use the dashboard's actions. Programs running as you can already read your transcripts and talk to cmux from inside it, but not every program you run is inside cmux. Don't run Prompt Beach on a shared computer.
- **Permission cards** show the exact call being approved: the transcript's copy only when it can't be another call (one open call of that tool, made at the time of the request), otherwise cmux's own copy, which is exactly what Allow approves (some paths may be shortened there). For anything sensitive, you can always answer in the terminal instead.

## Check that the prebuilt page matches the source

The page your browser runs is the minified bundle in `public/build`, built from `client/` with the exact package versions in `package-lock.json`. The build is reproducible, so you can rebuild it and compare:

```bash
npm ci            # the build tools, at the locked versions
npm run build     # rebuilds public/build and public/index.html
git status        # nothing changed: the committed bundle is what the source produces
```

The bundle's file names contain a hash of their content, so a rebuild that matches leaves `git status` clean.

## Reporting a problem

Please open an issue on GitHub. If it's something that shouldn't be public before it's fixed, say so in the issue without the details and we'll find a private channel.
