import { App, Modal, Notice, TFile } from 'obsidian';
import { LinkType } from './types';
import { allNoteNames } from './parser';

/**
 * Modal for inserting a hierarchical link into the current note's frontmatter.
 * The user chooses a link type and a target note name.
 */
export class LinkModal extends Modal {
    private presetType: LinkType | null;
    private onInsert: (type: LinkType, target: string) => Promise<void>;

    constructor(
        app: App,
        presetType: LinkType | null,
        onInsert: (type: LinkType, target: string) => Promise<void>
    ) {
        super(app);
        this.presetType = presetType;
        this.onInsert = onInsert;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        this.titleEl.setText('Insert Archy Link');

        // ── Link type selector ──────────────────────────────────────────────
        const typeRow = contentEl.createDiv({ cls: 'archy-modal-row' });
        typeRow.createEl('label', { text: 'Link type', cls: 'archy-modal-label' });

        const typeSelect = typeRow.createEl('select', { cls: 'archy-modal-select' });
        const types: { value: LinkType; label: string }[] = [
            { value: 'leadsto', label: '→ leadsto    (this note leads to another)' },
            { value: 'dependson', label: '↑ dependson  (this note depends on another)' },
            { value: 'informedby', label: '◎ informedby (context / miscellaneous)' },
        ];
        types.forEach(t => {
            const opt = typeSelect.createEl('option', { text: t.label });
            opt.value = t.value;
        });
        if (this.presetType) typeSelect.value = this.presetType;

        // ── Target note input ──────────────────────────────────────────────
        const targetRow = contentEl.createDiv({ cls: 'archy-modal-row' });
        targetRow.createEl('label', { text: 'Target note', cls: 'archy-modal-label' });

        const inputWrap = targetRow.createDiv({ cls: 'archy-modal-input-wrap' });
        const input = inputWrap.createEl('input', {
            cls: 'archy-modal-input',
            type: 'text',
            placeholder: 'Start typing a note name…',
        });

        // Autocomplete datalist
        const list = inputWrap.createEl('datalist');
        list.id = 'archy-modal-datalist';
        input.setAttribute('list', list.id);

        allNoteNames(this.app).forEach(name => {
            const opt = list.createEl('option');
            opt.value = name;
        });

        // ── Buttons ────────────────────────────────────────────────────────
        const btnRow = contentEl.createDiv({ cls: 'archy-modal-btn-row' });

        const cancelBtn = btnRow.createEl('button', { text: 'Cancel', cls: 'archy-modal-btn' });
        cancelBtn.addEventListener('click', () => this.close());

        const insertBtn = btnRow.createEl('button', {
            text: 'Insert',
            cls: 'archy-modal-btn archy-modal-btn-primary',
        });
        insertBtn.addEventListener('click', async () => {
            const target = input.value.trim();
            if (!target) {
                new Notice('Please enter a target note name.');
                return;
            }
            const type = typeSelect.value as LinkType;
            await this.onInsert(type, target);
            this.close();
        });

        // Allow Enter key to submit
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') insertBtn.click();
        });

        setTimeout(() => input.focus(), 50);
    }

    onClose() {
        this.contentEl.empty();
    }
}
