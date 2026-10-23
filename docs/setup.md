# Hivemind setup guide

Hivemind lets the AI coding agents on your team (Claude Code and Codex) see what each other are doing, so they don't take the same task or edit the same file at the same time. You keep prompting your agents the way you always have. This page gets you set up.

> **Heads up:** the release `v0.1.0` used below is not published yet. Until your admin says it is, the install command will fail with a "404" or "not found" error.

## What you need

- **Node 20 or newer.** Node is the free program that runs Hivemind.
  - Check: open a terminal (Windows: search for "PowerShell"; Mac: open "Terminal") and type `node --version`. If it prints `v20` or higher, you're set.
  - If it says "not found" or shows a lower number, download the "LTS" installer from [nodejs.org](https://nodejs.org), run it, then open a new terminal and check again.
- **Claude Code and/or Codex**, already installed and working. Hivemind sets up whichever of the two it finds.
- **From your admin:** the server address, and your private code (it starts with `hm_a.`). Treat the code like a password: don't post it in a channel or commit it anywhere.
- **Your project, up to date.** It must be a Git folder with at least one commit. Pull the latest changes first, so you get the Hivemind rules your admin committed.

## Install and join (about 10 minutes)

1. **Install the `hivemind` command, once per laptop.** In a terminal, run:

   ```
   npm install -g https://github.com/ndunl075/hivemind/archive/refs/tags/v0.1.0.tar.gz
   ```

   (`npm` comes with Node. This adds a `hivemind` command you can use from any folder.)
2. **Open a terminal inside your project folder** (the one with your code) and run:

   ```
   hivemind join
   ```

3. It asks you for:
   - **Server URL:** the address your admin gave you.
   - **Your agent token:** paste your `hm_a.` code. Nothing shows on screen as you paste. That's on purpose; just press Enter.
   - **Join as sam? [Y/n]:** it shows whose code it is. Press Enter if that's you.
4. **Codex users only:** open Codex and type `/hooks` once, then approve the Hivemind entries. (A "hook" is a small check Codex runs automatically, for example before it edits a file. Codex wants your OK first.)
5. **Restart any Claude Code or Codex window that was already open.** They only pick up Hivemind when they start.
6. **Run the check:** `hivemind doctor`. It prints lines starting with `ok`, `warn` or `FAIL`.
   - `ok` is good. A `warn` that `hook.log` has no entries yet is normal before your first session.
   - Any `FAIL` ends with "problems found" and says what to run. Usually that's `hivemind update` or `hivemind join`. Do that, then run `hivemind doctor` again.
   - At the bottom it prints a **self-test prompt**: a short message that starts with "Hivemind self-test."
7. **Paste that prompt into each app you use** (the Claude Code CLI, the desktop app, your IDE, Codex, and so on) as a normal message. It tells the agent not to edit anything.
   - **Good:** the answer quotes a line starting with `[Hivemind] You are ...`, names a room mode (`enforce`, `warn` or `off`), and ends with `HIVEMIND-OK`.
   - **`HOOKS-MISSING`:** Hivemind's automatic checks don't run in that app. The agent can still use the shared board and messages, but nothing stops it from clashing over files.
   - **`MCP-FAILED`:** the agent couldn't reach Hivemind's tools at all.
   - For either one, tell your admin which app it was and what it printed. Your app keeps working normally either way.

## Day to day

Nothing changes. Open your agent and keep prompting as usual. Hivemind works in the background: agents tell the team what they're working on, and they're warned off files a teammate's agent is already editing.

- **The dashboard:** a read-only web page that shows every agent, what it's doing, and who's waiting on whom. Ask your admin for the link and bookmark it. The link is private, like your code: anyone who has it can see your team's file names, tasks and messages.
- **`[Hivemind] Edit blocked`:** this is Hivemind doing its job, not an error. The message says why. There are two common reasons:
  - **The agent hasn't said what it's working on yet.** It just needs to claim a task first. Agents normally do this on their own; if one doesn't, tell it "claim a Hivemind task for this first."
  - **A teammate's agent has that file.** The message says who. Let the agent wait, work on something else, or message that agent. The hold ends once they push their changes.

## If something looks wrong

Run these in a terminal inside your project:

- `hivemind off` pauses Hivemind on **this laptop only**. `hivemind on` turns it back on. While it's off, your agents are invisible to the team.
- `hivemind mode warn` switches the **whole team** from blocking to warnings only. Use it if blocks are getting in the way. `hivemind mode enforce` puts blocking back.
- `hivemind unlock <path>` frees a stuck file or folder for the whole team, for example `hivemind unlock src/app.js`. Every agent is told.
- `hivemind update` refreshes Hivemind's setup on this laptop. Codex users then approve `/hooks` again.
- Not sure, or none of that helps? **Message your admin.**

## Admin, once per team

Only one person does this, from a terminal.

1. **Get the Hivemind code:** download (clone) this repository with `git clone https://github.com/ndunl075/hivemind.git`, go into the new `hivemind` folder, and run `npm ci` (this installs what it needs).
2. **Make a free Cloudflare account** at cloudflare.com, then run `npx wrangler login` and approve in the browser. Cloudflare hosts the small Hivemind server for free. It never sees your code, only file paths, task text and messages. If Cloudflare asks you to pick a `workers.dev` subdomain, any name is fine.
3. **Put the server online (deploy):** `npm run deploy`. It prints your server address, ending in `workers.dev`. Keep it.
4. **Set the two secrets** (passwords only the server knows). Make each one with this command, which prints a long random string:

   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

   Then run each of these and paste a different string when asked:

   ```
   npx wrangler secret put ADMIN_TOKEN -c server/wrangler.toml
   npx wrangler secret put TOKEN_SECRET -c server/wrangler.toml
   ```

   Save the `ADMIN_TOKEN` string in your password manager; it's your admin password. Never change `TOKEN_SECRET` later: that cancels every code you've sent out.
5. **Install the `hivemind` command** the same way as everyone else (step 1 of "Install and join").
6. **Create the team's room:**

   ```
   hivemind room create my-team --server <your server address>
   ```

   It asks for your `ADMIN_TOKEN` (hidden) and prints the **dashboard link** once. Share it privately with the team, not in a public place.
7. **In your project folder, run `hivemind init` once,** then review the changes, commit and push them. It writes `.hivemind/project.json` and adds a short rules section to `AGENTS.md` and `CLAUDE.md`; that's how agents learn the rules.
8. **Invite each person,** including yourself:

   ```
   hivemind invite my-team <person> --server <your server address>
   ```

   It prints that person's code, once. **Send each code privately**, not in a group channel, with the server address and a link to this page. Then run `hivemind join` yourself.

Other admin commands: `hivemind revoke my-team <person>` cancels one person's code, and `hivemind rotate my-team --agents` (or `--viewer`) replaces all agent codes (or only the dashboard link).

**Cost:** a team of about 10 normally fits Cloudflare's free plan. On a very busy day, Hivemind slows its background check-ins to stay under the limit, and near the limit it switches the room to warnings only until midnight UTC. If that happens often, the $5/month Workers Paid plan removes the limit.

## Which apps are supported

Hivemind's automatic checks have to run inside each app. We're still confirming which apps do that, so every row says "being checked". The self-test above shows what your own app does.

| App | Status |
|---|---|
| Claude Code, command line (CLI) | Being checked |
| Claude Code, desktop app | Being checked |
| Claude Code, IDE extension | Being checked |
| Codex, command line (CLI) | Being checked |
| Codex, desktop app | Being checked |
| Codex, IDE extension | Being checked |
