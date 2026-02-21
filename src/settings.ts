import { App, PluginSettingTab, Setting } from 'obsidian';
import type ArchiPlugin from './main';

export interface ArchiSettings {
    panelSide: 'left' | 'right';
    maxDepth: number;
    parentDepth: number;
    viewMode: 'folio' | 'mindmap' | 'network';
    folioFontSize: number;   // px, 8–24
}

export const DEFAULT_SETTINGS: ArchiSettings = {
    panelSide: 'right',
    maxDepth: 4,
    parentDepth: 2,
    viewMode: 'folio',
    folioFontSize: 13,
};

export class ArchiSettingTab extends PluginSettingTab {
    plugin: ArchiPlugin;

    constructor(app: App, plugin: ArchiPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'Archy – Knowledge Graph' });

        // ── Panel side ──────────────────────────────────────────────────────
        new Setting(containerEl)
            .setName('Panel side')
            .setDesc('Which sidebar should the knowledge tree open in?')
            .addDropdown(drop =>
                drop
                    .addOption('right', 'Right')
                    .addOption('left', 'Left')
                    .setValue(this.plugin.settings.panelSide)
                    .onChange(async (value) => {
                        this.plugin.settings.panelSide = value as 'left' | 'right';
                        await this.plugin.saveSettings();
                    })
            );

        // ── Default view mode ────────────────────────────────────────────────
        new Setting(containerEl)
            .setName('Default view mode')
            .setDesc('View shown when the panel opens.')
            .addDropdown(drop =>
                drop
                    .addOption('folio',   'Folio (tree list)')
                    .addOption('mindmap', 'Mindmap (active note)')
                    .addOption('network', 'Network (force-directed)')
                    .setValue(this.plugin.settings.viewMode)
                    .onChange(async (value) => {
                        this.plugin.settings.viewMode =
                            value as 'folio' | 'mindmap' | 'network';
                        await this.plugin.saveSettings();
                    })
            );

        // ── Child depth ──────────────────────────────────────────────────────
        new Setting(containerEl)
            .setName('Child depth')
            .setDesc('How many levels of leadsto children to show (1–8).')
            .addSlider(slider =>
                slider
                    .setLimits(1, 8, 1)
                    .setValue(this.plugin.settings.maxDepth)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        this.plugin.settings.maxDepth = value;
                        await this.plugin.saveSettings();
                    })
            );

        // ── Parent depth ─────────────────────────────────────────────────────
        new Setting(containerEl)
            .setName('Parent depth (Folio)')
            .setDesc('How many levels of ancestor notes to show above the root note in Folio view (1–6).')
            .addSlider(slider =>
                slider
                    .setLimits(1, 6, 1)
                    .setValue(this.plugin.settings.parentDepth)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        this.plugin.settings.parentDepth = value;
                        await this.plugin.saveSettings();
                    })
            );

        // ── Folio font size ───────────────────────────────────────────────────
        new Setting(containerEl)
            .setName('Folio font size')
            .setDesc('Font size for the Folio tree list (8–24 px).')
            .addSlider(slider =>
                slider
                    .setLimits(8, 24, 1)
                    .setValue(this.plugin.settings.folioFontSize)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        this.plugin.settings.folioFontSize = value;
                        await this.plugin.saveSettings();
                    })
            );
    }
}
