import { MODULE_ID } from '../constants.js';
import { autorecManager } from './autorecManager.js';
import { adapter } from '../adapter/index.js';
import { abstractMultiattackDescription, hydrateMultiattackSequence, enrichSequenceWithDiscoveredSubActivities } from '../multiattack/abstraction.js';
import { parseMultiattackTemplate } from '../multiattack/parser.js';
import { stripOrderPrefix, getTokenUseLimit, stripPrefixesAndLimits, parseTokenComponents } from '../multiattack/executor.js';
import { llmClient } from '../multiattack/llm-client.js';
import { localize } from '../lib/utils.js';
import { notify } from '../lib/logger.js';
import type { MultiattackSequence, AutorecEntry } from '../types/global.d.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const BaseApp = (foundry as any)?.applications?.api?.ApplicationV2 ?? class {};

export interface GroupedAttackPill {
    token: string;
    count: number;
    strictOrder: boolean;
}

const STANDARD_TOKEN_CHOICES: Array<{ value: string; label: string }> = [
    { value: '<ITEM_0>', label: 'Item #1' },
    { value: '<ITEM_1>', label: 'Item #2' },
    { value: '<ITEM_2>', label: 'Item #3' },
    { value: '<ITEM_3>', label: 'Item #4' },
    { value: 'melee attack', label: 'Any Melee Attack' },
    { value: 'ranged attack', label: 'Any Ranged Attack' },
    { value: 'spell attack', label: 'Any Spell Attack' },
    { value: 'any attack', label: 'Any Attack (Pool)' }
];

/**
 * Formats an attack token string into a human-friendly label for UI display.
 */
export function formatTokenHumanLabel(rawToken: string): string {
    const comp = parseTokenComponents(rawToken);
    const clean = comp.cleanToken;
    const lower = clean.toLowerCase();

    let label = clean;

    const itemMatch = /^<item_(\d+)>(?::(.+))?$/i.exec(clean);
    if (itemMatch && itemMatch[1]) {
        const idx = parseInt(itemMatch[1], 10);
        const act = itemMatch[2] ? `: ${itemMatch[2]}` : '';
        label = `Item #${idx + 1}${act}`;
    } else if (lower.startsWith('any:')) {
        label = `Any of [${clean.slice(4).split('|').join(', ')}]`;
    } else if (comp.itemName && comp.activityName) {
        label = `${comp.itemName} (${comp.activityName})`;
    } else if (lower === 'melee attack') {
        label = 'Any Melee Attack';
    } else if (lower === 'ranged attack') {
        label = 'Any Ranged Attack';
    } else if (lower === 'spell attack') {
        label = 'Any Spell Attack';
    } else if (lower === 'any attack') {
        label = 'Any Attack';
    } else if (clean.startsWith('(') && clean.endsWith(')')) {
        const choices = clean
            .slice(1, -1)
            .split('|')
            .map((c) => formatTokenHumanLabel(c.trim()))
            .join(' OR ');
        label = `Choice (${choices})`;
    }

    if (comp.uses !== undefined) {
        label += ` (${comp.uses} ${comp.uses === 1 ? 'use' : 'uses'})`;
    }

    return label;
}

/**
 * Groups consecutive identical tokens in a flow array into compact `{ token, count, strictOrder }` pills.
 */
export function groupFlowTokens(flow: string[]): GroupedAttackPill[] {
    const groups: GroupedAttackPill[] = [];
    for (const raw of flow) {
        const strictOrder = raw.trim().startsWith('>');
        const clean = stripOrderPrefix(raw);
        if (!clean) continue;
        const prev = groups[groups.length - 1];
        if (prev && prev.token.toLowerCase() === clean.toLowerCase() && prev.strictOrder === strictOrder) {
            prev.count++;
        } else {
            groups.push({ token: clean, count: 1, strictOrder });
        }
    }
    return groups;
}

/**
 * Expands grouped attack pills back into a flat `string[]` flow array.
 */
export function expandGroupedTokens(groups: GroupedAttackPill[]): string[] {
    const out: string[] = [];
    for (const g of groups) {
        const prefix = g.strictOrder ? '>' : '';
        for (let i = 0; i < Math.max(1, g.count); i++) {
            out.push(`${prefix}${g.token}`);
        }
    }
    return out;
}

/**
 * Generates a human-readable plain-English HTML summary of a 3D MultiattackSequence.
 */
export function summarizeSequenceInPlainEnglish(sequence: MultiattackSequence): string {
    if (!Array.isArray(sequence) || sequence.length === 0) {
        return 'No attack steps configured.';
    }

    const stepSummaries = sequence.map((section, stepIdx) => {
        const stepTitle = stepIdx === 0 ? `<b>Step 1:</b>` : `<b>Then Step ${stepIdx + 1}:</b>`;
        const nonEmptyFlows = (Array.isArray(section) ? section : []).filter((f) => f.length > 0);
        const hasOptionalExit = (Array.isArray(section) ? section : []).some((f) => f.length === 0);

        if (nonEmptyFlows.length === 0) {
            return `${stepTitle} <i>Empty step</i>`;
        }

        const branchStrings = nonEmptyFlows.map((flow) => {
            const groups = groupFlowTokens(flow);
            const hasStrict = groups.some((g) => g.strictOrder);
            const itemsText = groups
                .map((g) => `<b>${g.count}&times; ${formatTokenHumanLabel(g.token)}</b>${g.strictOrder ? ' <span style="color:#fbbf24;">(strict order)</span>' : ''}`)
                .join(hasStrict ? ' &rarr; then ' : ' + ');
            return itemsText;
        });

        const joinedBranches = branchStrings.join(' <span style="color:#818cf8; font-weight:700;">&mdash; OR &mdash;</span> ');
        const optBadge = hasOptionalExit
            ? ' <span style="font-size:0.75rem; color:#38bdf8; background:rgba(56,189,248,0.15); padding:1px 6px; border-radius:4px;">Optional / Can Finish Early</span>'
            : '';

        return `<div>${stepTitle} Roll ${joinedBranches}${optBadge}</div>`;
    });

    return stepSummaries.join('');
}

export interface DroppedActorInfo {
    actorName: string;
    actorImg: string;
    itemName: string;
    rawDescription: string;
    templateText: string;
    overrideKey: string;
    itemMap: Record<string, string>;
    templateSequence: MultiattackSequence;
    concreteSequence: MultiattackSequence;
    mode: 'template' | 'override';
}

/**
 * ApplicationV2 Menu for inspecting, editing, testing, and managing central Multiattack Autorecognition entries
 * with a human-readable Visual Multiattack Flow Builder and Drag-and-Drop Monster Auto-Fill.
 */
export class AutorecMenuApplication extends BaseApp {
    private _selectedId: string | null = null;
    private _searchFilter: string = '';
    private _workingSequence: MultiattackSequence | null = null;
    private _lastSelectedIdForWorking: string | null = null;
    private _droppedActor: DroppedActorInfo | null = null;
    private _pendingName: string | null = null;
    private _pendingPattern: string | null = null;
    private _pendingType: 'template' | 'override' | 'llm' | null = null;

    static DEFAULT_OPTIONS = {
        id: 'bam-autorec-menu',
        tag: 'div',
        window: {
            title: 'BAM.autorecMenu.title',
            icon: 'fa-solid fa-swords',
            resizable: true
        },
        position: {
            width: 860,
            height: 660
        },
        classes: ['bam-autorec-app']
    };

    /**
     * Reads a dropped Actor document, extracts its Multiattack item & weapons, resolves 2024 enrichers,
     * builds both abstract template and concrete sequences, and populates the editor.
     * If deterministic parsing fails and LLM fallback is enabled, queries the LLM and stores the result
     * in the LLM Generated section for review and approval.
     */
    async handleActorDrop(actor: Actor, requestedMode?: 'template' | 'override'): Promise<boolean> {
        if (!actor) return false;
        const items = adapter.getActorItems(actor);
        const maItem = items.find((i) => adapter.isMultiattackItem(i));
        if (!maItem) {
            notify.warn(`Actor "${actor.name}" does not have a Multiattack feature.`);
            return false;
        }

        const rawDescription = adapter.getItemDescription(maItem);
        if (!rawDescription) {
            notify.warn(`Multiattack feature on "${actor.name}" has an empty description.`);
            return false;
        }

        const { template, itemMap } = abstractMultiattackDescription(rawDescription, items, actor.name);
        let parsedTemplateSeq = parseMultiattackTemplate(template);

        // If deterministic parser could not parse it and LLM fallback is enabled, query LLM and store in LLM Generated section
        if (!parsedTemplateSeq && Boolean(game.settings?.get(MODULE_ID, 'enableLlmFallback'))) {
            const llmSeq = await llmClient.queryMultiattackTemplate(template);
            if (llmSeq) {
                const actorName = actor.name ?? 'Monster';
                const itemName = maItem.name ?? 'Multiattack';
                const llmEntry = await autorecManager.registerEntry({
                    id: '',
                    name: `${actorName} (LLM Generated)`,
                    type: 'llm',
                    pattern: template,
                    sequence: llmSeq,
                    enabled: true,
                    sourceModule: 'llm',
                    llmMetadata: {
                        actorName,
                        itemName,
                        overrideKey: `${actorName}::${itemName}`,
                        templatePattern: template,
                        rawDescription,
                        itemMap
                    }
                });
                this._selectedId = llmEntry.id;
                this._droppedActor = null;
                this._pendingName = llmEntry.name;
                this._pendingPattern = llmEntry.pattern;
                this._pendingType = 'llm';
                this._workingSequence = JSON.parse(JSON.stringify(llmSeq));
                notify.info(`Generated Multiattack sequence via LLM for "${actorName}"! Review and approve it in the LLM Generated section.`);
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (this as any).render?.();
                return true;
            }
        }

        const templateSequence: MultiattackSequence = parsedTemplateSeq ?? [[['<ITEM_0>']]];

        const rawConcreteSequence: MultiattackSequence = templateSequence.map((section) =>
            section.map((flow) =>
                flow.map((token) => {
                    const strict = token.trim().startsWith('>');
                    const clean = stripOrderPrefix(token);
                    const concreteName = itemMap[clean.toUpperCase()] ?? clean;
                    return strict ? `>${concreteName}` : concreteName;
                })
            )
        );

        const concreteSequence = enrichSequenceWithDiscoveredSubActivities(rawConcreteSequence, actor, rawDescription);

        const existingSelected = autorecManager.getAllEntries().find((e) => e.id === this._selectedId);

        // Determine effective mode:
        // If not explicitly requested, and the monster's general template already exists in Templates,
        // automatically default to 'override' so the existing general template is preserved for all other monsters.
        let effectiveMode: 'template' | 'override' = requestedMode ?? 'template';
        const existingTemplateMatch = autorecManager.findDuplicatePattern(template, this._selectedId ?? undefined, 'template');

        if (!requestedMode) {
            if (existingSelected?.type === 'override') {
                effectiveMode = 'override';
            } else if (existingTemplateMatch) {
                effectiveMode = 'override';
                notify.info(
                    `"${actor.name}" matches existing template "${existingTemplateMatch.name}". Defaulted to Monster Override ("${actor.name}::${maItem.name}") so other monsters using "${existingTemplateMatch.name}" are not affected.`
                );
            }
        }

        const targetPattern = effectiveMode === 'override' ? `${actor.name}::${maItem.name}` : template;
        const existingMatch = autorecManager.findDuplicatePattern(targetPattern, this._selectedId ?? undefined, effectiveMode);

        if (existingMatch) {
            if (existingSelected && !existingSelected.pattern.trim() && existingSelected.id !== existingMatch.id) {
                await autorecManager.deleteEntry(existingSelected.id, false);
            }
            this._selectedId = existingMatch.id;
            this._droppedActor = {
                actorName: actor.name ?? 'Monster',
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                actorImg: (actor as any).img ?? 'icons/svg/mystery-man.svg',
                itemName: maItem.name ?? 'Multiattack',
                rawDescription,
                templateText: template,
                overrideKey: `${actor.name}::${maItem.name}`,
                itemMap,
                templateSequence,
                concreteSequence,
                mode: effectiveMode
            };
            this._pendingName = existingMatch.name;
            this._pendingPattern = existingMatch.pattern;
            this._pendingType = existingMatch.type;
            this._workingSequence = JSON.parse(JSON.stringify(existingMatch.sequence));
            notify.info(`"${actor.name}" already matches existing ${effectiveMode === 'override' ? 'override' : 'template'} "${existingMatch.name}"! Switched to existing entry.`);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (this as any).render?.();
            return true;
        }

        // If no entry is selected, OR the selected entry is already filled in a different category,
        // create a brand-new entry in the target category so existing filled templates are never overwritten.
        const isExistingFilled = Boolean(existingSelected && existingSelected.pattern.trim().length > 0 && !this._droppedActor);
        const isSwitchingCategoryFromFilled = Boolean(existingSelected && existingSelected.pattern.trim().length > 0 && existingSelected.type !== effectiveMode);

        if (!this._selectedId || isExistingFilled || isSwitchingCategoryFromFilled) {
            const created = await autorecManager.registerEntry({
                id: '',
                name: effectiveMode === 'override' ? `${actor.name} Override` : `${actor.name} Pattern`,
                type: effectiveMode,
                pattern: '',
                sequence: [],
                enabled: true
            });
            this._selectedId = created.id;
        } else if (existingSelected && !existingSelected.pattern.trim()) {
            existingSelected.type = effectiveMode;
            existingSelected.name = effectiveMode === 'override' ? `${actor.name} Override` : `${actor.name} Pattern`;
        }

        this._droppedActor = {
            actorName: actor.name ?? 'Monster',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            actorImg: (actor as any).img ?? 'icons/svg/mystery-man.svg',
            itemName: maItem.name ?? 'Multiattack',
            rawDescription,
            templateText: template,
            overrideKey: `${actor.name}::${maItem.name}`,
            itemMap,
            templateSequence,
            concreteSequence,
            mode: effectiveMode
        };

        this._applyDroppedActorMode(effectiveMode);
        notify.info(`Loaded Multiattack from "${actor.name}"!`);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (this as any).render?.();
        return true;
    }

    private _applyDroppedActorMode(mode: 'template' | 'override'): void {
        if (!this._droppedActor) return;
        this._droppedActor.mode = mode;
        if (mode === 'template') {
            this._pendingName = `${this._droppedActor.actorName} Pattern`;
            this._pendingPattern = this._droppedActor.templateText;
            this._pendingType = 'template';
            this._workingSequence = JSON.parse(JSON.stringify(this._droppedActor.templateSequence));
        } else {
            this._pendingName = `${this._droppedActor.actorName} Override`;
            this._pendingPattern = this._droppedActor.overrideKey;
            this._pendingType = 'override';
            this._workingSequence = JSON.parse(JSON.stringify(this._droppedActor.concreteSequence));
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async _renderHTML(_context: any, _options: any): Promise<HTMLElement> {
        const entries = autorecManager.getAllEntries().filter((e) => {
            if (!this._searchFilter) return true;
            const q = this._searchFilter.toLowerCase();
            return e.name.toLowerCase().includes(q) || e.pattern.toLowerCase().includes(q);
        });

        const selected = entries.find((e) => e.id === this._selectedId) ?? entries[0] ?? null;
        if (selected) {
            this._selectedId = selected.id;
            if (this._lastSelectedIdForWorking !== selected.id && !this._droppedActor) {
                this._workingSequence = JSON.parse(JSON.stringify(selected.sequence));
                this._lastSelectedIdForWorking = selected.id;
                this._pendingName = null;
                this._pendingPattern = null;
                this._pendingType = null;
            } else if (!this._workingSequence) {
                this._workingSequence = JSON.parse(JSON.stringify(selected.sequence));
                this._lastSelectedIdForWorking = selected.id;
            }
        } else {
            this._workingSequence = null;
            this._lastSelectedIdForWorking = null;
        }

        const templateEntries = entries.filter((e: AutorecEntry) => e.type === 'template');
        const overrideEntries = entries.filter((e: AutorecEntry) => e.type === 'override');
        const llmEntries = entries.filter((e: AutorecEntry) => e.type === 'llm');

        const sidebarSections = [];
        if (templateEntries.length > 0) {
            sidebarSections.push({
                title: 'Templates',
                icon: 'fas fa-scroll',
                count: templateEntries.length,
                entries: templateEntries.map((e: AutorecEntry) => ({ id: e.id, name: e.name, active: e.id === selected?.id }))
            });
        }
        if (overrideEntries.length > 0) {
            sidebarSections.push({
                title: 'Monster Overrides',
                icon: 'fas fa-dragon',
                count: overrideEntries.length,
                entries: overrideEntries.map((e) => ({ id: e.id, name: e.name, active: e.id === selected?.id }))
            });
        }
        if (llmEntries.length > 0) {
            sidebarSections.push({
                title: 'LLM Generated',
                icon: 'fas fa-robot',
                count: llmEntries.length,
                entries: llmEntries.map((e) => ({ id: e.id, name: e.name, active: e.id === selected?.id }))
            });
        }

        const displayName = this._pendingName ?? selected?.name ?? '';
        const displayPattern = this._pendingPattern ?? selected?.pattern ?? '';
        const isUnfilled = Boolean(selected && !displayPattern.trim() && (!this._workingSequence || this._workingSequence.length === 0) && !this._droppedActor);

        const seq = this._workingSequence && this._workingSequence.length > 0 ? this._workingSequence : [[['<ITEM_0>']]];
        const summaryHtml = summarizeSequenceInPlainEnglish(seq);

        const itemMapForChoices = this._droppedActor?.itemMap ?? selected?.llmMetadata?.itemMap;
        const activeChoices = STANDARD_TOKEN_CHOICES.map((c) => {
            const mappedWeapon = itemMapForChoices?.[c.value.toUpperCase()];
            return {
                value: c.value,
                label: mappedWeapon ? `${c.label} — ${mappedWeapon}` : c.label
            };
        });

        const stepCards = seq.map((section, sectionIdx) => {
            const nonEmptyFlows = (Array.isArray(section) ? section : []).filter((f) => f.length > 0);
            const hasOptionalExit = (Array.isArray(section) ? section : []).some((f) => f.length === 0);
            const displayFlows = nonEmptyFlows.length > 0 ? nonEmptyFlows : [['<ITEM_0>']];

            const branches = displayFlows.map((flow, flowIdx) => {
                const groups = groupFlowTokens(flow);
                const pills = groups.map((group, groupIdx) => {
                    const isStandard = activeChoices.some(
                        (c) => c.value.toLowerCase() === group.token.toLowerCase()
                    );
                    const options = activeChoices.map((c) => ({
                        value: c.value,
                        label: c.label,
                        selected: c.value.toLowerCase() === group.token.toLowerCase()
                    }));

                    return {
                        secIdx: sectionIdx,
                        flowIdx,
                        grpIdx: groupIdx,
                        hasConnector: groupIdx > 0,
                        group,
                        isStandard,
                        options
                    };
                });

                return {
                    secIdx: sectionIdx,
                    flowIdx,
                    isAlternative: flowIdx > 0,
                    canDeleteBranch: displayFlows.length > 1,
                    pills
                };
            });

            return {
                secIdx: sectionIdx,
                stepTitle: sectionIdx === 0 ? 'Step 1 (Initial Attacks)' : `Then Step ${sectionIdx + 1} (After Step ${sectionIdx})`,
                hasOptionalExit,
                canDeleteStep: seq.length > 1,
                branches
            };
        });

        const droppedActorCard = this._droppedActor ? {
            actorImg: this._droppedActor.actorImg,
            actorName: this._droppedActor.actorName,
            itemName: this._droppedActor.itemName,
            rawDescription: this._droppedActor.rawDescription,
            weaponMappings: Object.entries(this._droppedActor.itemMap).map(([k, v]) => ({
                label: formatTokenHumanLabel(k),
                target: v
            })),
            isTemplateMode: this._droppedActor.mode === 'template',
            isOverrideMode: this._droppedActor.mode === 'override'
        } : null;

        const llmReviewBanner = selected?.type === 'llm' ? {
            actorName: selected.llmMetadata?.actorName || 'Monster',
            itemName: selected.llmMetadata?.itemName || 'Multiattack',
            rawDescription: selected.llmMetadata?.rawDescription,
            overrideKey: selected.llmMetadata?.overrideKey ?? 'this monster',
            weaponMappings: selected.llmMetadata?.itemMap
                ? Object.entries(selected.llmMetadata.itemMap).map(([k, v]) => ({
                    label: formatTokenHumanLabel(k),
                    target: v
                }))
                : []
        } : null;

        const container = document.createElement('div');
        container.className = 'bam-autorec-container';

        container.innerHTML = await adapter.renderTemplate(
            `modules/${MODULE_ID}/templates/autorec-menu.html`,
            {
                searchPlaceholder: localize('BAM.autorecMenu.searchPlaceholder', 'Filter templates or monsters...'),
                searchFilter: this._searchFilter,
                addTemplateLabel: localize('BAM.autorecMenu.addTemplateBtn', 'Add Template'),
                resetDefaultsLabel: localize('BAM.autorecMenu.resetDefaultsBtn', 'Reset Defaults'),
                saveBtnLabel: localize('BAM.autorecMenu.saveBtn', 'Save Changes'),
                deleteBtnLabel: localize('BAM.autorecMenu.deleteBtn', 'Delete'),
                sidebarSections,
                hasSelected: Boolean(selected),
                isUnfilled,
                displayName,
                displayPattern,
                summaryHtml,
                stepCards,
                droppedActorCard,
                llmReviewBanner,
                enableLlmFallback: Boolean(game.settings?.get(MODULE_ID, 'enableLlmFallback')),
                rawSequenceJson: JSON.stringify(seq, null, 2)
            }
        );

        this._attachListeners(container, isUnfilled);
        return container;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _replaceHTML(result: HTMLElement, content: HTMLElement, _options: any): void {
        const wasSearchFocused = document.activeElement?.id === 'bam-search-input';
        const selectionStart = (document.activeElement as HTMLInputElement | null)?.selectionStart ?? null;
        const selectionEnd = (document.activeElement as HTMLInputElement | null)?.selectionEnd ?? null;

        content.replaceChildren(result);

        if (wasSearchFocused) {
            const newSearch = content.querySelector('#bam-search-input') as HTMLInputElement | null;
            if (newSearch) {
                newSearch.focus();
                if (selectionStart !== null && selectionEnd !== null) {
                    newSearch.setSelectionRange(selectionStart, selectionEnd);
                }
            }
        }
    }

    private _mutateFlowGroups(
        secIdx: number,
        flowIdx: number,
        mutator: (groups: GroupedAttackPill[]) => GroupedAttackPill[]
    ): void {
        if (!this._workingSequence) return;
        const section = this._workingSequence[secIdx];
        if (!section) return;
        const hasOptionalExit = section.some((f) => f.length === 0);
        const nonEmptyFlows = section.filter((f) => f.length > 0);
        const targetFlow = nonEmptyFlows[flowIdx] ?? ['<ITEM_0>'];
        const updatedGroups = mutator(groupFlowTokens(targetFlow));
        const expanded = expandGroupedTokens(updatedGroups);
        nonEmptyFlows[flowIdx] = expanded.length > 0 ? expanded : ['<ITEM_0>'];
        this._workingSequence[secIdx] = hasOptionalExit ? [...nonEmptyFlows, []] : nonEmptyFlows;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (this as any).render?.();
    }

    private _attachListeners(root: HTMLElement, isUnfilled: boolean = false): void {
        const searchInput = root.querySelector('#bam-search-input') as HTMLInputElement | null;
        searchInput?.addEventListener('input', (ev) => {
            this._searchFilter = (ev.target as HTMLInputElement).value;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (this as any).render?.();
        });

        root.querySelectorAll('.bam-sidebar-item').forEach((el) => {
            el.addEventListener('click', () => {
                this._selectedId = el.getAttribute('data-entry-id');
                this._workingSequence = null;
                this._droppedActor = null;
                this._pendingName = null;
                this._pendingPattern = null;
                this._pendingType = null;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (this as any).render?.();
            });
        });

        // Start Manual Setup button inside unfilled template screen
        root.querySelector('#bam-start-manual-btn')?.addEventListener('click', () => {
            this._pendingName = 'Custom Multiattack Template';
            this._pendingPattern = '<ACTOR> makes two attacks: one with its <ITEM_0> and one with its <ITEM_1>.';
            this._pendingType = 'template';
            this._workingSequence = [[['<ITEM_0>', '<ITEM_1>']]];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (this as any).render?.();
        });

        const dropZoneEl = root.querySelector('#bam-actor-dropzone') as HTMLElement | null;
        const addBtnEl = root.querySelector('#bam-add-template-btn') as HTMLElement | null;
        const inspectorEl = root.querySelector('.bam-autorec-inspector') as HTMLElement | null;

        // Allow dropping an Actor directly onto the "+ Add Template" button at any time
        if (addBtnEl) {
            addBtnEl.addEventListener('dragover', (ev: DragEvent) => {
                ev.preventDefault();
                if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
            });
            addBtnEl.addEventListener('drop', async (ev: DragEvent) => {
                ev.preventDefault();
                ev.stopPropagation();
                const rawData = ev.dataTransfer?.getData('text/plain');
                if (!rawData) return;
                try {
                    const data = JSON.parse(rawData) as Record<string, unknown>;
                    const actor = await adapter.resolveActorFromDropData(data);
                    if (!actor) return;
                    const created = await autorecManager.registerEntry({
                        id: '',
                        name: 'New Template',
                        type: 'template',
                        pattern: '',
                        sequence: [],
                        enabled: true
                    });
                    this._selectedId = created.id;
                    this._droppedActor = null;
                    await this.handleActorDrop(actor);
                } catch (_err) {
                    notify.warn('Invalid drag-and-drop payload.');
                }
            });
        }

        // Handle Drag & Drop on the inspector panel: ONLY allow drop if template is unfilled or already in droppedActor state
        if (inspectorEl) {
            inspectorEl.addEventListener('dragover', (ev: DragEvent) => {
                ev.preventDefault();
                if (isUnfilled || this._droppedActor) {
                    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
                    dropZoneEl?.classList.add('dragover');
                } else {
                    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'none';
                }
            });

            inspectorEl.addEventListener('dragleave', () => {
                dropZoneEl?.classList.remove('dragover');
            });

            inspectorEl.addEventListener('drop', async (ev: DragEvent) => {
                ev.preventDefault();
                ev.stopPropagation();
                dropZoneEl?.classList.remove('dragover');

                if (!isUnfilled && !this._droppedActor) {
                    notify.info('To prevent overwriting existing templates, click "+ Add Template" first (or drop the Actor directly onto the "+ Add Template" button).');
                    return;
                }

                const rawData = ev.dataTransfer?.getData('text/plain');
                if (!rawData) return;

                try {
                    const data = JSON.parse(rawData) as Record<string, unknown>;
                    const actor = await adapter.resolveActorFromDropData(data);
                    if (!actor) {
                        notify.warn('Could not resolve an Actor from the dropped item.');
                        return;
                    }
                    await this.handleActorDrop(actor);
                } catch (_err) {
                    notify.warn('Invalid drag-and-drop payload.');
                }
            });
        }

        // Dropped actor mode switch buttons
        root.querySelector('#bam-drop-mode-template')?.addEventListener('click', async () => {
            if (!this._droppedActor) return;
            const currentSelf = autorecManager.getAllEntries().find((e) => e.id === this._selectedId);
            const existingTemplate = autorecManager.findDuplicatePattern(this._droppedActor.templateText, undefined, 'template');
            if (existingTemplate) {
                if (currentSelf && !currentSelf.pattern.trim() && currentSelf.id !== existingTemplate.id) {
                    await autorecManager.deleteEntry(currentSelf.id, false);
                }
                this._selectedId = existingTemplate.id;
                notify.info(`Switched to existing template "${existingTemplate.name}".`);
            } else if (currentSelf && currentSelf.type === 'override' && currentSelf.pattern.trim()) {
                const created = await autorecManager.registerEntry({
                    id: '',
                    name: `${this._droppedActor.actorName} Pattern`,
                    type: 'template',
                    pattern: '',
                    sequence: [],
                    enabled: true
                }, false);
                this._selectedId = created.id;
            } else if (currentSelf && !currentSelf.pattern.trim()) {
                currentSelf.type = 'template';
                currentSelf.name = `${this._droppedActor.actorName} Pattern`;
            }
            this._applyDroppedActorMode('template');
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (this as any).render?.();
        });

        root.querySelector('#bam-drop-mode-override')?.addEventListener('click', async () => {
            if (!this._droppedActor) return;
            const currentSelf = autorecManager.getAllEntries().find((e) => e.id === this._selectedId);
            const existingOverride = autorecManager.findDuplicatePattern(this._droppedActor.overrideKey, undefined, 'override');
            if (existingOverride) {
                if (currentSelf && !currentSelf.pattern.trim() && currentSelf.id !== existingOverride.id) {
                    await autorecManager.deleteEntry(currentSelf.id, false);
                }
                this._selectedId = existingOverride.id;
                notify.info(`Switched to existing override "${existingOverride.name}".`);
            } else if (currentSelf && currentSelf.type === 'template' && currentSelf.pattern.trim()) {
                const created = await autorecManager.registerEntry({
                    id: '',
                    name: `${this._droppedActor.actorName} Override`,
                    type: 'override',
                    pattern: '',
                    sequence: [],
                    enabled: true
                }, false);
                this._selectedId = created.id;
                notify.info(`Created new Monster Override for "${this._droppedActor.actorName}" so template "${currentSelf.name}" remains unchanged.`);
            } else if (currentSelf && !currentSelf.pattern.trim()) {
                currentSelf.type = 'override';
                currentSelf.name = `${this._droppedActor.actorName} Override`;
            }
            this._applyDroppedActorMode('override');
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (this as any).render?.();
        });

        root.querySelector('#bam-clear-dropped-btn')?.addEventListener('click', () => {
            this._droppedActor = null;
            this._pendingName = '';
            this._pendingPattern = '';
            this._pendingType = 'template';
            this._workingSequence = [];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (this as any).render?.();
        });

        // Decrement pill count
        root.querySelectorAll('.bam-pill-dec').forEach((btn) => {
            btn.addEventListener('click', () => {
                const sec = Number(btn.getAttribute('data-sec'));
                const flow = Number(btn.getAttribute('data-flow'));
                const grp = Number(btn.getAttribute('data-grp'));
                this._mutateFlowGroups(sec, flow, (groups) => {
                    const target = groups[grp];
                    if (!target) return groups;
                    if (target.count > 1) {
                        target.count--;
                        return groups;
                    }
                    return groups.filter((_, i) => i !== grp);
                });
            });
        });

        // Increment pill count
        root.querySelectorAll('.bam-pill-inc').forEach((btn) => {
            btn.addEventListener('click', () => {
                const sec = Number(btn.getAttribute('data-sec'));
                const flow = Number(btn.getAttribute('data-flow'));
                const grp = Number(btn.getAttribute('data-grp'));
                this._mutateFlowGroups(sec, flow, (groups) => {
                    if (groups[grp]) groups[grp]!.count++;
                    return groups;
                });
            });
        });

        // Select token change
        root.querySelectorAll('.bam-pill-select').forEach((sel) => {
            sel.addEventListener('change', (ev) => {
                const val = (ev.target as HTMLSelectElement).value;
                const sec = Number(sel.getAttribute('data-sec'));
                const flow = Number(sel.getAttribute('data-flow'));
                const grp = Number(sel.getAttribute('data-grp'));
                this._mutateFlowGroups(sec, flow, (groups) => {
                    if (groups[grp]) {
                        groups[grp]!.token = val === '__CUSTOM__' ? 'Bite' : val;
                    }
                    return groups;
                });
            });
        });

        // Custom input change
        root.querySelectorAll('.bam-pill-custom-input').forEach((inp) => {
            inp.addEventListener('change', (ev) => {
                const val = (ev.target as HTMLInputElement).value.trim();
                const sec = Number(inp.getAttribute('data-sec'));
                const flow = Number(inp.getAttribute('data-flow'));
                const grp = Number(inp.getAttribute('data-grp'));
                if (!val) return;
                this._mutateFlowGroups(sec, flow, (groups) => {
                    if (groups[grp]) groups[grp]!.token = val;
                    return groups;
                });
            });
        });

        // Toggle strict order (`>`)
        root.querySelectorAll('.bam-pill-order').forEach((btn) => {
            btn.addEventListener('click', () => {
                const sec = Number(btn.getAttribute('data-sec'));
                const flow = Number(btn.getAttribute('data-flow'));
                const grp = Number(btn.getAttribute('data-grp'));
                this._mutateFlowGroups(sec, flow, (groups) => {
                    if (groups[grp]) groups[grp]!.strictOrder = !groups[grp]!.strictOrder;
                    return groups;
                });
            });
        });

        // Delete pill
        root.querySelectorAll('.bam-pill-del').forEach((btn) => {
            btn.addEventListener('click', () => {
                const sec = Number(btn.getAttribute('data-sec'));
                const flow = Number(btn.getAttribute('data-flow'));
                const grp = Number(btn.getAttribute('data-grp'));
                this._mutateFlowGroups(sec, flow, (groups) => groups.filter((_, i) => i !== grp));
            });
        });

        // Auto-Build from Pattern Text button
        root.querySelector('#bam-parse-pattern-btn')?.addEventListener('click', () => {
            const patternEl = root.querySelector('#bam-edit-pattern') as HTMLInputElement | null;
            const nameEl = root.querySelector('#bam-edit-name') as HTMLInputElement | null;
            if (!patternEl || !patternEl.value.trim()) {
                notify.warn('Enter a sentence in Pattern / Key first.');
                return;
            }
            const rawText = patternEl.value.trim();
            if (nameEl) this._pendingName = nameEl.value;

            let templateToParse = rawText;
            let itemMap: Record<string, string> = {};
            if (!/<ITEM_\d+>/i.test(rawText)) {
                const candidateMatches = Array.from(
                    rawText.matchAll(/\b(?:with\s+(?:its|his|her|their)\s+|two\s+|three\s+|four\s+|one\s+)([\p{L}\s-]+?)(?=\s+attacks?\b|\s+then\b|,|\s+or\b|\.)/giu)
                );
                const mockItems = candidateMatches
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    .map((m) => ({ name: (m[1] ?? '').trim() } as any))
                    .filter((i) => i.name.length > 1);
                const abstracted = abstractMultiattackDescription(rawText, mockItems);
                if (abstracted.template) {
                    templateToParse = abstracted.template;
                    itemMap = abstracted.itemMap;
                }
            }

            const parsed = parseMultiattackTemplate(templateToParse);
            if (!parsed) {
                notify.warn('Could not automatically parse sentence. You can build it using + Attack, + Then, and + Add "OR" Alternative Branch below.');
                return;
            }

            const currentSelf = autorecManager.getAllEntries().find((e) => e.id === this._selectedId);
            const isOverride = this._pendingType === 'override' || currentSelf?.type === 'override' || rawText.includes('::');
            if (isOverride && Object.keys(itemMap).length > 0) {
                this._workingSequence = hydrateMultiattackSequence(parsed, itemMap);
                this._pendingPattern = rawText;
            } else {
                this._workingSequence = parsed;
                this._pendingPattern = templateToParse;
            }
            notify.info('Built visual attack sequence from pattern text!');
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (this as any).render?.();
        });

        // LLM Sequence Repair Agent button & Enter key
        const llmRepairBtn = root.querySelector('#bam-llm-repair-btn') as HTMLButtonElement | null;
        const llmFeedbackInput = root.querySelector('#bam-llm-feedback-input') as HTMLInputElement | null;

        const handleLlmRepair = async () => {
            if (!llmFeedbackInput || !llmRepairBtn) return;
            const feedback = llmFeedbackInput.value.trim();
            if (!feedback) {
                notify.warn('Please describe what is wrong or how you want the sequence adjusted first.');
                return;
            }
            const patternEl = root.querySelector('#bam-edit-pattern') as HTMLInputElement | null;
            const nameEl = root.querySelector('#bam-edit-name') as HTMLInputElement | null;
            if (nameEl) this._pendingName = nameEl.value;
            if (patternEl) this._pendingPattern = patternEl.value;

            const description = this._droppedActor?.rawDescription
                ? `${this._droppedActor.rawDescription} (Pattern: ${patternEl?.value ?? ''})`
                : (patternEl?.value ?? '');
            const currentSeq = this._workingSequence && this._workingSequence.length > 0
                ? this._workingSequence
                : [[['<ITEM_0>']]];

            const originalHtml = llmRepairBtn.innerHTML;
            llmRepairBtn.disabled = true;
            llmRepairBtn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Fixing...`;

            try {
                const fixedSequence = await llmClient.repairMultiattackSequence({
                    description,
                    currentSequence: currentSeq,
                    userFeedback: feedback
                });

                if (fixedSequence) {
                    this._workingSequence = fixedSequence;
                    notify.info('LLM Agent repaired the multiattack sequence!');
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    (this as any).render?.();
                } else {
                    notify.warn('LLM Agent could not produce a valid sequence. Check your LLM API key/settings or refine your feedback.');
                }
            } finally {
                if (llmRepairBtn) {
                    llmRepairBtn.disabled = false;
                    llmRepairBtn.innerHTML = originalHtml;
                }
            }
        };

        llmRepairBtn?.addEventListener('click', handleLlmRepair);
        llmFeedbackInput?.addEventListener('keydown', (ev: KeyboardEvent) => {
            if (ev.key === 'Enter') {
                ev.preventDefault();
                handleLlmRepair();
            }
        });

        // Add Attack Pill to branch
        root.querySelectorAll('.bam-add-pill-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                const sec = Number(btn.getAttribute('data-sec'));
                const flow = Number(btn.getAttribute('data-flow'));
                this._mutateFlowGroups(sec, flow, (groups) => {
                    const nextIdx = groups.length;
                    const nextToken = nextIdx < 4 ? `<ITEM_${nextIdx}>` : '<ITEM_0>';
                    groups.push({ token: nextToken, count: 1, strictOrder: false });
                    return groups;
                });
            });
        });

        // Add sequential 'THEN' Attack Pill inside branch
        root.querySelectorAll('.bam-add-then-pill-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                const sec = Number(btn.getAttribute('data-sec'));
                const flow = Number(btn.getAttribute('data-flow'));
                this._mutateFlowGroups(sec, flow, (groups) => {
                    const nextIdx = groups.length;
                    const nextToken = nextIdx < 4 ? `<ITEM_${nextIdx}>` : '<ITEM_0>';
                    groups.push({ token: nextToken, count: 1, strictOrder: true });
                    return groups;
                });
            });
        });

        // Add OR branch to Step
        root.querySelectorAll('.bam-add-branch-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                if (!this._workingSequence) return;
                const sec = Number(btn.getAttribute('data-sec'));
                const section = this._workingSequence[sec];
                if (!section) return;
                const hasOptionalExit = section.some((f) => f.length === 0);
                const nonEmptyFlows = section.filter((f) => f.length > 0);
                const usedCount = nonEmptyFlows.reduce((acc, f) => acc + groupFlowTokens(f).length, 0);
                const nextToken = usedCount < 4 ? `<ITEM_${usedCount}>` : '<ITEM_0>';
                nonEmptyFlows.push([nextToken]);
                this._workingSequence[sec] = hasOptionalExit ? [...nonEmptyFlows, []] : nonEmptyFlows;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (this as any).render?.();
            });
        });

        // Delete OR branch
        root.querySelectorAll('.bam-del-branch-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                if (!this._workingSequence) return;
                const sec = Number(btn.getAttribute('data-sec'));
                const flow = Number(btn.getAttribute('data-flow'));
                const section = this._workingSequence[sec];
                if (!section) return;
                const hasOptionalExit = section.some((f) => f.length === 0);
                const nonEmptyFlows = section.filter((f) => f.length > 0).filter((_, i) => i !== flow);
                this._workingSequence[sec] = hasOptionalExit ? [...nonEmptyFlows, []] : nonEmptyFlows;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (this as any).render?.();
            });
        });

        // Toggle Optional / Can Finish Early checkbox
        root.querySelectorAll('.bam-step-optional-cb').forEach((cb) => {
            cb.addEventListener('change', (ev) => {
                if (!this._workingSequence) return;
                const sec = Number(cb.getAttribute('data-sec'));
                const checked = (ev.target as HTMLInputElement).checked;
                const section = this._workingSequence[sec];
                if (!section) return;
                const nonEmptyFlows = section.filter((f) => f.length > 0);
                this._workingSequence[sec] = checked ? [...nonEmptyFlows, []] : nonEmptyFlows;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (this as any).render?.();
            });
        });

        // Add "Then" Sequential Step
        const addStepBtn = root.querySelector('#bam-add-step-btn');
        addStepBtn?.addEventListener('click', () => {
            if (!this._workingSequence) return;
            this._workingSequence.push([['<ITEM_0>']]);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (this as any).render?.();
        });

        // Delete Step
        root.querySelectorAll('.bam-del-step-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                if (!this._workingSequence || this._workingSequence.length <= 1) return;
                const sec = Number(btn.getAttribute('data-sec'));
                this._workingSequence = this._workingSequence.filter((_, i) => i !== sec);
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (this as any).render?.();
            });
        });

        // Raw JSON textarea manual edit sync
        const rawJsonEl = root.querySelector('#bam-edit-sequence') as HTMLTextAreaElement | null;
        rawJsonEl?.addEventListener('change', () => {
            try {
                const parsed = JSON.parse(rawJsonEl.value);
                if (Array.isArray(parsed)) {
                    this._workingSequence = parsed;
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    (this as any).render?.();
                }
            } catch (_e) {
                // Keep working sequence if JSON is mid-edit invalid
            }
        });

        const addBtn = root.querySelector('#bam-add-template-btn');
        addBtn?.addEventListener('click', async () => {
            const newEntry = await autorecManager.registerEntry({
                id: '',
                name: 'New Template',
                type: 'template',
                pattern: '',
                sequence: [],
                enabled: true
            });
            this._selectedId = newEntry.id;
            this._workingSequence = [];
            this._droppedActor = null;
            this._pendingName = '';
            this._pendingPattern = '';
            this._pendingType = 'template';
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (this as any).render?.();
        });

        const resetBtn = root.querySelector('#bam-reset-defaults-btn');
        resetBtn?.addEventListener('click', async () => {
            await autorecManager.resetToDefaults(true);
            this._workingSequence = null;
            this._droppedActor = null;
            this._pendingName = null;
            this._pendingPattern = null;
            this._pendingType = null;
            notify.info('Reset multiattack autorecognition entries to system defaults.');
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (this as any).render?.();
        });

        // Approve LLM Generated entry as Generic Template
        const approveTemplateBtn = root.querySelector('#bam-approve-template-btn');
        approveTemplateBtn?.addEventListener('click', async () => {
            if (!this._selectedId) return;
            const currentSelf = autorecManager.getAllEntries().find((e) => e.id === this._selectedId);
            if (!currentSelf) return;

            const nameEl = root.querySelector('#bam-edit-name') as HTMLInputElement | null;
            const patternEl = root.querySelector('#bam-edit-pattern') as HTMLInputElement | null;

            const rawName = (nameEl?.value ?? currentSelf.name).trim();
            const cleanName = rawName.replace(/\s*\(LLM Generated\)/i, ' Pattern');
            const templatePattern = currentSelf.llmMetadata?.templatePattern ?? (patternEl?.value ?? currentSelf.pattern).trim();

            const reverseMap: Record<string, string> = {};
            for (const [k, v] of Object.entries(currentSelf.llmMetadata?.itemMap ?? {})) {
                reverseMap[v.toLowerCase()] = k;
            }

            const baseSeq = this._workingSequence && this._workingSequence.length > 0
                ? this._workingSequence
                : currentSelf.sequence;

            const abstractSeq: MultiattackSequence = baseSeq.map((sec) =>
                sec.map((flow) =>
                    flow.map((tok) => {
                        const strict = tok.trim().startsWith('>');
                        const clean = stripOrderPrefix(tok);
                        const mapped = reverseMap[clean.toLowerCase()] ?? clean;
                        return strict ? `>${mapped}` : mapped;
                    })
                )
            );

            const saved = await autorecManager.registerEntry({
                id: currentSelf.id,
                name: cleanName,
                type: 'template',
                pattern: templatePattern,
                sequence: abstractSeq,
                enabled: true,
                sourceModule: 'world',
                llmMetadata: undefined
            });
            this._selectedId = saved.id;
            this._pendingName = null;
            this._pendingPattern = null;
            this._pendingType = null;
            this._workingSequence = null;
            notify.info(`Approved "${saved.name}" as a Generic Template and moved to Templates!`);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (this as any).render?.();
        });

        // Approve LLM Generated entry as Monster Override
        const approveOverrideBtn = root.querySelector('#bam-approve-override-btn');
        approveOverrideBtn?.addEventListener('click', async () => {
            if (!this._selectedId) return;
            const currentSelf = autorecManager.getAllEntries().find((e) => e.id === this._selectedId);
            if (!currentSelf) return;

            const nameEl = root.querySelector('#bam-edit-name') as HTMLInputElement | null;
            const patternEl = root.querySelector('#bam-edit-pattern') as HTMLInputElement | null;

            const actorName = currentSelf.llmMetadata?.actorName ?? 'Monster';
            const rawName = (nameEl?.value ?? currentSelf.name).trim();
            const overrideName = currentSelf.llmMetadata?.actorName
                ? `${actorName} Override`
                : rawName.replace(/\s*\(LLM Generated\)/i, ' Override');
            const overrideKey = currentSelf.llmMetadata?.overrideKey ?? (
                patternEl?.value?.includes('::') ? patternEl.value.trim() : `${actorName}::Multiattack`
            );

            const baseSeq = this._workingSequence && this._workingSequence.length > 0
                ? this._workingSequence
                : currentSelf.sequence;

            const concreteSeq = hydrateMultiattackSequence(baseSeq, currentSelf.llmMetadata?.itemMap ?? {});

            const saved = await autorecManager.registerEntry({
                id: currentSelf.id,
                name: overrideName,
                type: 'override',
                pattern: overrideKey,
                sequence: concreteSeq,
                enabled: true,
                sourceModule: 'world',
                llmMetadata: undefined
            });
            this._selectedId = saved.id;
            this._pendingName = null;
            this._pendingPattern = null;
            this._pendingType = null;
            this._workingSequence = null;
            notify.info(`Approved "${saved.name}" as a Monster Override and moved to Monster Overrides!`);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (this as any).render?.();
        });

        const saveBtn = root.querySelector('#bam-save-btn');
        saveBtn?.addEventListener('click', async () => {
            if (!this._selectedId) return;
            const nameEl = root.querySelector('#bam-edit-name') as HTMLInputElement | null;
            const patternEl = root.querySelector('#bam-edit-pattern') as HTMLInputElement | null;
            const seqEl = root.querySelector('#bam-edit-sequence') as HTMLTextAreaElement | null;
            if (!nameEl || !patternEl) return;

            const rawPattern = patternEl.value.trim();
            if (!rawPattern) {
                notify.warn('Pattern / Key cannot be empty.');
                return;
            }

            const currentSelf = autorecManager.getAllEntries().find((e) => e.id === this._selectedId);
            const entryType: 'override' | 'template' | 'llm' = this._pendingType ?? (rawPattern.includes('::') ? 'override' : (currentSelf?.type ?? 'template'));

            const existingDuplicate = autorecManager.findDuplicatePattern(rawPattern, this._selectedId, entryType);
            if (existingDuplicate) {
                notify.warn(`Pattern already exists in ${entryType === 'override' ? 'Monster Overrides' : (entryType === 'llm' ? 'LLM Generated' : 'Templates')} under "${existingDuplicate.name}". Switched to existing entry.`);
                if (currentSelf && !currentSelf.pattern.trim()) {
                    await autorecManager.deleteEntry(this._selectedId, false);
                }
                this._selectedId = existingDuplicate.id;
                this._droppedActor = null;
                this._pendingName = null;
                this._pendingPattern = null;
                this._pendingType = null;
                this._workingSequence = null;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (this as any).render?.();
                return;
            }

            try {
                const parsedSeq = this._workingSequence && this._workingSequence.length > 0
                    ? this._workingSequence
                    : (seqEl ? JSON.parse(seqEl.value) : [[['<ITEM_0>']]]);
                const saved = await autorecManager.registerEntry({
                    id: this._selectedId,
                    name: nameEl.value.trim(),
                    type: entryType,
                    pattern: rawPattern,
                    sequence: parsedSeq,
                    enabled: true,
                    llmMetadata: entryType === 'llm' ? currentSelf?.llmMetadata : undefined
                });
                this._selectedId = saved.id;
                this._droppedActor = null;
                this._pendingName = null;
                this._pendingPattern = null;
                this._pendingType = null;
                notify.info(`Saved Multiattack Autorec entry: "${nameEl.value.trim()}"`);
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (this as any).render?.();
            } catch (_err) {
                notify.error('Invalid Multiattack sequence format.');
            }
        });

        const deleteBtn = root.querySelector('#bam-delete-btn');
        deleteBtn?.addEventListener('click', async () => {
            if (!this._selectedId) return;
            const deletedEntry = autorecManager.getAllEntries().find((e) => e.id === this._selectedId);
            await autorecManager.deleteEntry(this._selectedId);
            this._selectedId = null;
            this._workingSequence = null;
            this._droppedActor = null;
            this._pendingName = null;
            this._pendingPattern = null;
            this._pendingType = null;
            if (deletedEntry) {
                notify.info(`Deleted Multiattack Autorec entry: "${deletedEntry.name}"`);
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (this as any).render?.();
        });
    }

    /**
     * Helper to test how a raw description abstracts and parses deterministically.
     */
    static previewParse(description: string, itemNames: string[], actorName: string = 'Monster'): {
        template: string;
        itemMap: Record<string, string>;
        sequence: unknown;
    } {
        const mockItems = itemNames.map((name) => ({ name } as unknown as Item));
        const { template, itemMap } = abstractMultiattackDescription(description, mockItems, actorName);
        const sequence = parseMultiattackTemplate(template);
        return { template, itemMap, sequence };
    }
}


