import { MODULE_ID } from '../constants.js';
import { adapter } from '../adapter/index.js';
import { notify } from '../lib/logger.js';
import { llmClient } from '../multiattack/llm-client.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const BaseApp = (foundry as any)?.applications?.api?.ApplicationV2 ?? class {};

/**
 * ApplicationV2 Menu for configuring Automated Support (LLM fallback & JSON repair agent settings).
 */
export class AutomatedSupportMenuApplication extends BaseApp {
    static DEFAULT_OPTIONS = {
        id: 'bam-automated-support-menu',
        tag: 'div',
        window: {
            title: 'Automated Support',
            icon: 'fa-solid fa-robot',
            resizable: true
        },
        position: {
            width: 540,
            height: 520
        },
        classes: ['bam-autorec-app']
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async _renderHTML(_context: any, _options: any): Promise<HTMLElement> {
        const container = document.createElement('div');
        container.className = 'bam-autorec-container';
        container.style.padding = '16px';
        container.style.display = 'flex';
        container.style.flexDirection = 'column';
        container.style.gap = '12px';

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const settingsApi = (game as any)?.settings;
        const enableLlmFallback = Boolean(settingsApi?.get(MODULE_ID, 'enableLlmFallback') ?? false);
        const llmProvider = String(settingsApi?.get(MODULE_ID, 'llmProvider') ?? 'openai');
        const llmApiKey = String(settingsApi?.get(MODULE_ID, 'llmApiKey') ?? '');
        const llmModel = String(settingsApi?.get(MODULE_ID, 'llmModel') ?? 'gpt-4o-mini');
        const llmEndpoint = String(settingsApi?.get(MODULE_ID, 'llmEndpoint') ?? '');

        container.innerHTML = await adapter.renderTemplate(
            `modules/${MODULE_ID}/templates/automated-support.html`,
            {
                enableLlmFallback,
                llmProvider,
                llmApiKey: llmApiKey.replace(/"/g, '&quot;'),
                llmModel: llmModel.replace(/"/g, '&quot;'),
                llmEndpoint: llmEndpoint.replace(/"/g, '&quot;')
            }
        );

        const toggleKeyBtn = container.querySelector('#bam-toggle-key-btn');
        const keyInput = container.querySelector('#bam-llm-api-key') as HTMLInputElement | null;
        toggleKeyBtn?.addEventListener('click', () => {
            if (!keyInput) return;
            const isPassword = keyInput.type === 'password';
            keyInput.type = isPassword ? 'text' : 'password';
            toggleKeyBtn.innerHTML = isPassword
                ? '<i class="fas fa-eye-slash"></i>'
                : '<i class="fas fa-eye"></i>';
        });

        const getFormValues = () => {
            const enableEl = container.querySelector('#bam-llm-enable') as HTMLInputElement | null;
            const providerEl = container.querySelector('#bam-llm-provider') as HTMLSelectElement | null;
            const modelEl = container.querySelector('#bam-llm-model') as HTMLInputElement | null;
            const endpointEl = container.querySelector('#bam-llm-endpoint') as HTMLInputElement | null;
            return {
                enableLlmFallback: Boolean(enableEl?.checked ?? false),
                llmProvider: providerEl?.value ?? 'openai',
                llmApiKey: keyInput?.value?.trim() ?? '',
                llmModel: modelEl?.value?.trim() ?? 'gpt-4o-mini',
                llmEndpoint: endpointEl?.value?.trim() ?? ''
            };
        };

        const statusEl = container.querySelector('#bam-llm-test-status') as HTMLElement | null;
        const testBtn = container.querySelector('#bam-test-llm-btn');
        testBtn?.addEventListener('click', async () => {
            const values = getFormValues();
            if (statusEl) {
                statusEl.style.display = 'block';
                statusEl.style.background = 'rgba(59, 130, 246, 0.15)';
                statusEl.style.border = '1px solid rgba(59, 130, 246, 0.4)';
                statusEl.style.color = '#93c5fd';
                statusEl.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Testing connection with sample multiattack pattern...';
            }

            try {
                const result = await llmClient.queryMultiattackTemplate(
                    '<ACTOR> makes two <ITEM_0> attacks.',
                    {
                        provider: values.llmProvider,
                        apiKey: values.llmApiKey,
                        model: values.llmModel,
                        endpoint: values.llmEndpoint
                    }
                );
                if (result && Array.isArray(result)) {
                    if (statusEl) {
                        statusEl.style.background = 'rgba(16, 185, 129, 0.15)';
                        statusEl.style.border = '1px solid rgba(16, 185, 129, 0.4)';
                        statusEl.style.color = '#6ee7b7';
                        statusEl.innerHTML = `<i class="fas fa-check-circle"></i> Connection successful! Parsed sample as <code>${JSON.stringify(result)}</code>`;
                    }
                } else {
                    if (statusEl) {
                        statusEl.style.background = 'rgba(239, 68, 68, 0.15)';
                        statusEl.style.border = '1px solid rgba(239, 68, 68, 0.4)';
                        statusEl.style.color = '#fca5a5';
                        statusEl.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Connection failed or returned invalid sequence format. Check API key, model, or console logs.';
                    }
                }
            } catch (err) {
                if (statusEl) {
                    statusEl.style.background = 'rgba(239, 68, 68, 0.15)';
                    statusEl.style.border = '1px solid rgba(239, 68, 68, 0.4)';
                    statusEl.style.color = '#fca5a5';
                    statusEl.innerHTML = `<i class="fas fa-times-circle"></i> Error testing connection: ${(err as Error)?.message ?? String(err)}`;
                }
            }
        });

        const saveBtn = container.querySelector('#bam-save-llm-btn');
        saveBtn?.addEventListener('click', async () => {
            const values = getFormValues();
            if (settingsApi) {
                await settingsApi.set(MODULE_ID, 'enableLlmFallback', values.enableLlmFallback);
                await settingsApi.set(MODULE_ID, 'llmProvider', values.llmProvider);
                await settingsApi.set(MODULE_ID, 'llmApiKey', values.llmApiKey);
                await settingsApi.set(MODULE_ID, 'llmModel', values.llmModel);
                await settingsApi.set(MODULE_ID, 'llmEndpoint', values.llmEndpoint);
            }
            notify.info('Saved Automated Support settings.');
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (this as any).close?.();
        });

        return container;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _replaceHTML(result: HTMLElement, content: HTMLElement, _options: any): void {
        content.replaceChildren(result);
    }
}
