# Hivemind setup guide

Hivemind lets the AI coding agents on your team (Claude Code and Codex) see what each other are doing, so they don't edit the same file at the same time. You keep prompting your agents the way you always have. This page gets you set up.

> **Heads up:** the release tag `v0.1.0` used below is not published yet. Until your admin tells you it is, the `npx` commands in this guide will fail with a "not found" error. Ask your admin which tag to use.

Every command below is written in its long form, `npx github:ndunl075/hivemind#v0.1.0 <command>`. Joining does **not** add a short `hivemind` command to your computer, so keep using the long form. (`npx` is a helper that comes with Node. It downloads and runs a program in one step.)

## What you need

- **Node 20 or newer.** Node is the free program that runs Hivemind's setup.
  - Check: open a terminal (Windows: search for "PowerShell"; Mac: open "Terminal") and type `node --version`. If it prints `v20` or higher, you're set.
  - If it says "not found" or shows a lower number, download the "LTS" installer from [nodejs.org](https://nodejs.org), run it, then open a new terminal and check again.
- **Claude Code and/or Codex**, already installed and working. Hivemind sets up whichever of the two it finds.
- **The private code your admin sent you.** It starts with `hm_a.`. Treat it like a password: don't post it in a channel or commit it anywhere.
- Also: your project must be a Git folder with at least one commit, and you run the setup from inside it.

## Join (about 10 minutes)

1. Open a terminal **inside your project folder** (the one with your code).
2. Run:

   ```
   npx github:ndunl075/hivemind#v0.1.0 join
   ```

3. It asks you for three things:
   - **Server address:** the web address your admin gave you.
   - **Your code:** paste the `hm_a.` code. Nothing shows on screen as you paste. That's on purpose; just press Enter.
   - **Your name:** it shows who the code belongs to, for example `Join as sam? [Y/n]`. Press Enter if that's you. (Your name comes from the code, so you don't type it.)
4. **Codex users only:** open Codex and type `/hooks` once, then approve the Hivemind entries. (A "hook" is a small check Codex runs automatically before it edits a file. Codex wants your OK first.)
5. **Restart any Claude Code or Codex window that was already open.** They only pick up Hivemind when they start.
6. Run the check:

   ```
   npx github:ndunl075/hivemind#v0.1.0 doctor
   ```

   It prints a list of lines starting with `ok`, `warn` or `FAIL`. Everything should say `ok`. (A `warn` that "hook.log has no entries yet" is normal before your first session.) At the bottom it prints a **self-test prompt**: a short message that starts with "Hivemind self-test."

7. **Paste that prompt into each app you use** (the Claude Code CLI, the desktop app, your IDE, Codex, and so on) as a normal message. It tells the agent not to edit anything.
   - **A good answer** quotes a line starting with `[Hivemind] You are ...`, names a room mode (`enforce`, `warn` or `off`), and ends with `HIVEMIND-OK`.
   - **A bad answer** says `HOOKS-MISSING` (Hivemind's automatic checks don't run in that app) or `MCP-FAILED` (the agent couldn't reach Hivemind). Tell your admin which app it was and what it printed. An app that fails still works for you; it just isn't protected by Hivemind.

## Day to day

Nothing changes. Open your agent and keep prompting as usual. Hivemind works in the background: agents tell the team what they're working on, and they're warned off files a teammate's agent is already editing.

- **The dashboard:** your admin has a read-only web link that shows every agent, what it's doing, and who's waiting on whom. Ask them for it and bookmark it.
- **A "blocked" message:** if an agent says something like `[Hivemind] Edit blocked`, it tried to edit a file a teammate's agent is working on. The message says who has it and why. Let the agent wait, work on something else, or message that agent. The hold goes away on its own once they push their changes. This is Hivemind doing its job, not an error.

## If something looks wrong

Run these in a terminal inside your project, in the long form. For example: `npx github:ndunl075/hivemind#v0.1.0 mode warn`.

- `off` pauses Hivemind on **this laptop only**. `on` turns it back on. While it's off, your agents are invisible to the team.
- `mode warn` switches the **whole team** from blocking to warnings only. Use it if blocks are getting in the way. `mode enforce` puts blocking back.
- `unlock <path>` frees a stuck file or folder for the whole team, for example `unlock src/app.js`. Every agent is told.
- Not sure, or none of that helps? **Message your admin.**

## Admin, once per team

Only one person does this. You need the Hivemind code on your machine: clone this repository, then run `npm ci` in it.

1. **Make a free Cloudflare account** at cloudflare.com, then run `npx wrangler login` and approve in the browser. (Cloudflare hosts the small Hivemind server for free. It never sees your code, only file paths, task text and messages.)
2. **Deploy:** `npm run deploy`. It prints your server address. Keep it.
3. **Set the two secrets**, pasting a long random string when asked for each:
   - `npx wrangler secret put ADMIN_TOKEN` (your admin password; keep it)
   - `npx wrangler secret put TOKEN_SECRET` (used to make everyone's codes)
4. **Create the team's room:**

   ```
   npx github:ndunl075/hivemind#v0.1.0 room create my-team --server <your server address>
   ```

   It asks for your `ADMIN_TOKEN` (hidden) and prints the **dashboard link** once. Copy it and share it with the team.
5. **Invite each person:**

   ```
   npx github:ndunl075/hivemind#v0.1.0 invite my-team <person> --server <your server address>
   ```

   It prints that person's code, once. **Send each code privately**, not in a group channel. Also send them the server address and a link to this page.
6. **In the project folder, run `init` once, then commit:**

   ```
   npx github:ndunl075/hivemind#v0.1.0 init
   ```

   This writes `.hivemind/project.json` and adds a short rules section to `AGENTS.md` and `CLAUDE.md`, which is how agents learn the rules. Review the changes, commit and push them so teammates get them.

Other admin commands: `revoke my-team <person>` cancels one person's code, and `rotate my-team --agents` (or `--viewer`) replaces all agent codes (or only the dashboard link).

**Cost:** a team of about 10 fits Cloudflare's free plan. If you ever outgrow it, the $5/month Workers Paid plan lifts the limits.

## Which apps are supported

Hivemind's automatic checks have to run inside each app. We're still confirming which apps do that, so every row is "being checked". The self-test above shows what your own app does.

| App | Status |
|---|---|
| Claude Code, command line (CLI) | Being checked |
| Claude Code, desktop app | Being checked |
| Claude Code, IDE extension | Being checked |
| Codex, command line (CLI) | Being checked |
| Codex, desktop app | Being checked |
| Codex, IDE extension | Being checked |

An app that fails the self-test still works normally and can still use the shared board and messages. It just isn't protected from file clashes.
