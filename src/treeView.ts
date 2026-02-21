import { ItemView, WorkspaceLeaf, App } from 'obsidian';
import { NoteLinks, LinkType } from './types';
import { buildFullGraph, openNote } from './parser';
import { ForceGraphRenderer } from './forceGraph';
import type ArchiPlugin from './main';

export const VIEW_TYPE_ARCHY = 'archy-tree';

interface TreeNode {
    name: string;
    linkType: LinkType | 'root' | 'parent';
    depth: number;
    expanded: boolean;
    el?: HTMLElement;
    children?: TreeNode[];
}

// ── SVG mindmap types & constants ─────────────────────────────────────────────

interface MmNode {
    name: string;
    linkType: LinkType | 'root' | 'parent';
    x: number;   // circle centre x (filled during layout)
    y: number;   // circle centre y (filled during layout)
    children: MmNode[];
}

const MM_R      = 14;   // circle radius
const MM_SLOT   = 54;   // horizontal slot width per leaf
const MM_H_GAP  = 20;   // gap between sibling slots
const MM_V_GAP  = 80;   // vertical distance between level centres
const MM_PAD    = 40;   // outer SVG padding
const SVG_NS    = 'http://www.w3.org/2000/svg';

export class ArchiTreeView extends ItemView {
    plugin: ArchiPlugin;
    private graph: Map<string, NoteLinks> = new Map();
    private rootName: string | null = null;
    private treeContainerEl: HTMLElement | null = null;
    private currentMode: 'folio' | 'mindmap' | 'network';
    private forceRenderer: ForceGraphRenderer | null = null;

    // toggle button references
    private folioBtn:   HTMLButtonElement | null = null;
    private mindmapBtn: HTMLButtonElement | null = null;
    private networkBtn: HTMLButtonElement | null = null;

    constructor(leaf: WorkspaceLeaf, plugin: ArchiPlugin) {
        super(leaf);
        this.plugin = plugin;
        // 'vault' was removed; fall back to 'network' if an old setting persists
        const saved = plugin.settings.viewMode as string;
        this.currentMode = (saved === 'vault' ? 'network' : saved) as 'folio' | 'mindmap' | 'network';
    }

    getViewType() { return VIEW_TYPE_ARCHY; }
    getDisplayText() { return 'Archy Tree'; }
    getIcon() { return 'git-fork'; }

    async onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('archy-view');

        // ── View-mode toggle bar (the only header element) ───────────────────
        const toggle = contentEl.createDiv({ cls: 'archy-view-toggle' });
        this.folioBtn   = toggle.createEl('button', { cls: 'archy-toggle-btn', text: 'Folio' });
        this.mindmapBtn = toggle.createEl('button', { cls: 'archy-toggle-btn', text: 'Mindmap' });
        this.networkBtn = toggle.createEl('button', { cls: 'archy-toggle-btn', text: 'Network' });
        this.updateToggleBtns();

        this.folioBtn.addEventListener('click', () => {
            this.currentMode = 'folio';
            this.updateToggleBtns();
            this.refresh();
        });
        this.mindmapBtn.addEventListener('click', () => {
            this.currentMode = 'mindmap';
            this.updateToggleBtns();
            this.refresh();
        });
        this.networkBtn.addEventListener('click', () => {
            this.currentMode = 'network';
            this.updateToggleBtns();
            this.refresh();
        });

        // ── Tree / graph container ───────────────────────────────────────────
        this.treeContainerEl = contentEl.createDiv({ cls: 'archy-tree-container' });

        await this.refresh();
    }

    private updateToggleBtns() {
        this.folioBtn?.classList.toggle(  'active', this.currentMode === 'folio');
        this.mindmapBtn?.classList.toggle('active', this.currentMode === 'mindmap');
        this.networkBtn?.classList.toggle('active', this.currentMode === 'network');
    }

    async refresh() {
        if (!this.treeContainerEl) return;

        // Stop any running force-graph animation before rebuilding
        this.forceRenderer?.stop();
        this.forceRenderer = null;

        this.treeContainerEl.empty();
        this.treeContainerEl.style.fontSize = `${this.plugin.settings.folioFontSize}px`;

        // ── Network: full-vault force graph ───────────────────────────────────
        if (this.currentMode === 'network') {
            const rawGraph = await buildFullGraph(this.app, false);
            const rootName = this.app.workspace.getActiveFile()?.basename ?? null;
            this.forceRenderer = new ForceGraphRenderer(this.app, rootName);
            this.forceRenderer.mount(this.treeContainerEl, rawGraph);
            return;
        }

        // ── Folio / Mindmap: active-note tree ─────────────────────────────────
        this.graph = await buildFullGraph(this.app);

        const activeFile = this.app.workspace.getActiveFile();
        this.rootName = activeFile ? activeFile.basename : null;

        if (!this.rootName) {
            this.treeContainerEl.createEl('p', {
                cls: 'archy-empty',
                text: 'Open a note to see its knowledge tree.',
            });
            return;
        }

        // Build inverted informedby index: for each note B, which notes A have informedby@B
        const informedbyOf = new Map<string, string[]>();
        for (const [noteName, links] of this.graph) {
            for (const ib of links.informedby) {
                if (!informedbyOf.has(ib)) informedbyOf.set(ib, []);
                informedbyOf.get(ib)!.push(noteName);
            }
        }

        const rootNode    = this.buildTreeNode(this.rootName, 'root', 0, new Set());
        const parentNodes = this.buildParentNodes(this.rootName, this.plugin.settings.parentDepth, new Set([this.rootName]), informedbyOf);

        if (this.currentMode === 'mindmap') {
            this.renderMindmap(this.treeContainerEl, rootNode, parentNodes);
        } else {
            this.renderFolio(this.treeContainerEl, rootNode, parentNodes);
        }
    }

    // ── Folio render ──────────────────────────────────────────────────────────

    private renderFolio(container: HTMLElement, rootNode: TreeNode, parentNodes: TreeNode[]) {
        // Render parent ancestors above the root
        if (parentNodes.length > 0) {
            const parentSection = container.createDiv({ cls: 'archy-parent-section' });
            for (const p of parentNodes) {
                this.renderParentNode(parentSection, p, 0);
            }
            container.createEl('hr', { cls: 'archy-parent-divider' });
        }

        // Render current note root + children (existing behaviour)
        this.renderNode(container, rootNode);
    }

    // ── Downward tree builder ─────────────────────────────────────────────────

    private buildTreeNode(
        name: string,
        linkType: LinkType | 'root',
        depth: number,
        visited: Set<string>
    ): TreeNode {
        const node: TreeNode = { name, linkType, depth, expanded: true };

        const maxDepth = this.plugin.settings.maxDepth;
        if (depth >= maxDepth || visited.has(name)) {
            node.children = [];
            return node;
        }

        const seen = new Set(visited);
        seen.add(name);

        const links = this.graph.get(name);
        if (!links) {
            node.children = [];
            return node;
        }

        // dependson = parents, shown above root — never listed as children
        node.children = [
            ...links.leadsto.map(n => this.buildTreeNode(n, 'leadsto', depth + 1, seen)),
            ...links.informedby.map(n => this.buildTreeNode(n, 'informedby', depth + 1, seen)),
        ];

        return node;
    }

    // ── Upward parent builder ─────────────────────────────────────────────────

    /**
     * Build ancestor nodes above the current root.
     * Includes two kinds of parents:
     *   - Hierarchical parents: notes in note.dependson (via bidirectional inference)
     *   - Context parents: notes that have informedby@note (inverted informedby index)
     */
    private buildParentNodes(
        name: string,
        depth: number,
        visited: Set<string>,
        informedbyOf: Map<string, string[]>
    ): TreeNode[] {
        if (depth <= 0) return [];
        const links = this.graph.get(name);

        const hierarchicalParents = links?.dependson ?? [];
        const contextParents      = informedbyOf.get(name) ?? [];

        if (hierarchicalParents.length === 0 && contextParents.length === 0) return [];

        const parents: TreeNode[] = [];

        for (const parentName of hierarchicalParents) {
            if (visited.has(parentName)) continue;
            const seen = new Set(visited);
            seen.add(parentName);
            parents.push({
                name: parentName,
                linkType: 'parent',
                depth: 0,
                expanded: true,
                children: this.buildParentNodes(parentName, depth - 1, seen, informedbyOf),
            });
        }

        for (const contextName of contextParents) {
            if (visited.has(contextName)) continue;
            const seen = new Set(visited);
            seen.add(contextName);
            parents.push({
                name: contextName,
                linkType: 'informedby',   // use ◎ amber — this note informed the current note
                depth: 0,
                expanded: true,
                children: this.buildParentNodes(contextName, depth - 1, seen, informedbyOf),
            });
        }

        return parents;
    }

    // ── Folio node rendering ──────────────────────────────────────────────────

    private renderNode(parent: HTMLElement, node: TreeNode) {
        const wrapper = parent.createDiv({ cls: 'archy-node-wrapper' });
        const row = wrapper.createDiv({ cls: 'archy-node-row' });

        // Indentation
        if (node.depth > 0) {
            const indent = row.createDiv({ cls: 'archy-indent' });
            indent.style.width = `${(node.depth - 1) * 18}px`;
        }

        // Toggle button
        const hasChildren = node.children && node.children.length > 0;
        const toggle = row.createSpan({ cls: 'archy-toggle' });
        if (hasChildren) {
            toggle.setText(node.expanded ? '▾' : '▸');
        } else {
            toggle.setText('·');
            toggle.style.opacity = '0.3';
        }

        // Link type icon
        if (node.linkType !== 'root') {
            const icons: Record<string, string> = {
                leadsto:   '→',
                dependson: '↑',
                informedby:'◎',
                parent:    '↑',
            };
            row.createSpan({
                cls: `archy-icon archy-link-${node.linkType === 'parent' ? 'dependson' : node.linkType}`,
                text: icons[node.linkType] ?? '',
            });
        }

        // Note name (clickable)
        const nameEl = row.createSpan({
            cls: node.linkType === 'root' ? 'archy-node-name archy-root-name' : 'archy-node-name',
            text: node.name,
        });
        nameEl.title = `Open: ${node.name}`;
        nameEl.addEventListener('click', () => openNote(node.name, this.app));

        // Children container
        const childContainer = wrapper.createDiv({ cls: 'archy-children' });
        if (!node.expanded) childContainer.addClass('archy-hidden');

        if (hasChildren) {
            toggle.style.cursor = 'pointer';
            toggle.addEventListener('click', () => {
                node.expanded = !node.expanded;
                toggle.setText(node.expanded ? '▾' : '▸');
                childContainer.toggleClass('archy-hidden', !node.expanded);
            });

            for (const child of node.children!) {
                this.renderNode(childContainer, child);
            }
        }
    }

    /**
     * Render a parent/ancestor node (displayed above the root divider).
     * parentLevel=0 means direct parent, 1 means grandparent, etc.
     * Deeper ancestors are shown at greater indentation (indent = level * 18px).
     */
    private renderParentNode(parent: HTMLElement, node: TreeNode, level: number) {
        const wrapper = parent.createDiv({ cls: 'archy-node-wrapper' });
        const row = wrapper.createDiv({ cls: 'archy-node-row' });

        // Indent deeper ancestors more
        if (level > 0) {
            const indent = row.createDiv({ cls: 'archy-indent' });
            indent.style.width = `${level * 18}px`;
        }

        // Toggle
        const hasChildren = node.children && node.children.length > 0;
        const toggle = row.createSpan({ cls: 'archy-toggle' });
        if (hasChildren) {
            toggle.setText(node.expanded ? '▾' : '▸');
        } else {
            toggle.setText('·');
            toggle.style.opacity = '0.3';
        }

        // Icon: ↑ blue for hierarchical parents, ◎ amber for informedby-context parents
        const parentIcon = node.linkType === 'informedby' ? '◎' : '↑';
        const parentIconCls = node.linkType === 'informedby' ? 'archy-link-informedby' : 'archy-link-dependson';
        row.createSpan({ cls: `archy-icon ${parentIconCls}`, text: parentIcon });

        const nameEl = row.createSpan({ cls: 'archy-node-name', text: node.name });
        nameEl.title = `Open: ${node.name}`;
        nameEl.addEventListener('click', () => openNote(node.name, this.app));

        const childContainer = wrapper.createDiv({ cls: 'archy-children' });
        if (!node.expanded) childContainer.addClass('archy-hidden');

        if (hasChildren) {
            toggle.style.cursor = 'pointer';
            toggle.addEventListener('click', () => {
                node.expanded = !node.expanded;
                toggle.setText(node.expanded ? '▾' : '▸');
                childContainer.toggleClass('archy-hidden', !node.expanded);
            });
            for (const child of node.children!) {
                this.renderParentNode(childContainer, child, level + 1);
            }
        }
    }

    // ── Mindmap SVG renderer ──────────────────────────────────────────────────

    private renderMindmap(container: HTMLElement, rootNode: TreeNode, parentNodes: TreeNode[]) {
        // ── Build MmNode trees ────────────────────────────────────────────────
        const mmRoot     = toMmNode(rootNode);
        const mmParents  = parentNodes.map(p => toMmNode(p));

        // ── Compute required band widths ──────────────────────────────────────
        const childBand   = slotW(mmRoot);
        const parentBand  = mmParents.length > 0
            ? mmParents.reduce((acc, p) => acc + slotW(p), 0) + (mmParents.length - 1) * MM_H_GAP
            : 0;
        const innerW      = Math.max(childBand, parentBand, MM_SLOT);
        const totalWidth  = innerW + MM_PAD * 2;

        // ── Place root ────────────────────────────────────────────────────────
        const rootCX  = totalWidth / 2;
        const rootY   = MM_PAD + (mmParents.length > 0 ? MM_V_GAP : 0);

        mmRoot.x = rootCX;
        mmRoot.y = rootY;

        // ── Layout children downward ──────────────────────────────────────────
        layoutDown(mmRoot.children, rootCX, rootY + MM_V_GAP);

        // ── Layout parents upward ─────────────────────────────────────────────
        if (mmParents.length > 0) {
            let startX = totalWidth / 2 - parentBand / 2;
            for (const mp of mmParents) {
                const sw = slotW(mp);
                mp.x = startX + sw / 2;
                mp.y = rootY - MM_V_GAP;
                // grandparent ancestors above the parent
                layoutUp(mp.children, mp.x, mp.y - MM_V_GAP);
                startX += sw + MM_H_GAP;
            }
        }

        // ── Compute SVG height ────────────────────────────────────────────────
        let maxY = rootY;
        walkMm(mmRoot,    n => { if (n.y > maxY) maxY = n.y; });
        for (const mp of mmParents) walkMm(mp, n => { if (n.y > maxY) maxY = n.y; });
        let minY = rootY;
        walkMm(mmRoot,    n => { if (n.y < minY) minY = n.y; });
        for (const mp of mmParents) walkMm(mp, n => { if (n.y < minY) minY = n.y; });

        const svgHeight = (maxY - minY) + MM_R * 2 + MM_PAD * 2 + 24; // 24 for label text
        const offsetY   = minY - MM_PAD - MM_R;   // shift everything so top = 0

        // ── Create pan/zoom wrapper ───────────────────────────────────────────
        const wrapper = document.createElement('div');
        wrapper.className = 'archy-mm-wrapper';
        container.appendChild(wrapper);

        // ── Create SVG ────────────────────────────────────────────────────────
        const svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
        svg.classList.add('archy-mindmap-svg');
        svg.setAttribute('width',   String(totalWidth));
        svg.setAttribute('height',  String(svgHeight));
        svg.setAttribute('viewBox', `0 ${offsetY} ${totalWidth} ${svgHeight}`);
        wrapper.appendChild(svg);

        // Edges drawn first (behind nodes)
        const edgeLayer = document.createElementNS(SVG_NS, 'g') as SVGGElement;
        svg.appendChild(edgeLayer);
        const nodeLayer = document.createElementNS(SVG_NS, 'g') as SVGGElement;
        svg.appendChild(nodeLayer);

        // Draw parent nodes + edges to root
        for (const mp of mmParents) {
            drawMmSubtree(edgeLayer, nodeLayer, mp, null, this.app);
            drawMmEdge(edgeLayer, mp, mmRoot, 'parent');
        }

        // Draw root + children subtree
        drawMmSubtree(edgeLayer, nodeLayer, mmRoot, null, this.app);

        // ── Pan + zoom ────────────────────────────────────────────────────────
        let panX = 0, panY = 0, zoom = 1;
        let dragging = false, lastX = 0, lastY = 0;

        const applyTransform = () => {
            svg.style.transformOrigin = '0 0';
            svg.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
        };

        const onMouseMove = (e: MouseEvent) => {
            if (!dragging) return;
            panX += e.clientX - lastX;
            panY += e.clientY - lastY;
            lastX = e.clientX;
            lastY = e.clientY;
            applyTransform();
        };

        const onMouseUp = () => {
            dragging = false;
            wrapper.classList.remove('archy-mm-dragging');
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        };

        wrapper.addEventListener('mousedown', (e: MouseEvent) => {
            if (e.button !== 0) return;
            dragging = true;
            lastX = e.clientX;
            lastY = e.clientY;
            wrapper.classList.add('archy-mm-dragging');
            e.preventDefault();
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });

        wrapper.addEventListener('wheel', (e: WheelEvent) => {
            e.preventDefault();
            const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
            const rect   = wrapper.getBoundingClientRect();
            const mx     = e.clientX - rect.left;
            const my     = e.clientY - rect.top;
            // Keep the point under the cursor fixed in content space
            panX = mx - (mx - panX) * factor;
            panY = my - (my - panY) * factor;
            zoom *= factor;
            applyTransform();
        }, { passive: false });
    }

    /** Called by main plugin when metadata changes */
    async onMetadataChange() {
        await this.refresh();
    }

    async onClose() {
        this.forceRenderer?.stop();
        this.forceRenderer = null;
    }
}

// ── Mindmap pure helpers (module-level) ───────────────────────────────────────

function toMmNode(t: TreeNode): MmNode {
    return {
        name: t.name,
        linkType: t.linkType,
        x: 0,
        y: 0,
        children: (t.children ?? []).map(c => toMmNode(c)),
    };
}

/** Total horizontal slot required to lay out this node + all descendants. */
function slotW(node: MmNode): number {
    if (node.children.length === 0) return MM_SLOT;
    const childrenTotal = node.children.reduce((acc, c) => acc + slotW(c), 0)
        + (node.children.length - 1) * MM_H_GAP;
    return Math.max(MM_SLOT, childrenTotal);
}

/** Layout children going downward, centred under parentCX. */
function layoutDown(children: MmNode[], parentCX: number, y: number) {
    if (children.length === 0) return;
    const bandW = children.reduce((acc, c) => acc + slotW(c), 0)
        + (children.length - 1) * MM_H_GAP;
    let x = parentCX - bandW / 2;
    for (const c of children) {
        const sw = slotW(c);
        c.x = x + sw / 2;
        c.y = y;
        layoutDown(c.children, c.x, y + MM_V_GAP);
        x += sw + MM_H_GAP;
    }
}

/** Layout children going upward (for grandparent ancestors), centred under parentCX. */
function layoutUp(children: MmNode[], parentCX: number, y: number) {
    if (children.length === 0) return;
    const bandW = children.reduce((acc, c) => acc + slotW(c), 0)
        + (children.length - 1) * MM_H_GAP;
    let x = parentCX - bandW / 2;
    for (const c of children) {
        const sw = slotW(c);
        c.x = x + sw / 2;
        c.y = y;
        layoutUp(c.children, c.x, y - MM_V_GAP);
        x += sw + MM_H_GAP;
    }
}

function walkMm(node: MmNode, cb: (n: MmNode) => void) {
    cb(node);
    for (const c of node.children) walkMm(c, cb);
}

function drawMmEdge(layer: SVGGElement, from: MmNode, to: MmNode, linkType: LinkType | 'parent' | 'root') {
    const cls = linkType === 'parent' || linkType === 'dependson' ? 'archy-mm-edge-dependson'
              : linkType === 'informedby' ? 'archy-mm-edge-informedby'
              : 'archy-mm-edge-leadsto';

    // Connect edge to the circumference of each circle (top/bottom depending on direction)
    const goingDown = from.y < to.y;
    const x1 = from.x;
    const y1 = goingDown ? from.y + MM_R : from.y - MM_R;
    const x2 = to.x;
    const y2 = goingDown ? to.y - MM_R : to.y + MM_R;
    const midY = (y1 + y2) / 2;

    const path = document.createElementNS(SVG_NS, 'path') as SVGPathElement;
    path.setAttribute('class', `archy-mm-edge ${cls}`);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke-width', '1.5');
    path.setAttribute('d', `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`);
    layer.appendChild(path);
}

function drawMmNodeCircle(layer: SVGGElement, node: MmNode, app: App) {
    const isRoot = node.linkType === 'root';
    const circleCls = isRoot               ? 'archy-mm-circle archy-mm-circle-root'
                    : node.linkType === 'parent'     ? 'archy-mm-circle archy-mm-circle-dependson'
                    : node.linkType === 'informedby' ? 'archy-mm-circle archy-mm-circle-informedby'
                    : 'archy-mm-circle archy-mm-circle-leadsto';

    const g = document.createElementNS(SVG_NS, 'g') as SVGGElement;
    g.setAttribute('class', 'archy-mm-node');
    g.setAttribute('transform', `translate(${node.x}, ${node.y})`);

    const circle = document.createElementNS(SVG_NS, 'circle') as SVGCircleElement;
    circle.setAttribute('cx', '0');
    circle.setAttribute('cy', '0');
    circle.setAttribute('r', String(MM_R));
    circle.setAttribute('class', circleCls);
    g.appendChild(circle);

    // Hover label (shown via CSS on :hover)
    const label = document.createElementNS(SVG_NS, 'text') as SVGTextElement;
    label.setAttribute('x', '0');
    label.setAttribute('y', String(MM_R + 14));
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('class', 'archy-mm-label');
    label.textContent = node.name;
    g.appendChild(label);

    g.addEventListener('click', () => openNote(node.name, app));
    layer.appendChild(g);
}

function drawMmSubtree(
    edgeLayer: SVGGElement,
    nodeLayer: SVGGElement,
    node: MmNode,
    parent: MmNode | null,
    app: App
) {
    if (parent) {
        drawMmEdge(edgeLayer, parent, node, node.linkType);
    }
    drawMmNodeCircle(nodeLayer, node, app);
    for (const child of node.children) {
        drawMmSubtree(edgeLayer, nodeLayer, child, node, app);
    }
}
