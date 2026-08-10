(function installSessionUiElements(globalScope) {
  if (!globalScope?.customElements) return;

  class AgentSessionStreamElement extends HTMLElement {
    connectedCallback() {
      this.style.display ||= 'block';
      this.dataset.sharedSessionUi = 'stream';
      if (!this.hasAttribute('role')) this.setAttribute('role', 'log');
      if (!this.hasAttribute('aria-live')) this.setAttribute('aria-live', 'polite');
      if (!this.hasAttribute('aria-relevant')) this.setAttribute('aria-relevant', 'additions text');
    }
  }

  class AgentSessionMessageElement extends HTMLElement {
    static get observedAttributes() { return ['role', 'phase']; }
    connectedCallback() { this.sync(); }
    attributeChangedCallback() { this.sync(); }
    sync() {
      const role = this.getAttribute('role') === 'user' ? 'user' : 'assistant';
      const phase = role === 'assistant' && this.getAttribute('phase') === 'commentary' ? 'commentary' : 'answer';
      this.dataset.sharedSessionUi = 'message';
      this.style.display ||= 'block';
      this.dataset.role = role;
      this.dataset.phase = phase;
      this.classList.toggle('is-user', role === 'user');
      this.classList.toggle('is-assistant', role === 'assistant' && phase === 'answer');
      this.classList.toggle('is-commentary', phase === 'commentary');
    }
  }

  class AgentSessionComposerElement extends HTMLElement {
    connectedCallback() {
      this.dataset.sharedSessionUi = 'composer';
      this.style.display ||= 'block';
      if (!this.hasAttribute('role')) this.setAttribute('role', 'group');
      if (!this.hasAttribute('aria-label')) this.setAttribute('aria-label', 'Session 输入区');
    }
  }

  define('agent-session-stream', AgentSessionStreamElement);
  define('agent-session-message', AgentSessionMessageElement);
  define('agent-session-composer', AgentSessionComposerElement);

  function define(name, constructor) {
    if (!globalScope.customElements.get(name)) globalScope.customElements.define(name, constructor);
  }
}(globalThis));
