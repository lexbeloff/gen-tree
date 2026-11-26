import './styles/main.scss';
import { computeLayout, CARD_H, CARD_W } from './layout.ts';
import { InfoPanel, indexTree } from './panel.ts';
import { el, renderTree, statusBadge } from './render.ts';
import type { Rendered } from './render.ts';
import { fullName, searchKey, searchText, STATUS_LABEL } from './format.ts';
import { Viewport } from './viewport.ts';
import type { Status, TreeData } from './types.ts';

const $ = <T extends HTMLElement>(id: string): T => {
  const e = document.getElementById(id);
  if (!e) throw new Error(`#${id} не найден`);
  return e as T;
};

// ---------------------------------------------------------------- тема
const THEME_KEY = 'gentree-theme';
function currentTheme(): 'light' | 'dark' {
  const t = document.documentElement.dataset.theme;
  if (t === 'light' || t === 'dark') return t;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function initTheme(): void {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
  } catch { /* хранилище недоступно */ }
  const btn = $<HTMLButtonElement>('theme-toggle');
  const sync = () => {
    const dark = currentTheme() === 'dark';
    btn.textContent = dark ? '☀' : '☾';
    btn.setAttribute('aria-pressed', String(dark));
    btn.title = dark ? 'Светлая тема' : 'Тёмная тема';
    btn.setAttribute('aria-label', btn.title);
  };
  btn.addEventListener('click', () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem(THEME_KEY, next); } catch { /* ignore */ }
    sync();
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', sync);
  sync();
}

// ---------------------------------------------------------------- загрузка
async function loadTree(): Promise<TreeData> {
  const res = await fetch('data/tree.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error(`data/tree.json: HTTP ${res.status}`);
  return (await res.json()) as TreeData;
}

function showError(msg: string): void {
  const box = $('message');
  box.hidden = false;
  box.textContent = msg;
}

function buildLegend(): void {
  const list = $('legend-list');
  for (const s of Object.keys(STATUS_LABEL) as Status[]) {
    const li = el('li');
    li.append(statusBadge(s), el('span', '', STATUS_LABEL[s]));
    list.append(li);
  }
  const solid = el('li');
  const sv = el('span', 'legend-line solid');
  solid.append(sv, el('span', '', 'Линия: связь подтверждена'));
  const dashed = el('li');
  dashed.append(el('span', 'legend-line dashed'), el('span', '', 'Пунктир: гипотеза / не установлено'));
  list.append(solid, dashed);
}

// ---------------------------------------------------------------- старт
async function start(): Promise<void> {
  initTheme();
  buildLegend();
  let data: TreeData;
  try {
    data = await loadTree();
  } catch (e) {
    showError(`Не удалось загрузить данные древа. ${(e as Error).message}`);
    return;
  }
  $('message').hidden = true;

  const idx = indexTree(data.persons, data.sources, data.relations);
  const layout = computeLayout(data.persons, data.relations, data.rootId);
  const viewportEl = $('viewport');
  const worldEl = $('world');
  const stage = $('stage');

  let rendered: Rendered = renderTree(worldEl, layout, idx.persons);
  const zoomLabel = $('zoom-level');
  if (data.title) {
    document.title = data.title;
    const brand = document.querySelector('.brand span');
    if (brand) brand.textContent = data.title;
  }
  // semantic zoom: на малом масштабе карточки упрощаются
  let zoomMode = '';
  function applyZoomClass(): void {
    const s = viewport.scale;
    const mode = s < 0.25 ? 'zoom-xs' : s < 0.5 ? 'zoom-s' : '';
    if (mode !== zoomMode) {
      worldEl.classList.remove('zoom-s', 'zoom-xs');
      if (mode) worldEl.classList.add(mode);
      zoomMode = mode;
    }
  }

  let panel: InfoPanel;
  const viewport = new Viewport(viewportEl, worldEl, {
    onChange: () => {
      zoomLabel.textContent = `${Math.round(viewport.scale * 100)}%`;
      if (panel?.visible) panel.reposition();
      applyZoomClass();
    },
    onInteractStart: () => { if (panel?.visible && !panel.pinned) panel.hide(); },
  });

  const cardCenter = (id: string): { x: number; y: number } => {
    const n = layout.nodes.get(id)!;
    return { x: n.x + CARD_W / 2, y: n.y + CARD_H / 2 };
  };

  let selectedId: string | null = null;
  const setSelected = (id: string | null): void => {
    if (selectedId) rendered.cards.get(selectedId)?.classList.remove('selected');
    selectedId = id;
    if (id) rendered.cards.get(id)?.classList.add('selected');
  };

  panel = new InfoPanel(idx, stage, {
    onNavigate: (id) => goTo(id, true),
    onClose: () => setSelected(null),
  });

  const open = (id: string, pin: boolean): void => {
    const card = rendered.cards.get(id);
    if (!card) return;
    setSelected(id);
    panel.show(id, card, pin);
  };

  function goTo(id: string, openPanel: boolean): void {
    const c = cardCenter(id);
    if (openPanel) panel.hide();
    const scale = Math.max(viewport.scale, 0.85);
    const { w, h } = viewport.size;
    // если откроется панель — оставляем для неё место справа (или снизу на телефоне)
    let ax = w / 2;
    let ay = h / 2;
    if (openPanel) {
      if (w >= 640) ax = Math.max(CARD_W / 2 * scale + 16, Math.min(w / 2, w - 430 - (CARD_W / 2) * scale));
      else ay = h * 0.2;
    }
    const target = viewport.stateCenterOn(c.x, c.y, scale, ax, ay);
    viewport.animateTo(target);
    if (openPanel) {
      window.setTimeout(() => { open(id, true); }, 400);
    } else {
      setSelected(id);
    }
  }

  const fitAll = (): void => viewport.animateTo(viewport.stateFit(layout.width, layout.height));
  const toRoot = (): void => goTo(data.rootId, false);

  // начальный вид
  // старт: корень в нижней части экрана, предки над ним, масштаб ~0.58 (если всё влезает крупнее — просто «всё»)
  const fit = viewport.stateFit(layout.width, layout.height);
  if (fit.scale >= 0.58) {
    viewport.set(fit);
  } else {
    const c = cardCenter(data.rootId);
    const { w, h } = viewport.size;
    viewport.set(viewport.stateCenterOn(c.x, c.y, 0.58, w / 2, h * 0.72));
  }
  applyZoomClass();

  // при изменении размера окна/области (шапка перенеслась, поворот экрана) удерживаем центр вида:
  // иначе дерево, вписанное по прежним размерам, смещается к краю
  let lastSize = viewport.size;
  new ResizeObserver(() => {
    const { w, h } = viewport.size;
    if (!w || !h || (w === lastSize.w && h === lastSize.h)) return;
    const { w: pw, h: ph } = lastSize;
    lastSize = { w, h };
    if (!pw || !ph) { viewport.set(viewport.stateFit(layout.width, layout.height)); return; }
    viewport.panBy((w - pw) / 2, (h - ph) / 2);
  }).observe(viewportEl);

  let suppressFocusShow = false;
  // ---- карточки: ховер / фокус / тап
  for (const [id, card] of rendered.cards) {
    card.addEventListener('pointerenter', (e) => {
      if (e.pointerType !== 'mouse' || viewport.interacting) return;
      panel.scheduleShow(id, card);
    });
    card.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') panel.scheduleHide(); });
    card.addEventListener('click', (e) => {
      e.stopPropagation();
      if (panel.pinned && panel.currentId === id) { panel.hide(); return; }
      open(id, true);
      const { w, h } = viewport.size;
      if (w < 640 && card.getBoundingClientRect().bottom > viewportEl.getBoundingClientRect().top + h * 0.34) {
        const c = cardCenter(id);
        viewport.animateTo(viewport.stateCenterOn(c.x, c.y, undefined, w / 2, h * 0.2), 300);
      }
    });
    card.addEventListener('focus', () => {
      if (suppressFocusShow) return;
      // если карточка за пределами видимой области — подвести её
      const r = card.getBoundingClientRect();
      const v = viewportEl.getBoundingClientRect();
      if (r.left < v.left || r.right > v.right || r.top < v.top || r.bottom > v.bottom) {
        const c = cardCenter(id);
        viewport.animateTo(viewport.stateCenterOn(c.x, c.y), 250);
      }
      panel.pinned = false;
      panel.scheduleShow(id, card, 60);
    });
    card.addEventListener('blur', () => panel.scheduleHide(250));
  }
  viewportEl.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (!t.closest('.card')) panel.hide();
  });

  // ---- кнопки
  $('zoom-in').addEventListener('click', () => viewport.zoomCenter(1.35));
  $('zoom-out').addEventListener('click', () => viewport.zoomCenter(1 / 1.35));
  $('fit-all').addEventListener('click', fitAll);
  $('to-root').addEventListener('click', toRoot);

  // ---- клавиатура
  viewportEl.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const step = 80;
    switch (e.key) {
      case '+': case '=': viewport.zoomCenter(1.25); break;
      case '-': case '_': viewport.zoomCenter(1 / 1.25); break;
      case '0': fitAll(); break;
      case 'Home': toRoot(); break;
      case 'ArrowLeft': viewport.panBy(step, 0); break;
      case 'ArrowRight': viewport.panBy(-step, 0); break;
      case 'ArrowUp': viewport.panBy(0, step); break;
      case 'ArrowDown': viewport.panBy(0, -step); break;
      default: return;
    }
    e.preventDefault();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (panel.visible) {
      const id = panel.currentId;
      panel.hide();
      if (id) {
        suppressFocusShow = true;
        rendered.cards.get(id)?.focus({ preventScroll: true });
        suppressFocusShow = false;
      }
    } else if (search.value) {
      search.value = '';
      runSearch();
    }
  });

  // ---- поиск
  const search = $<HTMLInputElement>('search');
  const results = $('search-results');
  let matches: string[] = [];
  let active = -1;
  const searchIndex = data.persons.map((p) => ({ id: p.id, key: searchText(p) }));

  function highlight(): void {
    const q = searchKey(search.value.trim());
    const set = new Set(matches);
    for (const [id, card] of rendered.cards) {
      card.classList.toggle('match', !!q && set.has(id));
      card.classList.toggle('dim', !!q && !set.has(id));
    }
  }
  function renderResults(): void {
    results.replaceChildren();
    results.hidden = !search.value.trim();
    if (results.hidden) return;
    if (!matches.length) {
      results.append(el('li', 'none', 'Никого не найдено'));
      return;
    }
    matches.slice(0, 8).forEach((id, i) => {
      const p = idx.persons.get(id)!;
      const li = el('li');
      li.setAttribute('role', 'option');
      li.id = `sr-${i}`;
      const b = el('button', i === active ? 'active' : '', fullName(p));
      b.type = 'button';
      b.tabIndex = -1;
      b.addEventListener('mousedown', (ev) => ev.preventDefault());
      b.addEventListener('click', () => pick(id));
      li.append(b);
      results.append(li);
    });
    if (matches.length > 8) results.append(el('li', 'none', `…ещё ${matches.length - 8}`));
  }
  function runSearch(): void {
    const q = searchKey(search.value.trim());
    const tokens = q.split(/\s+/).filter(Boolean);
    matches = tokens.length ? searchIndex.filter((s) => tokens.every((t) => s.key.includes(t))).map((s) => s.id) : [];
    active = matches.length ? 0 : -1;
    highlight();
    renderResults();
  }
  function pick(id: string): void {
    results.hidden = true;
    goTo(id, true);
  }
  new MutationObserver(() => search.setAttribute('aria-expanded', String(!results.hidden)))
    .observe(results, { attributes: true, attributeFilter: ['hidden'] });
  search.addEventListener('input', runSearch);
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const id = matches[Math.max(active, 0)];
      if (id) { e.preventDefault(); pick(id); }
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!matches.length) return;
      e.preventDefault();
      const n = Math.min(matches.length, 8);
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
      renderResults();
    }
  });
  search.addEventListener('focus', () => { if (search.value.trim()) renderResults(); });
  document.addEventListener('pointerdown', (e) => {
    if (!(e.target as HTMLElement).closest('.search')) results.hidden = true;
  });

  // переотрисовка позиции панели при изменении размера
  window.addEventListener('resize', () => panel.reposition());
  // подсказка при первой загрузке
  const hint = $('hint');
  const HINT_KEY = 'gentree-hint-seen';
  let seen = false;
  try { seen = localStorage.getItem(HINT_KEY) === '1'; } catch { /* ignore */ }
  const dismissHint = (): void => {
    hint.hidden = true;
    try { localStorage.setItem(HINT_KEY, '1'); } catch { /* ignore */ }
  };
  hint.hidden = seen;
  $('hint-close').addEventListener('click', dismissHint);
  viewportEl.addEventListener('wheel', () => { if (!hint.hidden) dismissHint(); }, { passive: true });
  document.body.dataset.ready = 'true';
}

void start();
