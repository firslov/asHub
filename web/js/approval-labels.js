import { lang, t } from './i18n.js';

export function formatApprovalTime(seconds) {
  const minutes = seconds >= 120;
  return t(minutes ? 'approval.minutes' : 'approval.seconds', { n: minutes ? Math.ceil(seconds / 60) : seconds });
}
function hostTitle(title) {
  const parts = String(title || '').split(' / ');
  return parts.length === 2 ? parts[lang.peek() === 'zh' ? 0 : 1] : String(title || '');
}
export function presentApproval(card, p) {
  const source = p.sourceName || t('approval.host');
  const items = Array.isArray(p.items) ? p.items : [];
  const browser = p.browser;
  let heading = p.title || t('approval.operation');
  if (browser && ['open', 'click', 'fill'].includes(browser.action)) {
    heading = t('approval.' + browser.action, { source, origin: browser.origin });
    // Collapse only the original URL. The destination, submitted values, effects
    // and scope remain visible before the user decides.
    const root = card.querySelector('.approval-items');
    const sectionTitle = root?.querySelector('section > strong');
    if (sectionTitle && items.length === 1) sectionTitle.hidden = true;
    const field = root?.querySelector('dt');
    if (field?.textContent === 'URL') {
      const url = field.nextElementSibling;
      const details = document.createElement('details');
      details.className = 'approval-url';
      const summary = document.createElement('summary');
      summary.dataset.i18n = 'approval.fullUrl';
      details.append(summary, document.createTextNode(url.textContent));
      field.parentElement.after(details);
      url.remove(); field.remove();
    }
    if (browser.action === 'open' && p.scope === 'site') {
      let purpose = card.querySelector('.permission-purpose');
      if (!purpose) {
        purpose = document.createElement('p');
        purpose.className = 'permission-purpose';
        card.querySelector('.permission-head').after(purpose);
        const access = root?.querySelector('dt');
        if (access?.textContent === '权限 / Access') {
          access.nextElementSibling.remove(); access.remove();
        }
      }
      purpose.textContent = t('approval.readPurpose');
    }
    const summary = root?.querySelector('.approval-url summary');
    if (summary) summary.textContent = t('approval.fullUrl');
  } else if (p.explicit && p.scope === 'once' && items.length) {
    const first = items[0];
    const target = first.fields?.find(f => ['对话 / Conversation', '名称 / Name', '项目 / Project'].includes(f.label));
    const action = items.length > 1 ? t('approval.batch', { n: items.length })
      : [hostTitle(first.title), target?.value].filter(Boolean).join(' · ');
    heading = t('approval.request', { source, action });
  }
  if (!p.explicit && p.kind && p.kind !== 'unknown') {
    let details = card.querySelector('.permission-kind-details');
    if (!details) {
      details = document.createElement('details');
      details.className = 'approval-url permission-kind-details';
      const summary = document.createElement('summary');
      details.append(summary, document.createTextNode(String(p.kind)));
      card.querySelector('.permission-actions').before(details);
    }
    details.querySelector('summary').textContent = t('approval.kind');
  }
  card.querySelector('.permission-label').textContent = heading;
  card.setAttribute('aria-label', heading);
  const approve = card.querySelector('.approve span');
  const key = { daily7:'approval.seven', site:'approval.site', once:'approval.once' }[p.scope];
  if (approve) approve.textContent = t(key || 'permission.approve');
  card.querySelector('.deny span').textContent = t('permission.deny');
  const all = card.querySelector('.approve-all');
  if (all) {
    const confirming = all.classList.contains('confirming');
    all.title = p.acpExtendedOption || t('permission.approve_all_hint');
    all.querySelector('span').textContent = p.acpExtendedOption
      ? confirming ? t('permission.confirmOption', { name: p.acpExtendedOption }) : p.acpExtendedOption
      : t(confirming ? 'permission.approve_all_confirm' : 'permission.approve_all');
  }
  const note = card.querySelector('.permission-timeout-note');
  if (note) note.textContent = t('permission.timeout_note');
}

// A host result supersedes a local timeout or historical replay label.
export function showApprovalResult(card, outcome) {
  const approved = outcome === 'approved';
  clearInterval(card._timer);
  card._disarm?.();
  card.classList.remove('timeout');
  card.classList.add('decided');
  card.classList.toggle('allowed', approved);
  card.classList.toggle('blocked', outcome === 'denied');
  card.querySelectorAll('.permission-btn').forEach(button => { button.disabled = true; });
  card.querySelector('.permission-countdown')?.remove();
  card.querySelector('.permission-timeout-note')?.remove();
  let status = card.querySelector('.permission-status');
  if (!status) {
    status = document.createElement('span');
    status.className = 'permission-status';
    card.querySelector('.permission-actions-right')?.appendChild(status);
  }
  status.dataset.i18n = { approved: 'permission.granted', denied: 'permission.refused', unconfirmed: 'permission.unconfirmed' }[outcome] || 'permission.handled';
  status.textContent = t(status.dataset.i18n);
}
