import { MODULE_ID } from '../constants.js';
import { adapter } from '../adapter/index.js';
import { autorecManager } from './autorecManager.js';
import { notify } from '../lib/logger.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const BaseApp = (foundry as any)?.applications?.api?.ApplicationV2 ?? class {};

/**
 * ApplicationV2 Menu for importing and exporting central Multiattack Autorecognition entries as JSON.
 */
export class AutorecExchangeMenuApplication extends BaseApp {
    static DEFAULT_OPTIONS = {
        id: 'bam-autorec-exchange-menu',
        tag: 'div',
        window: {
            title: 'Import / Export Multiattack Autorec JSON',
            icon: 'fa-solid fa-file-import',
            resizable: true
        },
        position: {
            width: 520,
            height: 420
        },
        classes: ['bam-autorec-app']
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async _renderHTML(_context: any, _options: any): Promise<HTMLElement> {
        const container = document.createElement('div');
        container.className = 'bam-autorec-container';
        container.style.padding = '16px';
        container.style.gap = '12px';

        const currentJson = JSON.stringify(autorecManager.getAllEntries(), null, 2);

        container.innerHTML = await adapter.renderTemplate(
            `modules/${MODULE_ID}/templates/autorec-exchange.html`,
            { currentJson }
        );

        const importBtn = container.querySelector('#bam-import-json-btn');
        importBtn?.addEventListener('click', async () => {
            const textEl = container.querySelector('#bam-exchange-json') as HTMLTextAreaElement | null;
            if (!textEl) return;
            try {
                const parsed = JSON.parse(textEl.value);
                autorecManager.loadSavedEntries(parsed);
                await autorecManager.saveToSettings();
                notify.info('Successfully imported Multiattack Autorecognition entries.');
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (this as any).close?.();
            } catch (_err) {
                notify.error('Failed to import JSON: Invalid JSON structure.');
            }
        });

        return container;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _replaceHTML(result: HTMLElement, content: HTMLElement, _options: any): void {
        content.replaceChildren(result);
    }
}
