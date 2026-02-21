import { App } from 'obsidian';
import { NoteLinks, LinkType } from './types';
import { openNote } from './parser';

// ── Constants ──────────────────────────────────────────────────────────────────

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

// Verlet spring parameters
const BASE_R    = 7;     // base node radius (px, SVG coords)
const MAX_ADD_R = 8;     // max extra radius earned from high degree
const REPULSION = 5500;  // node–node repulsion constant
const SPRING_K  = 0.03;  // edge spring stiffness
const REST_LEN  = 120;   // edge spring rest length (px)
const GRAVITY   = 0.03;  // pull toward origin
const DAMPING   = 0.85;  // velocity damping per tick
const MAX_TICKS = 500;   // animation cap

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

    constructor(
        private readonly app:      App,
        private readonly rootName: string | null,
    ) {}

    /** Attach to `container`, build the graph, and start the animated simulation. */
    mount(container: HTMLElement, graph: Map<string, NoteLinks>) {
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

    // ── Data prep ─────────────────────────────────────────────────────────────

    private buildData(graph: Map<string, NoteLinks>) {
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

        // Centre the SVG origin (where the force graph converges) in the panel
        let panX = 0, panY = 0, zoom = 1;
        let dragging = false, lastX = 0, lastY = 0;

        const applyT = () => {
            this.svg.style.transformOrigin = '0 0';
            this.svg.style.transform =
                `translate(${panX}px, ${panY}px) scale(${zoom})`;
        };

        requestAnimationFrame(() => {
            const rect = wrapper.getBoundingClientRect();
            panX = rect.width  / 2 - SVG_HALF;
            panY = rect.height / 2 - SVG_HALF;
            applyT();
        });

        const onMove = (e: MouseEvent) => {
            if (!dragging) return;
            panX += e.clientX - lastX;
            panY += e.clientY - lastY;
            lastX = e.clientX;
            lastY = e.clientY;
            applyT();
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
            panX = mx - (mx - panX) * factor;
            panY = my - (my - panY) * factor;
            zoom *= factor;
            applyT();
        }, { passive: false });
    }

    // ── DOM: edge lines + node circles + labels ───────────────────────────────

    private createElements() {
        for (const edge of this.edges) {
            const line = document.createElementNS(SVG_NS, 'line') as SVGLineElement;
            // All edges begin fully dimmed; they light up on node hover
            line.setAttribute('stroke',       EDGE_DIM_COLOR);
            line.setAttribute('opacity',      EDGE_DIM_OPACITY);
            line.setAttribute('stroke-width', '1.2');
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
                    edge.el.setAttribute('stroke-width', '2');
                    edge.el.setAttribute('marker-end',   `url(#fg-arrow-${edge.type})`);
                }
            });

            node.el.addEventListener('mouseleave', () => {
                for (const i of idxs) {
                    const el = this.edges[i].el;
                    if (!el) continue;
                    el.setAttribute('stroke',       EDGE_DIM_COLOR);
                    el.setAttribute('opacity',      EDGE_DIM_OPACITY);
                    el.setAttribute('stroke-width', '1.2');
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
