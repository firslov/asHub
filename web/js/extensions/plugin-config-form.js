const object = value => value && typeof value === 'object' && !Array.isArray(value);
const clone = value => JSON.parse(JSON.stringify(value));

export function validateFormValues(fields, values) {
  const result = {};
  for (const field of fields) {
    const value = values[field.id];
    if (field.type === 'number' && value === undefined) continue;
    if (field.type === 'text' && (typeof value !== 'string' || value.length > 8000)) throw Error('Invalid text field');
    if (field.type === 'boolean' && typeof value !== 'boolean') throw Error('Invalid boolean field');
    if (field.type === 'number' && (!Number.isFinite(value) || (field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max))) throw Error('Invalid number field');
    if (field.type === 'select' && !field.options.some(option => option.value === value)) throw Error('Invalid selection');
    if (['__proto__', 'constructor', 'prototype'].includes(field.id)) throw Error('Invalid field name');
    Object.defineProperty(result, field.id, { value, enumerable: true, writable: true, configurable: true });
  }
  return result;
}

// Uses the same config API/revision storage as the Plugins JSON editor.
export class PluginConfigForm {
  constructor({ pluginId, namespace, allowedNamespaces, fields, request = (...args) => fetch(...args), changed = () => {} }) {
    if (typeof pluginId !== 'string' || !pluginId || pluginId.length > 200 || !allowedNamespaces?.includes(namespace)) throw Error('Unbound plugin configuration');
    this.pluginId = pluginId; this.namespace = namespace; this.fields = fields; this.request = request; this.changed = changed;
    this.base = {}; this.values = {}; this.revision = ''; this.busy = false; this.ready = false; this.error = ''; this.conflict = false; this.dirty = false;
  }
  emit(editedField) { this.changed(this, editedField); }
  async response(response) {
    if (!response.ok) {
      const raw = await response.text(); const error = new Error(raw.slice(0, 300) || `HTTP ${response.status}`); error.status = response.status; throw error;
    }
    const result = await response.json();
    if (result.namespace !== this.namespace || typeof result.revision !== 'string' || !object(result.config)) throw Error('Invalid plugin configuration response');
    return result;
  }
  assign(result) {
    this.base = clone(result.config); this.revision = result.revision;
    this.values = Object.fromEntries(this.fields.map(field => [field.id, Object.hasOwn(this.base, field.id) ? this.base[field.id] : fieldDefaultValue(field)]));
    this.ready = true; this.dirty = false; this.conflict = false; this.error = '';
  }
  update(id, value) { if (!this.ready || this.busy || !this.fields.some(field => field.id === id)) return; this.values[id] = value; this.dirty = true; this.error = ''; this.emit(id); }
  async load() {
    if (this.busy) return;
    this.busy = true; this.error = ''; this.emit();
    try {
      const result = await this.response(await this.request(`/api/plugins/config?id=${encodeURIComponent(this.pluginId)}&namespace=${encodeURIComponent(this.namespace)}`, { cache: 'no-store' }));
      this.assign(result);
    } catch (error) { this.error = error.message; throw error; }
    finally { this.busy = false; this.emit(); }
  }
  async save() {
    if (this.busy || !this.ready) return;
    const values = validateFormValues(this.fields, this.values);
    const config = { ...this.base, ...values };
    this.busy = true; this.error = ''; this.emit();
    try {
      const result = await this.response(await this.request('/api/plugins/config', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: this.pluginId, namespace: this.namespace, config, revision: this.revision }),
      }));
      this.assign(result);
    } catch (error) { this.error = error.message; this.conflict = error.status === 409; throw error; }
    finally { this.busy = false; this.emit(); }
  }
}
import { fieldDefaultValue } from './declarative-schema.js';
