import { mountResource } from './resource-view.js';
import { validateDeclarativeUI, fieldDefaultValue } from './declarative-schema.js';
import { registerPanel, unregisterPanel } from '../panel-manager.js';
import { t } from '../i18n.js';
import { PluginConfigForm } from './plugin-config-form.js';

const node = (tag, className, content) => {
  const element = document.createElement(tag); element.className = className;
  if (content !== undefined) element.textContent = content;
  return element;
};

// Every DOM node and event handler is created by the host. No markup, routes,
// executable paths or event names are accepted from third-party manifests.
export function mountDeclarativeUI(feature, { menuHost, panelHost, input = document.getElementById('query'), drafts = new Map() }) {
  const ui = validateDeclarativeUI(feature.ui);
  const disposers = [];
  for (const definition of ui.panels) {
    const key = `extension-${feature.id.length}-${feature.id}-panel-${definition.id.length}-${definition.id}`;
    const trigger = node('button', 'toolbar-btn extension-menu');
    // Use the same optical size and stroke as the toolbar, never a font glyph.
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [key, value] of Object.entries({ width:'18', height:'18', viewBox:'0 0 14 14', fill:'none', stroke:'currentColor', 'stroke-width':'1.3', 'stroke-linecap':'round', 'stroke-linejoin':'round', 'aria-hidden':'true' })) svg.setAttribute(key, value);
    const shape = document.createElementNS(svg.namespaceURI, 'path');
    shape.setAttribute('d', definition.icon === 'clock'
      ? 'M12.5 7a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0M7 3.5V7l2.5 1.5'
      : 'M4 1.5h6A2.5 2.5 0 0 1 12.5 4v6a2.5 2.5 0 0 1-2.5 2.5H4A2.5 2.5 0 0 1 1.5 10V4A2.5 2.5 0 0 1 4 1.5ZM4.5 4.5h5M4.5 7h5M4.5 9.5h2.5');
    svg.append(shape); trigger.append(svg);
    trigger.type = 'button'; trigger.id = `${key}-toggle`; trigger.title = `${feature.name} · ${definition.title}`;
    trigger.setAttribute('aria-label', definition.title);
    const panel = node('section', 'p-drawer extension-panel'); panel.id = `${key}-panel`; panel.hidden = true;
    const head = node('header', 'p-head');
    const heading = node('h2', 'p-title', definition.title); heading.id = `${key}-title`; panel.setAttribute('aria-labelledby', heading.id);
    const close = node('button', 'p-icon-btn', '×'); close.type = 'button'; close.setAttribute('aria-label', t('features.close'));
    const body = node('div', 'p-body extension-body'); head.append(heading, close); panel.append(head, body);
    const fields = [];
    for (const component of definition.components) {
      if (component.type === 'resource') {
        const resource = node('div', 'extension-resource-host');body.append(resource);disposers.push(mountResource(resource, feature, component.id));
      } else if (component.type === 'text' || component.type === 'status') {
        const block = node('p', component.type === 'text' ? 'extension-text' : `extension-status tone-${component.tone || 'neutral'}`, component.text);
        if (component.type === 'status') block.setAttribute('role', 'status'); body.append(block);
      } else if (component.type === 'list') {
        const list = node('ul', 'extension-list'); for (const item of component.items) list.append(node('li', '', item)); body.append(list);
      } else if (component.type === 'form') {
        const group = node('section', 'extension-form');
        const formControls = [];
        let controller;
        for (const field of component.fields) {
          const fieldKey = `${key}-form-${component.id.length}-${component.id}-field-${field.id.length}-${field.id}`;
          const label = node('label', 'plugin-config-label', field.label); label.htmlFor = fieldKey;
          const control = node(field.type === 'select' ? 'select' : 'input', 'p-input extension-field');
          control.id = fieldKey;
          if (field.type === 'select') {
            for (const option of field.options) { const el = node('option', '', option.label); el.value = option.value; control.append(el); }
          } else control.type = field.type === 'boolean' ? 'checkbox' : field.type;
          if (field.type === 'number') { if (field.min !== undefined) control.min = String(field.min); if (field.max !== undefined) control.max = String(field.max); }
          const value = drafts.has(fieldKey) ? drafts.get(fieldKey) : fieldDefaultValue(field);
          if (field.type === 'boolean') control.checked = value === true; else control.value = String(value ?? '');
          formControls.push({ id: field.id, control, type: field.type });
          if (component.mode !== 'config') fields.push({ fieldKey, control, type: field.type });
          control.addEventListener('input', () => {
            if (controller) controller.update(field.id, field.type === 'boolean' ? control.checked : field.type === 'number' ? (control.value === '' ? NaN : Number(control.value)) : control.value);
          });
          group.append(label, control);
        }
        if (component.mode === 'config') {
          const actions = node('div', 'plugin-config-actions');
          const reload = node('button', 'p-btn', t('plugins.read')); reload.type = 'button';
          const save = node('button', 'p-btn-primary', t('plugins.saveConfig')); save.type = 'button';
          const feedback = node('p', 'plugins-message'); feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite');
          let confirmReload = false;
          const paint = (state, editedField) => {
            for (const { id, control, type } of formControls) {
              control.disabled = state.busy || !state.ready;
              if (state.ready) { if (type === 'boolean') control.checked = state.values[id] === true; else if (!(type === 'number' && editedField === id) && control.value !== String(state.values[id] ?? '')) control.value = String(state.values[id] ?? ''); }
            }
            reload.disabled = state.busy;
            reload.textContent = t(confirmReload ? 'plugins.discardRead' : 'plugins.read');
            save.disabled = state.busy || !state.ready;
            save.textContent = t(state.busy ? 'plugins.saving' : 'plugins.saveConfig');
            feedback.textContent = state.conflict ? t('plugins.configConflict') : state.error ? `${t('plugins.configFailed')} · ${state.error}` : state.dirty ? t('plugins.unsaved') : state.ready ? t('plugins.configSaved') : t('loading');
          };
          controller = new PluginConfigForm({ pluginId: feature.pluginId, namespace: component.namespace, allowedNamespaces: feature.configNamespaces, fields: component.fields, changed: paint });
          reload.addEventListener('click', () => {
            if (controller.dirty && !confirmReload) { confirmReload = true; paint(controller); return; }
            confirmReload = false; void controller.load().catch(() => {});
          });
          save.addEventListener('click', () => {
            confirmReload = false;
            void controller.save().catch(error => { if (!controller.error) { controller.error = error.message; paint(controller); } });
          });
          actions.append(reload, save); group.append(actions, feedback);
          void controller.load().catch(() => {});
          disposers.push(() => { controller.changed = () => {}; });
        }
        body.append(group);
      } else if (component.type === 'action') {
        const button = node('button', 'p-btn extension-action', component.label); button.type = 'button'; button.disabled = !input;
        button.addEventListener('click', () => {
          if (!input || !trigger.isConnected) return;
          // This action only edits a draft. Submitting still belongs to the user.
          input.value = component.value; input.dispatchEvent(new Event('input', { bubbles: true })); input.focus();
        });
        body.append(button);
      }
    }
    // Keep installed panels with the other tools, above settings and utilities.
    const anchor = menuHost.querySelector(':scope > #config-toggle, :scope > .toolbar-sep');
    menuHost.insertBefore(trigger, anchor); panelHost.append(panel);
    const hide = () => { panel.hidden = true; trigger.classList.remove('active'); };
    close.addEventListener('click', () => { hide(); trigger.focus(); });
    registerPanel(key, { toggleBtnId: trigger.id, panelId: panel.id, open: () => { panel.hidden = false; close.focus(); }, close: hide });
    disposers.push(() => {
      for (const { fieldKey, control, type } of fields) drafts.set(fieldKey, type === 'boolean' ? control.checked : control.value);
      unregisterPanel(key); trigger.remove(); panel.remove();
    });
  }
  return () => { for (const dispose of disposers) dispose(); };
}
