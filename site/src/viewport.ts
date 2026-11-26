// Масштаб и панорама полотна: колесо (к курсору), перетаскивание, pinch, анимация.

export interface ViewState {
  scale: number;
  tx: number;
  ty: number;
}

interface Options {
  minScale?: number;
  maxScale?: number;
  onChange?: () => void;
  onInteractStart?: () => void;
}

const DRAG_THRESHOLD = 5;

export class Viewport {
  scale = 1;
  tx = 0;
  ty = 0;
  interacting = false;
  readonly minScale: number;
  readonly maxScale: number;
  private pointers = new Map<number, { x: number; y: number }>();
  private dragStart: { x: number; y: number; tx: number; ty: number } | null = null;
  private dragging = false;
  private pinch: { dist: number; scale: number } | null = null;
  private anim = 0;
  private suppressClickUntil = 0;
  private reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  constructor(readonly el: HTMLElement, readonly world: HTMLElement, private opts: Options = {}) {
    this.minScale = opts.minScale ?? 0.08;
    this.maxScale = opts.maxScale ?? 2.5;
    world.style.transformOrigin = '0 0';
    el.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    el.addEventListener('pointerdown', (e) => this.onDown(e));
    el.addEventListener('pointermove', (e) => this.onMove(e));
    el.addEventListener('pointerup', (e) => this.onUp(e));
    el.addEventListener('pointercancel', (e) => this.onUp(e));
    el.addEventListener('click', (e) => {
      if (performance.now() < this.suppressClickUntil) { e.stopPropagation(); e.preventDefault(); }
    }, true);
  }

  get size(): { w: number; h: number } {
    return { w: this.el.clientWidth, h: this.el.clientHeight };
  }

  private apply(): void {
    this.world.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.scale})`;
    this.opts.onChange?.();
  }

  private clamp(s: number): number {
    return Math.min(this.maxScale, Math.max(this.minScale, s));
  }

  private stopAnim(): void {
    if (this.anim) { cancelAnimationFrame(this.anim); this.anim = 0; }
  }

  /** Зум с фиксированной точкой экрана (координаты относительно viewport). */
  zoomAt(px: number, py: number, factor: number): void {
    this.stopAnim();
    const s = this.clamp(this.scale * factor);
    const k = s / this.scale;
    this.tx = px - (px - this.tx) * k;
    this.ty = py - (py - this.ty) * k;
    this.scale = s;
    this.apply();
  }

  zoomCenter(factor: number): void {
    const { w, h } = this.size;
    this.animateTo(this.stateZoomAt(w / 2, h / 2, factor));
  }

  private stateZoomAt(px: number, py: number, factor: number): ViewState {
    const s = this.clamp(this.scale * factor);
    const k = s / this.scale;
    return { scale: s, tx: px - (px - this.tx) * k, ty: py - (py - this.ty) * k };
  }

  panBy(dx: number, dy: number): void {
    this.stopAnim();
    this.tx += dx;
    this.ty += dy;
    this.apply();
  }

  stateFit(w: number, h: number, pad = 24): ViewState {
    const vp = this.size;
    const s = this.clamp(Math.min((vp.w - pad * 2) / w, (vp.h - pad * 2) / h, 1));
    return { scale: s, tx: (vp.w - w * s) / 2, ty: (vp.h - h * s) / 2 };
  }

  /** Точка мира (wx, wy) окажется в точке экрана (ax, ay); по умолчанию — в центре. */
  stateCenterOn(wx: number, wy: number, scale?: number, ax?: number, ay?: number): ViewState {
    const vp = this.size;
    const s = this.clamp(scale ?? this.scale);
    return { scale: s, tx: (ax ?? vp.w / 2) - wx * s, ty: (ay ?? vp.h / 2) - wy * s };
  }

  set(state: ViewState): void {
    this.stopAnim();
    this.scale = state.scale;
    this.tx = state.tx;
    this.ty = state.ty;
    this.apply();
  }

  animateTo(target: ViewState, ms = 380): void {
    this.stopAnim();
    if (this.reduceMotion.matches || ms <= 0) return this.set(target);
    const from = { scale: this.scale, tx: this.tx, ty: this.ty };
    const t0 = performance.now();
    const step = (now: number): void => {
      const t = Math.min(1, (now - t0) / ms);
      const e = 1 - Math.pow(1 - t, 3);
      // интерполяция масштаба в логарифмической шкале — зум выглядит равномерным
      this.scale = Math.exp(Math.log(from.scale) + (Math.log(target.scale) - Math.log(from.scale)) * e);
      this.tx = from.tx + (target.tx - from.tx) * e;
      this.ty = from.ty + (target.ty - from.ty) * e;
      this.apply();
      this.anim = t < 1 ? requestAnimationFrame(step) : 0;
    };
    this.anim = requestAnimationFrame(step);
  }

  private local(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    this.opts.onInteractStart?.();
    const p = this.local(e);
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const factor = Math.exp(-e.deltaY * unit * (e.ctrlKey ? 0.01 : 0.0016));
    this.zoomAt(p.x, p.y, factor);
  }

  private onDown(e: PointerEvent): void {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    this.stopAnim();
    this.pointers.set(e.pointerId, this.local(e));
    if (this.pointers.size === 1) {
      const p = this.local(e);
      this.dragStart = { x: p.x, y: p.y, tx: this.tx, ty: this.ty };
      this.dragging = false;
    } else if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
      this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, scale: this.scale };
      this.dragStart = null;
      this.beginInteract();
    }
  }

  private beginInteract(): void {
    if (!this.interacting) {
      this.interacting = true;
      this.opts.onInteractStart?.();
    }
    this.el.classList.add('is-panning');
  }

  private onMove(e: PointerEvent): void {
    if (!this.pointers.has(e.pointerId)) return;
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    if (this.pointers.size >= 2 && this.pinch) {
      const [a, b] = [...this.pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const target = this.clamp(this.pinch.scale * (dist / this.pinch.dist));
      const k = target / this.scale;
      this.tx = mid.x - (mid.x - this.tx) * k;
      this.ty = mid.y - (mid.y - this.ty) * k;
      this.scale = target;
      this.apply();
      return;
    }
    if (!this.dragStart) return;
    const dx = p.x - this.dragStart.x;
    const dy = p.y - this.dragStart.y;
    if (!this.dragging && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
      this.dragging = true;
      this.beginInteract();
      try { this.el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    }
    if (this.dragging) {
      this.tx = this.dragStart.tx + dx;
      this.ty = this.dragStart.ty + dy;
      this.apply();
    }
  }

  private onUp(e: PointerEvent): void {
    if (!this.pointers.delete(e.pointerId)) return;
    if (this.dragging || this.pinch) this.suppressClickUntil = performance.now() + 250;
    if (this.pointers.size < 2) this.pinch = null;
    if (this.pointers.size === 0) {
      this.dragging = false;
      this.dragStart = null;
      this.interacting = false;
      this.el.classList.remove('is-panning');
    } else if (this.pointers.size === 1) {
      // после pinch продолжаем панорамирование оставшимся пальцем
      const [id, p] = [...this.pointers.entries()][0]!;
      void id;
      this.dragStart = { x: p.x, y: p.y, tx: this.tx, ty: this.ty };
      this.dragging = true;
    }
  }
}
