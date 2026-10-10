/** Bounded display identity; call parameters and results stay in item detail. */
export function runtimeTechnicalIdentity(item = {}) {
  const type = item.type === 'commandExecution' ? 'command'
    : item.type === 'fileChange' ? 'file'
      : item.type === 'collabAgentToolCall' ? 'subagent' : 'tool';
  const operation = type === 'subagent' ? label(item.tool || item.name || '') : '';
  const toolName = item.type === 'mcpToolCall'
    ? [item.server, item.tool || item.name || item.toolName].filter(Boolean).join('.')
    : type === 'command' ? 'exec_command'
      : type === 'file' ? 'apply_patch'
        : operation || item.tool || item.toolName || item.name || item.type;
  const agentName = type === 'subagent'
    ? item.agentNickname || item.agentName || item.taskName || item.task_name
      || (Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.join(', ') : '')
    : '';
  return { type, toolName: label(toolName), agentOperation: operation, agentName: label(agentName) };
}

export function runtimeCollaborationDetail(item = {}) {
  const sections = [
    ['Task', item.prompt],
    ['Targets', item.receiverThreadIds],
    ['States', item.agentsStates],
    ['Model', item.model],
    ['Reasoning effort', item.reasoningEffort],
  ];
  return sections.filter(([, value]) => value != null && value !== '')
    .map(([name, value]) => `${name}\n${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join('\n\n').slice(0, 16_000);
}

function label(value) { return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 160); }
