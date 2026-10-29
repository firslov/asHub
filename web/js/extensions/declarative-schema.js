const record = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 8000) => typeof value === 'string' && value.length <= max;
const id = value => text(value, 80) && /^[a-z][a-z0-9-]*$/.test(value) && !['constructor', 'prototype'].includes(value);
const only = (value, keys) => record(value) && Object.keys(value).every(key => keys.includes(key));
const array = (value, max) => Array.isArray(value) && value.length <= max;
const fail = () => { throw Error('Unsupported declarative interface'); };

export function fieldDefaultValue(field) {
  if (field.value !== undefined) return field.value;
  if (field.type === 'boolean') return false;
  if (field.type === 'select') return field.options[0].value;
  // Numeric fields without a declared/stored value stay visibly unset.
  if (field.type === 'number') return undefined;
  return '';
}

export function validateDeclarativeUI(value) {
  if (JSON.stringify(value)?.length > 262144) fail();
  if (!only(value, ['version', 'panels']) || value.version !== 1 || !array(value.panels, 8)) fail();
  const panelIds = new Set();
  for (const panel of value.panels) {
    if (!only(panel, ['id', 'title', 'components']) || !id(panel.id) || panelIds.has(panel.id) || !text(panel.title, 200) || !array(panel.components, 32)) fail();
    panelIds.add(panel.id);
    const formIds = new Set();
    for (const item of panel.components) {
      if (!record(item)) fail();
      if (item.type === 'text') {
        if (!only(item, ['type', 'text']) || !text(item.text)) fail();
      } else if (item.type === 'status') {
        if (!only(item, ['type', 'text', 'tone']) || !text(item.text) || !['neutral', 'success', 'warning'].includes(item.tone || 'neutral')) fail();
      } else if (item.type === 'list') {
        if (!only(item, ['type', 'items']) || !array(item.items, 100) || !item.items.every(value => text(value))) fail();
      } else if (item.type === 'action') {
        if (!only(item, ['type', 'label', 'action', 'value']) || !text(item.label, 200) || item.action !== 'composer.insert' || !text(item.value)) fail();
      } else if (item.type === 'form') {
        if (!only(item, ['type', 'id', 'fields', 'mode', 'namespace']) || !id(item.id) || formIds.has(item.id) || !array(item.fields, 32)) fail();
        if (item.mode !== undefined && !['draft', 'config'].includes(item.mode)) fail();
        if (item.mode === 'config') {
          if (!text(item.namespace, 128) || !item.namespace.trim() || item.namespace !== item.namespace.trim() || /[\x00-\x1f\x7f]/.test(item.namespace)) fail();
        } else if (item.namespace !== undefined) fail();
        formIds.add(item.id);
        const fields = new Set();
        for (const field of item.fields) {
          if (!only(field, ['id', 'label', 'type', 'value', 'min', 'max', 'options']) || !id(field.id) || fields.has(field.id) || !text(field.label, 200)) fail();
          fields.add(field.id);
          if (field.type === 'text') {
            if (!text(field.value ?? '') || field.options !== undefined || field.min !== undefined || field.max !== undefined) fail();
          } else if (field.type === 'boolean') {
            if ((field.value !== undefined && typeof field.value !== 'boolean') || field.options !== undefined || field.min !== undefined || field.max !== undefined) fail();
          } else if (field.type === 'number') {
            if ((field.value !== undefined && !Number.isFinite(field.value)) || field.options !== undefined || (field.min !== undefined && !Number.isFinite(field.min)) || (field.max !== undefined && !Number.isFinite(field.max)) || (field.min !== undefined && field.max !== undefined && field.min > field.max)) fail();
            if (field.value !== undefined && ((field.min !== undefined && field.value < field.min) || (field.max !== undefined && field.value > field.max))) fail();
          } else if (field.type === 'select') {
            if ((field.value !== undefined && !text(field.value, 200)) || field.min !== undefined || field.max !== undefined || !array(field.options, 50) || !field.options.length) fail();
            const options = new Set();
            for (const option of field.options) {
              if (!only(option, ['value', 'label']) || !text(option.value, 200) || !text(option.label, 200) || options.has(option.value)) fail();
              options.add(option.value);
            }
            if (field.value !== undefined && !options.has(field.value)) fail();
          } else fail();
        }
      } else fail();
    }
  }
  // Copy caller-owned input; validation must not be invalidated by later mutation.
  return JSON.parse(JSON.stringify(value));
}
