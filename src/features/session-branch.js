const DEFAULT_MAX_PROMPT_LENGTH = 12_000;

export class SessionBranchController {
  constructor({ history, runtime, sessions, maxPromptLength = DEFAULT_MAX_PROMPT_LENGTH } = {}) {
    requireMethod(history, 'read', 'Session Branch history');
    requireMethod(runtime, 'create', 'Session Branch runtime');
    requireMethod(runtime, 'fork', 'Session Branch runtime');
    requireMethod(runtime, 'submit', 'Session Branch runtime');
    requireMethod(sessions, 'register', 'Session Branch sessions');
    this.history = history;
    this.runtime = runtime;
    this.sessions = sessions;
    this.maxPromptLength = positiveInteger(maxPromptLength, 'maxPromptLength');
  }

  async branch({ sourceSessionId, replaceTurnId, prompt, context = null } = {}) {
    const sourceId = requiredString(sourceSessionId, 'Source Session id');
    const targetTurnId = requiredString(replaceTurnId, 'Replace Turn id');
    const input = requiredString(prompt, 'Branch prompt');
    if (input.length > this.maxPromptLength) {
      throw branchError('SESSION_BRANCH_PROMPT_TOO_LONG', `Branch prompt cannot exceed ${this.maxPromptLength} characters.`, 400);
    }
    const source = await this.history.read(sourceId, { context });
    const plan = planSessionBranch(source?.turns, targetTurnId);
    let reservation = null;
    let branch = null;
    try {
      reservation = await this.sessions.reserve?.({ source, sourceSessionId: sourceId, plan, context }) ?? null;
      branch = plan.lastTurnId
        ? await this.runtime.fork({ source, sourceSessionId: sourceId, lastTurnId: plan.lastTurnId, reservation, context })
        : await this.runtime.create({ source, sourceSessionId: sourceId, reservation, context });
      const session = await this.sessions.register({ source, sourceSessionId: sourceId, branch, reservation, plan, context });
      const turn = await this.runtime.submit({ branch, session, input, context });
      await this.sessions.recordInput?.({ source, branch, session, turn, input, plan, context });
      return {
        sourceSessionId: sourceId,
        replacedTurnId: targetTurnId,
        lastTurnId: plan.lastTurnId,
        session,
        branch,
        turn,
      };
    } catch (error) {
      await this.sessions.rollback?.({ source, sourceSessionId: sourceId, branch, reservation, plan, context, error });
      throw error;
    }
  }
}

export function planSessionBranch(turns = [], replaceTurnId) {
  const targetTurnId = requiredString(replaceTurnId, 'Replace Turn id');
  const orderedTurns = Array.isArray(turns) ? turns : [];
  const targetIndex = orderedTurns.findIndex((turn) => String(turn?.id || '') === targetTurnId);
  if (targetIndex < 0) throw branchError('SESSION_BRANCH_TURN_NOT_FOUND', 'The selected message is no longer in this Session.', 404);
  if (['inProgress', 'running'].includes(String(orderedTurns[targetIndex]?.status || ''))) {
    throw branchError('SESSION_BRANCH_TURN_ACTIVE', 'An active message cannot be edited or forked.', 409);
  }
  return {
    replaceTurnId: targetTurnId,
    targetIndex,
    lastTurnId: targetIndex > 0 ? requiredString(orderedTurns[targetIndex - 1]?.id, 'Previous Turn id') : null,
    empty: targetIndex === 0,
  };
}

export function sessionMessageBranchEligibility({
  session = {},
  message = {},
  isLatestUserMessage = false,
  features = {},
} = {}) {
  const activeTurnId = session.activeTurnId
    || session.runtimeBinding?.activeTurnId
    || session.turnState?.activeTurnId
    || (session.turnState?.active ? 'active' : null);
  const userMessage = message.type === 'userMessage' || message.role === 'user';
  const idle = !session.isDraft
    && !session.isArchived
    && !session.archived
    && !activeTurnId
    && !session.connectionError;
  const eligible = idle && userMessage && Boolean(message.turnId) && Boolean(isLatestUserMessage);
  return {
    canEdit: eligible && features.messageEdit !== false,
    canFork: eligible && features.messageFork !== false,
  };
}

function requireMethod(value, name, label) {
  if (typeof value?.[name] !== 'function') throw new TypeError(`${label}.${name} is required.`);
}

function requiredString(value, label) {
  const normalized = value == null ? '' : String(value).trim();
  if (!normalized) throw new TypeError(`${label} is required.`);
  return normalized;
}

function positiveInteger(value, label) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) throw new TypeError(`${label} must be a positive integer.`);
  return normalized;
}

function branchError(code, message, status) {
  return Object.assign(new Error(message), { code, status });
}
