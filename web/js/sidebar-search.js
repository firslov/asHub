// Search is a disclosure, but an active query is never hidden from the user.
export function initSidebarSearch({ toggle, panel, input, close, onChange }) {
  if (!toggle || !panel || !input || !close) return { setAvailable() {} };
  let available = true, expanded = false;
  const sync = () => {
    const active = !!input.value.trim();
    const visible = available && (expanded || active);
    toggle.hidden = !available;
    toggle.dataset.active = String(active);
    toggle.setAttribute('aria-expanded', String(visible));
    panel.hidden = !visible;
  };
  const dismiss = () => {
    const changed = input.value !== '';
    input.value = ''; expanded = false; sync();
    if (changed) onChange('');
    if (available) toggle.focus();
  };
  toggle.addEventListener('click', () => {
    if (!panel.hidden) { dismiss(); return; }
    expanded = true; sync(); input.focus();
  });
  close.addEventListener('click', dismiss);
  input.addEventListener('input', () => { expanded = true; sync(); onChange(input.value); });
  const onEscape = event => {
    if (event.key !== 'Escape' || event.isComposing || panel.hidden) return;
    event.preventDefault(); event.stopPropagation(); dismiss();
  };
  for (const node of [input, close, toggle]) node.addEventListener('keydown', onEscape);
  // Keep the row stable on blur: collapsing between pointerdown and click
  // would move the intended action (e.g. New session) out from under the pointer.
  sync();
  return { setAvailable(value) { available = value; sync(); } };
}
