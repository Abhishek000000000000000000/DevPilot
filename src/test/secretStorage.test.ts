import * as assert from 'assert';
import * as vscode from 'vscode';
import { SecretStorageService, ISecretStorage } from '../services/SecretStorageService.js';
import {
	handleSetApiKeyCommand,
	handleClearApiKeyCommand
} from '../commands/apiKeyCommands.js';

/**
 * In-memory MockSecretStorage implementation for deterministic unit testing.
 */
class MockSecretStorage implements ISecretStorage {
	public storeMap = new Map<string, string>();
	public failNextGet = false;
	public failNextStore = false;
	public failNextDelete = false;

	public async get(key: string): Promise<string | undefined> {
		if (this.failNextGet) {
			this.failNextGet = false;
			throw new Error('Keyring read failure');
		}
		return this.storeMap.get(key);
	}

	public async store(key: string, value: string): Promise<void> {
		if (this.failNextStore) {
			this.failNextStore = false;
			throw new Error('Keyring write failure');
		}
		this.storeMap.set(key, value);
	}

	public async delete(key: string): Promise<void> {
		if (this.failNextDelete) {
			this.failNextDelete = false;
			throw new Error('Keyring delete failure');
		}
		this.storeMap.delete(key);
	}
}

suite('SecretStorageService & Credential Management Test Suite', () => {
	let mockStorage: MockSecretStorage;
	let service: SecretStorageService;

	setup(() => {
		mockStorage = new MockSecretStorage();
		service = new SecretStorageService(mockStorage);
	});

	// --- 1. Key Naming & Validation Tests ---
	test('1. Computes canonical key name with devpilot.apiKey. prefix and lowercase normalization', () => {
		assert.strictEqual(SecretStorageService.getKeyName('groq'), 'devpilot.apiKey.groq');
		assert.strictEqual(SecretStorageService.getKeyName('GROQ'), 'devpilot.apiKey.groq');
		assert.strictEqual(SecretStorageService.getKeyName('  OpenAI-Compatible  '), 'devpilot.apiKey.openai-compatible');
		assert.strictEqual(SecretStorageService.getKeyName('mistral_ai'), 'devpilot.apiKey.mistral_ai');
	});

	test('2. Throws error when providerId is empty, whitespace-only, or invalid type', () => {
		assert.throws(() => SecretStorageService.getKeyName(''), /Provider ID must be a non-empty string/);
		assert.throws(() => SecretStorageService.getKeyName('   '), /Provider ID must be a non-empty string/);
		assert.throws(() => SecretStorageService.getKeyName(null as unknown as string), /Provider ID must be a non-empty string/);
		assert.throws(() => SecretStorageService.getKeyName(undefined as unknown as string), /Provider ID must be a non-empty string/);
	});

	// --- 2. Storage & Retrieval Tests ---
	test('3. Stores and retrieves valid API key with whitespace trimming', async () => {
		await service.storeApiKey('groq', '  gsk_test_1234567890  ');
		assert.strictEqual(mockStorage.storeMap.get('devpilot.apiKey.groq'), 'gsk_test_1234567890');

		const retrieved = await service.getApiKey('groq');
		assert.strictEqual(retrieved, 'gsk_test_1234567890');
	});

	test('4. Case-insensitivity: key stored under uppercase ID is retrievable via lowercase ID', async () => {
		await service.storeApiKey('GROQ', 'gsk_secret');
		const retrieved = await service.getApiKey('groq');
		assert.strictEqual(retrieved, 'gsk_secret');
	});

	test('5. Rejects empty or whitespace-only API keys on store', async () => {
		await assert.rejects(
			async () => service.storeApiKey('groq', ''),
			/API key must be a non-empty string/
		);
		await assert.rejects(
			async () => service.storeApiKey('groq', '   '),
			/API key must be a non-empty string/
		);
		await assert.rejects(
			async () => service.storeApiKey('groq', null as unknown as string),
			/API key must be a non-empty string/
		);
	});

	test('6. getApiKey returns undefined when key is not set', async () => {
		const retrieved = await service.getApiKey('non-existent');
		assert.strictEqual(retrieved, undefined);
	});

	test('7. getApiKey returns undefined when stored value is empty whitespace', async () => {
		mockStorage.storeMap.set('devpilot.apiKey.groq', '   ');
		const retrieved = await service.getApiKey('groq');
		assert.strictEqual(retrieved, undefined);
	});

	// --- 3. Deletion & hasApiKey Tests ---
	test('8. hasApiKey returns true when present, false when absent', async () => {
		assert.strictEqual(await service.hasApiKey('groq'), false);
		await service.storeApiKey('groq', 'gsk_val');
		assert.strictEqual(await service.hasApiKey('groq'), true);
	});

	test('9. Deletes stored API key correctly', async () => {
		await service.storeApiKey('groq', 'gsk_val');
		assert.strictEqual(await service.hasApiKey('groq'), true);

		await service.deleteApiKey('groq');
		assert.strictEqual(await service.hasApiKey('groq'), false);
		assert.strictEqual(mockStorage.storeMap.has('devpilot.apiKey.groq'), false);
	});

	test('10. Deleting non-existent key does not throw', async () => {
		await assert.doesNotReject(async () => {
			await service.deleteApiKey('non-existent');
		});
	});

	// --- 4. Multi-Provider Isolation Tests ---
	test('11. Isolates credentials strictly per provider without crosstalk', async () => {
		await service.storeApiKey('groq', 'gsk_groq_key');
		await service.storeApiKey('openai-compatible', 'sk_openai_key');
		await service.storeApiKey('openrouter', 'sk_openrouter_key');

		assert.strictEqual(await service.getApiKey('groq'), 'gsk_groq_key');
		assert.strictEqual(await service.getApiKey('openai-compatible'), 'sk_openai_key');
		assert.strictEqual(await service.getApiKey('openrouter'), 'sk_openrouter_key');

		// Deleting groq should leave others intact
		await service.deleteApiKey('groq');
		assert.strictEqual(await service.getApiKey('groq'), undefined);
		assert.strictEqual(await service.getApiKey('openai-compatible'), 'sk_openai_key');
		assert.strictEqual(await service.getApiKey('openrouter'), 'sk_openrouter_key');
	});

	// --- 5. Error Handling & Security Boundary Tests ---
	test('12. Wraps underlying storage errors during store without leaking API key in error message', async () => {
		mockStorage.failNextStore = true;
		const secretKey = 'gsk_super_secret_payload_9876';

		await assert.rejects(
			async () => service.storeApiKey('groq', secretKey),
			(err: Error) => {
				assert.ok(err.message.includes('Failed to store API key for provider "groq"'));
				// Ensure the secret key itself is NEVER leaked inside the error message
				assert.ok(!err.message.includes(secretKey), 'Error message must never contain the plaintext secret');
				return true;
			}
		);
	});

	test('13. Wraps underlying storage errors during get gracefully', async () => {
		mockStorage.failNextGet = true;
		await assert.rejects(
			async () => service.getApiKey('groq'),
			/Failed to retrieve API key for provider "groq": Keyring read failure/
		);
	});

	test('14. Wraps underlying storage errors during delete gracefully', async () => {
		mockStorage.failNextDelete = true;
		await assert.rejects(
			async () => service.deleteApiKey('groq'),
			/Failed to delete API key for provider "groq": Keyring delete failure/
		);
	});

	test('15. devpilot.setApiKey and devpilot.clearApiKey commands are registered in VS Code', async () => {
		const ext = vscode.extensions.all.find(e => e.packageJSON?.name === 'AIEngineeringAssistant');
		assert.ok(ext, 'AIEngineeringAssistant extension must be found in host');

		// 1. Verify commands are contributed in extension manifest
		const contributedCommands: Array<{ command: string; title: string; category: string }> =
			ext.packageJSON?.contributes?.commands ?? [];
		const setCmd = contributedCommands.find(c => c.command === 'devpilot.setApiKey');
		const clearCmd = contributedCommands.find(c => c.command === 'devpilot.clearApiKey');
		assert.ok(setCmd, 'devpilot.setApiKey must be contributed in package.json');
		assert.strictEqual(setCmd?.title, 'Set Provider API Key');
		assert.strictEqual(setCmd?.category, 'DevPilot');
		assert.ok(clearCmd, 'devpilot.clearApiKey must be contributed in package.json');
		assert.strictEqual(clearCmd?.title, 'Clear Provider API Key');
		assert.strictEqual(clearCmd?.category, 'DevPilot');

		// 2. Verify command activation events are declared in package.json
		const activationEvents: string[] = ext.packageJSON?.activationEvents ?? [];
		assert.ok(
			activationEvents.includes('onCommand:devpilot.setApiKey'),
			'onCommand:devpilot.setApiKey must be in activationEvents'
		);
		assert.ok(
			activationEvents.includes('onCommand:devpilot.clearApiKey'),
			'onCommand:devpilot.clearApiKey must be in activationEvents'
		);

		// 3. Verify commands are registered at runtime upon activation
		if (!ext.isActive) {
			await ext.activate();
		}
		const allCommands = await vscode.commands.getCommands(true);
		assert.ok(allCommands.includes('devpilot.setApiKey'), 'devpilot.setApiKey must be registered at runtime');
		assert.ok(allCommands.includes('devpilot.clearApiKey'), 'devpilot.clearApiKey must be registered at runtime');
	});

	test('16. handleSetApiKeyCommand handles programmatic providerId and saves key', async () => {
		const originalShowInputBox = vscode.window.showInputBox;
		try {
			(vscode.window as any).showInputBox = async (options: vscode.InputBoxOptions) => {
				assert.strictEqual(options.password, true, 'Input box must have password mask enabled for security');
				return 'gsk_mock_from_command';
			};

			const result = await handleSetApiKeyCommand(service, 'groq');
			assert.strictEqual(result, true);

			const stored = await service.getApiKey('groq');
			assert.strictEqual(stored, 'gsk_mock_from_command');
		} finally {
			vscode.window.showInputBox = originalShowInputBox;
		}
	});

	test('17. handleSetApiKeyCommand handles quickpick selection flow', async () => {
		const originalShowQuickPick = vscode.window.showQuickPick;
		const originalShowInputBox = vscode.window.showInputBox;
		try {
			(vscode.window as any).showQuickPick = async () => ({
				label: 'Groq',
				providerId: 'groq'
			});
			(vscode.window as any).showInputBox = async () => 'gsk_quickpicked_key';

			const result = await handleSetApiKeyCommand(service);
			assert.strictEqual(result, true);

			const stored = await service.getApiKey('groq');
			assert.strictEqual(stored, 'gsk_quickpicked_key');
		} finally {
			vscode.window.showQuickPick = originalShowQuickPick;
			vscode.window.showInputBox = originalShowInputBox;
		}
	});

	test('18. handleSetApiKeyCommand ignores cancellation without saving empty key', async () => {
		const originalShowInputBox = vscode.window.showInputBox;
		try {
			// Simulate user pressing Escape
			(vscode.window as any).showInputBox = async () => undefined;

			const result = await handleSetApiKeyCommand(service, 'groq');
			assert.strictEqual(result, false);

			const stored = await service.getApiKey('groq');
			assert.strictEqual(stored, undefined);
		} finally {
			vscode.window.showInputBox = originalShowInputBox;
		}
	});

	test('19. handleClearApiKeyCommand removes key when user confirms warning modal', async () => {
		await service.storeApiKey('groq', 'gsk_existing');
		assert.strictEqual(await service.hasApiKey('groq'), true);

		const originalWarning = vscode.window.showWarningMessage;
		try {
			(vscode.window as any).showWarningMessage = async () => 'Remove API Key';

			const result = await handleClearApiKeyCommand(service, 'groq');
			assert.strictEqual(result, true);
			assert.strictEqual(await service.hasApiKey('groq'), false);
		} finally {
			vscode.window.showWarningMessage = originalWarning;
		}
	});

	test('20. handleClearApiKeyCommand preserves key when user cancels warning modal', async () => {
		await service.storeApiKey('groq', 'gsk_existing');
		assert.strictEqual(await service.hasApiKey('groq'), true);

		const originalWarning = vscode.window.showWarningMessage;
		try {
			(vscode.window as any).showWarningMessage = async () => undefined;

			const result = await handleClearApiKeyCommand(service, 'groq');
			assert.strictEqual(result, false);

			assert.strictEqual(await service.hasApiKey('groq'), true);
			assert.strictEqual(await service.getApiKey('groq'), 'gsk_existing');
		} finally {
			vscode.window.showWarningMessage = originalWarning;
		}
	});

	test('21. handleClearApiKeyCommand informs user when no key is currently stored', async () => {
		const originalInfo = vscode.window.showInformationMessage;
		let infoShown = false;
		try {
			(vscode.window as any).showInformationMessage = async (msg: string) => {
				if (msg.includes('No API key is currently stored')) {
					infoShown = true;
				}
				return undefined;
			};

			const result = await handleClearApiKeyCommand(service, 'groq');
			assert.strictEqual(result, false);
			assert.strictEqual(infoShown, true);
		} finally {
			vscode.window.showInformationMessage = originalInfo;
		}
	});
});
