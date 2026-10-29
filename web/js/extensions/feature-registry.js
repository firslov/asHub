import { validateDeclarativeUI } from './declarative-schema.js';
// Host state and bundled code are separate: metadata can never supply an import path.
export class FeatureRegistry {
  constructor(definitions, { request = (...args) => fetch(...args) } = {}) {
    this.definitions = new Map(definitions.map(definition => [definition.id, definition]));
    this.features = new Map(definitions.map(({ id, name, scope = 'frontend' }) => [id, { id, name, scope, enabled: true, state: 'enabled' }]));
    this.request = request;
    this.supported = null;
    this.error = null;
    this.sequence = 0;
    this.busy = false;
    this.refreshAfterWrite = false;
    this.listeners = new Set();
    this.modules = new Map();
  }
  enabled(id) { return this.features.get(id)?.enabled === true; }
  snapshot() { return { version: 1, supported: this.supported, busy: this.busy, error: this.error, features: [...this.features.values()].map(feature => ({ ...feature, ...(feature.ui ? { ui: JSON.parse(JSON.stringify(feature.ui)) } : {}) })) }; }
  subscribe(listener) { this.listeners.add(listener); listener(this.snapshot()); return () => this.listeners.delete(listener); }
  emit() { for (const listener of this.listeners) { try { listener(this.snapshot()); } catch {} } }
  apply(snapshot) {
    if (snapshot?.version !== 1 || !Array.isArray(snapshot.features) || snapshot.features.length > 256) throw Error('Invalid extension catalog');
    const next = new Map();
    for (const feature of snapshot.features) {
      if (!feature || typeof feature.id !== 'string' || !/^[a-z][a-z0-9-]{0,79}$/.test(feature.id)
        || next.has(feature.id) || typeof feature.name !== 'string' || typeof feature.enabled !== 'boolean'
        || !['application', 'frontend'].includes(feature.scope) || typeof feature.state !== 'string') throw Error('Invalid extension metadata');
      // Copy the supported fields. Ignore executable paths, markup and unknown fields.
      const entry = { id: feature.id, name: feature.name.slice(0, 200), scope: feature.scope, enabled: feature.enabled, state: feature.state.slice(0, 80) };
      if (feature.ui?.panels !== undefined) {
        try {
          const ui = validateDeclarativeUI(feature.ui);
          const namespaces = Array.isArray(feature.configNamespaces) && feature.configNamespaces.length <= 32 && feature.configNamespaces.every(value => typeof value === 'string' && value.length <= 128) ? [...feature.configNamespaces] : [];
          const forms = ui.panels.flatMap(panel => panel.components).filter(component => component.type === 'form' && component.mode === 'config');
          if (forms.length && (typeof feature.pluginId !== 'string' || !feature.pluginId || feature.pluginId.length > 200 || !forms.every(form => namespaces.includes(form.namespace)))) throw Error('Unbound configuration form');
          entry.ui = ui;
          if (forms.length) { entry.pluginId = feature.pluginId; entry.configNamespaces = namespaces; }
        } catch { entry.uiError = true; }
      }
      next.set(feature.id, entry);
    }
    // A v1 catalog is authoritative: absent bundled features are unavailable.
    for (const [id, definition] of this.definitions) {
      if (!next.has(id)) next.set(id, { id, name: definition.name, scope: definition.scope || 'frontend', enabled: false, state: 'unavailable' });
    }
    this.features = next;
    this.supported = true;
    this.error = null;
  }
  async refresh() {
    if (this.busy) { this.refreshAfterWrite = true; return this.snapshot(); }
    const sequence = ++this.sequence;
    try {
      const response = await this.request('/api/extensions', { cache: 'no-store' });
      if (sequence !== this.sequence) return this.snapshot();
      if ([404, 405, 501].includes(response.status)) {
        // Only an initial old-host response enables compatibility defaults.
        if (this.supported !== true) { this.supported = false; this.error = null; }
        else this.error = 'Extension catalog unavailable';
      } else {
        if (!response.ok) throw Error(`HTTP ${response.status}`);
        const snapshot = await response.json();
        if (sequence !== this.sequence) return this.snapshot();
        this.apply(snapshot);
      }
    } catch (error) { if (sequence === this.sequence) this.error = error?.message || String(error); }
    if (sequence === this.sequence) this.emit();
    return this.snapshot();
  }
  async setEnabled(id, enabled) {
    if (this.supported !== true || !this.features.has(id) || typeof enabled !== 'boolean') throw Error('Extension controls unavailable');
    if (this.busy) throw Error('Extension update in progress');
    this.busy = true; this.error = null; ++this.sequence; this.emit();
    let failure;
    try {
      const response = await this.request(`/api/extensions/${encodeURIComponent(id)}/enabled`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ashub-Local': '1' }, body: JSON.stringify({ enabled }),
      });
      if (!response.ok) {
        const body = await response.text();
        let detail; try { detail = JSON.parse(body).error; } catch {}
        throw Error(detail || body.slice(0, 300) || `HTTP ${response.status}`);
      }
    } catch (error) { failure = error; }
    // A failed teardown may have committed the disabled preference. Reconcile
    // after every POST, and retain any invalidation received during this read.
    do {
      this.refreshAfterWrite = false;
      try {
        const current = await this.request('/api/extensions', { cache: 'no-store' });
        if (!current.ok) throw Error(`HTTP ${current.status}`);
        this.apply(await current.json());
      } catch (error) { failure ||= error; break; }
    } while (this.refreshAfterWrite);
    this.refreshAfterWrite = false;
    this.busy = false;
    if (failure) this.error = failure?.message || String(failure);
    this.emit();
    if (failure) throw failure;
    return this.snapshot();
  }
  async load(id) {
    if (!this.enabled(id)) return null;
    const definition = this.definitions.get(id);
    if (!definition?.load) return null;
    if (!this.modules.has(id)) {
      const pending = Promise.resolve().then(() => definition.load()).catch(error => { this.modules.delete(id); throw error; });
      this.modules.set(id, pending);
    }
    const module = await this.modules.get(id);
    return this.enabled(id) ? module : null;
  }
}
