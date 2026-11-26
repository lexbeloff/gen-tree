// Собственный слоистый (layered) макет родословного древа.
//  1. Супруги объединяются в «кластеры» (цепочка людей в одну строку).
//  2. Кластеры раскладываются по поколениям (предки выше).
//  3. Порядок в строках и x-координаты ищутся итеративно: кластеры тянутся к
//     центру родителей/детей, пересечения устраняются взвешенной изотонической
//     регрессией (PAV) с сохранением порядка.
//  4. Для каждой «семейной группы» (набор родителей -> дети) строится
//     ортогональная шина на своей «дорожке», чтобы линии не слипались.
import type { Person, Relation, Status } from './types.ts';

export const CARD_W = 224;
export const CARD_H = 96;
const SPOUSE_GAP = 30;
const CLUSTER_GAP = 40;
const ROW_GAP_BASE = 64;
const LANE_STEP = 14;
const MARGIN = 60;
const SIDE_GAP = 280; // минимальный «коридор» между линией отца и линией матери
const BAND_PAD = 22; // отступ подложки стороны от карточек
const UNION_COLORS = 3; // число цветов для разных браков одного человека
const BAND_LABEL = 44; // место под подпись стороны над верхним рядом

export interface Node {
  id: string;
  x: number; // левый верхний угол
  y: number;
  gen: number;
  cluster: number;
}

export interface Polyline {
  d: string;
  dashed: boolean;
  union?: number; // номер брака (0..2) у человека с несколькими супругами — для цвета линии
}

/** Точка на середине линии брака, из которой идёт линия к детям (только для многобрачных). */
export interface UnionDot { x: number; y: number; union: number }

export interface SpouseLink {
  a: string;
  b: string;
  status: Status;
  d: string;
  dashed: boolean;
  union?: number;
}

export interface Rect { x: number; y: number; w: number; h: number }

export interface SideBand {
  side: 'father' | 'mother';
  label: string;
  labelX: number;
  labelY: number;
  rects: Rect[]; // по прямоугольнику на ряд: подложка «ступеньками», не заходит на центральные карточки
}

export interface Layout {
  nodes: Map<string, Node>;
  width: number;
  height: number;
  lines: Polyline[];
  spouseLinks: SpouseLink[];
  unionDots: UnionDot[];
  order: string[]; // порядок обхода (сверху вниз, слева направо) — для Tab
  sides: SideBand[];
}

interface Cluster {
  index: number;
  members: string[];
  gen: number;
  x: number; // левый край
  order: number;
}

interface Group {
  parents: string[];
  children: string[];
  statusByChild: Map<string, Status>;
}

const WEAK: Status[] = ['hypothesis', 'unresolved'];
export const isWeak = (s: Status | undefined): boolean => !!s && WEAK.includes(s);

const clusterWidth = (n: number): number => n * CARD_W + (n - 1) * SPOUSE_GAP;

export function computeLayout(persons: Person[], relations: Relation[], rootId: string): Layout {
  const ids = persons.map((p) => p.id);
  const byId = new Map(persons.map((p) => [p.id, p]));

  const parentsOf = new Map<string, string[]>();
  const childrenOf = new Map<string, string[]>();
  const spouseAdj = new Map<string, Set<string>>();
  const spouseStatus = new Map<string, Status>();
  const parentStatus = new Map<string, Status>(); // parent|child
  for (const id of ids) {
    parentsOf.set(id, []);
    childrenOf.set(id, []);
    spouseAdj.set(id, new Set());
  }
  for (const r of relations) {
    if (r.type === 'parent') {
      parentsOf.get(r.child)?.push(r.parent);
      childrenOf.get(r.parent)?.push(r.child);
      parentStatus.set(`${r.parent}|${r.child}`, r.status);
    } else {
      spouseAdj.get(r.a)?.add(r.b);
      spouseAdj.get(r.b)?.add(r.a);
      spouseStatus.set([r.a, r.b].sort().join('|'), r.status);
    }
  }
  for (const ps of parentsOf.values()) ps.sort((a, b) => sexRank(byId.get(a)) - sexRank(byId.get(b)) || a.localeCompare(b));

  // ---------- 1. кластеры ----------
  const clusterOf = new Map<string, Cluster>();
  const clusters: Cluster[] = [];
  for (const id of ids) {
    if (clusterOf.has(id)) continue;
    const comp: string[] = [];
    const stack = [id];
    const seen = new Set([id]);
    while (stack.length) {
      const cur = stack.pop()!;
      comp.push(cur);
      for (const n of spouseAdj.get(cur) ?? []) if (!seen.has(n)) { seen.add(n); stack.push(n); }
    }
    const c: Cluster = { index: clusters.length, members: orderComponent(comp, spouseAdj, byId), gen: 0, x: 0, order: 0 };
    clusters.push(c);
    for (const m of c.members) clusterOf.set(m, c);
  }

  // ---------- 2. поколения ----------
  for (let iter = 0; iter <= clusters.length + 1; iter++) {
    let changed = false;
    for (const c of clusters) {
      for (const m of c.members) {
        for (const p of parentsOf.get(m) ?? []) {
          const pc = clusterOf.get(p)!;
          if (pc !== c && c.gen < pc.gen + 1) { c.gen = pc.gen + 1; changed = true; }
        }
      }
    }
    if (!changed) break;
  }
  // родословные «корни» без известных родителей опускаем к своим детям (меньше длинных линий)
  for (const c of clusters) {
    const hasParents = c.members.some((m) => (parentsOf.get(m) ?? []).length > 0);
    if (hasParents) continue;
    let min = Infinity;
    for (const m of c.members) for (const ch of childrenOf.get(m) ?? []) { const cc = clusterOf.get(ch)!; if (cc !== c) min = Math.min(min, cc.gen); }
    if (min !== Infinity) c.gen = min - 1;
  }
  const minGen = Math.min(...clusters.map((c) => c.gen));
  for (const c of clusters) c.gen -= minGen;
  const maxGen = Math.max(...clusters.map((c) => c.gen));

  // ---------- 3. начальный порядок: обход от корня ----------
  const visited = new Set<Cluster>();
  let counter = 0;
  const bfs = (start: Cluster): void => {
    const queue = [start];
    visited.add(start);
    while (queue.length) {
      const c = queue.shift()!;
      c.order = counter++;
      const next: Cluster[] = [];
      for (const m of c.members) {
        for (const p of parentsOf.get(m) ?? []) next.push(clusterOf.get(p)!);
        for (const ch of childrenOf.get(m) ?? []) next.push(clusterOf.get(ch)!);
      }
      for (const n of next) if (!visited.has(n)) { visited.add(n); queue.push(n); }
    }
  };
  const rootCluster = clusterOf.get(rootId) ?? clusters[0]!;
  bfs(rootCluster);
  for (const c of clusters) if (!visited.has(c)) bfs(c);

  // ---------- 3a. «сторона» (ключ) по родословной корня ----------
  // Как в анентафеле: корень занимает [0,1], отец — левую половину интервала, мать — правую.
  // Так линия отца всегда левее линии матери и ветви не перемешиваются.
  // Не-предки (братья, сёстры, их дети, супруги) получают ключ ближайшего родственника.
  const sideKey = computeSideKeys(rootId, ids, parentsOf, childrenOf, spouseAdj, byId);
  const clusterKey = new Map<Cluster, number>();
  for (const c of clusters) clusterKey.set(c, c.members.reduce((s, m) => s + sideKey.get(m)!, 0) / c.members.length);

  const rows: Cluster[][] = Array.from({ length: maxGen + 1 }, () => []);
  for (const c of clusters) rows[c.gen]!.push(c);
  for (const r of rows) r.sort((a, b) => clusterKey.get(a)! - clusterKey.get(b)! || a.order - b.order);

  // группы родители -> дети
  const groupMap = new Map<string, Group>();
  for (const p of persons) {
    const ps = parentsOf.get(p.id) ?? [];
    if (!ps.length) continue;
    const key = ps.join('|');
    let g = groupMap.get(key);
    if (!g) { g = { parents: ps, children: [], statusByChild: new Map() }; groupMap.set(key, g); }
    g.children.push(p.id);
    g.statusByChild.set(p.id, weakest(ps.map((pp) => parentStatus.get(`${pp}|${p.id}`))));
  }
  const groups = [...groupMap.values()];
  const groupOfChild = new Map<string, Group>();
  for (const g of groups) for (const ch of g.children) groupOfChild.set(ch, g);
  const groupsOfParent = new Map<string, Group[]>();
  for (const g of groups) for (const p of g.parents) (groupsOfParent.get(p) ?? groupsOfParent.set(p, []).get(p)!).push(g);

  // начальные x
  for (const r of rows) {
    let x = 0;
    for (const c of r) { c.x = x; x += clusterWidth(c.members.length) + CLUSTER_GAP; }
  }

  const personCenter = (id: string): number => {
    const c = clusterOf.get(id)!;
    return c.x + c.members.indexOf(id) * (CARD_W + SPOUSE_GAP) + CARD_W / 2;
  };
  const anchorOf = (g: Group): number => {
    if (g.parents.length === 2) {
      const [a, b] = g.parents as [string, string];
      const ca = clusterOf.get(a)!;
      if (ca === clusterOf.get(b)) {
        const ia = ca.members.indexOf(a);
        const ib = ca.members.indexOf(b);
        if (Math.abs(ia - ib) === 1 || spouseAdj.get(a)?.has(b)) return (personCenter(a) + personCenter(b)) / 2;
      }
    }
    return g.parents.reduce((s, p) => s + personCenter(p), 0) / g.parents.length;
  };

  const placeRow = (row: Cluster[], dir: 'down' | 'up', sort: boolean): void => {
    const targets = row.map((c) => {
      let sum = 0;
      let n = 0;
      for (const m of c.members) {
        if (dir === 'down') {
          const g = groupOfChild.get(m);
          if (g) { sum += anchorOf(g) - personCenter(m); n++; }
        } else {
          for (const g of groupsOfParent.get(m) ?? []) {
            const mean = g.children.reduce((s, ch) => s + personCenter(ch), 0) / g.children.length;
            sum += mean - anchorOf(g);
            n++;
          }
        }
      }
      const w = clusterWidth(c.members.length);
      return n ? { has: true, center: c.x + w / 2 + sum / n } : { has: false, center: c.x + w / 2 };
    });
    let items = row.map((c, i) => ({ c, t: targets[i]! }));
    // порядок: сначала сторона родословной (не меняется), внутри равных ключей — барицентр
    if (sort) items = items.map((it, i) => ({ ...it, i })).sort((a, b) => clusterKey.get(a.c)! - clusterKey.get(b.c)! || a.t.center - b.t.center || a.i - b.i);
    const order = items.map((it) => it.c);
    row.splice(0, row.length, ...order);
    // PAV
    const widths = order.map((c) => clusterWidth(c.members.length));
    const off: number[] = [0];
    for (let i = 1; i < order.length; i++) off[i] = off[i - 1]! + (widths[i - 1]! + widths[i]!) / 2 + CLUSTER_GAP;
    const blocks: { sum: number; w: number; start: number; n: number }[] = [];
    items.forEach((it, i) => {
      const wt = it.t.has ? 1 : 0.15;
      blocks.push({ sum: (it.t.center - off[i]!) * wt, w: wt, start: i, n: 1 });
      while (blocks.length > 1) {
        const b = blocks[blocks.length - 1]!;
        const a = blocks[blocks.length - 2]!;
        if (a.sum / a.w <= b.sum / b.w) break;
        blocks.splice(blocks.length - 2, 2, { sum: a.sum + b.sum, w: a.w + b.w, start: a.start, n: a.n + b.n });
      }
    });
    for (const b of blocks) {
      const base = b.sum / b.w;
      for (let i = b.start; i < b.start + b.n; i++) order[i]!.x = base + off[i]! - widths[i]! / 2;
    }
  };

  const ITER = 40;
  const SORT_ITER = 8;
  for (let it = 0; it < ITER; it++) {
    const sort = it < SORT_ITER;
    for (let g = 1; g <= maxGen; g++) placeRow(rows[g]!, 'down', sort);
    for (let g = maxGen - 1; g >= 0; g--) placeRow(rows[g]!, 'up', sort);
  }
  for (let g = 1; g <= maxGen; g++) placeRow(rows[g]!, 'down', false);

  // ---------- 3b. явное разделение сторон ----------
  // Линию отца сдвигаем влево, линию матери вправо, чтобы между ними был коридор SIDE_GAP.
  // Корень, его братья/сёстры и пара родителей (ключ ровно 0.5) остаются в середине.
  const EPS = 1e-9;
  const sideOf = (c: Cluster): 'father' | 'mother' | null => {
    const k = clusterKey.get(c)!;
    if (k > 1.5) return null; // не связаны с корнем
    return k < 0.5 - EPS ? 'father' : k > 0.5 + EPS ? 'mother' : null;
  };
  {
    let maxRightF = -Infinity;
    let minLeftM = Infinity;
    for (const c of clusters) {
      const sd = sideOf(c);
      if (sd === 'father') maxRightF = Math.max(maxRightF, c.x + clusterWidth(c.members.length));
      if (sd === 'mother') minLeftM = Math.min(minLeftM, c.x);
    }
    if (maxRightF > -Infinity && minLeftM < Infinity) {
      const need = SIDE_GAP - (minLeftM - maxRightF);
      if (need > 0) {
        for (const c of clusters) {
          const sd = sideOf(c);
          if (sd === 'father') c.x -= need / 2;
          // несвязанные с корнем (ключ 2) стоят правее линии матери — сдвигаем вместе с ней
          if (sd === 'mother' || clusterKey.get(c)! > 1.5) c.x += need / 2;
        }
      }
    }
  }

  // нормализация по x
  let minX = Infinity;
  for (const c of clusters) minX = Math.min(minX, c.x);
  for (const c of clusters) c.x += MARGIN - minX;

  // ---------- 4. дорожки шин и y ----------
  const groupInfo = groups.map((g) => {
    const childGens = g.children.map((ch) => clusterOf.get(ch)!.gen);
    const gapIndex = Math.min(...childGens) - 1; // зазор между строкой gapIndex и gapIndex+1
    const xs = [...g.parents.map(personCenter), ...g.children.map(personCenter), anchorOf(g)];
    return { g, gapIndex: Math.max(gapIndex, 0), min: Math.min(...xs), max: Math.max(...xs), lane: 0 };
  });
  const lanesPerGap: number[] = Array.from({ length: maxGen + 1 }, () => 1);
  for (let gap = 0; gap <= maxGen; gap++) {
    const inGap = groupInfo.filter((gi) => gi.gapIndex === gap).sort((a, b) => a.min - b.min || a.max - b.max);
    const laneEnds: number[] = [];
    for (const gi of inGap) {
      let lane = laneEnds.findIndex((end) => end + 10 < gi.min);
      if (lane < 0) { lane = laneEnds.length; laneEnds.push(0); }
      laneEnds[lane] = gi.max;
      gi.lane = lane;
    }
    lanesPerGap[gap] = Math.max(1, laneEnds.length);
  }
  const rowY: number[] = [];
  let y = MARGIN + BAND_LABEL;
  for (let g = 0; g <= maxGen; g++) {
    rowY[g] = y;
    y += CARD_H + ROW_GAP_BASE + (lanesPerGap[g]! - 1) * LANE_STEP;
  }
  const height = y - ROW_GAP_BASE - (lanesPerGap[maxGen]! - 1) * LANE_STEP + MARGIN;

  const nodes = new Map<string, Node>();
  const order: string[] = [];
  let width = 0;
  for (let g = 0; g <= maxGen; g++) {
    for (const c of rows[g]!) {
      c.members.forEach((m, i) => {
        const x = c.x + i * (CARD_W + SPOUSE_GAP);
        nodes.set(m, { id: m, x, y: rowY[g]!, gen: g, cluster: c.index });
        order.push(m);
        width = Math.max(width, x + CARD_W);
      });
    }
  }
  width += MARGIN;

  const cx = (id: string): number => nodes.get(id)!.x + CARD_W / 2;
  const top = (id: string): number => nodes.get(id)!.y;
  const bottom = (id: string): number => nodes.get(id)!.y + CARD_H;

  const isAdjacent = (a: string, b: string): boolean => {
    const na = nodes.get(a)!;
    const nb = nodes.get(b)!;
    return na.y === nb.y && Math.abs(Math.abs(na.x - nb.x) - (CARD_W + SPOUSE_GAP)) < 1;
  };
  /** Линия брака неподряд стоящих супругов идёт под карточками; глубже — для более дальних пар. */
  const arcY = (a: string, b: string): number => {
    const span = Math.max(2, Math.round(Math.abs(nodes.get(a)!.x - nodes.get(b)!.x) / (CARD_W + SPOUSE_GAP)));
    return Math.max(bottom(a), bottom(b)) + 8 + (span - 2) * 8;
  };

  // номер брака (цвет) у человека с несколькими супругами: у «звезды» (центр + только его супруги) —
  // порядковый номер супруга в ряду, иначе позиция пары в цепочке
  const unionIndex = (a: string, b: string): number | undefined => {
    const ca = clusterOf.get(a)!;
    if (ca !== clusterOf.get(b)) return undefined;
    const da = spouseAdj.get(a)?.size ?? 0;
    const db = spouseAdj.get(b)?.size ?? 0;
    if (da < 2 && db < 2) return undefined;
    if ((da >= 2) !== (db >= 2)) {
      const [hub, other] = da >= 2 ? [a, b] : [b, a];
      const mates = [...spouseAdj.get(hub)!];
      if (mates.every((m) => (spouseAdj.get(m)?.size ?? 0) < 2)) {
        mates.sort((x, y) => ca.members.indexOf(x) - ca.members.indexOf(y));
        return mates.indexOf(other) % UNION_COLORS;
      }
    }
    return Math.min(ca.members.indexOf(a), ca.members.indexOf(b)) % UNION_COLORS;
  };

  /** x вертикали к ребёнку: ближайший к его центру, где между рядами fromGen..gen-1 нет карточек. */
  const freeDropX = (ch: string, fromGen: number): number => {
    const n = nodes.get(ch)!;
    const want = cx(ch);
    const PAD = 14;
    const obstacles: [number, number][] = [];
    for (const o of nodes.values()) if (o.gen >= fromGen && o.gen < n.gen) obstacles.push([o.x - PAD, o.x + CARD_W + PAD]);
    const blocked = (x: number): boolean => obstacles.some(([a, b]) => x > a && x < b);
    if (!blocked(want)) return want;
    // кандидаты — края препятствий (чуть снаружи)
    const free = obstacles.flatMap(([a, b]) => [a - 1, b + 1]).filter((x) => !blocked(x));
    if (!free.length) return want;
    // не дальше ширины карточки от центра ребёнка, чтобы «уступ» оставался в пределах его карточки
    const inside = free.filter((x) => x > n.x + 8 && x < n.x + CARD_W - 8);
    const pool = inside.length ? inside : free;
    return pool.reduce((best, x) => (Math.abs(x - want) < Math.abs(best - want) ? x : best));
  };

  const lines: Polyline[] = [];
  const unionDots: UnionDot[] = [];
  for (const gi of groupInfo) {
    const { g } = gi;
    const busY = rowY[gi.gapIndex]! + CARD_H + 24 + gi.lane * LANE_STEP;
    const allWeak = g.children.every((ch) => isWeak(g.statusByChild.get(ch)));
    let coupleAnchor: number | null = null;
    let coupleY = 0;
    let union: number | undefined;
    if (g.parents.length === 2) {
      const [a, b] = g.parents as [string, string];
      const na = nodes.get(a)!;
      const nb = nodes.get(b)!;
      if (na.y === nb.y && (isAdjacent(a, b) || spouseAdj.get(a)?.has(b))) {
        coupleAnchor = (cx(a) + cx(b)) / 2;
        union = unionIndex(a, b);
        coupleY = isAdjacent(a, b) ? na.y + CARD_H / 2 : arcY(a, b);
      }
    }
    const xs: number[] = [];
    if (coupleAnchor !== null) {
      lines.push({ d: `M${coupleAnchor} ${coupleY}V${busY}`, dashed: allWeak, union });
      xs.push(coupleAnchor);
    } else {
      for (const p of g.parents) {
        lines.push({ d: `M${cx(p)} ${bottom(p)}V${busY}`, dashed: allWeak });
        xs.push(cx(p));
      }
    }
    // ребёнок в более глубоком ряду, чем сиблинги: вертикаль не должна проходить сквозь чужие карточки
    const dropX = new Map<string, number>();
    for (const ch of g.children) dropX.set(ch, freeDropX(ch, gi.gapIndex + 1));
    for (const ch of g.children) xs.push(dropX.get(ch)!);
    const lo = Math.min(...xs);
    const hi = Math.max(...xs);
    if (hi > lo) lines.push({ d: `M${lo} ${busY}H${hi}`, dashed: allWeak, union });
    for (const ch of g.children) {
      const dx = dropX.get(ch)!;
      const d = dx === cx(ch)
        ? `M${dx} ${busY}V${top(ch)}`
        : `M${dx} ${busY}V${top(ch) - 22}H${cx(ch)}V${top(ch)}`;
      lines.push({ d, dashed: isWeak(g.statusByChild.get(ch)), union });
    }
  }

  const spouseLinks: SpouseLink[] = [];
  const doneSp = new Set<string>();
  for (const [a, adj] of spouseAdj) {
    for (const b of adj) {
      const key = [a, b].sort().join('|');
      if (doneSp.has(key)) continue;
      doneSp.add(key);
      const na = nodes.get(a)!;
      const nb = nodes.get(b)!;
      const [l, r] = na.x <= nb.x ? [na, nb] : [nb, na];
      const status = spouseStatus.get(key) ?? 'unresolved';
      let d: string;
      let dotY: number;
      const union = unionIndex(a, b);
      if (isAdjacent(a, b)) {
        const yy = l.y + CARD_H / 2;
        d = `M${l.x + CARD_W} ${yy}H${r.x}`;
        dotY = yy;
      } else {
        const yy = l.y === r.y ? arcY(a, b) : Math.max(l.y, r.y) + CARD_H + 8;
        d = `M${l.x + CARD_W / 2} ${l.y + CARD_H}V${yy}H${r.x + CARD_W / 2}V${r.y + CARD_H}`;
        dotY = yy;
      }
      spouseLinks.push({ a, b, status, d, dashed: isWeak(status), union });
      // у многобрачных — явная точка брака на каждой линии (от неё идёт шина детей)
      if (union !== undefined) unionDots.push({ x: (l.x + r.x + CARD_W) / 2, y: dotY, union });
    }
  }

  // подложки сторон
  const sides: SideBand[] = [];
  const rootParents = parentsOf.get(rootId) ?? [];
  const sideLabel = (sd: 'father' | 'mother'): string => {
    const p = byId.get(rootParents.find((id) => byId.get(id)?.sex === (sd === 'father' ? 'M' : 'F')) ?? '');
    const who = p ? ` — ${[p.name.surname, p.name.given].filter(Boolean).join(' ')}` : '';
    return (sd === 'father' ? 'Линия отца' : 'Линия матери') + who;
  };
  for (const sd of ['father', 'mother'] as const) {
    const cs = clusters.filter((c) => sideOf(c) === sd);
    if (!cs.length) continue;
    const span = new Map<number, [number, number]>();
    for (const c of cs) {
      const [lo, hi] = span.get(c.gen) ?? [Infinity, -Infinity];
      span.set(c.gen, [Math.min(lo, c.x), Math.max(hi, c.x + clusterWidth(c.members.length))]);
    }
    const gens = [...span.keys()].sort((a, b) => a - b);
    const rects: Rect[] = gens.map((g, i) => {
      const [lo, hi] = span.get(g)!;
      const y0 = i === 0 ? rowY[g]! - BAND_LABEL - BAND_PAD + 14 : rowY[g]! - BAND_PAD;
      const next = gens[i + 1];
      const y1 = next === g + 1 ? rowY[next]! - BAND_PAD : rowY[g]! + CARD_H + BAND_PAD;
      return { x: lo - BAND_PAD, y: y0, w: hi - lo + 2 * BAND_PAD, h: y1 - y0 };
    });
    sides.push({ side: sd, label: sideLabel(sd), labelX: rects[0]!.x + 18, labelY: rects[0]!.y + 12, rects });
  }

  return { nodes, width, height, lines, spouseLinks, unionDots, order, sides };
}

function computeSideKeys(
  rootId: string,
  ids: string[],
  parentsOf: Map<string, string[]>,
  childrenOf: Map<string, string[]>,
  spouseAdj: Map<string, Set<string>>,
  byId: Map<string, Person>,
): Map<string, number> {
  const key = new Map<string, number>();
  // предки корня: интервалы
  const interval = new Map<string, [number, number]>();
  if (byId.has(rootId)) {
    interval.set(rootId, [0, 1]);
    const queue = [rootId];
    while (queue.length) {
      const cur = queue.shift()!;
      const [lo, hi] = interval.get(cur)!;
      const ps = parentsOf.get(cur) ?? []; // уже отсортированы: мужчина первым
      if (ps.length === 1) {
        if (!interval.has(ps[0]!)) { interval.set(ps[0]!, [lo, hi]); queue.push(ps[0]!); }
      } else if (ps.length >= 2) {
        const mid = (lo + hi) / 2;
        const parts: [number, number][] = [[lo, mid], [mid, hi]];
        ps.slice(0, 2).forEach((p, i) => { if (!interval.has(p)) { interval.set(p, parts[i]!); queue.push(p); } });
      }
    }
  }
  for (const [id, [lo, hi]] of interval) key.set(id, (lo + hi) / 2);
  // остальные — от ближайших родственников (родители → супруги → дети), пока есть изменения
  const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
  for (let changed = true; changed; ) {
    changed = false;
    for (const id of ids) {
      if (key.has(id)) continue;
      const fromParents = (parentsOf.get(id) ?? []).filter((p) => key.has(p)).map((p) => key.get(p)!);
      const fromSpouses = [...(spouseAdj.get(id) ?? [])].filter((p) => key.has(p)).map((p) => key.get(p)!);
      const fromChildren = (childrenOf.get(id) ?? []).filter((p) => key.has(p)).map((p) => key.get(p)!);
      const src = fromParents.length ? fromParents : fromSpouses.length ? fromSpouses : fromChildren;
      if (src.length) { key.set(id, mean(src)); changed = true; }
    }
  }
  // не связанные с корнем — справа
  for (const id of ids) if (!key.has(id)) key.set(id, 2);
  return key;
}

function sexRank(p: Person | undefined): number {
  return p?.sex === 'M' ? 0 : p?.sex === 'F' ? 1 : 2;
}

const STRENGTH: Status[] = ['unresolved', 'hypothesis', 'family-report', 'single-source', 'corroborated', 'strongly-corroborated'];
function weakest(list: (Status | undefined)[]): Status {
  let best: Status = 'strongly-corroborated';
  for (const s of list) if (s && STRENGTH.indexOf(s) < STRENGTH.indexOf(best)) best = s;
  return list.every((s) => !s) ? 'unresolved' : best;
}

/** Порядок людей в кластере: пара — муж слева; цепочка — по пути; иначе хаб в середине. */
function orderComponent(comp: string[], adj: Map<string, Set<string>>, byId: Map<string, Person>): string[] {
  if (comp.length === 1) return comp;
  const sorted = [...comp].sort((a, b) => sexRank(byId.get(a)) - sexRank(byId.get(b)) || a.localeCompare(b));
  if (comp.length === 2) return sorted;
  const deg = (id: string) => adj.get(id)!.size;
  const edges = comp.reduce((s, id) => s + deg(id), 0) / 2;
  const maxDeg = Math.max(...comp.map(deg));
  if (edges === comp.length - 1 && maxDeg <= 2) {
    const ends = comp.filter((id) => deg(id) === 1).sort((a, b) => a.localeCompare(b));
    const out = [ends[0]!];
    let prev = '';
    let cur = ends[0]!;
    while (out.length < comp.length) {
      const next = [...adj.get(cur)!].find((n) => n !== prev)!;
      out.push(next);
      prev = cur;
      cur = next;
    }
    return out;
  }
  const hub0 = [...comp].sort((a, b) => deg(b) - deg(a) || a.localeCompare(b))[0]!;
  const star = comp.filter((id) => id !== hub0);
  if (star.every((id) => adj.get(hub0)!.has(id))) {
    // «звезда»: человек с несколькими супругами в середине, супруги по порядку id: меньшая половина слева, остальные справа
    const mates = star.sort((a, b) => a.localeCompare(b));
    const k = Math.floor(mates.length / 2);
    return [...mates.slice(0, k), hub0, ...mates.slice(k)];
  }
  // хаб в середине, остальные слева/справа по очереди
  const hub = [...comp].sort((a, b) => deg(b) - deg(a) || a.localeCompare(b))[0]!;
  const left: string[] = [];
  const right: string[] = [];
  const rest = comp.filter((id) => id !== hub);
  rest.sort((a, b) => (adj.get(hub)!.has(b) ? 1 : 0) - (adj.get(hub)!.has(a) ? 1 : 0) || a.localeCompare(b));
  rest.forEach((id, i) => (i % 2 === 0 ? right : left).push(id));
  return [...left.reverse(), hub, ...right];
}
