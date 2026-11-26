import { CARD_H, CARD_W, isWeak } from './layout.ts';
import type { Layout } from './layout.ts';
import { birthVerb, eventLabel, fullName, lifeYears, STATUS_LABEL } from './format.ts';
import type { Person, Status } from './types.ts';
import { photoUrl } from './format.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';

export const STATUS_GLYPH: Record<Status, string> = {
  'strongly-corroborated': '★',
  corroborated: '✓',
  'single-source': '1',
  'family-report': '≈',
  hypothesis: '?',
  unresolved: '–',
};

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function silhouette(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 40 50');
  svg.setAttribute('class', 'silhouette');
  svg.setAttribute('aria-hidden', 'true');
  const head = document.createElementNS(SVG_NS, 'circle');
  head.setAttribute('cx', '20');
  head.setAttribute('cy', '17');
  head.setAttribute('r', '9');
  const body = document.createElementNS(SVG_NS, 'path');
  body.setAttribute('d', 'M3 50c0-12 7-19 17-19s17 7 17 19z');
  svg.append(head, body);
  return svg;
}

export function statusBadge(status: Status | undefined, withText = false): HTMLElement {
  const s: Status = status ?? 'unresolved';
  const b = el('span', `status-badge s-${s}`);
  b.title = STATUS_LABEL[s];
  b.append(el('span', 'glyph', STATUS_GLYPH[s]));
  if (withText) b.append(el('span', 'label', STATUS_LABEL[s]));
  else b.setAttribute('aria-label', STATUS_LABEL[s]);
  return b;
}

export function personStatus(p: Person): Status | undefined {
  return p.status ?? p.birth?.status;
}

export interface Rendered {
  world: HTMLElement;
  cards: Map<string, HTMLButtonElement>;
}

export function renderTree(world: HTMLElement, layout: Layout, persons: Map<string, Person>): Rendered {
  world.replaceChildren();
  world.style.width = `${layout.width}px`;
  world.style.height = `${layout.height}px`;

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'lines');
  svg.setAttribute('width', String(layout.width));
  svg.setAttribute('height', String(layout.height));
  svg.setAttribute('aria-hidden', 'true');
  for (const b of layout.sides) {
    // прозрачность на группе: перекрытия прямоугольников не темнеют
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', `side-band side-${b.side}`);
    for (const r of b.rects) {
      const rect = document.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('x', String(r.x));
      rect.setAttribute('y', String(r.y));
      rect.setAttribute('width', String(r.w));
      rect.setAttribute('height', String(r.h));
      rect.setAttribute('rx', '18');
      g.append(rect);
    }
    svg.append(g);
  }
  for (const l of layout.lines) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', l.d);
    path.setAttribute('class', `${l.dashed ? 'line weak' : 'line'}${l.union !== undefined ? ` u${l.union}` : ''}`);
    svg.append(path);
  }
  for (const s of layout.spouseLinks) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', s.d);
    path.setAttribute('class', `${s.dashed ? 'line marriage weak' : 'line marriage'}${s.union !== undefined ? ` u${s.union}` : ''}`);
    svg.append(path);
  }
  for (const d of layout.unionDots) {
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('cx', String(d.x));
    c.setAttribute('cy', String(d.y));
    c.setAttribute('r', '7');
    c.setAttribute('class', `union-dot u${d.union}`);
    svg.append(c);
  }
  world.append(svg);

  for (const b of layout.sides) {
    const lab = el('div', `side-label side-${b.side}`, b.label);
    lab.style.left = `${b.labelX}px`;
    lab.style.top = `${b.labelY}px`;
    world.append(lab);
  }

  const cards = new Map<string, HTMLButtonElement>();
  for (const id of layout.order) {
    const p = persons.get(id)!;
    const node = layout.nodes.get(id)!;
    const status = p.living ? undefined : personStatus(p);
    const card = el('button', 'card');
    card.type = 'button';
    card.dataset.id = id;
    card.style.left = `${node.x}px`;
    card.style.top = `${node.y}px`;
    card.style.width = `${CARD_W}px`;
    card.style.height = `${CARD_H}px`;
    if (p.living) card.classList.add('living');
    if (p.sex) card.classList.add(`sex-${p.sex}`);
    if (isWeak(status)) card.classList.add('weak');
    const label = [fullName(p)];
    if (!p.name.surname) label.push('фамилия не известна');
    if (!p.living) {
      const b = eventLabel(p.birth);
      if (b) label.push(`${birthVerb(p)} ${b}`);
    }
    card.setAttribute('aria-label', label.join(', '));

    if (!p.living) {
      const av = el('span', 'avatar');
      const first = p.photos?.[0];
      if (first) {
        const img = document.createElement('img');
        img.src = photoUrl(p, first.file);
        img.alt = '';
        img.loading = 'lazy';
        img.draggable = false;
        av.append(img);
      } else {
        av.append(silhouette());
      }
      card.append(av);
    }

    const text = el('span', 'text');
    const surname = el('span', p.name.surname ? 'surname' : 'surname unknown', p.name.surname ?? p.name.given);
    if (p.name.birthSurname && p.name.birthSurname !== p.name.surname && !p.living) surname.append(el('span', 'maiden', ` (${p.name.birthSurname})`));
    text.append(surname);
    // без фамилии имя выводится в первой строке, во второй — пометка
    const given = p.name.surname ? [p.name.given, p.name.patronymic].filter(Boolean).join(' ') : ['фамилия не известна', p.name.patronymic].filter(Boolean).join(' · ');
    text.append(el('span', p.name.surname ? 'given' : 'given muted', given));
    if (!p.living) {
      const b = eventLabel(p.birth);
      text.append(el('span', 'birth', b ? `р. ${b}` : 'дата рождения неизвестна'));
      const years = lifeYears(p);
      if (years) text.append(el('span', 'years', years));
    }
    card.append(text);
    if (status) {
      const badge = statusBadge(status);
      badge.classList.add('card-status');
      card.append(badge);
    }
    world.append(card);
    cards.set(id, card);
  }
  return { world, cards };
}
