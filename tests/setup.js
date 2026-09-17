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
    let template = fs.readFileSync(fullPath, 'utf8');

    const getPathVal = (obj, pathStr) => {
        if (obj === null || obj === undefined) return undefined;
        let str = pathStr.trim();
        if (str === 'this' || str === '.') return obj;
        if (str.startsWith('this.')) str = str.slice(5);
        if (str.startsWith('./')) str = str.slice(2);
        const parts = str.split('.');
        let curr = obj;
        for (const p of parts) {
            if (curr === null || curr === undefined) return undefined;
            curr = curr[p];
        }
        return curr;
    };

    const partials = new Map();
    template = template.replace(/\{\{#\*inline\s+"([^"]+)"\}\}([\s\S]*?)\{\{\/inline\}\}/g, (_match, name, content) => {
        partials.set(name, content);
        return '';
    });

    const evaluate = (tmpl, ctx) => {
        let res = '';
        let i = 0;
        const len = tmpl.length;

        while (i < len) {
            const blockStart = tmpl.indexOf('{{#', i);
            if (blockStart === -1) {
                res += tmpl.slice(i);
                break;
            }

            res += tmpl.slice(i, blockStart);
            i = blockStart;

            const match = tmpl.slice(i).match(/^\{\{\#(if|unless|each)\s+([^}]+)\}\}/);
            if (!match) {
                const inlineMatch = tmpl.slice(i).match(/^\{\{\#\*inline\s+"([^"]+)"\}\}/);
                if (inlineMatch) {
                    const closeIdx = tmpl.indexOf('{{/inline}}', i);
                    if (closeIdx !== -1) {
                        i = closeIdx + 11;
                        continue;
                    }
                }
                res += tmpl[i];
                i++;
                continue;
            }

            const type = match[1];
            const expr = match[2].trim();
            const tagLength = match[0].length;
            const contentStart = i + tagLength;

            let depth = 1;
            let pos = contentStart;
            let elsePos = -1;

            while (pos < len && depth > 0) {
                const nextOpen = tmpl.indexOf('{{#', pos);
                const nextClose = tmpl.indexOf(`{{/${type}}}`, pos);

                let minPos = nextClose;
                if (minPos === -1) break;

                if (nextOpen !== -1 && nextOpen < minPos) {
                    minPos = nextOpen;
                }

                if (depth === 1 && elsePos === -1) {
                    const nextElse = tmpl.indexOf('{{else}}', pos);
                    if (nextElse !== -1 && nextElse < minPos && (nextOpen === -1 || nextElse < nextOpen)) {
                        elsePos = nextElse;
                        pos = nextElse + 8;
                        continue;
                    }
                }

                if (minPos === nextOpen) {
                    depth++;
                    pos = nextOpen + 3;
                } else {
                    depth--;
                    if (depth === 0) {
                        const ifContent = elsePos !== -1 ? tmpl.slice(contentStart, elsePos) : tmpl.slice(contentStart, minPos);
                        const elseContent = elsePos !== -1 ? tmpl.slice(elsePos + 8, minPos) : '';

                        let cond = false;
                        if (type === 'each') {
                            const list = getPathVal(ctx, expr);
                            if (Array.isArray(list) && list.length > 0) {
                                res += list.map((item, idx) => {
                                    const itemCtx = typeof item === 'object' && item !== null ? { ...item, '@first': idx === 0, '@index': idx } : { this: item, '@first': idx === 0, '@index': idx };
                                    return evaluate(ifContent, itemCtx);
                                }).join('');
                            } else {
                                res += evaluate(elseContent, ctx);
                            }
                        } else {
                            if (type === 'if') {
                                const eqMatch = expr.match(/\(eq\s+([^\s]+)\s+"([^"]+)"\)/);
                                if (eqMatch) {
                                    cond = String(getPathVal(ctx, eqMatch[1])) === eqMatch[2];
                                } else if (expr.includes('.length')) {
                                    const prop = expr.replace('.length', '').trim();
                                    const list = getPathVal(ctx, prop);
                                    cond = Array.isArray(list) ? list.length > 0 : Boolean(list);
                                } else {
                                    cond = Boolean(getPathVal(ctx, expr));
                                }
                            } else if (type === 'unless') {
                                const val = getPathVal(ctx, expr);
                                cond = expr.startsWith('@') ? false : !val;
                            }
                            res += cond ? evaluate(ifContent, ctx) : evaluate(elseContent, ctx);
                        }

                        i = minPos + type.length + 5;
                        break;
                    }
                    pos = minPos + type.length + 5;
                }
            }
        }

        let prevRes = '';
        while (prevRes !== res && res.includes('{{>')) {
            prevRes = res;
            res = res.replace(/\{\{>\s*(\w+)(?:\s+([^}]+))?\}\}/g, (_match, pName, argExpr) => {
                const pTmpl = partials.get(pName);
                if (!pTmpl) return '';
                let pCtx = ctx;
                if (argExpr) {
                    const match = argExpr.match(/(\w+)=([\s\S]+)/);
                    if (match) {
                        const valKey = match[2].trim();
                        pCtx = getPathVal(ctx, valKey) ?? ctx;
                    } else {
                        pCtx = getPathVal(ctx, argExpr.trim()) ?? ctx;
                    }
                }
                return evaluate(pTmpl, pCtx);
            });
        }

        res = res.replace(/\{\{\{\s*([^}]+)\s*\}\}\}/g, (_match, expr) => {
            const val = getPathVal(ctx, expr.trim());
            return val !== undefined && val !== null ? String(val) : '';
        });

        res = res.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_match, expr) => {
            const key = expr.trim();
            if (key.startsWith('>')) return _match;
            const val = getPathVal(ctx, key);
            return val !== undefined && val !== null ? String(val) : '';
        });

        return res;
    };

    return evaluate(template, data);
};

if (!globalThis.window) {
    globalThis.window = globalThis;
}
