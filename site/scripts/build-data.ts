// Сборщик данных: data/people/*/person.json + data/sources.json -> site/.generated/tree.json (+ фото).
// Запуск: node scripts/build-data.ts [путь-к-данным]   (или переменная GENTREE_DATA)
// Путь по умолчанию — ../data (относительно site/).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { Person, Relation, Source, Status, TreeData } from '../src/types.ts';

const SITE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const STATUSES: Status[] = ['strongly-corroborated', 'corroborated', 'single-source', 'family-report', 'hypothesis', 'unresolved'];

export class DataError extends Error {}

interface RawRel {
  id: string;
  status?: Status;
  date?: string | null;
  sources?: string[];
}

type RawPerson = Omit<Person, 'folder'> & { parents?: RawRel[]; spouses?: RawRel[]; $schema?: string };

export interface BuildResult {
  changed: boolean;
  persons: number;
  warnings: string[];
  dataDir: string;
  outDir: string;
}

/** Для данных по умолчанию (../data) — .generated, для остальных (фикстура) — отдельная папка, чтобы сборки не мешали друг другу. */
export function outDirFor(dataDir: string): string {
  if (path.resolve(dataDir) === path.resolve(SITE_ROOT, '../data')) return path.join(SITE_ROOT, '.generated');
  const slug = path.relative(SITE_ROOT, dataDir).replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
  return path.join(SITE_ROOT, `.generated-${slug || 'custom'}`);
}

export function resolveDataDir(arg?: string): string {
  const raw = arg ?? process.env.GENTREE_DATA ?? '../data';
  return path.resolve(SITE_ROOT, raw);
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (e) {
    throw new DataError(`${file}: не удалось прочитать JSON — ${(e as Error).message}`);
  }
}

function rel(p: string): string {
  return path.relative(process.cwd(), p) || p;
}

/** Для живых оставляем только id/living/sex/name(ФИО без девичьих/других фамилий)/связи без дат. */
function maskLiving(raw: RawPerson, file: string, warnings: string[]): RawPerson {
  const extra = ['status', 'birth', 'death', 'facts', 'photos', 'notes'].filter((k) => (raw as Record<string, unknown>)[k] != null);
  if (extra.length) warnings.push(`${rel(file)}: у живого (${raw.id}) есть лишние поля [${extra.join(', ')}] — отброшены`);
  return {
    id: raw.id,
    living: true,
    sex: raw.sex,
    name: { surname: raw.name.surname ?? null, given: raw.name.given, patronymic: raw.name.patronymic ?? null },
    parents: raw.parents,
    spouses: (raw.spouses ?? []).map((s) => ({ id: s.id, status: s.status, sources: s.sources })),
  };
}

export function loadAndBuild(dataDir: string): { tree: TreeData; photos: Map<string, string>; warnings: string[] } {
  const warnings: string[] = [];
  const errors: string[] = [];
  const peopleDir = path.join(dataDir, 'people');
  if (!fs.existsSync(peopleDir)) throw new DataError(`Нет папки с людьми: ${peopleDir}`);

  // --- схемы (если есть) ---
  const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
  const loadSchema = (name: string) => {
    // схема из папки данных; если её там нет (фикстура) — общая схема проекта из ../data
    const f = [path.join(dataDir, name), path.resolve(SITE_ROOT, '../data', name)].find((x) => fs.existsSync(x));
    return f ? ajv.compile(readJson(f) as object) : null;
  };
  const validatePerson = loadSchema('person.schema.json');
  const validateSources = loadSchema('sources.schema.json');
  if (!validatePerson) warnings.push('person.schema.json не найден — валидация персон по схеме пропущена');
  if (!validateSources) warnings.push('sources.schema.json не найден — валидация источников по схеме пропущена');

  // --- источники ---
  const sourcesFile = path.join(dataDir, 'sources.json');
  if (!fs.existsSync(sourcesFile)) throw new DataError(`Нет файла источников: ${sourcesFile}`);
  const sourcesRaw = readJson(sourcesFile) as { sources?: Source[] };
  if (validateSources && !validateSources(sourcesRaw)) {
    for (const e of validateSources.errors ?? []) errors.push(`${rel(sourcesFile)}: ${e.instancePath || '/'} ${e.message}`);
  }
  const sources: Source[] = sourcesRaw.sources ?? [];
  const sourceIds = new Set<string>();
  for (const s of sources) {
    if (sourceIds.has(s.id)) errors.push(`${rel(sourcesFile)}: повторяющийся id источника ${s.id}`);
    sourceIds.add(s.id);
  }

  // --- персоны (private/ не читаем никогда) ---
  const persons: Person[] = [];
  const files = new Map<string, string>();
  const byId = new Map<string, Person>();
  const raws = new Map<string, RawPerson>();
  const dirs = fs
    .readdirSync(peopleDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.toLowerCase() !== 'private')
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b, 'ru'));

  for (const folder of dirs) {
    const file = path.join(peopleDir, folder, 'person.json');
    if (!fs.existsSync(file)) {
      warnings.push(`${rel(path.join(peopleDir, folder))}: нет person.json — папка пропущена`);
      continue;
    }
    let raw = readJson(file) as RawPerson;
    if (validatePerson && !validatePerson(raw)) {
      for (const e of validatePerson.errors ?? []) errors.push(`${rel(file)}: ${e.instancePath || '/'} ${e.message}`);
    }
    if (!raw || typeof raw.id !== 'string' || !raw.name || (raw.name.surname !== null && typeof raw.name.surname !== 'string')) {
      errors.push(`${rel(file)}: нет id или name (surname — строка или null)`);
      continue;
    }
    if (typeof raw.living !== 'boolean') {
      errors.push(`${rel(file)}: поле living обязательно (true/false)`);
      continue;
    }
    if (byId.has(raw.id)) {
      errors.push(`${rel(file)}: повторяющийся id ${raw.id} (уже есть в ${rel(files.get(raw.id) ?? '')})`);
      continue;
    }
    if (raw.living) {
      const expected = [raw.name.surname, raw.name.given, raw.name.patronymic].filter(Boolean).join(' ');
      if (folder !== expected) errors.push(`${rel(file)}: папка живого должна называться ровно «${expected}» (фамилия имя отчество, без скобок и пометок), сейчас «${folder}»`);
      raw = maskLiving(raw, file, warnings);
    }
    const { $schema: _s, parents: _p, spouses: _sp, ...pub } = raw;
    void _s; void _p; void _sp;
    const person: Person = { ...(pub as Omit<Person, 'folder'>), ...(raw.living ? {} : { folder }) };
    persons.push(person);
    byId.set(person.id, person);
    files.set(person.id, file);
    raws.set(person.id, raw);
  }

  // --- ссылки на источники в утверждениях ---
  const checkSources = (ids: string[] | undefined, where: string, file: string) => {
    for (const s of ids ?? []) if (!sourceIds.has(s)) errors.push(`${rel(file)}: ${where} ссылается на несуществующий источник ${s}`);
  };
  const checkStatus = (st: unknown, where: string, file: string) => {
    if (st !== undefined && !STATUSES.includes(st as Status)) errors.push(`${rel(file)}: ${where} — неизвестный статус «${String(st)}»`);
  };

  const photos = new Map<string, string>(); // относительный путь в .generated -> исходный файл
  for (const p of persons) {
    const file = files.get(p.id)!;
    checkStatus(p.status, 'status', file);
    for (const key of ['birth', 'death'] as const) {
      const ev = p[key];
      if (ev) {
        checkSources(ev.sources, key, file);
        checkStatus(ev.status, key, file);
      }
    }
    (p.facts ?? []).forEach((f, i) => { checkSources(f.sources, `facts[${i}]`, file); checkStatus(f.status, `facts[${i}]`, file); });
    (p.notes ?? []).forEach((n, i) => checkSources(n.sources, `notes[${i}]`, file));
    (p.photos ?? []).forEach((ph, i) => {
      if (!p.folder) return;
      checkSources(ph.sources, `photos[${i}]`, file);
      const personDir = path.join(peopleDir, p.folder);
      const src = path.resolve(personDir, ph.file);
      const photosDir = path.join(personDir, 'photos') + path.sep;
      if (!src.startsWith(photosDir)) {
        errors.push(`${rel(file)}: photos[${i}].file «${ph.file}» должен лежать в photos/ этой персоны`);
      } else if (!fs.existsSync(src)) {
        errors.push(`${rel(file)}: photos[${i}].file «${ph.file}» — файла нет`);
      } else {
        photos.set(path.posix.join('people', p.folder, ph.file.replace(/\\/g, '/')), src);
      }
    });
  }

  // --- связи ---
  const relations: Relation[] = [];
  const spouseMap = new Map<string, Map<string, RawRel>>();
  for (const p of persons) {
    const raw = raws.get(p.id)!;
    const file = files.get(p.id)!;
    const seenParents = new Set<string>();
    for (const r of raw.parents ?? []) {
      if (!byId.has(r.id)) { errors.push(`${rel(file)}: parents → несуществующая персона ${r.id}`); continue; }
      if (r.id === p.id) { errors.push(`${rel(file)}: персона указана собственным родителем`); continue; }
      if (seenParents.has(r.id)) { errors.push(`${rel(file)}: parents содержит ${r.id} дважды`); continue; }
      seenParents.add(r.id);
      checkSources(r.sources, `parents[${r.id}]`, file);
      checkStatus(r.status, `parents[${r.id}]`, file);
      relations.push({ type: 'parent', parent: r.id, child: p.id, status: r.status ?? 'unresolved', sources: r.sources ?? [] });
    }
    for (const r of raw.spouses ?? []) {
      if (!byId.has(r.id)) { errors.push(`${rel(file)}: spouses → несуществующая персона ${r.id}`); continue; }
      if (r.id === p.id) { errors.push(`${rel(file)}: персона указана собственным супругом`); continue; }
      checkSources(r.sources, `spouses[${r.id}]`, file);
      checkStatus(r.status, `spouses[${r.id}]`, file);
      if (!spouseMap.has(p.id)) spouseMap.set(p.id, new Map());
      spouseMap.get(p.id)!.set(r.id, r);
    }
  }
  for (const [a, m] of spouseMap) {
    for (const [b, r] of m) {
      if (!spouseMap.get(b)?.has(a)) {
        errors.push(`${rel(files.get(a)!)}: супруг ${b} не указывает ${a} в своём spouses (нет симметрии)`);
        continue;
      }
      if (a < b) {
        const other = spouseMap.get(b)!.get(a)!;
        const living = byId.get(a)!.living || byId.get(b)!.living;
        const date = living ? undefined : (r.date ?? other.date ?? undefined);
        relations.push({ type: 'spouse', a, b, status: r.status ?? other.status ?? 'unresolved', ...(date ? { date } : {}), sources: r.sources ?? other.sources ?? [] });
      }
    }
  }

  // --- циклы родства ---
  const parentsOf = new Map<string, string[]>();
  for (const r of relations) if (r.type === 'parent') (parentsOf.get(r.child) ?? parentsOf.set(r.child, []).get(r.child)!).push(r.parent);
  const state = new Map<string, 1 | 2>();
  const visit = (id: string, trail: string[]): void => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) {
      errors.push(`Цикл в родстве: ${[...trail.slice(trail.indexOf(id)), id].join(' → ')} (${rel(files.get(id)!)})`);
      return;
    }
    state.set(id, 1);
    for (const par of parentsOf.get(id) ?? []) visit(par, [...trail, id]);
    state.set(id, 2);
  };
  for (const p of persons) visit(p.id, []);

  if (errors.length) throw new DataError(`Найдено ошибок в данных: ${errors.length}\n  - ${errors.join('\n  - ')}`);
  if (!persons.length) throw new DataError(`В ${peopleDir} нет ни одной персоны`);

  let rootId = persons[0]!.id;
  let title: string | undefined;
  const siteFile = path.join(dataDir, 'site.json');
  if (fs.existsSync(siteFile)) {
    const cfg = readJson(siteFile) as { rootId?: string; title?: string };
    if (cfg.rootId) {
      if (byId.has(cfg.rootId)) rootId = cfg.rootId;
      else throw new DataError(`${rel(siteFile)}: rootId ${cfg.rootId} — нет такой персоны`);
    }
    if (typeof cfg.title === 'string' && cfg.title.trim()) title = cfg.title.trim();
  }
  const tree: TreeData = { generated: '', rootId, ...(title ? { title } : {}), persons, sources, relations };
  return { tree, photos, warnings };
}

function sameFile(a: string, b: string): boolean {
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    return sa.size === sb.size && sa.mtimeMs >= sb.mtimeMs;
  } catch {
    return false;
  }
}

function listFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

export function buildData(dataDir: string, outDir: string = outDirFor(dataDir)): BuildResult {
  const { tree, photos, warnings } = loadAndBuild(dataDir);
  fs.mkdirSync(outDir, { recursive: true });
  let changed = false;

  // tree.json пишем только если содержимое (без метки времени) изменилось — иначе dev-сервер зациклится
  const treeFile = path.join(outDir, 'tree.json');
  let prev: Partial<TreeData> | null = null;
  try { prev = JSON.parse(fs.readFileSync(treeFile, 'utf8')) as TreeData; } catch { prev = null; }
  const body = (t: Partial<TreeData>) => JSON.stringify({ ...t, generated: '' });
  if (!prev || body(prev) !== body(tree)) {
    tree.generated = new Date().toISOString();
    fs.writeFileSync(treeFile, JSON.stringify(tree, null, 1));
    changed = true;
  }

  // фото
  const wanted = new Set<string>();
  for (const [relPath, src] of photos) {
    const dst = path.join(outDir, ...relPath.split('/'));
    wanted.add(path.resolve(dst));
    if (!sameFile(dst, src)) {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      changed = true;
    }
  }
  for (const f of listFiles(path.join(outDir, 'people'))) {
    if (!wanted.has(path.resolve(f))) { fs.rmSync(f); changed = true; }
  }

  return { changed, persons: tree.persons.length, warnings, dataDir, outDir };
}

function main(): void {
  const dataDir = resolveDataDir(process.argv[2]);
  try {
    const res = buildData(dataDir);
    for (const w of res.warnings) console.warn(`[data] предупреждение: ${w}`);
    console.log(`[data] ${rel(dataDir)}: персон ${res.persons}, ${res.changed ? 'tree.json обновлён' : 'без изменений'}`);
  } catch (e) {
    console.error(`[data] ОШИБКА: ${(e as Error).message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
