import * as vscode from 'vscode';
import { SecretStorageService } from '../services/SecretStorageService.js';
import { ProviderFactory } from '../providers/ProviderFactory.js';

export interface ProviderQuickPickItem extends vscode.QuickPickItem {
	providerId: string;
}

export const KNOWN_HOSTED_PROVIDERS: readonly ProviderQuickPickItem[] = [
	{
		label: '$(cloud) OpenAI-Compatible',
		description: 'Groq, OpenRouter, Together AI, LocalAI, etc.',
		providerId: 'openai-compatible'
	},
	{
		label: '$(zap) Groq',
		description: 'GroqCloud (Llama 3.3, Qwen 2.5 Coder)',
		providerId: 'groq'
	}
];

/**
 * Core handler logic for devpilot.setApiKey command.
 */
export async function handleSetApiKeyCommand(
	secretStorageService: SecretStorageService,
	targetProviderId?: string
): Promise<boolean> {
	let providerId = typeof targetProviderId === 'string' ? targetProviderId.trim() : undefined;

	if (!providerId) {
		const selection = await vscode.window.showQuickPick(
			[
				...KNOWN_HOSTED_PROVIDERS,
				{
					label: '$(edit) Custom Provider ID...',
					description: 'Enter a custom provider identifier',
					providerId: '__custom__'
				}
			],
			{
				placeHolder: 'Select the LLM provider to configure an API key for',
				title: 'DevPilot: Set Provider API Key'
			}
		);

		if (!selection) {
			return false;
		}

		if (selection.providerId === '__custom__') {
			const customId = await vscode.window.showInputBox({
				prompt: 'Enter the provider identifier (e.g. openrouter, mistral)',
				title: 'DevPilot: Custom Provider Identifier',
				validateInput: (val) => {
					const trimmed = val ? val.trim() : '';
					if (!trimmed) {
						return 'Provider ID cannot be empty.';
					}
					if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
						return 'Provider ID must contain only alphanumeric characters, dashes, or underscores.';
					}
					return null;
				}
			});

			if (!customId || customId.trim().length === 0) {
				return false;
			}
			providerId = customId.trim();
		} else {
			providerId = selection.providerId;
		}
	}

	const apiKey = await vscode.window.showInputBox({
		prompt: `Enter API key for "${providerId}"`,
		title: `DevPilot: Enter API Key (${providerId})`,
		password: true,
		ignoreFocusOut: true,
		validateInput: (val) => {
			if (!val || val.trim().length === 0) {
				return 'API key cannot be empty.';
			}
			return null;
		}
	});

	if (apiKey === undefined) {
		// User cancelled
		return false;
	}

	try {
		await secretStorageService.storeApiKey(providerId, apiKey);
		vscode.window.showInformationMessage(`DevPilot: API key for "${providerId}" has been securely saved.`);
		return true;
	} catch (err) {
		const errMsg = err instanceof Error ? err.message : String(err);
		vscode.window.showErrorMessage(`DevPilot: Failed to save API key: ${errMsg}`);
		return false;
	}
}

/**
 * Core handler logic for devpilot.clearApiKey command.
 */
export async function handleClearApiKeyCommand(
	secretStorageService: SecretStorageService,
	targetProviderId?: string
): Promise<boolean> {
	let providerId = typeof targetProviderId === 'string' ? targetProviderId.trim() : undefined;

	if (!providerId) {
		const selection = await vscode.window.showQuickPick(
			[
				...KNOWN_HOSTED_PROVIDERS,
				{
					label: '$(trash) Custom Provider ID...',
					description: 'Specify a custom provider identifier to clear',
					providerId: '__custom__'
				}
			],
			{
				placeHolder: 'Select the LLM provider whose API key you want to remove',
				title: 'DevPilot: Clear Provider API Key'
			}
		);

		if (!selection) {
			return false;
		}

		if (selection.providerId === '__custom__') {
			const customId = await vscode.window.showInputBox({
				prompt: 'Enter the provider identifier to clear',
				title: 'DevPilot: Custom Provider Identifier',
				validateInput: (val) => (!val || !val.trim() ? 'Provider ID cannot be empty.' : null)
			});

			if (!customId || customId.trim().length === 0) {
				return false;
			}
			providerId = customId.trim();
		} else {
			providerId = selection.providerId;
		}
	}

	const hasKey = await secretStorageService.hasApiKey(providerId);
	if (!hasKey) {
		vscode.window.showInformationMessage(`DevPilot: No API key is currently stored for "${providerId}".`);
		return false;
	}

	const confirmation = await vscode.window.showWarningMessage(
		`Are you sure you want to remove the stored API key for "${providerId}"?`,
		{ modal: true },
		'Remove API Key'
	);

	if (confirmation !== 'Remove API Key') {
		return false;
	}

	try {
		await secretStorageService.deleteApiKey(providerId);
		vscode.window.showInformationMessage(`DevPilot: API key for "${providerId}" has been removed.`);
		return true;
	} catch (err) {
		const errMsg = err instanceof Error ? err.message : String(err);
		vscode.window.showErrorMessage(`DevPilot: Failed to remove API key: ${errMsg}`);
		return false;
	}
}

/**
 * Handler for devpilot.selectProvider command, allowing the user to switch the active LLM backend.
 */
export async function handleSelectProviderCommand(): Promise<string | undefined> {
	const config = vscode.workspace.getConfiguration('devpilot');
	const currentProvider = config.get<string>('activeProvider', 'ollama').trim().toLowerCase();

	const items = [
		{
			label: '$(zap) Groq Cloud (OpenAI-Compatible)',
			description: currentProvider === 'openai-compatible' || currentProvider === 'groq' ? '(Currently Active)' : 'Fast hosted LPU inference (Llama 3.3 70B)',
			providerId: 'openai-compatible'
		},
		{
			label: '$(server) Ollama (Local)',
			description: currentProvider === 'ollama' ? '(Currently Active)' : 'Local runtime (qwen3.5:9b)',
			providerId: 'ollama'
		}
	];

	const selection = await vscode.window.showQuickPick(items, {
		placeHolder: 'Select active LLM provider for DevPilot',
		title: 'DevPilot: Select Active LLM Provider'
	});

	if (!selection) {
		return undefined;
	}

	await config.update('activeProvider', selection.providerId, vscode.ConfigurationTarget.Global);
	vscode.window.showInformationMessage(`DevPilot: Active provider switched to ${selection.label.replace(/\$\([^)]+\)\s*/, '')}.`);
	return selection.providerId;
}

/**
 * Handler for devpilot.selectModel command, querying the active provider for available models.
 */
export async function handleSelectModelCommand(
	providerFactory: ProviderFactory
): Promise<string | undefined> {
	return await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: 'DevPilot: Querying available models from active provider...',
			cancellable: false
		},
		async () => {
			try {
				const provider = await providerFactory.resolveProvider();
				const health = await provider.checkHealth();
				if (!health.isHealthy && health.message) {
					vscode.window.showErrorMessage(`DevPilot: ${health.message}`);
					return undefined;
				}

				const available = health.availableModels && health.availableModels.length > 0
					? health.availableModels
					: [];

				if (available.length === 0) {
					const manual = await vscode.window.showInputBox({
						prompt: 'Enter model identifier supported by your provider account',
						placeHolder: 'e.g. openai/gpt-oss-20b, openai/gpt-oss-120b, qwen/qwen3.8-27b'
					});
					if (manual && manual.trim().length > 0) {
						await vscode.workspace.getConfiguration('devpilot.openaiCompatible').update('model', manual.trim(), vscode.ConfigurationTarget.Global);
						vscode.window.showInformationMessage(`DevPilot: Model set to "${manual.trim()}".`);
						return manual.trim();
					}
					return undefined;
				}

				const currentConfigModel = vscode.workspace.getConfiguration('devpilot.openaiCompatible').get<string>('model', '');
				const quickPickItems = available.map(m => ({
					label: m,
					description: m === currentConfigModel ? '(Currently Selected)' : undefined
				}));

				const selection = await vscode.window.showQuickPick(quickPickItems, {
					placeHolder: 'Select a model supported by your active provider account',
					title: 'DevPilot: Select Model'
				});

				if (!selection) {
					return undefined;
				}

				await vscode.workspace.getConfiguration('devpilot.openaiCompatible').update('model', selection.label, vscode.ConfigurationTarget.Global);
				vscode.window.showInformationMessage(`DevPilot: Model switched to "${selection.label}".`);
				return selection.label;
			} catch (err) {
				const errMsg = err instanceof Error ? err.message : String(err);
				vscode.window.showErrorMessage(`DevPilot: Could not fetch models: ${errMsg}`);
				return undefined;
			}
		}
	);
}

/**
 * Registers API key management and provider selection commands.
 */
export function registerApiKeyCommands(
	context: vscode.ExtensionContext,
	secretStorageService: SecretStorageService,
	providerFactory?: ProviderFactory
): vscode.Disposable[] {
	const setApiKeyDisposable = vscode.commands.registerCommand(
		'devpilot.setApiKey',
		(targetProviderId?: string) => handleSetApiKeyCommand(secretStorageService, targetProviderId)
	);

	const clearApiKeyDisposable = vscode.commands.registerCommand(
		'devpilot.clearApiKey',
		(targetProviderId?: string) => handleClearApiKeyCommand(secretStorageService, targetProviderId)
	);

	const selectProviderDisposable = vscode.commands.registerCommand(
		'devpilot.selectProvider',
		() => handleSelectProviderCommand()
	);

	const selectModelDisposable = vscode.commands.registerCommand(
		'devpilot.selectModel',
		() => {
			const factory = providerFactory ?? new ProviderFactory(secretStorageService);
			return handleSelectModelCommand(factory);
		}
	);

	return [setApiKeyDisposable, clearApiKeyDisposable, selectProviderDisposable, selectModelDisposable];
}
