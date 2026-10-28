/** Generic read-only operation preview. Text nodes only: never interpret plugin HTML. */
export function appendApprovalPreview(parent, items) {
  if (!Array.isArray(items)) return;
  const root = document.createElement('div'); root.className = 'approval-items';
  for (const item of items.slice(0, 12)) {
    if (!item || !Array.isArray(item.fields)) continue;
    const row = document.createElement('section');
    const title = document.createElement('strong'); title.textContent = String(item.title || ''); row.appendChild(title);
    const list = document.createElement('dl');
    for (const field of item.fields.slice(0, 20)) {
      const label = document.createElement('dt'), value = document.createElement('dd');
      label.textContent = String(field?.label || ''); value.textContent = String(field?.value ?? ''); list.appendChild(label); list.appendChild(value);
    }
    row.appendChild(list); root.appendChild(row);
  }
  parent.appendChild(root);
}
