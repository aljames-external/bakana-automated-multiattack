/**
 * Foundry VTT Mock Environment for Node Test Runner (tsx --test).
 */

const _settingsStore = new Map();
const _menusStore = new Map();
const _hooksStore = new Map();

globalThis.Hooks = {
    on: (event, fn) => {
        if (!_hooksStore.has(event)) _hooksStore.set(event, []);
        _hooksStore.get(event).push(fn);
    },
    once: (event, fn) => {
        if (!_hooksStore.has(event)) _hooksStore.set(event, []);
        _hooksStore.get(event).push(fn);
    },
    callAll: async (event, ...args) => {
        const fns = _hooksStore.get(event) ?? [];
        for (const fn of fns) {
            await fn(...args);
        }
    }
};

globalThis.CONST = {
    USER_ROLES: {
        NONE: 0,
        PLAYER: 1,
        TRUSTED: 2,
        ASSISTANT: 3,
        GAMEMASTER: 4
    },
    DOCUMENT_OWNERSHIP_LEVELS: {
        NONE: 0,
        LIMITED: 1,
        OBSERVER: 2,
        OWNER: 3
    }
};

globalThis.foundry = {
    applications: {
        api: {
            ApplicationV2: class ApplicationV2 {
                _renderHTML() {
                    throw new Error(`The ${this.constructor.name} Application class is not renderable because it does not implement the abstract methods _renderHTML and _replaceHTML.`);
                }
                _replaceHTML() {
                    throw new Error(`The ${this.constructor.name} Application class is not renderable because it does not implement the abstract methods _renderHTML and _replaceHTML.`);
                }
                async render(options = {}) {
                    if (
                        this._renderHTML === ApplicationV2.prototype._renderHTML ||
                        this._replaceHTML === ApplicationV2.prototype._replaceHTML
                    ) {
                        throw new Error(
                            `The ${this.constructor.name} Application class is not renderable because it does not implement the abstract methods _renderHTML and _replaceHTML.`
                        );
                    }
                    const result = await this._renderHTML({}, options);
                    const content = {
                        children: [],
                        replaceChildren(...nodes) {
                            this.children = nodes;
                        },
                        querySelector() {
                            return null;
                        }
                    };
                    this._replaceHTML(result, content, options);
                    return this;
                }
            },
            DialogV2: {
                wait: async (config) => {
                    if (globalThis.__mockDialogSelectHandler) {
                        return globalThis.__mockDialogSelectHandler(config);
                    }
                    if (config?.close) {
                        config.close();
                    }
                    return null;
                }
            },
            HandlebarsApplicationMixin: (Base) => Base
        }
    },
    utils: {
        mergeObject: (a, b) => ({ ...a, ...b }),
        deepClone: (obj) => (obj !== undefined ? JSON.parse(JSON.stringify(obj)) : undefined),
        randomID: (len = 8) => Math.random().toString(36).substring(2, 2 + len),
        isEmpty: (obj) => !obj || Object.keys(obj).length === 0,
        isNewerVersion: (v1, v0) => String(v1) > String(v0)
    }
};

globalThis.game = {
    release: { generation: 13 },
    system: { id: 'dnd5e' },
    user: {
        id: 'user-gm',
        isGM: true,
        role: 4,
        active: true,
        updateTokenTargets: () => {}
    },
    users: {
        contents: [
            { id: 'user-gm', isGM: true, role: 4, active: true }
        ]
    },
    i18n: {
        has: () => false,
        localize: (key) => key,
        format: (key) => key
    },
    settings: {
        _configs: new Map(),
        register: (module, key, data) => {
            const fullKey = `${module}.${key}`;
            globalThis.game.settings._configs.set(fullKey, data);
            if (!_settingsStore.has(fullKey)) {
                _settingsStore.set(fullKey, data.default);
            }
        },
        registerMenu: (module, key, data) => {
            _menusStore.set(`${module}.${key}`, data);
        },
        get: (module, key) => {
            const fullKey = `${module}.${key}`;
            return _settingsStore.get(fullKey);
        },
        set: async (module, key, value) => {
            const fullKey = `${module}.${key}`;
            _settingsStore.set(fullKey, value);
            const cfg = globalThis.game.settings._configs.get(fullKey);
            if (cfg?.onChange) {
                cfg.onChange(value);
            }
            return value;
        }
    },
    actors: new Map()
};

globalThis.canvas = {
    ready: true,
    tokens: {
        placeables: [],
        controlled: [],
        get: () => null
    }
};

globalThis.ui = {
    notifications: {
        info: () => {},
        warn: () => {},
        error: () => {}
    }
};

globalThis.ChatMessage = {
    getSpeakerActor: (speaker) => {
        if (speaker?.actor && globalThis.game.actors.has(speaker.actor)) {
            return globalThis.game.actors.get(speaker.actor);
        }
        return null;
    }
};

import fs from 'node:fs';
import path from 'node:path';

globalThis.loadTemplates = async (paths) => {
    return Promise.resolve(paths);
};

globalThis.renderTemplate = async (templatePath, data = {}) => {
    let cleanPath = templatePath;
    if (cleanPath.startsWith('modules/bakana-automated-multiattack/')) {
        cleanPath = cleanPath.replace('modules/bakana-automated-multiattack/', '');
    }
    const fullPath = path.resolve(process.cwd(), cleanPath);
    if (!fs.existsSync(fullPath)) return '';
    let html = fs.readFileSync(fullPath, 'utf8');

    html = html.replace(/\{\{#if\s+\(eq\s+(\w+)\s+"([^"]+)"\)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_match, varName, val, inner) => {
        return String(data[varName]) === val ? inner : '';
    });
    html = html.replace(/\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_match, varName, inner) => {
        return Boolean(data[varName]) ? inner : '';
    });

    for (const [k, v] of Object.entries(data)) {
        if (v !== undefined && v !== null) {
            html = html.replaceAll(`{{{${k}}}}`, String(v));
            html = html.replaceAll(`{{${k}}}`, String(v));
        }
    }
    return html;
};

if (!globalThis.window) {
    globalThis.window = globalThis;
}
