import * as vscode from 'vscode';
import { ILLMProvider } from './ILLMProvider.js';
import { ProviderRegistry } from './ProviderRegistry.js';
import { ProviderError } from './errors.js';
import { OllamaProvider } from './ollama/OllamaProvider.js';
import { getOllamaConfigFromVSCode } from './ollama/vscodeConfig.js';
import { OpenAICompatibleProvider } from './openai/OpenAICompatibleProvider.js';
import { getOpenAICompatibleConfigFromVSCode } from './openai/vscodeConfig.js';
import { SecretStorageService } from '../services/SecretStorageService.js';

/*
 * Resolves and instantiates the active LLM provider adapter at runtime
 * based on VS Code configuration and secure credential storage.
 */
export class ProviderFactory {
	constructor(
		private readonly _secretStorage: SecretStorageService,
		private readonly _fetchFn?: typeof fetch
	) { }

	/**
	 * Retrieves the currently active provider ID configured in VS Code settings.
	 * Defaults to 'ollama' for backward compatibility.
	 */
	public getActiveProviderId(): string {
		const config = vscode.workspace.getConfiguration('devpilot');
		const active = config.get<string>('activeProvider', 'ollama');
		return (active || 'ollama').trim().toLowerCase();
	}

	/**
	 * Synchronously creates a provider instance for immediate inspection.
	 * (Note: for hosted providers requiring API keys, apiKey should be provided if known).
	 */
	public createSyncProvider(providerIdOverride?: string, apiKey?: string): ILLMProvider {
		const providerId = (providerIdOverride || this.getActiveProviderId()).trim().toLowerCase();
		const descriptor = ProviderRegistry.getDescriptor(providerId);

		if (!descriptor) {
			throw new ProviderError(
				'INVALID_REQUEST',
				`Unknown or unsupported LLM provider: "${providerId}".`,
				{
					userSuggestion: 'Check devpilot.activeProvider in VS Code settings. Supported: "ollama", "openai-compatible".'
				}
			);
		}

		if (descriptor.id === 'ollama') {
			return new OllamaProvider(getOllamaConfigFromVSCode(), this._fetchFn);
		}

		if (descriptor.id === 'openai-compatible') {
			return new OpenAICompatibleProvider(
				getOpenAICompatibleConfigFromVSCode(apiKey),
				this._fetchFn
			);
		}

		throw new ProviderError('INVALID_REQUEST', `Unhandled provider: "${providerId}".`);
	}

	/**
	 * Asynchronously resolves the active provider, securely fetching API credentials
	 * from SecretStorageService when required by the selected provider.
	 */
	public async resolveProvider(providerIdOverride?: string): Promise<ILLMProvider> {
		const providerId = (providerIdOverride || this.getActiveProviderId()).trim().toLowerCase();
		const descriptor = ProviderRegistry.getDescriptor(providerId);

		if (!descriptor) {
			throw new ProviderError(
				'INVALID_REQUEST',
				`Unknown or unsupported LLM provider: "${providerId}".`,
				{
					userSuggestion: 'Check devpilot.activeProvider in VS Code settings. Supported: "ollama", "openai-compatible".'
				}
			);
		}

		// 1. Local providers do not require external API credentials
		if (descriptor.id === 'ollama') {
			return new OllamaProvider(getOllamaConfigFromVSCode(), this._fetchFn);
		}

		// 2. Hosted OpenAI-compatible provider requiring secure credentials
		if (descriptor.id === 'openai-compatible') {
			let apiKey = await this._secretStorage.getApiKey(providerId);
			if (!apiKey && providerId !== 'openai-compatible') {
				apiKey = await this._secretStorage.getApiKey('openai-compatible');
			}
			if (!apiKey && providerId !== 'groq') {
				apiKey = await this._secretStorage.getApiKey('groq');
			}
			if (!apiKey) {
				throw new ProviderError(
					'AUTHENTICATION_FAILED',
					'API key is not configured for provider "openai-compatible".',
					{
						userSuggestion: 'Please run the "DevPilot: Set Provider API Key" command to store your API key.'
					}
				);
			}

			const baseConfig = getOpenAICompatibleConfigFromVSCode(apiKey);
			return new OpenAICompatibleProvider(baseConfig, this._fetchFn);
		}

		throw new ProviderError('INVALID_REQUEST', `Unhandled provider: "${providerId}".`);
	}
}
