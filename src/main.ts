import { App, MarkdownView, Notice, Plugin, TFile } from 'obsidian';
import { DEFAULT_SETTINGS, ArchiSettings, ArchiSettingTab } from './settings';
import { ArchiTreeView, VIEW_TYPE_ARCHY } from './treeView';
import { LinkModal } from './linkModal';
import { LinkType } from './types';
import { INLINE_TAG_REGEX, openNote, resolveTagMatch } from './parser';
import { buildInlineTagExtension } from './inlineTagExtension';

export default class ArchiPlugin extends Plugin {
    settings: ArchiSettings = DEFAULT_SETTINGS;

    async onload() {
        await this.loadSettings();

        // ── Register the tree view ─────────────────────────────────────────
        this.registerView(VIEW_TYPE_ARCHY, (leaf) => new ArchiTreeView(leaf, this));

        // ── Ribbon icon ────────────────────────────────────────────────────
        this.addRibbonIcon('git-fork', 'Open Archy Knowledge Tree', async () => {
            await this.activateTreeView();
        });

        // ── Commands ───────────────────────────────────────────────────────
        this.addCommand({
            id: 'open-knowledge-tree',
            name: 'Open Knowledge Tree',
            callback: async () => await this.activateTreeView(),
        });

        this.addCommand({
            id: 'insert-link',
            name: 'Insert Link (choose type)',
            checkCallback: (checking) => {
                const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                if (!view) return false;
                if (!checking) this.openLinkModal(null);
                return true;
            },
        });

        const quickLinkTypes: { id: string; name: string; type: LinkType }[] = [
            { id: 'insert-leadsto', name: 'Insert leadsto link', type: 'leadsto' },
            { id: 'insert-dependson', name: 'Insert dependson link', type: 'dependson' },
            { id: 'insert-informedby', name: 'Insert informedby link', type: 'informedby' },
        ];
        for (const { id, name, type } of quickLinkTypes) {
            this.addCommand({
                id,
                name,
                checkCallback: (checking) => {
                    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                    if (!view) return false;
                    if (!checking) this.openLinkModal(type);
                    return true;
                },
            });
        }

        // ── Settings tab ───────────────────────────────────────────────────
        this.addSettingTab(new ArchiSettingTab(this.app, this));

        // ── Inline tag post-processor ───────────────────────────────────────
        // Renders leadsto@X, dependson@X, informedby@X as clickable chips
        // in reading/preview mode, without needing [[...]] wikilink brackets.
        this.registerMarkdownPostProcessor((element) => {
            const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
            const textNodes: Text[] = [];
            let node: Node | null;
            // Collect all text nodes first (avoid mutating while walking)
            while ((node = walker.nextNode())) {
                const txt = (node as Text).textContent ?? '';
                INLINE_TAG_REGEX.lastIndex = 0;
                if (INLINE_TAG_REGEX.test(txt)) textNodes.push(node as Text);
            }
            for (const textNode of textNodes) {
                const text = textNode.textContent ?? '';
                const frag = document.createDocumentFragment();
                let lastIndex = 0;
                INLINE_TAG_REGEX.lastIndex = 0;
                let match: RegExpExecArray | null;
                while ((match = INLINE_TAG_REGEX.exec(text)) !== null) {
                    const resolved = resolveTagMatch(match);
                    if (!resolved) continue;
                    const { type, target } = resolved;
                    if (match.index > lastIndex) {
                        frag.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
                    }
                    const chip = document.createElement('span');
                    chip.className = `archy-inline-tag archy-inline-${type}`;
                    chip.textContent = target;
                    chip.title = `${type} → ${target}`;
                    chip.addEventListener('click', () => openNote(target, this.app));
                    frag.appendChild(chip);
                    lastIndex = match.index + match[0].length;
                }
                if (lastIndex < text.length) {
                    frag.appendChild(document.createTextNode(text.slice(lastIndex)));
                }
                textNode.parentNode?.replaceChild(frag, textNode);
            }
        });

        // ── Live-Preview inline tag chips (CodeMirror 6 extension) ──────────
        this.registerEditorExtension(buildInlineTagExtension(this.app));

        // ── Refresh tree when metadata changes ─────────────────────────────
        this.registerEvent(
            this.app.metadataCache.on('changed', async (_file: TFile) => {
                await this.refreshOpenTreeViews();
            })
        );

        // ── Refresh tree when the active leaf changes ──────────────────────
        this.registerEvent(
            this.app.workspace.on('active-leaf-change', async () => {
                await this.refreshOpenTreeViews();
            })
        );
    }

    onunload() {
        this.app.workspace.detachLeavesOfType(VIEW_TYPE_ARCHY);
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<ArchiSettings>);
    }

    async saveSettings() {
        await this.saveData(this.settings);
        await this.refreshOpenTreeViews();
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    async activateTreeView() {
        const { workspace } = this.app;
        const side = this.settings.panelSide;

        // Detach any existing leaves in wrong side
        const existing = workspace.getLeavesOfType(VIEW_TYPE_ARCHY);
        if (existing.length > 0) {
            workspace.revealLeaf(existing[0]);
            return;
        }

        // Create a new leaf on the selected side
        const leaf = side === 'left'
            ? workspace.getLeftLeaf(false)
            : workspace.getRightLeaf(false);

        if (!leaf) {
            new Notice('Could not open Archy panel.');
            return;
        }

        await leaf.setViewState({ type: VIEW_TYPE_ARCHY, active: true });
        workspace.revealLeaf(leaf);
    }

    async refreshOpenTreeViews() {
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_ARCHY)) {
            const view = leaf.view;
            if (view instanceof ArchiTreeView) {
                await view.refresh();
            }
        }
    }

    openLinkModal(presetType: LinkType | null) {
        new LinkModal(this.app, presetType, async (type, target) => {
            await this.insertLinkIntoFrontmatter(type, target);
        }).open();
    }

    /**
     * Safely insert (or append to) a frontmatter array key in the active note.
     * If the file has no frontmatter, adds one. Avoids duplicates.
     */
    async insertLinkIntoFrontmatter(type: LinkType, target: string) {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) {
            new Notice('No active note.');
            return;
        }

        let content = await this.app.vault.read(activeFile);

        const hasFrontmatter = content.startsWith('---');

        if (!hasFrontmatter) {
            // Create frontmatter from scratch
            content = `---\n${type}:\n  - ${target}\n---\n\n${content}`;
        } else {
            // Find the closing ---
            const fmEnd = content.indexOf('\n---', 3);
            if (fmEnd === -1) {
                new Notice('Malformed frontmatter in this note.');
                return;
            }
            const frontmatter = content.slice(3, fmEnd);
            const afterFm = content.slice(fmEnd);

            // Check if the key already exists
            const keyRegex = new RegExp(`^(${type}:\\s*\\n(?:(?:  |- )[^\\n]*\\n)*)`, 'm');
            const existingKey = keyRegex.exec(frontmatter);

            if (existingKey) {
                // Key exists — see if the value is already there
                if (frontmatter.includes(`- ${target}`)) {
                    new Notice(`"${target}" is already listed under ${type}.`);
                    return;
                }
                // Append new entry under existing key
                const insertAt = existingKey.index + existingKey[0].length;
                const newFm = frontmatter.slice(0, insertAt) + `  - ${target}\n` + frontmatter.slice(insertAt);
                content = `---${newFm}${afterFm}`;
            } else {
                // Key doesn't exist — add it before the closing ---
                const newFm = frontmatter + `\n${type}:\n  - ${target}\n`;
                content = `---${newFm}${afterFm}`;
            }
        }

        await this.app.vault.modify(activeFile, content);
        new Notice(`Added ${type}@${target} to "${activeFile.basename}"`);
    }
}
