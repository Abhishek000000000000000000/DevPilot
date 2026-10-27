import * as vscode from 'vscode';

/**
 * Structural interface matching vscode.SecretStorage for dependency injection and deterministic testing.
 */
export interface ISecretStorage {
	get(key: string): Thenable<string | undefined>;
	store(key: string, value: string): Thenable<void>;
	delete(key: string): Thenable<void>;
}

/**
 * Service managing secure, encrypted storage of LLM provider API credentials
 * using VS Code's native SecretStorage API (backed by the OS credential manager/keychain).
 */
export class SecretStorageService {
	public static readonly KEY_PREFIX = 'devpilot.apiKey.';

	constructor(private readonly _storage: ISecretStorage) {}

	/**
	 * Computes the canonical secret storage key for a given provider.
	 * Format: devpilot.apiKey.${providerId}
	 */
	public static getKeyName(providerId: string): string {
		if (typeof providerId !== 'string') {
			throw new Error('Provider ID must be a non-empty string.');
		}
		const sanitized = providerId.trim().toLowerCase();
		if (sanitized.length === 0) {
			throw new Error('Provider ID must be a non-empty string.');
		}
		return `${SecretStorageService.KEY_PREFIX}${sanitized}`;
	}

	/**
	 * Safely retrieves the stored API key for the specified provider.
	 * Returns undefined if no key is stored.
	 */
	public async getApiKey(providerId: string): Promise<string | undefined> {
		const keyName = SecretStorageService.getKeyName(providerId);
		try {
			const value = await this._storage.get(keyName);
			if (typeof value === 'string' && value.trim().length > 0) {
				return value.trim();
			}
			return undefined;
		} catch (err) {
			throw new Error(
				`Failed to retrieve API key for provider "${providerId}": ${err instanceof Error ? err.message : String(err)}`
			);
		}
	}

	/**
	 * Validates and stores the API key for the specified provider in secure storage.
	 */
	public async storeApiKey(providerId: string, apiKey: string): Promise<void> {
		const keyName = SecretStorageService.getKeyName(providerId);
		if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
			throw new Error('API key must be a non-empty string.');
		}

		try {
			await this._storage.store(keyName, apiKey.trim());
		} catch (err) {
			throw new Error(
				`Failed to store API key for provider "${providerId}": ${err instanceof Error ? err.message : String(err)}`
			);
		}
	}

	/**
	 * Deletes the stored API key for the specified provider from secure storage.
	 */
	public async deleteApiKey(providerId: string): Promise<void> {
		const keyName = SecretStorageService.getKeyName(providerId);
		try {
			await this._storage.delete(keyName);
		} catch (err) {
			throw new Error(
				`Failed to delete API key for provider "${providerId}": ${err instanceof Error ? err.message : String(err)}`
			);
		}
	}

	/**
	 * Checks whether an API key currently exists for the specified provider.
	 */
	public async hasApiKey(providerId: string): Promise<boolean> {
		const key = await this.getApiKey(providerId);
		return key !== undefined;
	}
}
