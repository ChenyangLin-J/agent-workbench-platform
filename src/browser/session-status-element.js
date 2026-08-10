(function installSessionStatusElement(globalScope) {
  if (!globalScope?.customElements || globalScope.customElements.get('agent-session-status')) return;

  class AgentSessionStatusElement extends HTMLElement {
    static get observedAttributes() { return ['label', 'state', 'tone']; }

    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
    }

    connectedCallback() { this.render(); }
    attributeChangedCallback() { this.render(); }

    render() {
      if (!this.shadowRoot) return;
      const label = this.getAttribute('label') || '空闲';
      const tone = ['running', 'waiting', 'unread', 'error', 'idle'].includes(this.getAttribute('tone'))
        ? this.getAttribute('tone')
        : 'idle';
      this.shadowRoot.replaceChildren();
      const style = document.createElement('style');
      style.textContent = `
        :host { --status-color: var(--cwu-muted, #8d9199); display: inline-flex; min-width: 0; align-items: center; color: var(--status-color); font: inherit; }
        :host([tone="running"]) { --status-color: var(--cwu-running, #d97706); }
        :host([tone="waiting"]) { --status-color: var(--cwu-waiting, #d97706); }
        :host([tone="unread"]) { --status-color: var(--cwu-unread, #4f8cff); }
        :host([tone="error"]) { --status-color: var(--cwu-error, #d95c5c); }
        span { min-width: 0; display: inline-flex; align-items: center; gap: 6px; color: inherit; white-space: nowrap; }
        i { width: 7px; height: 7px; flex: 0 0 auto; border-radius: 50%; background: currentColor; }
        :host([tone="running"]) i { animation: status-pulse 1.4s ease-in-out infinite; box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 18%, transparent); }
        b { min-width: 0; overflow: hidden; text-overflow: ellipsis; font: inherit; font-weight: 650; }
        @keyframes status-pulse { 0%, 100% { opacity: .4; transform: scale(.82); } 50% { opacity: 1; transform: scale(1.12); } }
        @media (prefers-reduced-motion: reduce) { i { animation: none !important; } }
      `;
      const content = document.createElement('span');
      const indicator = document.createElement('i');
      indicator.setAttribute('aria-hidden', 'true');
      const text = document.createElement('b');
      text.textContent = label;
      content.append(indicator, text);
      this.shadowRoot.append(style, content);
      this.setAttribute('role', 'status');
      this.setAttribute('aria-label', label);
      this.dataset.tone = tone;
    }
  }

  globalScope.customElements.define('agent-session-status', AgentSessionStatusElement);
}(globalThis));
