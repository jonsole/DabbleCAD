// Makes a floating card movable by its header (.insp-head). The position is remembered in this
// browser and always kept inside the view it floats over.
export function makeDraggable(el, { key, handle = '.insp-head' }) {
  const STORE = 'dabblecad.card.' + key;
  let pos = null;
  try { pos = JSON.parse(localStorage.getItem(STORE) || 'null'); } catch { pos = null; }
  const clamp = () => {
    const parent = el.offsetParent || el.parentElement;
    if (!pos || !parent) return;
    const pw = parent.clientWidth, ph = parent.clientHeight, w = el.offsetWidth || 262;
    pos.left = Math.min(Math.max(0, pos.left), Math.max(0, pw - w));
    pos.top = Math.min(Math.max(0, pos.top), Math.max(0, ph - 48));
  };
  const apply = () => {
    if (!pos) return;
    clamp();
    el.style.left = pos.left + 'px'; el.style.top = pos.top + 'px'; el.style.right = 'auto';
    el.style.maxHeight = `calc(100% - ${pos.top + 14}px)`;
  };
  apply();
  if (window.ResizeObserver && el.parentElement) new ResizeObserver(() => apply()).observe(el.parentElement);
  el.addEventListener('pointerdown', (e) => {
    const head = e.target.closest && e.target.closest(handle);
    if (e.button !== 0 || !head || !el.contains(head) || e.target.closest('button, input, select, textarea, a')) return;
    e.preventDefault();
    const parent = el.offsetParent || el.parentElement, pr = parent.getBoundingClientRect(), er = el.getBoundingClientRect();
    const dx = e.clientX - er.left, dy = e.clientY - er.top;
    el.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
    const move = (ev) => { pos = { left: ev.clientX - pr.left - dx, top: ev.clientY - pr.top - dy }; apply(); };
    const up = () => {
      el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
      el.classList.remove('dragging');
      try { localStorage.setItem(STORE, JSON.stringify(pos)); } catch { /* ignore */ }
    };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  });
}
