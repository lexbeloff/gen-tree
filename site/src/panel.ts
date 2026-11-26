// Всплывающая панель с подробностями о персоне. Все утверждения снабжены сносками [n].
import { el, statusBadge } from './render.ts';
import { eventLabel, FACT_LABEL, formatDate, fullName, KIND_LABEL, photoUrl, safeUrl } from './format.ts';
import type { ParentRelation, Person, Relation, Source, SpouseRelation, Status } from './types.ts';

export interface TreeIndex {
  persons: Map<string, Person>;
  sources: Map<string, Source>;
  parentRels: Map<string, ParentRelation[]>; // по ребёнку
  childRels: Map<string, ParentRelation[]>; // по родителю
  spouseRels: Map<string, SpouseRelation[]>;
}

export function indexTree(persons: Person[], sources: Source[], relations: Relation[]): TreeIndex {
  const idx: TreeIndex = {
    persons: new Map(persons.map((p) => [p.id, p])),
    sources: new Map(sources.map((s) => [s.id, s])),
    parentRels: new Map(),
    childRels: new Map(),
    spouseRels: new Map(),
  };
  const push = <T>(m: Map<string, T[]>, k: string, v: T) => (m.get(k) ?? m.set(k, []).get(k)!).push(v);
  for (const r of relations) {
    if (r.type === 'parent') { push(idx.parentRels, r.child, r); push(idx.childRels, r.parent, r); }
    else { push(idx.spouseRels, r.a, r); push(idx.spouseRels, r.b, r); }
  }
  return idx;
}

/** Реестр сносок одной панели: источник -> номер в порядке первого упоминания. */
class Cites {
  readonly order: string[] = [];
  constructor(private idx: TreeIndex, private jump: (id: string) => void) {}

  mark(ids: string[] | undefined): HTMLElement {
    const wrap = el('span', 'cites');
    if (!ids || !ids.length) {
      const m = el('span', 'cite missing', '[нет источника]');
      m.title = 'Для этого утверждения источник не указан';
      wrap.append(m);
      return wrap;
    }
    for (const id of ids) {
      const src = this.idx.sources.get(id);
      if (!src) {
        const m = el('span', 'cite missing', '[нет источника]');
        m.title = `Источник ${id} не найден в каталоге`;
        wrap.append(m);
        continue;
      }
      let n = this.order.indexOf(id) + 1;
      if (!n) { this.order.push(id); n = this.order.length; }
      const b = el('button', 'cite', `[${n}]`);
      b.type = 'button';
      b.title = src.title;
      b.addEventListener('click', (e) => { e.stopPropagation(); this.jump(id); });
      wrap.append(b);
    }
    return wrap;
  }
}

export interface PanelCallbacks {
  onNavigate: (id: string) => void;
  onClose: () => void;
}

export class InfoPanel {
  readonly root: HTMLElement;
  private body: HTMLElement;
  private hideTimer = 0;
  private showTimer = 0;
  currentId: string | null = null;
  pinned = false;
  private anchor: HTMLElement | null = null;

  constructor(private idx: TreeIndex, private container: HTMLElement, private cb: PanelCallbacks) {
    this.root = el('aside', 'panel');
    this.root.hidden = true;
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', 'Сведения о человеке');
    this.root.tabIndex = -1;
    const close = el('button', 'panel-close icon-close');
    close.type = 'button';
    close.setAttribute('aria-label', 'Закрыть');
    close.addEventListener('click', () => this.hide());
    this.body = el('div', 'panel-body');
    this.root.append(close, this.body);
    this.root.addEventListener('pointerenter', () => this.cancelHide());
    this.root.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') this.scheduleHide(); });
    this.root.addEventListener('focusin', () => this.cancelHide());
    this.root.addEventListener('wheel', (e) => e.stopPropagation());
    container.append(this.root);
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  cancelHide(): void {
    clearTimeout(this.hideTimer);
  }

  scheduleHide(delay = 320): void {
    clearTimeout(this.showTimer);
    if (this.pinned) return;
    clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => this.hide(), delay);
  }

  scheduleShow(id: string, anchor: HTMLElement, delay = 180): void {
    this.cancelHide();
    clearTimeout(this.showTimer);
    if (this.pinned && this.currentId !== id) return;
    this.showTimer = window.setTimeout(() => this.show(id, anchor), delay);
  }

  show(id: string, anchor: HTMLElement, pin = false): void {
    clearTimeout(this.showTimer);
    this.cancelHide();
    if (pin) this.pinned = true;
    this.anchor = anchor;
    if (this.currentId !== id || this.root.hidden) {
      this.currentId = id;
      this.build(id);
      this.root.hidden = false;
      this.body.scrollTop = 0;
    }
    this.reposition();
  }

  hide(): void {
    clearTimeout(this.showTimer);
    clearTimeout(this.hideTimer);
    const was = this.visible;
    this.root.hidden = true;
    this.pinned = false;
    this.currentId = null;
    this.anchor = null;
    if (was) this.cb.onClose();
  }

  reposition(): void {
    if (this.root.hidden || !this.anchor) return;
    const c = this.container.getBoundingClientRect();
    const a = this.anchor.getBoundingClientRect();
    const sheet = c.width < 640;
    this.root.classList.toggle('sheet', sheet);
    if (sheet) {
      this.root.style.left = '';
      this.root.style.top = '';
      return;
    }
    const w = this.root.offsetWidth;
    const h = this.root.offsetHeight;
    const m = 10;
    let left = a.right + m;
    if (left + w > c.right - m) left = a.left - m - w;
    if (left < c.left + m) {
      // не помещается сбоку: под/над карточкой
      left = Math.min(Math.max(a.left, c.left + m), c.right - m - w);
    }
    let top = a.top;
    if (left > a.right || left + w < a.left) {
      top = Math.min(Math.max(a.top - 8, c.top + m), c.bottom - m - h);
    } else {
      top = a.bottom + m + h <= c.bottom - m ? a.bottom + m : Math.max(c.top + m, a.top - m - h);
    }
    top = Math.min(Math.max(top, c.top + m), Math.max(c.top + m, c.bottom - m - h));
    this.root.style.left = `${left - c.left}px`;
    this.root.style.top = `${top - c.top}px`;
  }

  // ---------------------------------------------------------------- содержимое

  private build(id: string): void {
    const p = this.idx.persons.get(id);
    this.body.replaceChildren();
    if (!p) return;
    const cites = new Cites(this.idx, (sid) => this.flashSource(sid));

    const head = el('header', 'p-head');
    head.append(el('h2', 'p-name', fullName(p)));
    const names = el('div', 'p-names');
    if (!p.name.surname) names.append(el('div', '', 'Фамилия не известна'));
    if (!p.living) {
      if (p.name.birthSurname) names.append(el('div', '', `Девичья фамилия: ${p.name.birthSurname}`));
      if (p.name.otherSurnames?.length) names.append(el('div', '', `Другие фамилии: ${p.name.otherSurnames.join(', ')}`));
    }
    if (names.childElementCount) head.append(names);
    if (!p.living && p.status) {
      const st = el('div', 'p-status');
      st.append(statusBadge(p.status, true));
      head.append(st);
    }
    this.body.append(head);

    if (p.living) {
      this.body.append(el('p', 'p-living', 'Сведения не публикуются, показано только имя.'));
    } else {
      this.body.append(...this.detailSections(p, cites));
    }
    this.body.append(this.familySection(p, cites));
    if (cites.order.length) this.body.append(this.sourcesSection(cites));
  }

  private detailSections(p: Person, cites: Cites): HTMLElement[] {
    const out: HTMLElement[] = [];
    const rows = el('dl', 'p-facts');
    const addEvent = (label: string, ev: Person['birth']) => {
      if (!ev) return;
      const text = [eventLabel(ev), ev.place].filter(Boolean).join(', ');
      if (!text) return;
      const dt = el('dt', '', label);
      const dd = el('dd');
      dd.append(text);
      if (ev.date && ev.text) dd.append(el('span', 'muted', ` (${ev.text})`));
      if (ev.status) dd.append(' ', statusBadge(ev.status));
      dd.append(' ', cites.mark(ev.sources));
      rows.append(dt, dd);
    };
    addEvent('Рождение', p.birth);
    addEvent('Смерть', p.death);
    for (const f of p.facts ?? []) {
      const dt = el('dt', '', FACT_LABEL[f.type] ?? f.type);
      const dd = el('dd');
      const when = formatDate(f.date);
      dd.append([when, f.text].filter(Boolean).join(' — '));
      if (f.status) dd.append(' ', statusBadge(f.status));
      dd.append(' ', cites.mark(f.sources));
      rows.append(dt, dd);
    }
    if (rows.childElementCount) out.push(this.section('Сведения', rows));

    if (p.photos?.length) {
      const gal = el('div', 'p-photos');
      for (const ph of p.photos) {
        const fig = el('figure');
        const href = photoUrl(p, ph.file);
        const a = el('a');
        a.href = href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        const img = document.createElement('img');
        img.src = href;
        img.alt = ph.caption ?? 'Фото';
        img.loading = 'lazy';
        a.append(img);
        const cap = el('figcaption');
        cap.append([ph.caption, ph.year].filter(Boolean).join(', ') || 'Фото', ' ', cites.mark(ph.sources));
        fig.append(a, cap);
        gal.append(fig);
      }
      out.push(this.section('Фотографии', gal));
    }

    if (p.notes?.length) {
      const ul = el('ul', 'p-notes');
      for (const n of p.notes) {
        const li = el('li');
        li.append(n.text, ' ', cites.mark(n.sources));
        ul.append(li);
      }
      out.push(this.section('Заметки', ul));
    }
    return out;
  }

  private familySection(p: Person, cites: Cites): HTMLElement {
    const box = el('div', 'p-family');
    const group = (label: string, items: HTMLElement[]) => {
      if (!items.length) return;
      const row = el('div', 'fam-row');
      row.append(el('span', 'fam-label', label));
      const list = el('span', 'fam-list');
      items.forEach((i) => list.append(i));
      row.append(list);
      box.append(row);
    };
    const link = (id: string, extra: string, status: Status | undefined, sources: string[], note?: string) => {
      const q = this.idx.persons.get(id);
      const wrap = el('span', 'fam-item');
      const b = el('button', 'fam-link', q ? fullName(q) : id);
      b.type = 'button';
      b.addEventListener('click', () => this.cb.onNavigate(id));
      wrap.append(b);
      if (extra) wrap.append(el('span', 'muted', ` ${extra}`));
      if (note) wrap.append(el('span', 'muted', ` ${note}`));
      if (status && isWeakStatus(status)) wrap.append(' ', statusBadge(status));
      wrap.append(' ', cites.mark(sources));
      return wrap;
    };
    const parents = (this.idx.parentRels.get(p.id) ?? []).map((r) => {
      const q = this.idx.persons.get(r.parent);
      return link(r.parent, q?.sex === 'M' ? '(отец)' : q?.sex === 'F' ? '(мать)' : '(родитель)', r.status, r.sources);
    });
    group('Родители', parents);
    const sp = (this.idx.spouseRels.get(p.id) ?? []).map((r) => {
      const other = r.a === p.id ? r.b : r.a;
      const date = p.living ? '' : formatDate(r.date);
      return link(other, '', r.status, r.sources, date ? `(брак: ${date})` : undefined);
    });
    group('Супруги', sp);
    const kids = (this.idx.childRels.get(p.id) ?? []).map((r) => link(r.child, '', r.status, r.sources));
    group('Дети', kids);
    if (!box.childElementCount) return el('div');
    return this.section('Семья', box);
  }

  private sourcesSection(cites: Cites): HTMLElement {
    const ol = el('ol', 'p-sources');
    cites.order.forEach((sid, i) => {
      const s = this.idx.sources.get(sid);
      if (!s) return;
      const li = el('li');
      li.id = `src-${i + 1}`;
      li.dataset.src = sid;
      const url = safeUrl(s.url);
      if (url) {
        const a = el('a', 'src-title', s.title);
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        li.append(a);
      } else {
        li.append(el('span', 'src-title', s.title));
      }
      const meta = [s.repository, s.reference, s.date].filter(Boolean).join(' · ');
      if (meta) li.append(el('div', 'src-meta', meta));
      const kind = el('div', 'src-kind', KIND_LABEL[s.kind] ?? s.kind);
      if (s.kind === 'family-document') kind.textContent = 'семейный архив, скан не публикуется';
      li.append(kind);
      if (s.note) li.append(el('div', 'src-note', s.note));
      ol.append(li);
    });
    return this.section('Источники', ol);
  }

  private section(title: string, content: HTMLElement): HTMLElement {
    const s = el('section', 'p-section');
    s.append(el('h3', '', title), content);
    return s;
  }

  private flashSource(sid: string): void {
    const li = this.body.querySelector<HTMLElement>(`li[data-src="${CSS.escape(sid)}"]`);
    if (!li) return;
    li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    li.classList.remove('flash');
    void li.offsetWidth;
    li.classList.add('flash');
  }
}

function isWeakStatus(s: Status): boolean {
  return s === 'hypothesis' || s === 'unresolved' || s === 'family-report';
}


