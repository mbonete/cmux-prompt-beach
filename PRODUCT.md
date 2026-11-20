# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

One developer (the author) running many Claude Code sessions at once, one per cmux workspace, on a Mac. They glance at Switchboard between tasks to see which agents need them, then act or jump to the terminal. The repo is public, so other cmux users may run it too, and it doubles as a portfolio piece.

## Product Purpose

Switchboard is a live local dashboard for the agents running in cmux. It answers "who needs me, who is working, whose move is it, what went stale" at a glance, and lets the user act without hunting through tabs: allow or deny a permission, answer a question, approve a plan, reply to an idle agent, mark read, or jump to the terminal in cmux.

## Positioning

Agent "who needs me" boards are common (Claude Code's Agent view, cmux's Agents Board template, menu-bar and TUI tools). Switchboard's differences are stale triage, Claude's recaps, separating unread results from open questions, and approvals from a web page. Since the 2026-11-20 redesign it presents the sessions as a small open-world city: every git repository is a lot, every agent a hotel floor plus a person and their car, and the agent card is an in-game phone.

## Operating Context

- Started with `npm start` from a cmux terminal (cmux only answers its own terminals) and opened at `http://localhost:4747`, in Chrome or as a cmux browser split, which can be narrow.
- Reads `cmux current --json`, `cmux rpc workspace.list | feed.list | notification.list`, `cmux list-status`, `cmux events --reconnect`, and Claude Code transcripts (read-only, last 2 MB).
- Feed decisions (permission, question, plan) are held by cmux for about 120 seconds; after that the agent falls back to its terminal prompt.

## Capabilities and Constraints

- A project is a git repository (grouped by `git rev-parse --git-common-dir`, so worktrees join their repo); sessions outside any repo share a "hangout" lot.
- States: Needs you (open decision, pending question or plan, unread result, or reply ending in a question), Working, Your move, Stale (idle longer than the "Stale after" setting), No agent (terminal without an agent).
- Actions: Open in cmux, Allow once / Always allow / Deny, answer a question, approve a plan (manual or auto) or keep planning, Reply (only when the agent is idle and its prompt box is empty), Mark read.
- Node 20+, no npm dependencies; `server.mjs` serves `public/`. Three.js is vendored as a static file (user decision, 2026-11-20), so it still runs with no install and offline.
- Local only: binds 127.0.0.1, Host and Origin checks, per-start token, strict CSP (`script-src 'self'`, `style-src 'self'`, no external fonts or CDNs).
- Feed "All tools" and "Bypass" permission modes are deliberately not offered.
- Demo mode with made-up sessions exists for screenshots and sharing, so real session titles and prompts are never published.

## Brand Commitments

- The look is a homage to the 2026 open-world crime-game release (sun-soaked Florida-style coast, golden hour into neon night, Art Deco beachfront, minimap, phone), chosen by the user on 2026-11-20. The game is never named in the UI, README or posts.
- Kept out on purpose (the repo is public): that game's logo and numeral, its characters or lookalikes, its place names and map, its art, screenshots, music and catchphrases, the Pricedown lettering, the painted cover-art panel grid and the wanted-star meter. Switchboard uses its own replacements (Anton + Yellowtail, its own banners, a countdown ring on the phone).

## Evidence on Hand

- No real usage numbers, users or testimonials. Screenshots for the README must come from demo mode.

## Product Principles

1. The one who needs you is never missed: needs-you agents must be findable from any camera position and zoom.
2. Act where you look: every decision the Feed allows can be made from the page, and the terminal is one click away.
3. Never type into a draft or interrupt a turn.
4. Nothing leaves the machine.

## Accessibility & Inclusion

- Every agent and action must be reachable without the 3D view (keyboard roster plus inspector), so the world is never the only way in.
- Honor `prefers-reduced-motion`: no walking, bobbing or camera flights.
