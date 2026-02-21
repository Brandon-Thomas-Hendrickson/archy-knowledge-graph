import { ItemView, WorkspaceLeaf, App } from 'obsidian';
import { NoteLinks, LinkType } from './types';
import { buildFullGraph, openNote } from './parser';
import { ForceGraphRenderer, FGConfig, FGPanZoom } from './forceGraph';
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

// ── SVG mindmap types ─────────────────────────────────────────────────────────

interface MmNode {
    name: string;
    linkType: LinkType | 'root' | 'parent';
    x: number;
    y: number;
    children: MmNode[];
}

// Fixed layout constants (not user-configurable)
const MM_H_GAP = 20;
const MM_V_GAP = 80;
const MM_PAD   = 40;
const SVG_NS   = 'http://www.w3.org/2000/svg';

export class ArchiTreeView extends ItemView {
    plugin: ArchiPlugin;
    private graph: Map<string, NoteLinks> = new Map();
    private rootName: string | null = null;
    private treeContainerEl:  HTMLElement | null = null;
    private settingsPanelEl:  HTMLElement | null = null;
    private forceRenderer:    ForceGraphRenderer | null = null;
    private mmWrapperEl:      HTMLElement | null = null;  // live CSS reference

    private currentMode: 'folio' | 'mindmap' | 'network';

    // ── Graph modifier ────────────────────────────────────────────────────────
    private applyInheritance = false;

    // ── Mindmap display settings ───────────────────────────────────────────────
    private mmShowLabels = false;
    private mmR          = 14;    // node radius
    private mmEdgeW      = 1.5;   // edge stroke width

    // Mindmap pan/zoom — persisted across graph rebuilds
    private mmPanX = 0;
    private mmPanY = 0;
    private mmZoom = 1;

    // ── Force-graph display / physics settings ────────────────────────────────
    private fgEdgeW     = 1.2;
    private fgNodeBaseR = 7;
    private fgRepulsion = 5500;
    private fgSpringK   = 0.03;
    private fgRestLen   = 120;
    private fgGravity   = 0.03;

    // Force-graph pan/zoom — saved before rebuild, restored after
    private fgPanSaved: FGPanZoom | null = null;

    // ── Header button refs ────────────────────────────────────────────────────
    private folioBtn:    HTMLButtonElement | null = null;
    private mindmapBtn:  HTMLButtonElement | null = null;
    private networkBtn:  HTMLButtonElement | null = null;
    private settingsBtn: HTMLButtonElement | null = null;

    constructor(leaf: WorkspaceLeaf, plugin: ArchiPlugin) {
        super(leaf);
        this.plugin = plugin;
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

        // ── Header: view-mode buttons + settings gear ─────────────────────────
        const headerWrap = contentEl.createDiv({ cls: 'archy-view-header' });

        const toggle = headerWrap.createDiv({ cls: 'archy-view-toggle' });
        this.folioBtn   = toggle.createEl('button', { cls: 'archy-toggle-btn', text: 'Folio' });
        this.mindmapBtn = toggle.createEl('button', { cls: 'archy-toggle-btn', text: 'MindMap' });
        this.networkBtn = toggle.createEl('button', { cls: 'archy-toggle-btn', text: 'Network' });

        toggle.createSpan({ cls: 'archy-toggle-fill' });   // pushes gear to right

        this.settingsBtn = toggle.createEl('button', {
            cls: 'archy-toggle-btn archy-settings-btn',
            text: '⚙',
        });
        this.settingsBtn.title = 'Display & physics settings';

        this.updateToggleBtns();

        this.folioBtn.addEventListener('click', () => {
            this.currentMode = 'folio';
            this.mmPanX = 0; this.mmPanY = 0; this.mmZoom = 1;
            this.fgPanSaved = null;
            this.updateToggleBtns();
            this.refresh();
        });
        this.mindmapBtn.addEventListener('click', () => {
            this.currentMode = 'mindmap';
            this.mmPanX = 0; this.mmPanY = 0; this.mmZoom = 1;
            this.updateToggleBtns();
            this.refresh();
        });
        this.networkBtn.addEventListener('click', () => {
            this.currentMode = 'network';
            this.fgPanSaved = null;
            this.updateToggleBtns();
            this.refresh();
        });
        this.settingsBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleSettingsPanel();
        });

        // ── Settings dropdown panel ───────────────────────────────────────────
        this.settingsPanelEl = headerWrap.createDiv({ cls: 'archy-settings-panel archy-settings-hidden' });
        this.buildSettingsPanel(this.settingsPanelEl);

        // ── Tree / graph container ────────────────────────────────────────────
        this.treeContainerEl = contentEl.createDiv({ cls: 'archy-tree-container' });

        await this.refresh();
    }

    // ── Settings panel ────────────────────────────────────────────────────────

    private toggleSettingsPanel() {
        if (!this.settingsPanelEl) return;
        const hidden = this.settingsPanelEl.classList.toggle('archy-settings-hidden');
        if (!hidden) {
            // Close when clicking anywhere outside the panel
            const close = (e: MouseEvent) => {
                if (
                    this.settingsPanelEl &&
                    !this.settingsPanelEl.contains(e.target as Node) &&
                    e.target !== this.settingsBtn
                ) {
                    this.settingsPanelEl.classList.add('archy-settings-hidden');
                    document.removeEventListener('click', close, true);
                }
            };
            setTimeout(() => document.addEventListener('click', close, true), 50);
        }
    }

    private buildSettingsPanel(panel: HTMLElement) {
        // ── Graph ─────────────────────────────────────────────────────────────
        this.addSettingsGroup(panel, 'Graph', (grp) => {
            this.addCheckRow(grp, 'Inherit',
                'Collapse connections already implied by a longer path (transitive reduction)',
                () => this.applyInheritance,
                (v) => { this.applyInheritance = v; this.refresh(true); });
        });

        // ── Mindmap ───────────────────────────────────────────────────────────
        this.addSettingsGroup(panel, 'Mindmap', (grp) => {
            this.addCheckRow(grp, 'Labels',
                'Always show node names (default: hover to reveal)',
                () => this.mmShowLabels,
                (v) => { this.mmShowLabels = v; this.applyMmLabels(); });
            this.addSliderRow(grp, 'Node size',  6, 28, 1,   this.mmR,
                (v) => { this.mmR    = v; this.refresh(true); });
            this.addSliderRow(grp, 'Edge width', 0.5, 5, 0.5, this.mmEdgeW,
                (v) => { this.mmEdgeW = v; this.refresh(true); });
        });

        // ── Network ───────────────────────────────────────────────────────────
        this.addSettingsGroup(panel, 'Network', (grp) => {
            this.addSliderRow(grp, 'Node size',   3, 18, 1,      this.fgNodeBaseR,
                (v) => { this.fgNodeBaseR = v; this.refresh(true); });
            this.addSliderRow(grp, 'Edge width',  0.5, 5, 0.5,   this.fgEdgeW,
                (v) => { this.fgEdgeW  = v; this.refresh(true); });
            this.addSliderRow(grp, 'Repulsion',   500, 15000, 500, this.fgRepulsion,
                (v) => { this.fgRepulsion = v; this.refresh(true); });
            this.addSliderRow(grp, 'Spring',      0.005, 0.15, 0.005, this.fgSpringK,
                (v) => { this.fgSpringK = v; this.refresh(true); });
            this.addSliderRow(grp, 'Rest length', 40, 400, 10,   this.fgRestLen,
                (v) => { this.fgRestLen = v; this.refresh(true); });
            this.addSliderRow(grp, 'Gravity',     0.005, 0.1, 0.005, this.fgGravity,
                (v) => { this.fgGravity = v; this.refresh(true); });
        });
    }

    private addSettingsGroup(panel: HTMLElement, title: string, cb: (g: HTMLElement) => void) {
        const grp = panel.createDiv({ cls: 'archy-settings-group' });
        grp.createDiv({ cls: 'archy-settings-group-title', text: title });
        cb(grp);
    }

    private addCheckRow(
        parent: HTMLElement, label: string, hint: string,
        get: () => boolean, set: (v: boolean) => void
    ) {
        const row = parent.createDiv({ cls: 'archy-settings-row archy-settings-check' });
        row.title = hint;
        const cb = row.createEl('input');
        cb.type    = 'checkbox';
        cb.checked = get();
        row.createSpan({ text: label });
        cb.addEventListener('change', () => set(cb.checked));
    }

    private addSliderRow(
        parent: HTMLElement, label: string,
        min: number, max: number, step: number, initValue: number,
        set: (v: number) => void
    ) {
        const row = parent.createDiv({ cls: 'archy-settings-row' });
        row.createSpan({ cls: 'archy-settings-label', text: label });
        const slider = row.createEl('input');
        slider.type  = 'range';
        slider.min   = String(min);
        slider.max   = String(max);
        slider.step  = String(step);
        slider.value = String(initValue);
        const valSpan = row.createSpan({ cls: 'archy-settings-val', text: fmtVal(initValue, step) });
        slider.addEventListener('input', () => {
            const v = parseFloat(slider.value);
            valSpan.textContent = fmtVal(v, step);
            set(v);
        });
    }

    // Apply the Labels toggle live (no full rebuild needed)
    private applyMmLabels() {
        this.mmWrapperEl?.classList.toggle('archy-mm-labels-always', this.mmShowLabels);
    }

    // ── Toggle button state ───────────────────────────────────────────────────

    private updateToggleBtns() {
        this.folioBtn?.classList.toggle(  'active', this.currentMode === 'folio');
        this.mindmapBtn?.classList.toggle('active', this.currentMode === 'mindmap');
        this.networkBtn?.classList.toggle('active', this.currentMode === 'network');
    }

    // ── Refresh ───────────────────────────────────────────────────────────────

    /**
     * Rebuild the view.
     * @param preservePanZoom When true, the current pan/zoom state is saved
     *   before the rebuild and restored afterward, so settings changes do not
     *   reset the user's viewport.  When false (default, e.g. note change),
     *   pan/zoom resets to its default for the current view.
     */
    async refresh(preservePanZoom = false) {
        if (!this.treeContainerEl) return;

        // Save network pan/zoom before stopping the renderer
        if (preservePanZoom && this.forceRenderer) {
            this.fgPanSaved = this.forceRenderer.getPanZoom();
        } else if (!preservePanZoom) {
            // Full reset — clear saved pan/zoom for both views
            this.mmPanX = 0; this.mmPanY = 0; this.mmZoom = 1;
            this.fgPanSaved = null;
        }

        this.forceRenderer?.stop();
        this.forceRenderer = null;

        this.treeContainerEl.empty();
        this.treeContainerEl.style.fontSize = `${this.plugin.settings.folioFontSize}px`;

        // ── Network ───────────────────────────────────────────────────────────
        if (this.currentMode === 'network') {
            const rawGraph = await buildFullGraph(this.app, false, this.applyInheritance);
            const rootName = this.app.workspace.getActiveFile()?.basename ?? null;
            const cfg: FGConfig = {
                edgeWidth:   this.fgEdgeW,
                nodeBaseR:   this.fgNodeBaseR,
                repulsion:   this.fgRepulsion,
                springK:     this.fgSpringK,
                restLen:     this.fgRestLen,
                gravity:     this.fgGravity,
            };
            this.forceRenderer = new ForceGraphRenderer(this.app, rootName, cfg);
            this.forceRenderer.mount(
                this.treeContainerEl,
                rawGraph,
                preservePanZoom ? (this.fgPanSaved ?? undefined) : undefined,
            );
            return;
        }

        // ── Folio / Mindmap ───────────────────────────────────────────────────
        this.graph = await buildFullGraph(this.app, true, this.applyInheritance);

        const activeFile = this.app.workspace.getActiveFile();
        this.rootName = activeFile ? activeFile.basename : null;

        if (!this.rootName) {
            this.treeContainerEl.createEl('p', {
                cls: 'archy-empty',
                text: 'Open a note to see its knowledge tree.',
            });
            return;
        }

        const informedbyOf = new Map<string, string[]>();
        for (const [noteName, links] of this.graph) {
            for (const ib of links.informedby) {
                if (!informedbyOf.has(ib)) informedbyOf.set(ib, []);
                informedbyOf.get(ib)!.push(noteName);
            }
        }

        const rootNode    = this.buildTreeNode(this.rootName, 'root', 0, new Set());
        const parentNodes = this.buildParentNodes(
            this.rootName, this.plugin.settings.parentDepth, new Set([this.rootName]), informedbyOf
        );

        if (this.currentMode === 'mindmap') {
            this.renderMindmap(this.treeContainerEl, rootNode, parentNodes);
        } else {
            this.renderFolio(this.treeContainerEl, rootNode, parentNodes);
        }
    }

    // ── Folio ─────────────────────────────────────────────────────────────────

    private renderFolio(container: HTMLElement, rootNode: TreeNode, parentNodes: TreeNode[]) {
        if (parentNodes.length > 0) {
            const parentSection = container.createDiv({ cls: 'archy-parent-section' });
            for (const p of parentNodes) this.renderParentNode(parentSection, p, 0);
            container.createEl('hr', { cls: 'archy-parent-divider' });
        }
        this.renderNode(container, rootNode);
    }

    // ── Tree builders ─────────────────────────────────────────────────────────

    private buildTreeNode(
        name: string, linkType: LinkType | 'root', depth: number, visited: Set<string>
    ): TreeNode {
        const node: TreeNode = { name, linkType, depth, expanded: true };
        const maxDepth = this.plugin.settings.maxDepth;
        if (depth >= maxDepth || visited.has(name)) { node.children = []; return node; }
        const seen = new Set(visited);
        seen.add(name);
        const links = this.graph.get(name);
        if (!links) { node.children = []; return node; }
        node.children = [
            ...links.leadsto.map(n   => this.buildTreeNode(n, 'leadsto',   depth + 1, seen)),
            ...links.informedby.map(n => this.buildTreeNode(n, 'informedby', depth + 1, seen)),
        ];
        return node;
    }

    private buildParentNodes(
        name: string, depth: number, visited: Set<string>,
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
            const seen = new Set(visited); seen.add(parentName);
            parents.push({ name: parentName, linkType: 'parent', depth: 0, expanded: true,
                children: this.buildParentNodes(parentName, depth - 1, seen, informedbyOf) });
        }
        for (const contextName of contextParents) {
            if (visited.has(contextName)) continue;
            const seen = new Set(visited); seen.add(contextName);
            parents.push({ name: contextName, linkType: 'informedby', depth: 0, expanded: true,
                children: this.buildParentNodes(contextName, depth - 1, seen, informedbyOf) });
        }
        return parents;
    }

    // ── Folio node rendering ──────────────────────────────────────────────────

    private renderNode(parent: HTMLElement, node: TreeNode) {
        const wrapper = parent.createDiv({ cls: 'archy-node-wrapper' });
        const row     = wrapper.createDiv({ cls: 'archy-node-row' });
        if (node.depth > 0) {
            const indent = row.createDiv({ cls: 'archy-indent' });
            indent.style.width = `${(node.depth - 1) * 18}px`;
        }
        const hasChildren = node.children && node.children.length > 0;
        const toggle = row.createSpan({ cls: 'archy-toggle' });
        toggle.setText(hasChildren ? (node.expanded ? '▾' : '▸') : '·');
        if (!hasChildren) toggle.style.opacity = '0.3';

        if (node.linkType !== 'root') {
            const icons: Record<string, string> = {
                leadsto: '→', dependson: '↑', informedby: '◎', parent: '↑',
            };
            row.createSpan({
                cls: `archy-icon archy-link-${node.linkType === 'parent' ? 'dependson' : node.linkType}`,
                text: icons[node.linkType] ?? '',
            });
        }

        const nameEl = row.createSpan({
            cls: node.linkType === 'root' ? 'archy-node-name archy-root-name' : 'archy-node-name',
            text: node.name,
        });
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
            for (const child of node.children!) this.renderNode(childContainer, child);
        }
    }

    private renderParentNode(parent: HTMLElement, node: TreeNode, level: number) {
        const wrapper = parent.createDiv({ cls: 'archy-node-wrapper' });
        const row     = wrapper.createDiv({ cls: 'archy-node-row' });
        if (level > 0) {
            const indent = row.createDiv({ cls: 'archy-indent' });
            indent.style.width = `${level * 18}px`;
        }
        const hasChildren = node.children && node.children.length > 0;
        const toggle = row.createSpan({ cls: 'archy-toggle' });
        toggle.setText(hasChildren ? (node.expanded ? '▾' : '▸') : '·');
        if (!hasChildren) toggle.style.opacity = '0.3';

        const parentIcon    = node.linkType === 'informedby' ? '◎' : '↑';
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
            for (const child of node.children!) this.renderParentNode(childContainer, child, level + 1);
        }
    }

    // ── Mindmap ───────────────────────────────────────────────────────────────

    private renderMindmap(container: HTMLElement, rootNode: TreeNode, parentNodes: TreeNode[]) {
        const r      = this.mmR;
        const edgeW  = this.mmEdgeW;
        const mmSlot = Math.max(54, r * 4);

        const mmRoot    = toMmNode(rootNode);
        const mmParents = parentNodes.map(p => toMmNode(p));

        const childBand  = slotW(mmRoot, mmSlot);
        const parentBand = mmParents.length > 0
            ? mmParents.reduce((acc, p) => acc + slotW(p, mmSlot), 0) + (mmParents.length - 1) * MM_H_GAP
            : 0;
        const innerW     = Math.max(childBand, parentBand, mmSlot);
        const totalWidth = innerW + MM_PAD * 2;

        const rootCX = totalWidth / 2;
        const rootY  = MM_PAD + (mmParents.length > 0 ? MM_V_GAP : 0);

        mmRoot.x = rootCX;
        mmRoot.y = rootY;

        layoutDown(mmRoot.children, rootCX, rootY + MM_V_GAP, mmSlot);

        if (mmParents.length > 0) {
            let startX = totalWidth / 2 - parentBand / 2;
            for (const mp of mmParents) {
                const sw = slotW(mp, mmSlot);
                mp.x = startX + sw / 2;
                mp.y = rootY - MM_V_GAP;
                layoutUp(mp.children, mp.x, mp.y - MM_V_GAP, mmSlot);
                startX += sw + MM_H_GAP;
            }
        }

        let maxY = rootY, minY = rootY;
        walkMm(mmRoot, n => { if (n.y > maxY) maxY = n.y; if (n.y < minY) minY = n.y; });
        for (const mp of mmParents) {
            walkMm(mp, n => { if (n.y > maxY) maxY = n.y; if (n.y < minY) minY = n.y; });
        }

        const svgHeight = (maxY - minY) + r * 2 + MM_PAD * 2 + 24;
        const offsetY   = minY - MM_PAD - r;

        // Pan/zoom wrapper
        const wrapper = document.createElement('div');
        wrapper.className = 'archy-mm-wrapper' + (this.mmShowLabels ? ' archy-mm-labels-always' : '');
        container.appendChild(wrapper);
        this.mmWrapperEl = wrapper;

        // SVG
        const svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
        svg.classList.add('archy-mindmap-svg');
        svg.setAttribute('width',   String(totalWidth));
        svg.setAttribute('height',  String(svgHeight));
        svg.setAttribute('viewBox', `0 ${offsetY} ${totalWidth} ${svgHeight}`);
        wrapper.appendChild(svg);

        const edgeLayer = document.createElementNS(SVG_NS, 'g') as SVGGElement;
        svg.appendChild(edgeLayer);
        const nodeLayer = document.createElementNS(SVG_NS, 'g') as SVGGElement;
        svg.appendChild(nodeLayer);

        for (const mp of mmParents) {
            drawMmSubtree(edgeLayer, nodeLayer, mp, null, this.app, r, edgeW);
            drawMmEdge(edgeLayer, mp, mmRoot, 'parent', r, edgeW);
        }
        drawMmSubtree(edgeLayer, nodeLayer, mmRoot, null, this.app, r, edgeW);

        // Pan + zoom — use stored state so rebuilds preserve position
        let panX = this.mmPanX, panY = this.mmPanY, zoom = this.mmZoom;
        let dragging = false, lastX = 0, lastY = 0;

        const applyTransform = () => {
            svg.style.transformOrigin = '0 0';
            svg.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
            // Keep class fields in sync so the next rebuild can restore them
            this.mmPanX = panX; this.mmPanY = panY; this.mmZoom = zoom;
        };

        applyTransform();  // apply immediately (no flash at default 0,0,1)

        const onMouseMove = (e: MouseEvent) => {
            if (!dragging) return;
            panX += e.clientX - lastX; panY += e.clientY - lastY;
            lastX = e.clientX; lastY = e.clientY;
            applyTransform();
        };
        const onMouseUp = () => {
            dragging = false;
            wrapper.classList.remove('archy-mm-dragging');
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup',   onMouseUp);
        };

        wrapper.addEventListener('mousedown', (e: MouseEvent) => {
            if (e.button !== 0) return;
            dragging = true; lastX = e.clientX; lastY = e.clientY;
            wrapper.classList.add('archy-mm-dragging');
            e.preventDefault();
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup',   onMouseUp);
        });

        wrapper.addEventListener('wheel', (e: WheelEvent) => {
            e.preventDefault();
            const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
            const rect   = wrapper.getBoundingClientRect();
            const mx = e.clientX - rect.left, my = e.clientY - rect.top;
            panX = mx - (mx - panX) * factor;
            panY = my - (my - panY) * factor;
            zoom *= factor;
            applyTransform();
        }, { passive: false });
    }

    /** Called by main plugin when metadata changes */
    async onMetadataChange() { await this.refresh(); }

    async onClose() {
        this.forceRenderer?.stop();
        this.forceRenderer = null;
    }
}

// ── Module-level mindmap helpers ──────────────────────────────────────────────

function toMmNode(t: TreeNode): MmNode {
    return { name: t.name, linkType: t.linkType, x: 0, y: 0,
             children: (t.children ?? []).map(c => toMmNode(c)) };
}

function slotW(node: MmNode, mmSlot: number): number {
    if (node.children.length === 0) return mmSlot;
    const childrenTotal = node.children.reduce((acc, c) => acc + slotW(c, mmSlot), 0)
        + (node.children.length - 1) * MM_H_GAP;
    return Math.max(mmSlot, childrenTotal);
}

function layoutDown(children: MmNode[], parentCX: number, y: number, mmSlot: number) {
    if (children.length === 0) return;
    const bandW = children.reduce((acc, c) => acc + slotW(c, mmSlot), 0)
        + (children.length - 1) * MM_H_GAP;
    let x = parentCX - bandW / 2;
    for (const c of children) {
        const sw = slotW(c, mmSlot);
        c.x = x + sw / 2; c.y = y;
        layoutDown(c.children, c.x, y + MM_V_GAP, mmSlot);
        x += sw + MM_H_GAP;
    }
}

function layoutUp(children: MmNode[], parentCX: number, y: number, mmSlot: number) {
    if (children.length === 0) return;
    const bandW = children.reduce((acc, c) => acc + slotW(c, mmSlot), 0)
        + (children.length - 1) * MM_H_GAP;
    let x = parentCX - bandW / 2;
    for (const c of children) {
        const sw = slotW(c, mmSlot);
        c.x = x + sw / 2; c.y = y;
        layoutUp(c.children, c.x, y - MM_V_GAP, mmSlot);
        x += sw + MM_H_GAP;
    }
}

function walkMm(node: MmNode, cb: (n: MmNode) => void) {
    cb(node);
    for (const c of node.children) walkMm(c, cb);
}

function drawMmEdge(
    layer: SVGGElement, from: MmNode, to: MmNode,
    linkType: LinkType | 'parent' | 'root', r: number, edgeW: number
) {
    const cls = linkType === 'parent' || linkType === 'dependson' ? 'archy-mm-edge-dependson'
              : linkType === 'informedby' ? 'archy-mm-edge-informedby'
              : 'archy-mm-edge-leadsto';

    const goingDown = from.y < to.y;
    const x1 = from.x, y1 = goingDown ? from.y + r : from.y - r;
    const x2 = to.x,   y2 = goingDown ? to.y   - r : to.y   + r;
    const midY = (y1 + y2) / 2;

    const path = document.createElementNS(SVG_NS, 'path') as SVGPathElement;
    path.setAttribute('class', `archy-mm-edge ${cls}`);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke-width', String(edgeW));
    path.setAttribute('d', `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`);
    layer.appendChild(path);
}

function drawMmNodeCircle(layer: SVGGElement, node: MmNode, app: App, r: number) {
    const circleCls = node.linkType === 'root'      ? 'archy-mm-circle archy-mm-circle-root'
                    : node.linkType === 'parent'     ? 'archy-mm-circle archy-mm-circle-dependson'
                    : node.linkType === 'informedby' ? 'archy-mm-circle archy-mm-circle-informedby'
                    : 'archy-mm-circle archy-mm-circle-leadsto';

    const g = document.createElementNS(SVG_NS, 'g') as SVGGElement;
    g.setAttribute('class', 'archy-mm-node');
    g.setAttribute('transform', `translate(${node.x}, ${node.y})`);

    const circle = document.createElementNS(SVG_NS, 'circle') as SVGCircleElement;
    circle.setAttribute('cx', '0'); circle.setAttribute('cy', '0');
    circle.setAttribute('r', String(r));
    circle.setAttribute('class', circleCls);
    g.appendChild(circle);

    const label = document.createElementNS(SVG_NS, 'text') as SVGTextElement;
    label.setAttribute('x', '0');
    label.setAttribute('y', String(r + 14));
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('class', 'archy-mm-label');
    label.textContent = node.name;
    g.appendChild(label);

    g.addEventListener('click', () => openNote(node.name, app));
    layer.appendChild(g);
}

function drawMmSubtree(
    edgeLayer: SVGGElement, nodeLayer: SVGGElement,
    node: MmNode, parent: MmNode | null, app: App,
    r: number, edgeW: number
) {
    if (parent) drawMmEdge(edgeLayer, parent, node, node.linkType, r, edgeW);
    drawMmNodeCircle(nodeLayer, node, app, r);
    for (const child of node.children) drawMmSubtree(edgeLayer, nodeLayer, child, node, app, r, edgeW);
}

/** Format a number for display next to its slider. */
function fmtVal(v: number, step: number): string {
    if (step >= 1) return String(Math.round(v));
    const decimals = Math.max(0, String(step).split('.')[1]?.length ?? 2);
    return v.toFixed(decimals);
}
