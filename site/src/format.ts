import type { DatedEvent, Person, Status } from './types.ts';

const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

/** ISO (1909 | 1909-01 | 1909-01-23 | 1941-1945) -> по-русски. Иначе возвращает исходный текст. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (m) return `${m[3]}.${m[2]}.${m[1]}`;
  m = /^(\d{4})-(\d{2})$/.exec(iso);
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return `${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
  if (/^\d{4}$/.test(iso)) return iso;
  m = /^(\d{4})\s*[-–—]\s*(\d{4})$/.exec(iso);
  if (m) return `${m[1]}–${m[2]}`;
  return iso;
}

/** Дата события: date приоритетнее, иначе text. */
export function eventLabel(ev: DatedEvent | null | undefined): string {
  if (!ev) return '';
  return formatDate(ev.date) || ev.text || '';
}

/** Год(ы) только из структурированной даты; из свободного текста годы не извлекаются. */
export function eventYear(ev: DatedEvent | null | undefined): string {
  const d = ev?.date;
  if (!d) return '';
  const range = /^(\d{4})\s*[-–—]\s*(\d{4})$/.exec(d);
  if (range) return `${range[1]}–${range[2]}`;
  const m = /^\d{4}/.exec(d);
  return m ? m[0] : '';
}

/** Строка «годы жизни». Без даты смерти — пометка по тексту, без выдуманных годов. */
export function lifeYears(p: Person): string {
  if (p.living || !p.death) return '';
  const death = eventYear(p.death);
  if (death) return `${eventYear(p.birth) || '?'}–${death}`;
  const t = p.death.text ?? '';
  if (/на войне/i.test(t)) return '† на войне';
  if (/пропал без вести/i.test(t)) return '† пропал без вести';
  return '† дата не известна';
}

/** «родился» / «родилась» по полу. */
export function birthVerb(p: Person): string {
  return p.sex === 'F' ? 'родилась' : 'родился';
}

export function fullName(p: Person): string {
  const n = p.name;
  return [n.surname, n.given, n.patronymic].filter(Boolean).join(' ');
}

export function givenName(p: Person): string {
  return [p.name.given, p.name.patronymic].filter(Boolean).join(' ');
}

export function searchKey(s: string): string {
  return s.toLowerCase().replace(/ё/g, 'е');
}

export function searchText(p: Person): string {
  const n = p.name;
  return searchKey([n.surname, n.given, n.patronymic, n.birthSurname, ...(n.otherSurnames ?? [])].filter(Boolean).join(' '));
}

export const STATUS_LABEL: Record<Status, string> = {
  'strongly-corroborated': 'Надёжно подтверждено',
  corroborated: 'Подтверждено',
  'single-source': 'Один источник',
  'family-report': 'Со слов семьи',
  hypothesis: 'Гипотеза',
  unresolved: 'Не установлено',
};

export const FACT_LABEL: Record<string, string> = {
  occupation: 'Занятие',
  military: 'Служба',
  residence: 'Проживание',
  award: 'Награда',
  education: 'Образование',
  name: 'Имя',
  other: 'Иное',
};

export const KIND_LABEL: Record<string, string> = {
  archive: 'архив',
  'family-document': 'семейный архив',
  'family-memory': 'сведения семьи',
  reference: 'справочник',
};

/** Только http/https. */
export function safeUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/** Путь к файлу фото внутри собранных данных (кириллица и пробелы кодируются). */
export function photoUrl(p: Person, file: string): string {
  if (!p.folder) return '';
  const enc = (s: string) => s.split('/').map(encodeURIComponent).join('/');
  return `data/people/${encodeURIComponent(p.folder)}/${enc(file)}`;
}
