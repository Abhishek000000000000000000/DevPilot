import * as assert from 'assert';
import * as vscode from 'vscode';
import {
	ProviderRegistry,
	OLLAMA_DESCRIPTOR,
	OPENAI_COMPATIBLE_DESCRIPTOR
} from '../providers/ProviderRegistry.js';
import { ProviderFactory } from '../providers/ProviderFactory.js';
import { SecretStorageService, ISecretStorage } from '../services/SecretStorageService.js';
import { OllamaProvider } from '../providers/ollama/OllamaProvider.js';
import { OpenAICompatibleProvider } from '../providers/openai/OpenAICompatibleProvider.js';
import { ProviderError } from '../providers/errors.js';
import { DevPilotViewProvider } from '../panels/DevPilotViewProvider.js';
import { ILLMProvider } from '../providers/ILLMProvider.js';
import { ChatRequest, ChatResponse, StreamChunk, ProviderHealth } from '../providers/types.js';

class InMemorySecretStorage implements ISecretStorage {
	private readonly _store = new Map<string, string>();

	public async get(key: string): Promise<string | undefined> {
		return this._store.get(key);
	}

	public async store(key: string, value: string): Promise<void> {
		this._store.set(key, value);
	}

	public async delete(key: string): Promise<void> {
		this._store.delete(key);
	}

	public clear(): void {
		this._store.clear();
	}
}

class MockLLMProvider implements ILLMProvider {
	public readonly id: string;
	public readonly displayName: string;
	public callCount = 0;
	public lastRequest?: ChatRequest;
	public responseText: string;

	constructor(id = 'mock-provider', responseText = 'mock output') {
		this.id = id;
		this.displayName = 'Mock Provider';
		this.responseText = responseText;
	}

	public async chat(request: ChatRequest): Promise<ChatResponse> {
		this.callCount++;
		this.lastRequest = request;
		return {
			text: this.responseText,
			finishReason: 'stop'
		};
	}

	public async chatStream(
		request: ChatRequest,
		onChunk: (chunk: StreamChunk) => void
	): Promise<ChatResponse> {
		this.callCount++;
		this.lastRequest = request;
		onChunk({ text: this.responseText });
		return {
			text: this.responseText,
			finishReason: 'stop'
		};
	}

	public async checkHealth(): Promise<ProviderHealth> {
		return {
			isHealthy: true,
			availableModels: ['mock-model']
		};
	}
}

suite('DevPilot Phase 3: Provider Registry, Factory & Dynamic Routing Test Suite', () => {
	let memoryStorage: InMemorySecretStorage;
	let secretStorageService: SecretStorageService;

	let savedCurrentProvider: DevPilotViewProvider | undefined;

	setup(() => {
		savedCurrentProvider = DevPilotViewProvider.currentProvider;
		memoryStorage = new InMemorySecretStorage();
		secretStorageService = new SecretStorageService(memoryStorage);
	});

	teardown(() => {
		memoryStorage.clear();
		DevPilotViewProvider.currentProvider = savedCurrentProvider;
		if (DevPilotViewProvider.currentProvider) {
			DevPilotViewProvider.currentProvider.setCustomProvider(undefined);
			DevPilotViewProvider.currentProvider.setOnDidPostMessage(undefined);
		}
	});

	suite('ProviderRegistry Descriptors & Metadata', () => {
		test('Registry exposes all defined providers', () => {
			const all = ProviderRegistry.getAllDescriptors();
			assert.strictEqual(all.length, 2);
			const ids = all.map(d => d.id);
			assert.ok(ids.includes('ollama'));
			assert.ok(ids.includes('openai-compatible'));
		});

		test('Ollama descriptor contains expected default metadata and capabilities', () => {
			const descriptor = ProviderRegistry.getDescriptor('ollama');
			assert.ok(descriptor);
			assert.strictEqual(descriptor?.id, 'ollama');
			assert.strictEqual(descriptor?.isLocal, true);
			assert.strictEqual(descriptor?.requiresApiKey, false);
			assert.strictEqual(descriptor?.defaultBaseUrl, 'http://localhost:11434');
			assert.strictEqual(descriptor?.defaultModel, 'qwen3.5:9b');
			assert.strictEqual(descriptor?.capabilities.supportsStreaming, true);
			assert.strictEqual(descriptor?.capabilities.supportsThinking, true);
			assert.strictEqual(descriptor?.capabilities.supportsCancellation, true);
			assert.strictEqual(descriptor, OLLAMA_DESCRIPTOR);
		});

		test('OpenAI-compatible descriptor contains expected default metadata and capabilities', () => {
			const descriptor = ProviderRegistry.getDescriptor('openai-compatible');
			assert.ok(descriptor);
			assert.strictEqual(descriptor?.id, 'openai-compatible');
			assert.strictEqual(descriptor?.isLocal, false);
			assert.strictEqual(descriptor?.requiresApiKey, true);
			assert.strictEqual(descriptor?.defaultBaseUrl, 'https://api.groq.com/openai/v1');
			assert.strictEqual(descriptor?.defaultModel, 'openai/gpt-oss-20b');
			assert.strictEqual(descriptor?.capabilities.supportsStreaming, true);
			assert.strictEqual(descriptor?.capabilities.supportsThinking, false);
			assert.strictEqual(descriptor?.capabilities.supportsCancellation, true);
			assert.strictEqual(descriptor, OPENAI_COMPATIBLE_DESCRIPTOR);
		});

		test('Descriptor retrieval is case-insensitive and trims whitespace', () => {
			assert.strictEqual(ProviderRegistry.getDescriptor('  OLLAMA  ')?.id, 'ollama');
			assert.strictEqual(ProviderRegistry.getDescriptor('OpenAI-Compatible')?.id, 'openai-compatible');
			assert.strictEqual(ProviderRegistry.getDescriptor('OPENAI-COMPATIBLE')?.id, 'openai-compatible');
			assert.strictEqual(ProviderRegistry.getDescriptor('groq')?.id, 'openai-compatible');
			assert.strictEqual(ProviderRegistry.getDescriptor('  GROQ  ')?.id, 'openai-compatible');
		});

		test('Unknown provider IDs return undefined from getDescriptor and false from isSupported', () => {
			assert.strictEqual(ProviderRegistry.getDescriptor('gemini'), undefined);
			assert.strictEqual(ProviderRegistry.getDescriptor('anthropic'), undefined);
			assert.strictEqual(ProviderRegistry.getDescriptor(''), undefined);
			assert.strictEqual(ProviderRegistry.isSupported('unknown'), false);
			assert.strictEqual(ProviderRegistry.isSupported('ollama'), true);
			assert.strictEqual(ProviderRegistry.isSupported('openai-compatible'), true);
			assert.strictEqual(ProviderRegistry.isSupported('groq'), true);
		});
	});

	suite('ProviderFactory Instantiation & Configuration', () => {
		test('getActiveProviderId defaults to ollama', () => {
			const factory = new ProviderFactory(secretStorageService);
			const activeId = factory.getActiveProviderId();
			assert.strictEqual(activeId, 'ollama');
		});

		test('createSyncProvider creates OllamaProvider for local ollama', () => {
			const factory = new ProviderFactory(secretStorageService);
			const provider = factory.createSyncProvider('ollama');
			assert.ok(provider instanceof OllamaProvider);
			assert.strictEqual(provider.id, 'ollama');
		});

		test('createSyncProvider creates OpenAICompatibleProvider when apiKey is passed', () => {
			const factory = new ProviderFactory(secretStorageService);
			const provider = factory.createSyncProvider('openai-compatible', 'gsk_test12345');
			assert.ok(provider instanceof OpenAICompatibleProvider);
			assert.strictEqual(provider.id, 'openai-compatible');
			assert.strictEqual((provider as OpenAICompatibleProvider).config.apiKey, 'gsk_test12345');
		});

		test('createSyncProvider throws INVALID_REQUEST on unknown provider ID', () => {
			const factory = new ProviderFactory(secretStorageService);
			assert.throws(
				() => factory.createSyncProvider('unknown-vendor'),
				(err: any) => {
					return err instanceof ProviderError &&
						err.code === 'INVALID_REQUEST' &&
						err.message.includes('unknown-vendor');
				}
			);
		});

		test('Custom fetch function is passed through to instantiated providers', async () => {
			let customFetchInvoked = false;
			const customFetch: typeof fetch = async () => {
				customFetchInvoked = true;
				return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
			};

			const factory = new ProviderFactory(secretStorageService, customFetch);
			const provider = factory.createSyncProvider('ollama');
			await provider.checkHealth();
			assert.strictEqual(customFetchInvoked, true);
		});
	});

	suite('Routing to Ollama vs. Hosted Adapter', () => {
		test('resolveProvider routes to OllamaProvider without requiring API credentials', async () => {
			const factory = new ProviderFactory(secretStorageService);
			const provider = await factory.resolveProvider('ollama');
			assert.ok(provider instanceof OllamaProvider);
			assert.strictEqual(provider.id, 'ollama');
		});

		test('resolveProvider routes to OpenAICompatibleProvider with stored secret API key', async () => {
			await secretStorageService.storeApiKey('openai-compatible', 'gsk_live_secret_key_999');

			const factory = new ProviderFactory(secretStorageService);
			const provider = await factory.resolveProvider('openai-compatible');
			assert.ok(provider instanceof OpenAICompatibleProvider);
			assert.strictEqual(provider.id, 'openai-compatible');
			assert.strictEqual(
				(provider as OpenAICompatibleProvider).config.apiKey,
				'gsk_live_secret_key_999'
			);
		});

		test('resolveProvider routes to OpenAICompatibleProvider when key was stored under groq alias', async () => {
			await secretStorageService.storeApiKey('groq', 'gsk_groq_alias_key_888');

			const factory = new ProviderFactory(secretStorageService);
			const provider = await factory.resolveProvider('groq');
			assert.ok(provider instanceof OpenAICompatibleProvider);
			assert.strictEqual(
				(provider as OpenAICompatibleProvider).config.apiKey,
				'gsk_groq_alias_key_888'
			);

			// Also resolves when requested as openai-compatible
			const provider2 = await factory.resolveProvider('openai-compatible');
			assert.ok(provider2 instanceof OpenAICompatibleProvider);
			assert.strictEqual(
				(provider2 as OpenAICompatibleProvider).config.apiKey,
				'gsk_groq_alias_key_888'
			);
		});

		test('resolveProvider throws INVALID_REQUEST for unhandled or unknown provider ID', async () => {
			const factory = new ProviderFactory(secretStorageService);
			await assert.rejects(
				async () => await factory.resolveProvider('non-existent-provider'),
				(err: any) => {
					return err instanceof ProviderError &&
						err.code === 'INVALID_REQUEST' &&
						err.message.includes('non-existent-provider');
				}
			);
		});
	});

	suite('Missing API Key Handling', () => {
		test('resolveProvider throws AUTHENTICATION_FAILED when hosted provider key is missing', async () => {
			// Ensure no key is stored
			await secretStorageService.deleteApiKey('openai-compatible');

			const factory = new ProviderFactory(secretStorageService);
			await assert.rejects(
				async () => await factory.resolveProvider('openai-compatible'),
				(err: any) => {
					assert.ok(err instanceof ProviderError);
					assert.strictEqual(err.code, 'AUTHENTICATION_FAILED');
					assert.ok(err.message.includes('API key is not configured for provider "openai-compatible"'));
					assert.ok(err.userSuggestion?.includes('DevPilot: Set Provider API Key'));
					return true;
				}
			);
		});

		test('DevPilotViewProvider displays notification and returns error response when API key is missing', async () => {
			await secretStorageService.deleteApiKey('openai-compatible');

			const viewUri = vscode.Uri.file('/mock/extension');
			const provider = new DevPilotViewProvider(viewUri, undefined, secretStorageService);

			// Inject a factory configured to resolve openai-compatible
			const hostedFactory = new ProviderFactory(secretStorageService);
			provider.setProviderFactory(hostedFactory);

			// Intercept showErrorMessage
			let shownErrorMsg = '';
			let actionOptions: string[] = [];
			const originalShowError = vscode.window.showErrorMessage;
			(vscode.window as any).showErrorMessage = (msg: string, ...items: string[]) => {
				shownErrorMsg = msg;
				actionOptions = items;
				return Promise.resolve(undefined);
			};

			let postedMessage: any;
			provider.setOnDidPostMessage(m => {
				postedMessage = m;
			});

			try {
				// Temporarily override getActiveProviderId to simulate activeProvider = 'openai-compatible'
				hostedFactory.getActiveProviderId = () => 'openai-compatible';

				const result = await provider.handleMessage({
					type: 'devpilot.chat.send',
					payload: {
						requestId: 'test-auth-fail-1',
						text: 'Hello world'
					}
				});

				// Verify toast error was triggered with 'Set API Key' action
				assert.ok(shownErrorMsg.includes('API key is not configured for provider "openai-compatible"'));
				assert.ok(actionOptions.includes('Set API Key'));

				// Verify webview received chat.error with AUTHENTICATION_FAILED
				assert.ok(postedMessage);
				assert.strictEqual(postedMessage.type, 'devpilot.chat.error');
				assert.strictEqual(postedMessage.payload.code, 'AUTHENTICATION_FAILED');
				assert.strictEqual(postedMessage.payload.requestId, 'test-auth-fail-1');
				assert.ok(result);
			} finally {
				(vscode.window as any).showErrorMessage = originalShowError;
			}
		});
	});

	suite('Dynamic Provider Switching Between Requests', () => {
		test('Resolves Ollama then switches to OpenAI-compatible on subsequent call without caching stale provider', async () => {
			await secretStorageService.storeApiKey('openai-compatible', 'gsk_switch_key');

			let currentActive = 'ollama';
			const factory = new ProviderFactory(secretStorageService);
			factory.getActiveProviderId = () => currentActive;

			// Request 1: Active provider is ollama
			const p1 = await factory.resolveProvider();
			assert.strictEqual(p1.id, 'ollama');
			assert.ok(p1 instanceof OllamaProvider);

			// Switch provider
			currentActive = 'openai-compatible';

			// Request 2: Active provider is openai-compatible
			const p2 = await factory.resolveProvider();
			assert.strictEqual(p2.id, 'openai-compatible');
			assert.ok(p2 instanceof OpenAICompatibleProvider);

			// Switch back
			currentActive = 'ollama';
			const p3 = await factory.resolveProvider();
			assert.strictEqual(p3.id, 'ollama');
		});

		test('Failure on hosted provider does not silently fall back to Ollama', async () => {
			// Clear key so openai-compatible fails
			await secretStorageService.deleteApiKey('openai-compatible');

			const factory = new ProviderFactory(secretStorageService);
			factory.getActiveProviderId = () => 'openai-compatible';

			await assert.rejects(
				async () => await factory.resolveProvider(),
				(err: any) => {
					assert.strictEqual(err.code, 'AUTHENTICATION_FAILED');
					return true;
				}
			);
			// Verifies it did NOT return OllamaProvider
		});
	});

	suite('Custom Provider Injection & Regression Coverage', () => {
		test('setCustomProvider overrides factory resolution completely', async () => {
			const viewUri = vscode.Uri.file('/mock/extension');
			const provider = new DevPilotViewProvider(viewUri, undefined, secretStorageService);

			const mockProvider = new MockLLMProvider('injected-mock', 'injected response');
			provider.setCustomProvider(mockProvider);

			// getProvider() returns mock
			assert.strictEqual(provider.getProvider(), mockProvider);

			// resolveProvider() returns mock
			const resolved = await provider.resolveProvider();
			assert.strictEqual(resolved, mockProvider);

			let postedMessage: any;
			provider.setOnDidPostMessage(m => {
				postedMessage = m;
			});

			// Dispatched chat.send uses custom provider
			await provider.handleMessage({
				type: 'devpilot.chat.send',
				payload: {
					requestId: 'custom-prov-req',
					text: 'Test custom provider prompt'
				}
			});

			assert.strictEqual(mockProvider.callCount, 1);
			assert.strictEqual(mockProvider.lastRequest?.messages[0].content, 'Test custom provider prompt');
			assert.strictEqual(postedMessage.type, 'devpilot.chat.complete');
			assert.strictEqual(postedMessage.payload.fullText, 'injected response');

			// Clearing custom provider restores factory behavior
			provider.setCustomProvider(undefined);
			const restored = provider.getProvider();
			assert.ok(restored instanceof OllamaProvider);
		});
	});
});
