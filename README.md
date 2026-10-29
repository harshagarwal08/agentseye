# Lookout

Your Mac and its coding agents, in your pocket. Phone-first web app (PWA) inspired by [Shed](https://github.com/IAmUnbounded/shed).

```bash
npm install && npm start          # http://localhost:4480 — set a password on the Mac
node bin/lookout.js install-service   # optional: start at login
npm test
```
Then on the Mac: **Settings → Use Lookout from your phone** (installs `cloudflared` if missing) → scan the QR → sign in → Share → Add to Home Screen → turn on notifications.

## Home
- **Usage limits**: Claude Code (live, from its usage endpoint via the Keychain token) and Codex (latest `rate_limits` from its logs) — % used per window and time to reset. Tap to refresh; push alert at 90%.
- **Needs you**: Claude permission requests (Allow / Deny + reason) and sessions waiting for input.
- **Live sessions**: pixel mascots per agent (working / waiting / idle), Claude Code + Codex.
- **Pick up where you left off**, **This Mac** glance (CPU, memory, disk, updates).
- **Composer**: start a new Claude/Codex session in any project, with model, name and skip-permissions options. Runs your own `claude`/`codex` login in Terminal.app; the phone opens the session as soon as it appears.

## Session
- **Names**: your own name (tap the title to rename) › Claude's latest AI title › first prompt; subtitle shows project · git branch. Names also appear in notifications.
- **Helpers**: Claude subagents for the session (type, task, working/done/stopped, last result); tap one to read its transcript.
- **Chat**: transcript with markdown; files the agent mentions get download buttons; reply box.
  Replies are typed into the session's Terminal tab (bracketed paste, foreground re-check), or resume a closed session in a new window. Sessions open in other apps (VS Code, T3…) continue in a copy (`claude --resume --fork-session` / `codex fork`) so two programs never write to one conversation.
- **Terminal**: live screen (2 s), parsed menu choices, Stop / 1 / 2 / 3 / Enter / Mode keys.
- **Files**: newest images, video, audio, PDFs, docs in the project; preview + download.

## This Mac
Processes (quit/force quit), Network (listening ports, exposed vs local), Startup (launch agents: start/stop), Updates (Homebrew/npm one-tap or all, macOS list), Privacy (TCC grants, revoke).

## Phone access & security
- Cloudflare Quick Tunnel (URL changes on restart; Lookout follows it).
- Password + **device approval on the Mac**; scanning the QR (single-use, 10 min) skips approval.
- Per-device keys (hashed), sign out any device, rate-limited sign-in, push alert after 20 failures.
- Mac-only actions: approving devices, tunnel, hook install, opening panes on the Mac.
- Web push (VAPID): agent needs OK, agent finished, new device waiting.
- Claude permission prompts go through a `PermissionRequest` hook (Settings → Approvals → Install); unanswered requests fall back to Claude's own prompt.

Data lives in `~/.lookout` (`LOOKOUT_HOME`), port `LOOKOUT_PORT` (4480).
