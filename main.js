'use strict';

const { Plugin, PluginSettingTab, Setting, Notice } = require('obsidian');

// ---------------------------------------------------------------------------
// Regex
// ---------------------------------------------------------------------------

const BASE64_IMAGE_REGEX_SOURCE =
    String.raw`!\[(.*?)\]\(data:image\/[a-z]+;base64,[a-zA-Z0-9+\/]+={0,2}\)`;

function buildRegex() {
    return new RegExp(BASE64_IMAGE_REGEX_SOURCE, 'g');
}

// Secondary regex to extract format + raw base64 from a match string.
const DATA_URI_RE = /data:image\/([a-z]+);base64,([a-zA-Z0-9+\/]+={0,2})/;

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

function base64ToArrayBuffer(base64) {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

async function loadImageBitmap(dataUri) {
    const response = await fetch(dataUri);
    const blob = await response.blob();
    return createImageBitmap(blob);
}

const SHRINK_PRESETS = {
    medium: { maxDim: 128, quality: 0.5 },
    icon: { maxDim: 32, quality: 0.3 },
};

async function shrinkImage(dataUri, maxDim, quality) {
    const bitmap = await loadImageBitmap(dataUri);
    const scale = Math.min(maxDim / bitmap.width, maxDim / bitmap.height, 1.0);
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();

    return canvas.toDataURL('image/webp', quality);
}

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function trailingTextLength(content, matchEnd, altText) {
    if (!altText) return 0;
    const after = content.substring(matchEnd);
    const re = new RegExp('^' + escapeRegex(altText) + '\\s*\\+\\s*\\d+');
    const m = after.match(re);
    return m ? m[0].length : 0;
}

async function generateUniqueFilename(vault, folder, baseName, ext) {
    let name = baseName + ext;
    let path = folder ? folder + '/' + name : name;
    let counter = 0;
    while (await vault.adapter.exists(path)) {
        counter++;
        name = baseName + '-' + counter + ext;
        path = folder ? folder + '/' + name : name;
    }
    return name;
}

async function ensureFolderExists(vault, folderPath) {
    if (!folderPath || folderPath === '/') return;
    const parts = folderPath.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
        current = current ? current + '/' + part : part;
        if (!(await vault.adapter.exists(current))) {
            try { await vault.createFolder(current); } catch { /* already exists */ }
        }
    }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS = {
    mode: 'replace',              // 'replace' | 'delete' | 'convert' | 'save'
    replaceUseCustom: false,
    replacementText: '\\[Image Removed]',
    replaceIncludeInfo: true,
    infoLabelMode: 'off',            // 'off' | 'default' | 'custom' — for convert/save modes
    infoLabelText: 'Image Removed',

    shrinkPreset: 'icon',         // 'medium' | 'icon'
    shrinkTarget: 'logos',        // 'all' | 'logos'
    cleanTrailing: true,
    suffixChoice: 'space',        // 'space' | 'newline' | 'none' | 'custom'
    suffixText: ' ',

    saveLocation: 'obsidianDefault', // 'obsidianDefault' | 'noteSubfolder' | 'custom'
    noteSubfolderName: 'attachments--{noteName}',
    customSavePath: '',
    saveScalePercent: 100,
    saveSquare: false,
};

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

class Base64ImageCleanerPlugin extends Plugin {
    async onload() {
        await this.loadSettings();

        this.addCommand({
            id: 'clean-current-note',
            name: 'Clean base64 images in current note',
            editorCallback: async (editor, view) => {
                await this.cleanEditor(editor, view);
            },
        });

        this.addSettingTab(new Base64ImageCleanerSettingTab(this.app, this));
    }

    async loadSettings() {
        const data = await this.loadData() || {};
        if (data._favSettings && !data._presets) {
            data._presets = { replace: { 'My Fav Settings': data._favSettings } };
        }
        if (data._presets && !data._presets.replace && !data._presets.delete && !data._presets.convert && !data._presets.save) {
            data._presets = { replace: data._presets };
        }
        this.presets = data._presets || {};
        delete data._favSettings;
        delete data._presets;
        this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    }

    async saveSettings() {
        const data = Object.assign({}, this.settings);
        const mode = this.settings.mode;
        if (!this.presets[mode]) this.presets[mode] = {};
        const differs = Object.keys(DEFAULT_SETTINGS).some(
            (k) => k !== 'mode' && this.settings[k] !== DEFAULT_SETTINGS[k]
        );
        if (differs) {
            this.presets[mode]['recent - auto saved'] = Object.assign({}, this.settings);
        }
        if (Object.keys(this.presets).length > 0) data._presets = this.presets;
        await this.saveData(data);
    }

    async savePreset(name) {
        const mode = this.settings.mode;
        if (!this.presets[mode]) this.presets[mode] = {};
        this.presets[mode][name] = Object.assign({}, this.settings);
        await this.saveSettings();
    }

    async loadPreset(name) {
        const mode = this.settings.mode;
        if (!this.presets[mode]?.[name]) return;
        this.settings = Object.assign({}, DEFAULT_SETTINGS, this.presets[mode][name]);
        this.settings.mode = mode;
        await this.saveSettings();
    }

    async revertToDefaults() {
        const mode = this.settings.mode;
        this.settings = Object.assign({}, DEFAULT_SETTINGS);
        this.settings.mode = mode;
        await this.saveSettings();
    }

    getReplacementText() {
        if (this.settings.mode === 'delete') return '';
        if (!this.settings.replaceUseCustom) return '\\[Image Removed]';
        const txt = this.settings.replacementText;
        return (typeof txt === 'string' && txt.length > 0) ? txt : '\\[Image Removed]';
    }

    async resolveTargetFolder(activeFile) {
        const loc = this.settings.saveLocation;

        if (loc === 'obsidianDefault') {
            let attachPath = this.app.vault.getConfig('attachmentFolderPath') || '';
            if (!attachPath || attachPath === '/' || attachPath === '.') {
                attachPath = activeFile.parent?.path || '';
            } else if (attachPath.startsWith('./')) {
                const noteDir = activeFile.parent?.path || '';
                attachPath = noteDir
                    ? noteDir + '/' + attachPath.slice(2)
                    : attachPath.slice(2);
            }
            return attachPath;
        }

        if (loc === 'noteSubfolder') {
            const noteDir = activeFile.parent?.path || '';
            const template = this.settings.noteSubfolderName || 'attachments--{noteName}';
            const sub = template.replace(/\{noteName\}/g, activeFile.basename);
            return noteDir ? noteDir + '/' + sub : sub;
        }

        if (loc === 'custom') {
            return this.settings.customSavePath || '';
        }

        return '';
    }

    async cleanEditor(editor, view) {
        const content = editor.getValue();
        const matches = [...content.matchAll(buildRegex())];

        if (matches.length === 0) {
            new Notice('No base64 images found in this note.');
            return;
        }

        const mode = this.settings.mode;
        const cleanTrailing = this.settings.cleanTrailing;
        const suffix = this.settings.suffixText;
        const logosOnly = this.settings.shrinkTarget === 'logos';
        const targetMatches = logosOnly ? matches.filter(m => m[1]) : matches;

        if (targetMatches.length === 0) {
            new Notice('No base64 images matched the target filter (logos only).');
            return;
        }

        let changes;

        // Helper: compute end offset including optional trailing text
        const endOffset = (m) => {
            const baseEnd = m.index + m[0].length;
            return cleanTrailing
                ? baseEnd + trailingTextLength(content, baseEnd, m[1])
                : baseEnd;
        };

        // ---- Delete ----
        if (mode === 'delete') {
            changes = targetMatches.map((m) => ({
                from: editor.offsetToPos(m.index),
                to: editor.offsetToPos(endOffset(m)),
                text: '',
            }));
        }

        // ---- Replace with text ----
        else if (mode === 'replace') {
            const baseText = this.getReplacementText();
            const includeInfo = this.settings.replaceIncludeInfo;

            changes = targetMatches.map((m) => {
                let text = baseText;
                if (includeInfo) {
                    const altText = m[1] || '';
                    const baseEnd = m.index + m[0].length;
                    const trailLen = trailingTextLength(content, baseEnd, altText);
                    const trailText = trailLen > 0 ? content.substring(baseEnd, baseEnd + trailLen) : '';
                    const label = this.settings.replaceUseCustom ? (this.settings.replacementText || 'Image Removed') : 'Image Removed';
                    const parts = [label];
                    if (altText) parts.push('AltText: ' + altText);
                    if (trailText) parts.push('Trailing Text: ' + trailText);
                    text = '\\[' + parts.join(' + ') + ']';
                }
                return {
                    from: editor.offsetToPos(m.index),
                    to: editor.offsetToPos(endOffset(m)),
                    text: text + suffix,
                };
            });
        }

        // ---- Image Shrink ----
        else if (mode === 'convert') {
            const preset = SHRINK_PRESETS[this.settings.shrinkPreset] || SHRINK_PRESETS.medium;
            const results = await Promise.all(targetMatches.map(async (m) => {
                try {
                    const fullMatch = m[0];
                    const altText = m[1] || '';

                    const uriMatch = fullMatch.match(DATA_URI_RE);
                    if (!uriMatch) return null;

                    const originalDataUri = uriMatch[0];
                    const shrunkDataUri = await shrinkImage(originalDataUri, preset.maxDim, preset.quality);
                    const end = endOffset(m);

                    // Strip existing size suffix from alt text (e.g. "YouTube|32" → "YouTube")
                    const baseAlt = altText.replace(/\|\d+$/, '');
                    const sizedAlt = baseAlt ? `${baseAlt}|${preset.maxDim}` : `|${preset.maxDim}`;

                    // Use shrunk data if smaller, otherwise keep original but still resize display
                    const useDataUri = shrunkDataUri.length < originalDataUri.length
                        ? shrunkDataUri : originalDataUri;
                    const newFull = `![${sizedAlt}](${useDataUri})` + suffix;

                    return {
                        from: editor.offsetToPos(m.index),
                        to: editor.offsetToPos(end),
                        text: newFull,
                    };
                } catch (e) {
                    console.warn('Base64 Image Cleaner: shrink failed', e);
                    return null;
                }
            }));

            changes = results.filter(Boolean);

            if (changes.length === 0) {
                new Notice('No images could be shrunk.');
                return;
            }
        }

        // ---- Save to file & replace with link ----
        else if (mode === 'save') {
            const activeFile = view.file;
            if (!activeFile) {
                new Notice('Cannot determine the active file.');
                return;
            }

            const targetFolder = await this.resolveTargetFolder(activeFile);
            await ensureFolderExists(this.app.vault, targetFolder);

            const pct = this.settings.saveScalePercent / 100;
            const square = this.settings.saveSquare;

            const results = await Promise.all(targetMatches.map(async (m, i) => {
                try {
                    const fullMatch = m[0];
                    const uriMatch = fullMatch.match(DATA_URI_RE);
                    if (!uriMatch) return null;

                    const origFormat = uriMatch[1];
                    const base64Data = uriMatch[2];
                    const ext = origFormat === 'jpeg' ? '.jpg' : '.' + origFormat;

                    const bitmap = await loadImageBitmap(
                        `data:image/${origFormat};base64,${base64Data}`
                    );
                    let w = Math.max(1, Math.round(bitmap.width * pct));
                    let h = Math.max(1, Math.round(bitmap.height * pct));
                    if (square) {
                        const side = Math.min(w, h);
                        w = side;
                        h = side;
                    }
                    bitmap.close();

                    const binary = base64ToArrayBuffer(base64Data);
                    const baseName = `image-${Date.now()}-${i}`;
                    const fileName = await generateUniqueFilename(
                        this.app.vault, targetFolder, baseName, ext
                    );
                    const filePath = targetFolder ? targetFolder + '/' + fileName : fileName;

                    await this.app.vault.createBinary(filePath, binary.buffer);

                    const wikiLink = `![[${fileName}|${w}x${h}]]` + suffix;

                    return {
                        from: editor.offsetToPos(m.index),
                        to: editor.offsetToPos(endOffset(m)),
                        text: wikiLink,
                    };
                } catch (e) {
                    console.warn('Base64 Image Cleaner: failed to save image', e);
                    return null;
                }
            }));

            changes = results.filter(Boolean);

            if (changes.length === 0) {
                new Notice('No images could be saved.');
                return;
            }
        }

        // ---- Apply all changes in one transaction (single undo step) ----
        editor.transaction({ changes });

        const n = changes.length;
        const verb = mode === 'delete' ? 'Deleted'
            : mode === 'replace' ? 'Replaced'
                : mode === 'convert' ? 'Shrunk'
                    : 'Saved';
        new Notice(`${verb} ${n} base64 image${n === 1 ? '' : 's'}. Ctrl/Cmd+Z to undo.`);
    }
}

// ---------------------------------------------------------------------------
// Settings tab
// ---------------------------------------------------------------------------

class Base64ImageCleanerSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'Base64 Image Cleaner' });

        // ---- Mode selector (always visible) ----
        new Setting(containerEl)
            .setName('Mode')
            .setDesc('What to do with each base64 image found in the note.')
            .addDropdown((dd) =>
                dd
                    .addOption('replace', 'Replace with text')
                    .addOption('delete', 'Delete entirely')
                    .addOption('convert', 'Image Shrink (less characters)')
                    .addOption('save', 'Save to file & replace with link')
                    .setValue(this.plugin.settings.mode)
                    .onChange(async (value) => {
                        this.plugin.settings.mode = value;
                        await this.plugin.saveSettings();
                        this.display();
                    })
            );

        // ---- Global: trailing text cleanup ----
        new Setting(containerEl)
            .setName('Clean trailing text')
            .setDesc('Remove text like "YouTube +1" that appears after base64 images.')
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.cleanTrailing)
                    .onChange(async (value) => {
                        this.plugin.settings.cleanTrailing = value;
                        await this.plugin.saveSettings();
                    })
            );

        // ---- Target filter (all modes) ----
        new Setting(containerEl)
            .setName('Target')
            .setDesc('Which images to process.')
            .addDropdown((dd) =>
                dd
                    .addOption('all', 'All images')
                    .addOption('logos', 'Only logos (images with alt text)')
                    .setValue(this.plugin.settings.shrinkTarget)
                    .onChange(async (value) => {
                        this.plugin.settings.shrinkTarget = value;
                        await this.plugin.saveSettings();
                    })
            );

        // ---- Replace settings ----
        if (this.plugin.settings.mode === 'replace') {
            this._renderInfoAndSuffix(containerEl);

            this._renderPresetButtons(containerEl);
        }

        // ---- Delete settings ----
        if (this.plugin.settings.mode === 'delete') {
            this._renderPresetButtons(containerEl);
        }

        // ---- Shrink settings ----
        if (this.plugin.settings.mode === 'convert') {
            new Setting(containerEl)
                .setName('Shrink to')
                .setDesc('Downscale images and compress to reduce the base64 length.')
                .addDropdown((dd) =>
                    dd
                        .addOption('medium', 'Medium (128px)')
                        .addOption('icon', 'Icon (32px)')
                        .setValue(this.plugin.settings.shrinkPreset)
                        .onChange(async (value) => {
                            this.plugin.settings.shrinkPreset = value;
                            await this.plugin.saveSettings();
                        })
                );

            this._renderInfoAndSuffix(containerEl);

            this._renderPresetButtons(containerEl);
        }

        // ---- Save & Replace settings ----
        if (this.plugin.settings.mode === 'save') {
            containerEl.createEl('h3', { text: 'Save & replace settings' });

            new Setting(containerEl)
                .setName('Save location')
                .setDesc('Where to save decoded image files.')
                .addDropdown((dd) =>
                    dd
                        .addOption('obsidianDefault', "Obsidian's default attachment location")
                        .addOption('noteSubfolder', 'Subfolder next to the note')
                        .addOption('custom', 'Custom vault path')
                        .setValue(this.plugin.settings.saveLocation)
                        .onChange(async (value) => {
                            this.plugin.settings.saveLocation = value;
                            await this.plugin.saveSettings();
                            this.display();
                        })
                );

            if (this.plugin.settings.saveLocation === 'noteSubfolder') {
                new Setting(containerEl)
                    .setName('Subfolder name')
                    .setDesc('Use {noteName} for the note\'s name. Created if it does not exist.')
                    .addText((text) =>
                        text
                            .setPlaceholder('attachments--{noteName}')
                            .setValue(this.plugin.settings.noteSubfolderName)
                            .onChange(async (value) => {
                                this.plugin.settings.noteSubfolderName = value || 'attachments--{noteName}';
                                await this.plugin.saveSettings();
                            })
                    );
            }

            if (this.plugin.settings.saveLocation === 'custom') {
                new Setting(containerEl)
                    .setName('Custom save path')
                    .setDesc('Vault-relative folder path (e.g. "assets/images"). Created if missing.')
                    .addText((text) =>
                        text
                            .setPlaceholder('assets/images')
                            .setValue(this.plugin.settings.customSavePath)
                            .onChange(async (value) => {
                                this.plugin.settings.customSavePath = value;
                                await this.plugin.saveSettings();
                            })
                    );
            }

            containerEl.createEl('h4', { text: 'Display size in note' });

            new Setting(containerEl)
                .setName('Display scale')
                .setDesc('Scale the image display to ' + this.plugin.settings.saveScalePercent + '% of original size.')
                .addSlider((slider) =>
                    slider
                        .setLimits(5, 100, 5)
                        .setValue(this.plugin.settings.saveScalePercent)
                        .setDynamicTooltip()
                        .onChange(async (value) => {
                            this.plugin.settings.saveScalePercent = value;
                            await this.plugin.saveSettings();
                            this.display();
                        })
                );

            new Setting(containerEl)
                .setName('Square')
                .setDesc('Force the displayed image to be square (width = height).')
                .addToggle((toggle) =>
                    toggle
                        .setValue(this.plugin.settings.saveSquare)
                        .onChange(async (value) => {
                            this.plugin.settings.saveSquare = value;
                            await this.plugin.saveSettings();
                        })
                );

            containerEl.createEl('p', {
                cls: 'setting-item-description',
                text: 'Saved files remain on disk even if you undo the text change (Ctrl/Cmd+Z only reverts the note text).',
            });

            this._renderInfoAndSuffix(containerEl);

            this._renderPresetButtons(containerEl);
        }
    }

    _renderPresetButtons(containerEl) {
        containerEl.createEl('h4', { text: 'Save / Load Settings - For this Mode Only' });
        const mode = this.plugin.settings.mode;
        const modePresets = this.plugin.presets[mode] || {};
        const presetNames = Object.keys(modePresets);
        const differs = Object.keys(DEFAULT_SETTINGS).some(
            (k) => k !== 'mode' && this.plugin.settings[k] !== DEFAULT_SETTINGS[k]
        );

        if (differs) {
            const saveSetting = new Setting(containerEl).setName('Save As...');
            let presetNameInput = '';
            saveSetting.addText((text) =>
                text.setPlaceholder('Preset name').onChange((value) => {
                    presetNameInput = value;
                })
            );
            saveSetting.addButton((btn) =>
                btn.setButtonText('Save').onClick(async () => {
                    const name = presetNameInput.trim();
                    if (!name) {
                        new Notice('Please enter a preset name.');
                        return;
                    }
                    await this.plugin.savePreset(name);
                    new Notice('Preset "' + name + '" saved.');
                    this.display();
                })
            );
        }

        if (presetNames.length > 0) {
            let selectedPreset = presetNames[0];
            const loadSetting = new Setting(containerEl).setName('Load preset');
            loadSetting.addDropdown((dd) => {
                presetNames.forEach((n) => dd.addOption(n, n));
                dd.setValue(selectedPreset);
                dd.onChange((value) => { selectedPreset = value; });
            });
            loadSetting.addButton((btn) =>
                btn.setButtonText('Load').onClick(async () => {
                    await this.plugin.loadPreset(selectedPreset);
                    new Notice('Preset "' + selectedPreset + '" loaded.');
                    this.display();
                })
            );
        }

        new Setting(containerEl).addButton((btn) =>
            btn.setButtonText('Revert to defaults').onClick(async () => {
                await this.plugin.revertToDefaults();
                new Notice('Settings reverted to defaults.');
                this.display();
            })
        );
    }

    _renderInfoAndSuffix(containerEl) {
        const s = this.plugin.settings;

        const group = containerEl.createDiv({
            attr: { style: 'background: var(--background-secondary); border-radius: 8px; padding: 8px 0; margin: 12px 0;' }
        });

        if (s.mode === 'replace') {
            new Setting(group)
                .setName('Replace Image with Text')
                .setDesc('Use the default text or specify your own.')
                .addDropdown((dd) =>
                    dd
                        .addOption('default', 'Default: [Image Removed]')
                        .addOption('custom', 'Custom text')
                        .setValue(s.replaceUseCustom ? 'custom' : 'default')
                        .onChange(async (value) => {
                            s.replaceUseCustom = value === 'custom';
                            await this.plugin.saveSettings();
                            this.display();
                        })
                );

            if (s.replaceUseCustom) {
                new Setting(group)
                    .setName('Custom replacement text')
                    .setDesc('This text replaces each base64 image.')
                    .addText((text) =>
                        text
                            .setPlaceholder('[Image Removed]')
                            .setValue(s.replacementText)
                            .onChange(async (value) => {
                                s.replacementText = value;
                                await this.plugin.saveSettings();
                            })
                    );
            }
        }

        if (s.mode === 'replace') {
            const label = s.replaceUseCustom ? (s.replacementText || 'Image Removed') : 'Image Removed';
            const example = '[' + label + ' + AltText: YouTube + Trailing Text: YouTube +1]';

            new Setting(group)
                .setName('Include image info')
                .setDesc('Add alt text and trailing text to the replacement, e.g. ' + example)
                .addToggle((toggle) =>
                    toggle
                        .setValue(s.replaceIncludeInfo)
                        .onChange(async (value) => {
                            s.replaceIncludeInfo = value;
                            await this.plugin.saveSettings();
                        })
                );
        } else {
            const label = s.infoLabelMode === 'custom' ? (s.infoLabelText || 'Image Removed') : 'Image Removed';
            const example = '[' + label + ' + AltText: YouTube + Trailing Text: YouTube +1]';

            new Setting(group)
                .setName('Include image info')
                .setDesc('Add alt text and trailing text to the replacement, e.g. ' + example)
                .addDropdown((dd) =>
                    dd
                        .addOption('off', 'Off')
                        .addOption('default', 'Default: [Image Removed]')
                        .addOption('custom', 'Custom text')
                        .setValue(s.infoLabelMode)
                        .onChange(async (value) => {
                            s.infoLabelMode = value;
                            await this.plugin.saveSettings();
                            this.display();
                        })
                );

            if (s.infoLabelMode === 'custom') {
                new Setting(group)
                    .setName('Custom info label')
                    .setDesc('Text used as the label in the image info bracket.')
                    .addText((text) =>
                        text
                            .setPlaceholder('Image Removed')
                            .setValue(s.infoLabelText)
                            .onChange(async (value) => {
                                s.infoLabelText = value;
                                await this.plugin.saveSettings();
                            })
                    );
            }
        }

        new Setting(group)
            .setName('Custom Trailing Text')
            .setDesc('Text inserted after each processed image.')
            .addDropdown((dd) =>
                dd
                    .addOption('space', 'Space')
                    .addOption('newline', 'New line')
                    .addOption('none', 'Nothing')
                    .addOption('custom', 'Custom')
                    .setValue(s.suffixChoice || 'space')
                    .onChange(async (value) => {
                        s.suffixChoice = value;
                        if (value === 'space') s.suffixText = ' ';
                        else if (value === 'newline') s.suffixText = '\n';
                        else if (value === 'none') s.suffixText = '';
                        await this.plugin.saveSettings();
                        this.display();
                    })
            );

        if ((s.suffixChoice || 'space') === 'custom') {
            new Setting(group)
                .setName('Custom suffix')
                .setDesc('Text to insert after each processed image.')
                .addText((text) =>
                    text
                        .setPlaceholder(' ')
                        .setValue(s.suffixText)
                        .onChange(async (value) => {
                            s.suffixText = value;
                            await this.plugin.saveSettings();
                        })
                );
        }
    }
}

module.exports = Base64ImageCleanerPlugin;
