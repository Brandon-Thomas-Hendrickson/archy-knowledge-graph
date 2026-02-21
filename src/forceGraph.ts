import { App } from 'obsidian';
import { NoteLinks, LinkType } from './types';
import { openNote } from './parser';

// ── Constants (fallback defaults) ──────────────────────────────────────────────

const SVG_NS   = 'http://www.w3.org/2000/svg';
const SVG_HALF = 2000;   // half of the SVG coordinate extent from centre

/** Colour for each link type (matches inline-chip CSS colours). */
const FG_COLORS: Record<string, string> = {
    leadsto:    '#4baf7e',
    dependson:  '#5c8fd6',
    informedby: '#e6a117',
};

const EDGE_DIM_COLOR   = '#555';
const EDGE_DIM_OPACITY = '0.18';

const MAX_TICKS = 500;

// ── Public config / state types ────────────────────────────────────────────────

/** Configurable rendering and physics parameters. */
export interface FGConfig {
    edgeWidth?:   number;   // edge stroke width (default 1.2)
    nodeBaseR?:   number;   // base node radius (default 7)
    nodeMaxAddR?: number;   // max extra radius from high degree (default 8)
    repulsion?:   number;   // node–node repulsion constant (default 5500)
    springK?:     number;   // edge spring stiffness (default 0.03)
    restLen?:     number;   // edge spring rest length px (default 120)
    gravity?:     number;   // pull toward origin (default 0.03)
    damping?:     number;   // velocity damping per tick (default 0.85)
}

export interface FGPanZoom { x: number; y: number; z: number }

// ── Internal types ────────────────────────────────────────────────────────────

interface FNode {
    id:     string;
    x:      number;
    y:      number;
    vx:     number;
    vy:     number;
    r:      number;
    isRoot: boolean;
    el:     SVGGElement | null;
}

interface FEdge {
    source: string;
    target: string;
    type:   LinkType;
    el:     SVGLineElement | null;
}

// ── Renderer ──────────────────────────────────────────────────────────────────

export class ForceGraphRenderer {
    private nodes     = new Map<string, FNode>();
    private edges: FEdge[] = [];
    private nodeList: FNode[] = [];

    private svg!:       SVGSVGElement;
    private edgeLayer!: SVGGElement;
    private nodeLayer!: SVGGElement;
    private rafId: number | null = null;
    private tick = 0;

    // Pan / zoom state (instance fields so they survive across in-place updates
    // and can be read back via getPanZoom())
    private panX = 0;
    private panY = 0;
    private zoom = 1;
    private panFromSaved = false;  // when true, skip the initial centering RAF

    constructor(
        private readonly app:      App,
        private readonly rootName: string | null,
        private readonly cfg: FGConfig = {},
    ) {}

    /** Attach to `container`, build the graph, and start the animated simulation.
     *  Pass `savedPan` to restore a previous pan/zoom instead of re-centering. */
    mount(container: HTMLElement, graph: Map<string, NoteLinks>, savedPan?: FGPanZoom) {
        if (savedPan) {
            this.panX = savedPan.x;
            this.panY = savedPan.y;
            this.zoom = savedPan.z;
            this.panFromSaved = true;
        }
        this.buildData(graph);
        const wrapper = this.createWrapper(container);
        this.createSVG(wrapper);
        this.createElements();
        this.setupHover();
        this.startRAF();
    }

    /** Cancel any running animation frame (call before unmounting). */
    stop() {
        if (this.rafId !== null) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
    }

    /** Return the current pan/zoom so the caller can restore it later. */
    getPanZoom(): FGPanZoom {
        return { x: this.panX, y: this.panY, z: this.zoom };
    }

    // ── Data prep ─────────────────────────────────────────────────────────────

    private buildData(graph: Map<string, NoteLinks>) {
        const BASE_R    = this.cfg.nodeBaseR    ?? 7;
        const MAX_ADD_R = this.cfg.nodeMaxAddR  ?? 8;

        // Count total connections (in + out) per note for node sizing
        const degree = new Map<string, number>();
        for (const [name] of graph) degree.set(name, 0);
        for (const [name, links] of graph) {
            const targets = [
                ...links.leadsto,
                ...links.dependson,
                ...links.informedby,
            ].filter(t => graph.has(t));
            degree.set(name, (degree.get(name) ?? 0) + targets.length);
            for (const t of targets) degree.set(t, (degree.get(t) ?? 0) + 1);
        }

        // Place nodes evenly on a circle for a symmetric initial repulsion
        const names  = [...graph.keys()];
        const spread = Math.max(300, names.length * 14);
        names.forEach((name, i) => {
            const angle = (i / names.length) * Math.PI * 2;
            const d     = degree.get(name) ?? 0;
            this.nodes.set(name, {
                id:     name,
                x:      Math.cos(angle) * spread + (Math.random() - 0.5) * 30,
                y:      Math.sin(angle) * spread + (Math.random() - 0.5) * 30,
                vx:     0,
                vy:     0,
                r:      BASE_R + Math.min(d * 1.0, MAX_ADD_R),
                isRoot: name === this.rootName,
                el:     null,
            });
        });

        // Build directed edges from explicit (non-inferred) links only
        for (const [name, links] of graph) {
            const add = (target: string, type: LinkType) => {
                if (this.nodes.has(target)) {
                    this.edges.push({ source: name, target, type, el: null });
                }
            };
            links.leadsto.forEach(t    => add(t, 'leadsto'));
            links.dependson.forEach(t  => add(t, 'dependson'));
            links.informedby.forEach(t => add(t, 'informedby'));
        }

        this.nodeList = [...this.nodes.values()];
    }

    // ── DOM: wrapper ──────────────────────────────────────────────────────────

    private createWrapper(container: HTMLElement): HTMLElement {
        const wrapper = document.createElement('div');
        wrapper.className = 'archy-mm-wrapper';
        container.appendChild(wrapper);
        return wrapper;
    }

    // ── DOM: SVG canvas + arrowhead markers + pan-zoom ────────────────────────

    private createSVG(wrapper: HTMLElement) {
        this.svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
        this.svg.classList.add('archy-mindmap-svg');
        this.svg.setAttribute('width',   String(SVG_HALF * 2));
        this.svg.setAttribute('height',  String(SVG_HALF * 2));
        this.svg.setAttribute('viewBox',
            `${-SVG_HALF} ${-SVG_HALF} ${SVG_HALF * 2} ${SVG_HALF * 2}`);
        wrapper.appendChild(this.svg);

        // One coloured arrowhead per link type, plus a dim one for the default state
        const defs = document.createElementNS(SVG_NS, 'defs') as SVGDefsElement;
        this.svg.appendChild(defs);

        const addMarker = (id: string, color: string) => {
            const m = document.createElementNS(SVG_NS, 'marker') as SVGMarkerElement;
            m.id = id;
            m.setAttribute('markerWidth',  '8');
            m.setAttribute('markerHeight', '6');
            m.setAttribute('refX',         '7');
            m.setAttribute('refY',         '3');
            m.setAttribute('orient',       'auto');
            const p = document.createElementNS(SVG_NS, 'polygon') as SVGPolygonElement;
            p.setAttribute('points', '0 0, 8 3, 0 6');
            p.setAttribute('fill', color);
            m.appendChild(p);
            defs.appendChild(m);
        };
        for (const [type, color] of Object.entries(FG_COLORS)) {
            addMarker(`fg-arrow-${type}`, color);
        }
        addMarker('fg-arrow-dim', EDGE_DIM_COLOR);

        this.edgeLayer = document.createElementNS(SVG_NS, 'g') as SVGGElement;
        this.svg.appendChild(this.edgeLayer);
        this.nodeLayer = document.createElementNS(SVG_NS, 'g') as SVGGElement;
        this.svg.appendChild(this.nodeLayer);

        // Centre the SVG origin in the panel — unless a saved pan/zoom was given
        if (!this.panFromSaved) {
            requestAnimationFrame(() => {
                const rect = wrapper.getBoundingClientRect();
                this.panX = rect.width  / 2 - SVG_HALF;
                this.panY = rect.height / 2 - SVG_HALF;
                this.applyT();
            });
        } else {
            // Apply immediately so the first paint is correct
            requestAnimationFrame(() => this.applyT());
        }

        // Pan + zoom
        let dragging = false, lastX = 0, lastY = 0;

        const onMove = (e: MouseEvent) => {
            if (!dragging) return;
            this.panX += e.clientX - lastX;
            this.panY += e.clientY - lastY;
            lastX = e.clientX;
            lastY = e.clientY;
            this.applyT();
        };
        const onUp = () => {
            dragging = false;
            wrapper.classList.remove('archy-mm-dragging');
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup',   onUp);
        };

        wrapper.addEventListener('mousedown', (e: MouseEvent) => {
            if (e.button !== 0) return;
            dragging = true;
            lastX = e.clientX;
            lastY = e.clientY;
            wrapper.classList.add('archy-mm-dragging');
            e.preventDefault();
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup',   onUp);
        });

        wrapper.addEventListener('wheel', (e: WheelEvent) => {
            e.preventDefault();
            const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
            const rect   = wrapper.getBoundingClientRect();
            const mx     = e.clientX - rect.left;
            const my     = e.clientY - rect.top;
            this.panX = mx - (mx - this.panX) * factor;
            this.panY = my - (my - this.panY) * factor;
            this.zoom *= factor;
            this.applyT();
        }, { passive: false });
    }

    private applyT() {
        this.svg.style.transformOrigin = '0 0';
        this.svg.style.transform =
            `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
    }

    // ── DOM: edge lines + node circles + labels ───────────────────────────────

    private createElements() {
        const edgeW = this.cfg.edgeWidth ?? 1.2;

        for (const edge of this.edges) {
            const line = document.createElementNS(SVG_NS, 'line') as SVGLineElement;
            // All edges begin fully dimmed; they light up on node hover
            line.setAttribute('stroke',       EDGE_DIM_COLOR);
            line.setAttribute('opacity',      EDGE_DIM_OPACITY);
            line.setAttribute('stroke-width', String(edgeW));
            line.setAttribute('marker-end',   'url(#fg-arrow-dim)');
            this.edgeLayer.appendChild(line);
            edge.el = line;
        }

        for (const node of this.nodeList) {
            const g = document.createElementNS(SVG_NS, 'g') as SVGGElement;
            g.classList.add('archy-mm-node');

            const circle = document.createElementNS(SVG_NS, 'circle') as SVGCircleElement;
            circle.setAttribute('cx', '0');
            circle.setAttribute('cy', '0');
            circle.setAttribute('r',  String(node.r));
            circle.setAttribute('class',
                node.isRoot
                    ? 'archy-mm-circle archy-mm-circle-root'
                    : 'archy-fg-circle');
            g.appendChild(circle);

            const label = document.createElementNS(SVG_NS, 'text') as SVGTextElement;
            label.setAttribute('x', '0');
            label.setAttribute('y', String(node.r + 11));
            label.setAttribute('text-anchor', 'middle');
            label.setAttribute('class', 'archy-fg-label');
            label.textContent = node.id;
            g.appendChild(label);

            g.addEventListener('click', () => openNote(node.id, this.app));
            this.nodeLayer.appendChild(g);
            node.el = g;
        }

        this.redraw();
    }

    // ── Hover: reveal edge colours on node mouseenter ─────────────────────────

    private setupHover() {
        const edgeW = this.cfg.edgeWidth ?? 1.2;
        const hoverW = Math.max(edgeW * 1.5, edgeW + 0.8);

        // adjacency list: node id → indices into this.edges
        const adj = new Map<string, number[]>();
        this.edges.forEach((e, i) => {
            if (!adj.has(e.source)) adj.set(e.source, []);
            if (!adj.has(e.target)) adj.set(e.target, []);
            adj.get(e.source)!.push(i);
            adj.get(e.target)!.push(i);
        });

        for (const node of this.nodeList) {
            if (!node.el) continue;
            const idxs = adj.get(node.id) ?? [];

            node.el.addEventListener('mouseenter', () => {
                for (const i of idxs) {
                    const edge = this.edges[i];
                    if (!edge.el) continue;
                    const color = FG_COLORS[edge.type] ?? '#aaa';
                    edge.el.setAttribute('stroke',       color);
                    edge.el.setAttribute('opacity',      '0.85');
                    edge.el.setAttribute('stroke-width', String(hoverW));
                    edge.el.setAttribute('marker-end',   `url(#fg-arrow-${edge.type})`);
                }
            });

            node.el.addEventListener('mouseleave', () => {
                for (const i of idxs) {
                    const el = this.edges[i].el;
                    if (!el) continue;
                    el.setAttribute('stroke',       EDGE_DIM_COLOR);
                    el.setAttribute('opacity',      EDGE_DIM_OPACITY);
                    el.setAttribute('stroke-width', String(edgeW));
                    el.setAttribute('marker-end',   'url(#fg-arrow-dim)');
                }
            });
        }
    }

    // ── Animated Verlet spring simulation ─────────────────────────────────────

    private startRAF() {
        const loop = () => {
            if (this.tick >= MAX_TICKS) { this.rafId = null; return; }
            // Run extra steps early on for faster visual convergence
            const steps = this.tick < 60 ? 5 : this.tick < 200 ? 2 : 1;
            for (let s = 0; s < steps; s++) {
                this.applyForces();
                this.tick++;
            }
            this.redraw();
            this.rafId = requestAnimationFrame(loop);
        };
        this.rafId = requestAnimationFrame(loop);
    }

    /** One physics tick: repulsion + springs + gravity + Euler integration. */
    private applyForces() {
        const REPULSION = this.cfg.repulsion ?? 5500;
        const SPRING_K  = this.cfg.springK   ?? 0.03;
        const REST_LEN  = this.cfg.restLen   ?? 120;
        const GRAVITY   = this.cfg.gravity   ?? 0.03;
        const DAMPING   = this.cfg.damping   ?? 0.85;

        const nodes = this.nodeList;

        // O(n²) node–node repulsion
        for (let i = 0; i < nodes.length - 1; i++) {
            for (let j = i + 1; j < nodes.length; j++) {
                const a  = nodes[i], b = nodes[j];
                const dx = b.x - a.x;
                const dy = b.y - a.y;
                const d2 = dx * dx + dy * dy || 0.01;
                const d  = Math.sqrt(d2);
                const f  = REPULSION / d2;
                const fx = (dx / d) * f;
                const fy = (dy / d) * f;
                a.vx -= fx;  a.vy -= fy;
                b.vx += fx;  b.vy += fy;
            }
        }

        // Edge spring attraction
        for (const edge of this.edges) {
            const s = this.nodes.get(edge.source);
            const t = this.nodes.get(edge.target);
            if (!s || !t) continue;
            const dx = t.x - s.x;
            const dy = t.y - s.y;
            const d  = Math.sqrt(dx * dx + dy * dy) || 1;
            const f  = SPRING_K * (d - REST_LEN);
            const fx = (dx / d) * f;
            const fy = (dy / d) * f;
            s.vx += fx;  s.vy += fy;
            t.vx -= fx;  t.vy -= fy;
        }

        // Gravity toward origin + damping + integration
        for (const n of nodes) {
            n.vx = (n.vx - n.x * GRAVITY) * DAMPING;
            n.vy = (n.vy - n.y * GRAVITY) * DAMPING;
            n.x += n.vx;
            n.y += n.vy;
        }
    }

    // ── Update SVG element positions from current physics state ───────────────

    private redraw() {
        const ARROW_OFFSET = 8;

        for (const edge of this.edges) {
            if (!edge.el) continue;
            const s = this.nodes.get(edge.source);
            const t = this.nodes.get(edge.target);
            if (!s || !t) continue;
            const dx   = t.x - s.x;
            const dy   = t.y - s.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            const x1 = s.x + (dx / dist) * s.r;
            const y1 = s.y + (dy / dist) * s.r;
            const x2 = t.x - (dx / dist) * (t.r + ARROW_OFFSET);
            const y2 = t.y - (dy / dist) * (t.r + ARROW_OFFSET);
            edge.el.setAttribute('x1', x1.toFixed(1));
            edge.el.setAttribute('y1', y1.toFixed(1));
            edge.el.setAttribute('x2', x2.toFixed(1));
            edge.el.setAttribute('y2', y2.toFixed(1));
        }

        for (const node of this.nodeList) {
            if (!node.el) continue;
            node.el.setAttribute(
                'transform',
                `translate(${node.x.toFixed(1)}, ${node.y.toFixed(1)})`,
            );
        }
    }
}
