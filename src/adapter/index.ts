import { initializeFoundryAdapter, BaseFoundryAdapter } from './foundry/index.js';
import type { SelectDialogConfig } from './foundry/base-foundry-adapter.js';
import { initializeSystemAdapter, BaseSystemAdapter } from './system/index.js';
import type { MultiattackContext } from './system/base-system-adapter.js';
import { log } from '../lib/logger.js';
import type { SelectOptionItem } from '../types/global.d.js';

/**
 * Unified Adapter Singleton for Bakana's Automated Multiattack.
 * Delegates all platform-specific, canvas, dialog, and system operations.
 */
class Adapter {
    foundry: BaseFoundryAdapter;
    system: BaseSystemAdapter;

    constructor() {
        this.foundry = initializeFoundryAdapter();
        this.system = initializeSystemAdapter(game?.system?.id ?? 'dnd5e', this.foundry);
    }

    init(): void {
        this.foundry = initializeFoundryAdapter();
        this.system = initializeSystemAdapter(game.system?.id, this.foundry);
        log.info(`Unified Adapter initialized [Foundry: v${this.foundry.generation}, System: ${this.system.systemId}]`);
    }

    getSpeakerToken(message: ChatMessage | null | undefined): Token | null {
        return this.foundry.getSpeakerToken(message);
    }

    getSpeakerActor(message: ChatMessage | null | undefined): Actor | null {
        return this.foundry.getSpeakerActor(message);
    }

    isUserInCharge(token: Token | null, actor: Actor | null = null, user: User | null = game.user ?? null): boolean {
        return this.foundry.isUserInCharge(token, actor, user);
    }

    isMessageAuthor(message: ChatMessage | null | undefined, hookUserId?: string): boolean {
        return this.foundry.isMessageAuthor(message, hookUserId);
    }

    isMultiattackMessage(message: ChatMessage): boolean {
        return this.system.isMultiattackMessage(message);
    }

    extractMultiattackContext(message: ChatMessage): MultiattackContext | null {
        return this.system.extractMultiattackContext(message);
    }

    registerItemUsageHook(callback: (actor: Actor, item: Item, token: Token | null) => Promise<void> | void): void {
        this.system.registerItemUsageHook(callback);
    }

    async useItem(item: Item, options: Record<string, unknown> = {}): Promise<unknown> {
        return this.system.useItem(item, options);
    }

    getActorItems(actor: Actor): Item[] {
        return this.system.getActorItems(actor);
    }

    isMultiattackItem(item: Item): boolean {
        return this.system.isMultiattackItem(item);
    }

    getItemDescription(item: Item): string {
        return this.system.getItemDescription(item);
    }

    getItemActionType(item: Item): 'mwak' | 'rwak' | 'msak' | 'rsak' | 'other' {
        return this.system.getItemActionType(item);
    }

    async resolveActorFromDropData(data: Record<string, unknown>): Promise<Actor | null> {
        return this.foundry.resolveActorFromDropData(data);
    }

    async selectOptionDialog(options: SelectOptionItem[], config: SelectDialogConfig = {}): Promise<string | null> {
        return this.foundry.selectOptionDialog(options, config);
    }

    mergeObject<T extends object, U extends object>(original: T, other: U = {} as U, options: Record<string, unknown> = {}): T & U {
        return this.foundry.mergeObject(original, other, options);
    }

    deepClone<T>(obj: T): T {
        return this.foundry.deepClone(obj);
    }

    async renderTemplate(path: string, data: Record<string, unknown> = {}): Promise<string> {
        return this.foundry.renderTemplate(path, data);
    }

    async loadTemplates(paths: string[]): Promise<unknown> {
        return this.foundry.loadTemplates(paths);
    }

    randomID(length: number = 16): string {
        return this.foundry.randomID(length);
    }
}

export const adapter = new Adapter();
export { Adapter, BaseFoundryAdapter, BaseSystemAdapter };
