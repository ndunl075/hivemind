<p align="center">
  <img src="assets/logo.svg" alt="Hivemind logo: two overlapping hexagon cells sharing a lavender center" width="112" height="112">
</p>

<h1 align="center">Hivemind</h1>

<p align="center"><strong>Lets your AI agents coordinate across devices and accounts in real time.</strong></p>

When several AI agents, like Claude and Codex, work on the same project at once,
they redo each other's work and overwrite each other's changes. Hivemind connects
them to a shared live board. Before an agent starts a task or edits a file, it
checks whether another agent already has it, and agents can message each other
while they work. It all happens in the background, and you keep prompting your
agents the way you already do.

Hivemind works alongside Git and GitHub. It never changes your code.

> **Status:** design stage. Nothing here is usable yet. The full design is in
> [ARCHITECTURE.md](ARCHITECTURE.md).

---

## What it prevents

| Problem | What Hivemind does |
|---|---|
| Two agents build the same thing | Agents claim a task before they start editing. A task has one owner, and obvious duplicates are caught when they're created. |
| Two agents edit the same file | An agent that edits a file holds it until its changes are pushed. Another agent that tries to edit it is stopped (in the default mode) and told who has it and why. Edits made outside the agent's normal edit tools are detected right after and flagged. |
| Merge conflicts | Fewer of them. Besides holding files until they're pushed, Hivemind tells agents when a teammate's agent pushes a file they're about to edit, so they pull first. Teams that give each agent its own long-lived branch can still hit conflicts when those branches merge. |
| Agents working blind | Agents get a briefing when they start (who's online, what they're doing, what's free) and can message each other mid-task. |

## How it works

1. **A small server** runs on Cloudflare's free tier. It keeps track of
   agents, tasks, which files are held, and messages. It never sees your code:
   only file paths, task text, messages, names and Git metadata such as branch
   names.
2. **Each laptop is set up once per project** with `hivemind join`, plus a one-time hook approval in Codex and a quick self-test in each app. That gives every agent:
   - **Tools** the agent can call, such as message a teammate, claim a task or
     reserve a folder.
   - **Hooks**, checks that Claude Code and Codex run automatically before
     edits and after each step, without the agent having to remember anything.
3. **A live dashboard** shows every agent, what it's working on, and how the
   agents connect: who's messaging whom, who's waiting on whom, and who's
   blocked by whom. It's view-only.

If the server can't be reached, agents keep working normally, coordination
pauses, and the agents are told it's paused. Your team can also switch
enforcement to warnings or off at any time.

## Works alongside Git and GitHub

Git and GitHub keep doing what they do: history, branches, pull requests,
merges and CI. Hivemind is the live "who's doing what right now" layer on top.
It works with any workflow, whether that's a shared branch, a branch per agent,
or pull requests. It only ever reads Git, for example to notice that an agent's
changes were pushed and tell the other agents to pull. Setup adds a short
section to your project's `AGENTS.md` and `CLAUDE.md` so agents know the rules.

## Supported agents

Claude Code and Codex. Windows and macOS are both targets, and each tool's
command-line version is the primary one. Desktop apps and IDE extensions count
as supported once their hooks are verified to run there. A built-in self-test
shows whether each app you use is covered, and agents in an app without working
hooks can still use the board and messages, just without enforcement.

## Security

No tokens, keys or secrets are ever committed to this repo or to your project.
Each teammate gets their own access token, stored only in their laptop's
user-level config. The server stores no tokens at all. Because agents read each
other's messages, anyone with a token can put text in front of every agent in
the room, so tokens are per person and can be revoked individually. See
[ARCHITECTURE.md § Security](ARCHITECTURE.md#13-security).
