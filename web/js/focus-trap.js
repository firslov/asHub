/**
 * Focus trap — keeps Tab focus cycling inside a modal container.
 *
 * Usage:
 *   const release = trapFocus(overlayElement);
 *   // ... panel is open ...
 *   release(); // when panel closes
 */
export const trapFocus = (container) => {
  const focusables = () =>
    Array.from(
      container.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => el.offsetParent !== null);

  const onKeydown = (ev) => {
    if (ev.key !== "Tab") return;
    const items = focusables();
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (ev.shiftKey && document.activeElement === first) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && document.activeElement === last) {
      ev.preventDefault();
      first.focus();
    }
  };

  const prevFocus = document.activeElement;
  container.addEventListener("keydown", onKeydown);
  const first = focusables()[0];
  if (first) first.focus();

  return () => {
    container.removeEventListener("keydown", onKeydown);
    if (prevFocus && typeof prevFocus.focus === "function") prevFocus.focus();
  };
};
