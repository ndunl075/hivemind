/**
 * The hook pipeline (ARCHITECTURE.md §6.2, §6.4). One POST /hook request runs these steps in order:
 *   identify -> update the roster -> settings -> Git state -> event handler -> response.
 * Extension points: a feature object may offer `hookStages()` returning stages for the phases below. Stages run
 * after the built-in step of the same phase and can add context, or deny an edit by calling call.deny().
 * The tool side (POST /mcp) is features/mcp, built with the same services.
 */
import {
  type Actor, type AgentRecord, type BriefingContributor, type HookRequest, type HookResponse, type Millis,
} from '../../shared/contracts';
import { buildBriefing } from './briefing';
import { denialText } from './features/locks/denial';
import { RoomFullError } from './agents';
import { actorOf, HttpError, type RoomServices } from './services';
import { deriveState } from '../../shared/state';

export type HookPhase = 'afterIdentify' | 'beforeEdit' | 'afterEdit' | 'beforeRespond';

export interface HookCall {
  req: HookRequest;
  actor: Actor;
  agent: AgentRecord;
  now: Millis;
  /** Extra text for the agent's context. */
  context: string[];
  /** Set to deny the tool call (PreToolUse) or block the stop (Stop). */
  deny(reason: string): void;
  denied: string | null;
}

export type HookStage = (call: HookCall) => void;

export interface HookStageProvider {
  hookStages(): Partial<Record<HookPhase, HookStage>>;
}

const EXIT_NOT_END = new Set(['clear', 'resume']);

export class Pipeline {
  constructor(private readonly svc: RoomServices) {}

  private stages(phase: HookPhase): HookStage[] {
    const out: HookStage[] = [];
    for (const f of Object.values(this.svc.features)) {
      const provider = f as Partial<HookStageProvider>;
      const s = provider.hookStages?.()[phase];
      if (s) out.push(s);
    }
    return out;
  }

  private runStages(phase: HookPhase, call: HookCall): void {
    for (const s of this.stages(phase)) s(call);
  }

  /** The §6.6 briefing for an agent. */
  briefing(agent: AgentRecord, unread: number): string {
    const { ctx, features } = this.svc;
    const actor = actorOf(agent);
    const extra: string[] = [];
    for (const f of Object.values(features)) {
      const c = f as Partial<BriefingContributor>;
      if (typeof c.briefingLines === 'function') extra.push(...c.briefingLines(actor));
    }
    return buildBriefing({
      room: this.svc.roomName(), mode: ctx.mode(), you: agent.callsign, now: ctx.now(), agents: ctx.agents(),
      taskOf: (cs) => features.tasks.inProgressFor(cs),
      openTasks: features.tasks.list().filter((t) => t.status === 'open'),
      heldByOthers: features.locks.list().filter((l) => l.holder !== agent.callsign),
      unread, extra,
    });
  }

  handleHook(person: string, req: HookRequest): HookResponse {
    const { ctx, features, agents } = this.svc;
    const now = ctx.now();

    // identify
    let agent = agents.bySession(req.session);
    if (agent && agent.person !== person) throw new HttpError(403, 'session belongs to another person');
    if (!agent) {
      if (req.event === 'SessionEnd') return this.respond(null, req, 'none', null, null);
      try {
        agent = agents.register({
          kind: req.agent, person, session: req.session, hooked: true, repo: req.repo, repoName: req.repoName ?? null,
          checkout: req.checkout, branch: req.branch, head: req.head,
        });
      } catch (e) {
        if (e instanceof RoomFullError) throw new HttpError(429, 'room is full');
        throw e;
      }
      ctx.emit({ type: 'agent.joined', actor: agent.callsign, text: `${agent.callsign} joined` });
    } else if (agents.isEnded(agent)) {
      if (req.event === 'SessionEnd') return this.respond(agent, req, 'none', null, null);
      agents.revive(agent);
      ctx.emit({ type: 'agent.revived', actor: agent.callsign, text: `${agent.callsign} is back` });
    }

    // roster
    const shown = (a: AgentRecord): string => [a.branch, a.head, a.checkout, a.repo, a.repoName, a.activity, a.idleSince !== null, a.outageAt, a.hooked].join('|');
    const before = shown(agent);
    agent.hooked = true;
    agent.repo = req.repo;
    agent.checkout = req.checkout;
    agent.branch = req.branch;
    agent.head = req.head;
    if (req.repoName) agent.repoName = req.repoName;
    if (req.outageMs) {
      agent.outageAt = now;
      agent.outageMs = req.outageMs;
    }
    const editPaths = req.event === 'PreToolUse' ? (req.paths ?? []) : [];
    const idle = req.event === 'Stop';
    const clearsActivity = req.event === 'UserPromptSubmit' || idle;
    agents.touch(agent, {
      idle,
      ...(editPaths.length > 0
        ? { activity: `${req.tool ?? 'Edit'} ${editPaths.slice(0, 3).join(', ')}`.slice(0, 300) }
        : clearsActivity ? { activity: null } : {}),
    });
    if (shown(agent) !== before) this.svc.changed();
    const actor = actorOf(agent);

    const call: HookCall = {
      req, actor, agent, now, context: [], denied: null,
      deny(reason) { this.denied = reason; },
    };
    this.runStages('afterIdentify', call);

    // settings
    if (req.settings) this.svc.storeSettings(req.repo, req.settings);

    // Git state
    if (req.git) {
      if (req.git.pushed && req.git.pushed.files.length > 0) features.pushes.record(actor, req.repo, req.git.pushed);
      features.locks.applyGitState(actor, req.repo, req.git, req.shellSinceHeartbeat === true);
    }

    let decision: HookResponse['decision'] = 'none';
    let lastPush: HookResponse['lastPush'];

    switch (req.event) {
      case 'SessionStart': {
        const msgs = features.messages.takeUnread(agent.callsign);
        let text = this.briefing(agent, msgs.length);
        if (msgs.length > 0) text += `\n\n${features.messages.format(msgs, now)}`;
        call.context.push(text);
        break;
      }
      case 'UserPromptSubmit':
      case 'PostToolUse': {
        const msgs = features.messages.takeUnread(agent.callsign);
        if (msgs.length > 0) call.context.push(features.messages.format(msgs, now));
        break;
      }
      case 'PreToolUse': {
        if (editPaths.length === 0) break;
        decision = 'allow';
        this.runStages('beforeEdit', call);
        const mode = ctx.mode();
        if (mode !== 'off' && !call.denied) {
          const gate = features.tasks.gate(actor, ctx.settings(req.repo));
          if (!gate.allow) {
            if (mode === 'enforce') {
              call.deny(`[Hivemind] Edit blocked: ${gate.reason}`);
              ctx.emit({
                type: 'task.gate', actor: actor.callsign, text: `${actor.callsign} was blocked: no task`,
                pulse: { kind: 'denied', from: actor.callsign, path: editPaths[0] as string },
              });
            } else {
              call.context.push(`[Hivemind] Heads-up: ${gate.reason}`);
            }
          }
        }
        if (mode !== 'off' && !call.denied) {
          const held = features.locks.holdings(actor.callsign).length;
          const d = features.locks.checkEdit(actor, req.repo, editPaths);
          if (features.locks.holdings(actor.callsign).length !== held) this.svc.changed();
          if (!d.allow) {
            const titles = new Map(features.tasks.list().map((t) => [t.id, t.title] as const));
            const silence = new Map(ctx.agents().map((a) => [a.callsign, deriveState(a, now).silenceMs] as const));
            call.deny(denialText({ paths: editPaths, conflicts: d.conflicts, taskTitles: titles, silenceMs: silence }));
            for (const c of d.conflicts) {
              const base = c.path.replace(/\/$/, '').split('/').pop() ?? c.path;
              ctx.emit({
                type: 'lock.denied', actor: actor.callsign, text: `${actor.callsign} was blocked on ${c.path} (held by ${c.holder})`,
                data: { path: c.path, holder: c.holder },
                pulse: { kind: 'denied', from: actor.callsign, to: c.holder, path: c.path },
                edge: { kind: 'blocked', from: actor.callsign, to: c.holder, label: base },
              });
            }
          } else {
            call.context.push(...d.notes);
            for (const c of d.conflicts) {
              ctx.emit({
                type: 'lock.warned', actor: actor.callsign, text: `${actor.callsign} edits ${c.path} held by ${c.holder} (warn mode)`,
                pulse: { kind: 'denied', from: actor.callsign, to: c.holder, path: c.path },
              });
            }
          }
        }
        if (call.denied) {
          decision = 'deny';
          const msgs = features.messages.takeUnread(agent.callsign);
          if (msgs.length > 0) call.denied += `\n\n${features.messages.format(msgs, now)}`;
        } else {
          this.runStages('afterEdit', call);
          const lp = features.pushes.latest(actor, req.repo, editPaths);
          if (lp.length > 0) lastPush = lp;
        }
        break;
      }
      case 'Stop': {
        if (req.stopActive !== true && features.messages.hasUnreadDirect(agent.callsign)) {
          const msgs = features.messages.takeUnread(agent.callsign, { directOnly: true });
          if (msgs.length > 0) {
            decision = 'block';
            call.denied = features.messages.format(msgs, now);
          }
        }
        // One block per Stop: unread direct messages come first. The task reminder is once per task (recorded by the
        // board), never in mode off, never while stop_hook_active, and not while the budget guard has heartbeats off.
        if (decision !== 'block' && req.stopActive !== true && ctx.mode() !== 'off' && this.svc.heartbeatMs() > 0) {
          const reminder = features.tasks.stopReminder(agent.callsign);
          if (reminder) {
            decision = 'block';
            call.denied = reminder;
          }
        }
        break;
      }
      case 'SessionEnd': {
        if (!EXIT_NOT_END.has(req.endReason ?? '')) {
          this.svc.endAgent(agent);
        }
        break;
      }
    }

    this.runStages('beforeRespond', call);
    const reason = decision === 'deny' || decision === 'block' ? call.denied : null;
    const context = call.context.length > 0 ? call.context.join('\n\n') : null;
    return this.respond(agent, req, decision, reason, context, lastPush);
  }

  private respond(
    agent: AgentRecord | null, _req: HookRequest, decision: HookResponse['decision'], reason: string | null,
    context: string | null, lastPush?: HookResponse['lastPush'],
  ): HookResponse {
    return {
      decision, reason, context, callsign: agent?.callsign ?? '',
      ...(lastPush ? { lastPush } : {}),
      heartbeatMs: this.svc.heartbeatMs(),
      mode: this.svc.ctx.mode(),
    };
  }
}

