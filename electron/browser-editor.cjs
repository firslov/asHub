// Fixed adapter, run in the page's main world solely to access public editor instances.
// No plugin/page supplied JavaScript is ever evaluated by the host.
function createEditorBinding() {
  const node = this;
  let root, editor, model, kind;
  if ((root = node.closest('.CodeMirror')) && (editor = root.CodeMirror)) {
    kind = 'codemirror5'; model = editor.getDoc?.();
  } else if ((root = node.closest('.ace_editor')) && (editor = root.env?.editor)) {
    kind = 'ace'; model = editor.getSession?.();
  } else if ((root = node.closest('.monaco-editor'))) {
    editor = window.monaco?.editor?.getEditors?.().find(e => e.getDomNode() === root);
    if (!editor || !window.monaco?.editor?.EditorOption) return null;
    kind = 'monaco'; model = editor.getModel?.();
  }
  return model && editor ? { root, editor, model, kind } : null;
}
function editorOperation(_action, value, expected, binding) {
  const node = this;
  if (!(node instanceof HTMLElement) || !node.isConnected || node.ownerDocument !== document || window !== top)
    return { blocked: 'Editor unavailable. Observe again.' };
  if (!binding) return { blocked: 'Unsupported code editor. Use a plain text field, file upload or manual control.' };
  const {root, editor, model, kind} = binding;
  let get, set, readonly;
  // Bind the actual document object, not merely its current text. An editor may
  // switch to another file with identical text while approval is pending.
  if (kind === 'codemirror5') {
    if (node.closest('.CodeMirror') !== root || root.CodeMirror !== editor || editor.getDoc() !== model)
      return { changed: true };
    get = () => editor.getValue(); set = v => editor.setValue(v);
    readonly = () => !!editor.getOption('readOnly');
  } else if (kind === 'ace') {
    if (node.closest('.ace_editor') !== root || root.env?.editor !== editor || editor.getSession() !== model)
      return { changed: true };
    get = () => editor.getValue(); set = v => editor.setValue(v, -1);
    readonly = () => editor.getReadOnly();
  } else if (kind === 'monaco') {
    if (node.closest('.monaco-editor') !== root || editor.getDomNode() !== root || editor.getModel() !== model
      || !window.monaco?.editor?.getEditors?.().includes(editor)) return { changed: true };
    get = () => editor.getValue(); set = v => editor.setValue(v);
    readonly = () => editor.getOption(window.monaco.editor.EditorOption.readOnly);
  } else return { blocked: 'Unsupported editor.' };
  for (let el = root; el; el = el.parentElement)
    if (el.matches('[hidden],[inert],[aria-disabled="true" i]')) return { blocked: 'Editor is disabled.' };
  const box = root.getBoundingClientRect();
  if (!box.width || !box.height || getComputedStyle(root).visibility !== 'visible' || readonly())
    return { blocked: 'Editor is hidden or read-only.' };
  const current = get();
  if (typeof current !== 'string' || current.length > 262144) return { blocked: 'Existing editor content is too large.' };
  const identity = JSON.stringify([location.href, kind, current, root.id, root.className]);
  if (expected === null) return { identity, fields: [['编辑器 / Editor', kind]], dailyEligible: false };
  if (expected.identity !== identity) return { changed: true };
  root.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
  const rect = root.getBoundingClientRect();
  if (!root.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)))
    return { blocked: 'Editor is covered. Use manual control.' };
  set(value);
  const actual = get();
  return { verified: typeof actual === 'string' && actual.replace(/\r\n?/g, '\n') === value.replace(/\r\n?/g, '\n'), actualValue: String(actual).slice(0, 262145), adapter: kind };
}
module.exports = { createEditorBinding, editorOperation };
