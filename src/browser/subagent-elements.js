(function installSubagentElements(globalScope) {
  if (!globalScope?.customElements || !globalScope.HTMLElement) return;

  const definitions = [
    ['agent-subagent-list', 'list', '子 Agent 列表'],
    ['agent-subagent-card', 'article', '子 Agent'],
  ];

  for (const [tagName, role, label] of definitions) {
    if (!globalScope.customElements.get(tagName)) {
      globalScope.customElements.define(tagName, class extends globalScope.HTMLElement {
        connectedCallback() {
          if (!this.hasAttribute('role')) this.setAttribute('role', role);
          if (!this.hasAttribute('aria-label')) this.setAttribute('aria-label', label);
          this.dataset.agentWorkbenchComponent = tagName.replace('agent-', '');
        }
      });
    }
  }
}(globalThis));
