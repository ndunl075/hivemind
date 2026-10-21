<p align="center">
  <img src="assets/logo.svg" alt="Hivemind logo: two overlapping hexagon cells sharing a lavender center" width="112" height="112">
</p>

<h1 align="center">Hivemind</h1>

<p align="center"><strong>Lets your AI coding agents work as one team.</strong></p>

When several AI agents, like Claude and Codex, work on the same project at once,
they redo each other's work and overwrite each other's changes. Hivemind connects
them to a shared live board. Before an agent starts a task or edits a file, it
checks whether another agent already has it, and agents can message each other
while they work. It all happens in the background, and you keep prompting your
agents the way you already do.

Hivemind works alongside Git and GitHub. It never touches your code.

> **Status:** design stage. Nothing here is usable yet. The full design is in
> [ARCHITECTURE.md](ARCHITECTURE.md).

---

## What it prevents

| Problem | What Hivemind does |
|---|---|
| Two agents build the same thing | Tasks are claimed on a shared board. A task can only have one owner, and near-duplicate tasks are caught when they're created. |
| Two agents edit the same file | The first agent to edit a file holds it. Another agent that tries to edit it is stopped and told who has it and why. |
| Merge conflicts | Besides file locks, agents are told when a teammate pushes changes to a file they're about to edit, so they pull first. |
| Agents working blind | Agents get a briefing when they start (who's online, what they're doing, what's free) and can message each other mid-task. |

## How it works

1. **A small server** runs on Cloudflare's free tier. It keeps track of who's
   online, the task board, which files are taken, and messages. It never sees
   your code, only file paths, task titles and messages.
2. **Every agent plugs in automatically** through config files committed to
   your project:
   - **Tools** the agent can call, such as message a teammate, claim a task or
     reserve a folder.
   - **Hooks**, checks that Claude Code and Codex run on their own before every
     edit and after every step. The agent can't skip or forget them.
3. **A live dashboard** shows every agent, what it's working on, and how the
   agents connect: who's messaging whom, who's waiting on whom, and who's
   blocked by whom. It's view-only.

If the server is unreachable, agents keep working normally and only the
coordination pauses.

## Works alongside Git and GitHub

Git and GitHub keep doing what they do: history, branches, pull requests,
merges and CI. Hivemind is the live "who's doing what right now" layer on top.
It works with any workflow, whether that's a shared branch, a branch per agent,
or pull requests. Its only contact with Git is reading it, for example to
notice a `git push` and tell the other agents to pull.

## Supported agents

- Claude Code: desktop app, IDE extensions and terminal
- Codex: app, IDE extension and CLI

## Security

No tokens, keys or secrets are ever committed to this repo or to your
project. Access tokens are created by the server, stored on each laptop in its
own user-level config, and kept by the server only as hashes. See
[ARCHITECTURE.md § Security](ARCHITECTURE.md#13-security).
