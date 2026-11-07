// These functions run in a Chromium isolated world. Plugins never supply page scripts.
const { randomUUID } = require('node:crypto');

function targetOperation(action, value, expected, dailyRequested) {
  const node = this;
  if (
    !(node instanceof HTMLElement) ||
    node.ownerDocument !== document ||
    window !== top ||
    !node.isConnected ||
    node.matches(':disabled')
  )
    return { blocked: 'Element unavailable. Observe the page again.' };
  // Walk the composed tree, including assigned slots and their hosts. Native
  // accessors also work on forms with controls named "matches" or "parentNode".
  const parentOf = Object.getOwnPropertyDescriptor(Node.prototype, 'parentNode').get;
  const slotOf = Object.getOwnPropertyDescriptor(Element.prototype, 'assignedSlot').get;
  for (let el = node; el && el !== document; ) {
    if (el instanceof ShadowRoot) {
      el = el.host;
      continue;
    }
    if (Element.prototype.matches.call(el, '[hidden],[inert],[aria-disabled="true" i]'))
      return { blocked: 'Element unavailable. Observe the page again.' };
    el = slotOf.call(el) || parentOf.call(el);
  }
  const rect = node.getBoundingClientRect();
  if (!rect.width || !rect.height || getComputedStyle(node).visibility !== 'visible')
    return { blocked: 'Element is hidden.' };
  const tag = node.localName;
  const field =
    tag === 'textarea' || (tag === 'input' && ['text', 'email', 'search', 'tel', 'url'].includes(node.type));
  const sensitive = (el) =>
    el.type === 'password' || el.type === 'file' || /password|one-time-code|cc-/.test(el.autocomplete || '');
  if (action === 'fill' && (!field || node.readOnly || sensitive(node)))
    return { blocked: 'Use manual control for this field.' };
  if (action === 'fill' && node.maxLength >= 0) {
    // Native value setters normalize text but bypass the editor's maxlength.
    // Measure the value this field type would store, without touching the live draft.
    const probe = document.createElement(tag);
    if (tag === 'input') {
      probe.type = node.type;
      probe.multiple = node.multiple;
    }
    probe.value = value;
    if (probe.value.length > node.maxLength) return { blocked: 'Text exceeds the field’s maximum length.' };
  }
  if (
    action === 'click' &&
    !(
      tag === 'button' ||
      tag === 'a' ||
      (tag === 'input' && ['button', 'submit', 'checkbox', 'radio'].includes(node.type)) ||
      ['button', 'link', 'checkbox', 'radio'].includes(node.getAttribute('role'))
    )
  )
    return { blocked: 'Unsupported control.' };
  const form = node.form || node.closest('form');
  // HTML forms expose named controls as properties (including "action", "method" and "elements").
  const formProperty = (key) =>
    Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, key).get.call(form);
  const fields = [];
  // Kept inside the host's comparison key. Never include hidden values in a
  // permission card, tool result or error, including on a failed recheck.
  const controls = [];
  if (action === 'click' && form) {
    for (const el of formProperty('elements')) {
      if (el.matches(':disabled')) continue;
      // A form-associated custom element can submit arbitrary entries through
      // ElementInternals.setFormValue(), independently of its public .value.
      if (el.localName.includes('-'))
        return { blocked: 'Use manual control for forms containing custom fields.' };
      if (['submit', 'image', 'button', 'reset'].includes(el.type)) continue;
      if (['checkbox', 'radio'].includes(el.type) && !el.checked) continue;
      if (sensitive(el)) return { blocked: 'Use manual control for this form.' };
      const values =
        el.localName === 'select'
          ? Array.from(el.selectedOptions)
              .filter((option) => !option.matches(':disabled'))
              .map((option) => option.value)
          : [String(el.value ?? '')];
      controls.push([el.name, el.type, values]);
      if (el.type === 'hidden') continue;
      const label = el.labels?.[0]?.innerText || el.name || el.id || el.type;
      for (const val of values) {
        if (val.length > 1000 || fields.length >= 15)
          return { blocked: 'Use manual control for long forms.' };
        fields.push([label, val]);
      }
    }
  }
  const checked =
    tag === 'input' && ['radio', 'checkbox'].includes(node.type)
      ? node.indeterminate && node.type === 'checkbox'
        ? 'mixed'
        : node.checked
      : node.getAttribute('aria-checked');
  // IDs are local to a document or shadow root. An unattended grant must
  // distinguish two instances of the same component, including after a reload.
  function stableButtonPath() {
    const path = [];
    for (let el = node; ; ) {
      if (!el.id) return null;
      const root = el.getRootNode(),
        selector = '#' + CSS.escape(el.id);
      const matches = root.querySelectorAll(selector);
      if (matches.length !== 1 || matches[0] !== el) return null;
      path.unshift(el.localName + selector);
      if (root === document) return path;
      if (!(root instanceof ShadowRoot)) return null;
      el = root.host;
    }
  }
  const dailyPath =
    dailyRequested && tag === 'button' && node.type === 'button' && !form ? stableButtonPath() : null;
  // A submitter with formaction="" overrides the form action with the current document.
  const destination =
    node.href ||
    (form &&
      (node.hasAttribute('formaction') && 'formAction' in node ? node.formAction : formProperty('action'))) ||
    '';
  const identity = JSON.stringify([
    dailyPath,
    checked,
    action === 'fill' ? node.value : null,
    location.href,
    tag,
    node.id,
    node.type,
    node.getAttribute('aria-label'),
    node.innerText?.slice(0, 240),
    node.href,
    form && formProperty('action'),
    destination,
    form && [
      formProperty('method'),
      formProperty('enctype'),
      formProperty('target'),
      formProperty('noValidate'),
      node.formMethod,
      node.formEnctype,
      node.formTarget,
      node.formNoValidate,
      node.name,
      node.value,
    ],
    controls,
    fields,
  ]);
  // querySelector does not cross shadow boundaries. Inspect open component trees
  // and any enclosing closed root of the resolved button, only for recurring clicks.
  function hasEditor() {
    const selector =
      'input,textarea,select,form,[contenteditable=""],[contenteditable="true" i],[contenteditable="plaintext-only" i]';
    const roots = new Set([document]);
    for (let root = node.getRootNode(); root instanceof ShadowRoot; root = root.host.getRootNode())
      roots.add(root);
    for (const root of roots) {
      if (root.querySelector(selector)) return true;
      for (const element of root.querySelectorAll('*')) if (element.shadowRoot) roots.add(element.shadowRoot);
    }
    return false;
  }
  const dailyEligible = !!dailyPath && action === 'click' && !hasEditor();
  if (expected === null)
    return {
      identity,
      fields,
      dailyEligible,
      dailyPath,
      checked,
      destination,
    };
  if (identity !== expected.identity || (expected.daily && !dailyEligible)) return { changed: true };
  node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
  const box = node.getBoundingClientRect();
  const x = box.left + box.width / 2,
    y = box.top + box.height / 2;
  // Hit testing retargets a shadow descendant to its host at each boundary.
  // Verify every enclosing root so an overlay outside the component still blocks the action.
  let target = node;
  for (;;) {
    const root = target.getRootNode();
    const hit = root.elementFromPoint(x, y);
    if (!hit || !target.contains(hit)) return { blocked: 'Control is covered. Use manual control.' };
    if (!(root instanceof ShadowRoot)) break;
    target = root.host;
  }
  if (action === 'click') node.click();
  else {
    const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(node, value);
    node.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        composed: true,
        inputType: 'insertReplacementText',
        data: node.value,
      }),
    );
    node.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return true;
}

const interactive = new Set(['button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio']);
function checkedState(node) {
  const value = node.properties?.find((p) => p.name === 'checked')?.value?.value;
  if (value === undefined || value === 'mixed') return value;
  return value === true || value === 'true';
}
async function snapshot(page, check, references = true) {
  const { nodes } = await page.command('Accessibility.getFullAXTree');
  check();
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const items = [],
    refs = new Map(),
    prefix = randomUUID().slice(0, 12);
  let truncated = false;
  function visit(id) {
    const n = byId.get(id);
    if (!n) return;
    if (items.length >= 1200) {
      truncated = true;
      return;
    }
    const role = n.role?.value,
      name = String(n.name?.value || '')
        .trim()
        .slice(0, 320);
    if (['Iframe', 'IframePresentational', 'InlineTextBox'].includes(role)) return;
    const edit = n.properties?.some((p) => p.name === 'editable' && p.value?.value);
    if (
      !n.ignored &&
      (interactive.has(role) || ['heading', 'StaticText', 'status', 'alert'].includes(role)) &&
      (name || interactive.has(role))
    ) {
      const item = { role, name };
      const checked = checkedState(n);
      if (checked !== undefined) item.checked = checked;
      if (n.properties?.some((p) => p.name === 'disabled' && p.value?.value)) item.disabled = true;
      if (references && !item.disabled && interactive.has(role) && n.backendDOMNodeId) {
        item.ref = prefix + '-' + (refs.size + 1);
        refs.set(item.ref, { node: n.backendDOMNodeId, role, name, checked });
      }
      items.push(item);
    }
    // Text descendants of fields can contain the human's current input.
    if (edit || interactive.has(role)) return;
    for (const child of n.childIds || []) visit(child);
  }
  if (nodes.length) visit(nodes[0].nodeId);
  if (references) page.refs = refs;
  const url = new URL(page.contents.getURL());
  return { url: url.origin + url.pathname, items, truncated };
}

async function resolveTarget(page, ref, check, dailyRequested) {
  const entry = page.refs.get(ref);
  if (!entry) throw Error('Expired element reference. Observe again.');
  const { frameTree } = await page.command('Page.getFrameTree');
  const world = await page.command('Page.createIsolatedWorld', {
    frameId: frameTree.frame.id,
    worldName: 'asHub browser controls',
  });
  const { object } = await page.command('DOM.resolveNode', {
    backendNodeId: entry.node,
    executionContextId: world.executionContextId,
  });
  const call = async (action, value, expected, beforeDispatch) => {
    const { nodes } = await page.command('Accessibility.getPartialAXTree', {
      backendNodeId: entry.node,
      fetchRelatives: false,
    });
    if (
      !nodes.some(
        (n) =>
          !n.ignored &&
          !n.properties?.some((p) => p.name === 'disabled' && p.value?.value) &&
          n.role?.value === entry.role &&
          checkedState(n) === entry.checked &&
          String(n.name?.value || '')
            .trim()
            .slice(0, 320) === entry.name,
      )
    )
      throw Error('Control changed. Observe again.');
    check();
    beforeDispatch?.();
    const reply = await page.command('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: targetOperation.toString(),
      arguments: [{ value: action }, { value }, { value: expected }, { value: dailyRequested }],
      returnByValue: true,
    });
    if (reply.exceptionDetails)
      throw Error(reply.exceptionDetails.exception?.description?.split('\n')[0] || 'Control unavailable.');
    return reply.result.value;
  };
  return {
    entry,
    call,
    release: () => page.command('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {}),
  };
}

module.exports = { snapshot, resolveTarget };
