import * as assert from 'assert';
import * as vscode from 'vscode';
import * as myExtension from '../extension.js';
import { DevPilotViewProvider } from '../panels/DevPilotViewProvider.js';
import {
	validateWebviewMessage,
	MAX_REQUEST_ID_LENGTH,
	MAX_CHAT_TEXT_LENGTH,
	ChatChunkMessage,
	ChatCompleteMessage,
	ChatErrorMessage,
	ExtensionToWebviewMessage
} from '../types/messages.js';
import { ILLMProvider } from '../providers/ILLMProvider.js';
import { ChatRequest, ChatResponse, StreamChunk, ProviderHealth, GenerationMetrics } from '../providers/types.js';
import { ProviderError } from '../providers/errors.js';
import { OllamaProvider } from '../providers/ollama/OllamaProvider.js';
import { getOllamaConfigFromVSCode } from '../providers/ollama/vscodeConfig.js';

/**
 * Mock LLM provider for deterministic, offline testing of the extension bridge.
 */
class MockLLMProvider implements ILLMProvider {
	public readonly id = 'mock-llm';
	public readonly displayName = 'Mock LLM Provider';

	public invocationCount = 0;
	public lastRequest?: ChatRequest;
	public mockResponseText = 'Model inference result: Quicksort is an O(n log n) algorithm.';
	public mockChunks?: string[];
	public mockFinishReason: 'stop' | 'length' = 'stop';
	public mockError?: Error;
	public mockMetrics?: GenerationMetrics;
	public delayCompletePromise?: Promise<void>;
	public onChunkEmitted?: () => void;

	public lastSignal?: AbortSignal;

	public async checkHealth(): Promise<ProviderHealth> {
		return { isHealthy: true, availableModels: ['mock-qwen:9b'] };
	}

	public async chatStream(
		request: ChatRequest,
		onChunk: (chunk: StreamChunk) => void,
		signal?: AbortSignal
	): Promise<ChatResponse> {
		this.invocationCount++;
		this.lastRequest = request;
		this.lastSignal = signal;

		if (signal?.aborted) {
			throw new ProviderError('REQUEST_CANCELLED', 'Request was cancelled by user');
		}

		if (this.mockError) {
			throw this.mockError;
		}

		if (this.mockChunks) {
			for (const chunkText of this.mockChunks) {
				if (signal?.aborted) {
					throw new ProviderError('REQUEST_CANCELLED', 'Request was cancelled by user');
				}
				onChunk({ text: chunkText });
				this.onChunkEmitted?.();
			}
		} else if (this.mockResponseText) {
			if (signal?.aborted) {
				throw new ProviderError('REQUEST_CANCELLED', 'Request was cancelled by user');
			}
			onChunk({ text: this.mockResponseText });
		}

		if (this.delayCompletePromise) {
			if (signal) {
				await Promise.race([
					this.delayCompletePromise,
					new Promise<never>((_, reject) => {
						if (signal.aborted) {
							reject(new ProviderError('REQUEST_CANCELLED', 'Request was cancelled by user'));
						} else {
							signal.addEventListener('abort', () => {
								reject(new ProviderError('REQUEST_CANCELLED', 'Request was cancelled by user'));
							}, { once: true });
						}
					})
				]);
			} else {
				await this.delayCompletePromise;
			}
		}

		if (signal?.aborted) {
			throw new ProviderError('REQUEST_CANCELLED', 'Request was cancelled by user');
		}

		const fullText = this.mockChunks ? this.mockChunks.join('') : this.mockResponseText;

		return {
			text: fullText,
			finishReason: this.mockFinishReason,
			model: 'mock-qwen:9b',
			usage: { promptTokens: 10, completionTokens: 12 },
			...(this.mockMetrics ? { metrics: this.mockMetrics } : {})
		};
	}
}

suite('DevPilot Extension & Command Test Suite', () => {
	vscode.window.showInformationMessage('Starting DevPilot tests.');

	let mockProvider: MockLLMProvider;

	setup(() => {
		mockProvider = new MockLLMProvider();
		if (DevPilotViewProvider.currentProvider) {
			DevPilotViewProvider.currentProvider.cancelAllRequests();
			DevPilotViewProvider.currentProvider.setCustomProvider(mockProvider);
			DevPilotViewProvider.currentProvider.setOnDidPostMessage(undefined);
		}
	});

	teardown(() => {
		if (DevPilotViewProvider.currentProvider) {
			DevPilotViewProvider.currentProvider.cancelAllRequests();
			DevPilotViewProvider.currentProvider.setCustomProvider(undefined);
			DevPilotViewProvider.currentProvider.setOnDidPostMessage(undefined);
		}
	});

	test('Extension is active and registered', async () => {
		const ext = vscode.extensions.all.find(e => e.packageJSON.name === 'AIEngineeringAssistant');
		assert.ok(ext, 'DevPilot extension should be installed in host');
		if (!ext.isActive) {
			await ext.activate();
		}
		assert.strictEqual(ext.isActive, true, 'DevPilot extension should be active');
	});

	test('devpilot.open command executes and focuses DevPilot view', async () => {
		const commands = await vscode.commands.getCommands(true);
		assert.ok(commands.includes('devpilot.open'), 'devpilot.open command should be registered');

		// Execute devpilot.open command
		await vscode.commands.executeCommand('devpilot.open');

		// Verify DevPilotViewProvider instance exists
		assert.ok(DevPilotViewProvider.currentProvider, 'DevPilotViewProvider.currentProvider should be defined');
	});

	test('UI <-> Extension communication: real inference via legacy devpilot.message', async () => {
		const provider = DevPilotViewProvider.currentProvider;
		assert.ok(provider, 'Provider should be initialized');
		provider.setCustomProvider(mockProvider);

		// 1. Test devpilot.ready
		const readyResponse = await provider.handleMessage({ type: 'devpilot.ready' });
		assert.ok(readyResponse, 'Ready message should return response');
		assert.strictEqual(readyResponse?.type, 'devpilot.ready');
		if (readyResponse?.type === 'devpilot.ready') {
			assert.strictEqual(readyResponse.payload.status, 'connected');
			assert.strictEqual(readyResponse.payload.message, 'DevPilot extension is connected.');
		}

		// 2. Test legacy devpilot.message returns real model inference
		const messageResponse = await provider.handleMessage({
			type: 'devpilot.message',
			payload: { text: 'Explain quicksort.' }
		});
		assert.ok(messageResponse, 'User message should return assistant response');
		assert.strictEqual(messageResponse?.type, 'devpilot.response');
		if (messageResponse?.type === 'devpilot.response') {
			assert.strictEqual(messageResponse.payload.text, mockProvider.mockResponseText);
		}
		assert.strictEqual(mockProvider.invocationCount, 1);
		assert.strictEqual(mockProvider.lastRequest?.messages[0].content, 'Explain quicksort.');

		// 3. Test empty / whitespace message is safely ignored
		const emptyMsgResponse = await provider.handleMessage({
			type: 'devpilot.message',
			payload: { text: '   ' }
		});
		assert.strictEqual(emptyMsgResponse, undefined, 'Empty message should be ignored without calling model');
		assert.strictEqual(mockProvider.invocationCount, 1, 'Invocation count must remain 1');

		// 4. Test malformed / unknown message does not crash
		const unknownMsgResponse = await provider.handleMessage({ type: 'unknown.type' });
		assert.strictEqual(unknownMsgResponse, undefined, 'Unknown message should be handled gracefully');
	});

	test('UI <-> Extension communication: real inference via devpilot.chat.send and cancel', async () => {
		const provider = DevPilotViewProvider.currentProvider;
		assert.ok(provider, 'Provider should be initialized');
		provider.setCustomProvider(mockProvider);

		// 1. Valid devpilot.chat.send returns chat.complete with matching requestId
		const sendResponse = await provider.handleMessage({
			type: 'devpilot.chat.send',
			payload: {
				requestId: 'req-real-test-123',
				text: 'Please review this algorithm.'
			}
		});
		assert.ok(sendResponse, 'chat.send should return completion response');
		assert.strictEqual(sendResponse?.type, 'devpilot.chat.complete');
		if (sendResponse?.type === 'devpilot.chat.complete') {
			assert.strictEqual(sendResponse.payload.requestId, 'req-real-test-123');
			assert.strictEqual(sendResponse.payload.finishReason, 'stop');
			assert.strictEqual(sendResponse.payload.fullText, mockProvider.mockResponseText);
		}
		assert.strictEqual(mockProvider.invocationCount, 1);

		// 2. Valid devpilot.chat.cancel
		const cancelResponse = await provider.handleMessage({
			type: 'devpilot.chat.cancel',
			payload: {
				requestId: 'req-real-test-123'
			}
		});
		assert.ok(cancelResponse, 'chat.cancel should return completion response');
		assert.strictEqual(cancelResponse?.type, 'devpilot.chat.complete');
		if (cancelResponse?.type === 'devpilot.chat.complete') {
			assert.strictEqual(cancelResponse.payload.requestId, 'req-real-test-123');
			assert.strictEqual(cancelResponse.payload.finishReason, 'cancelled');
		}
	});

	test('Error handling: provider failures produce safe, non-crashing error responses', async () => {
		const provider = DevPilotViewProvider.currentProvider;
		assert.ok(provider, 'Provider should be initialized');
		provider.setCustomProvider(mockProvider);

		// 1. Connection refused error on chat.send
		mockProvider.mockError = new ProviderError(
			'CONNECTION_REFUSED',
			'Cannot connect to Ollama at http://localhost:11434.',
			{ userSuggestion: 'Ensure Ollama is running on port 11434.' }
		);

		const sendErrResponse = await provider.handleMessage({
			type: 'devpilot.chat.send',
			payload: {
				requestId: 'req-err-1',
				text: 'Hello model'
			}
		});
		assert.ok(sendErrResponse);
		assert.strictEqual(sendErrResponse?.type, 'devpilot.chat.error');
		if (sendErrResponse?.type === 'devpilot.chat.error') {
			assert.strictEqual(sendErrResponse.payload.requestId, 'req-err-1');
			assert.strictEqual(sendErrResponse.payload.code, 'CONNECTION_REFUSED');
			assert.ok(sendErrResponse.payload.suggestion?.includes('Ensure Ollama is running'));
		}

		// 2. Missing-model error on chat.send
		mockProvider.mockError = new ProviderError(
			'MODEL_NOT_FOUND',
			'Model "qwen3.5:9b" was not found in Ollama.',
			{ userSuggestion: 'Run "ollama pull qwen3.5:9b" in your terminal.' }
		);

		const missingModelResponse = await provider.handleMessage({
			type: 'devpilot.chat.send',
			payload: {
				requestId: 'req-err-2',
				text: 'Hello model'
			}
		});
		assert.ok(missingModelResponse);
		assert.strictEqual(missingModelResponse?.type, 'devpilot.chat.error');
		if (missingModelResponse?.type === 'devpilot.chat.error') {
			assert.strictEqual(missingModelResponse.payload.code, 'MODEL_NOT_FOUND');
			assert.ok(missingModelResponse.payload.suggestion?.includes('ollama pull'));
		}

		// 3. Error on legacy message returns friendly error text in devpilot.response
		const legacyErrResponse = await provider.handleMessage({
			type: 'devpilot.message',
			payload: { text: 'Hello' }
		});
		assert.ok(legacyErrResponse);
		assert.strictEqual(legacyErrResponse?.type, 'devpilot.response');
		if (legacyErrResponse?.type === 'devpilot.response') {
			assert.ok(legacyErrResponse.payload.text.includes('MODEL_NOT_FOUND'));
			assert.ok(legacyErrResponse.payload.text.includes('ollama pull'));
		}

		// 4. Extension remains operational after failures
		mockProvider.mockError = undefined;
		mockProvider.mockResponseText = 'Recovered successfully.';

		const recoveredResponse = await provider.handleMessage({
			type: 'devpilot.chat.send',
			payload: {
				requestId: 'req-rec-1',
				text: 'Are you online now?'
			}
		});
		assert.ok(recoveredResponse);
		assert.strictEqual(recoveredResponse?.type, 'devpilot.chat.complete');
		if (recoveredResponse?.type === 'devpilot.chat.complete') {
			assert.strictEqual(recoveredResponse.payload.fullText, 'Recovered successfully.');
		}
	});

	test('Empty and whitespace model output is handled safely with a sensible fallback', async () => {
		const provider = DevPilotViewProvider.currentProvider;
		assert.ok(provider, 'Provider should be initialized');
		provider.setCustomProvider(mockProvider);

		mockProvider.mockResponseText = '   '; // Only whitespace

		const response = await provider.handleMessage({
			type: 'devpilot.chat.send',
			payload: {
				requestId: 'req-empty-1',
				text: 'Generate empty'
			}
		});
		assert.ok(response);
		assert.strictEqual(response?.type, 'devpilot.chat.complete');
		if (response?.type === 'devpilot.chat.complete') {
			assert.strictEqual(response.payload.fullText, '(No output generated by model)');
		}
	});

	test('Runtime validation: message boundary and payload checks', () => {
		// Non-object messages
		assert.strictEqual(validateWebviewMessage(null).valid, false);
		assert.strictEqual(validateWebviewMessage(undefined).valid, false);
		assert.strictEqual(validateWebviewMessage('hello').valid, false);
		assert.strictEqual(validateWebviewMessage(12345).valid, false);

		// Missing or non-string type
		assert.strictEqual(validateWebviewMessage({}).valid, false);
		assert.strictEqual(validateWebviewMessage({ type: 123 }).valid, false);

		// Unknown type
		assert.strictEqual(validateWebviewMessage({ type: 'unrecognized.event' }).valid, false);

		// devpilot.ready & devpilot.close (valid without payload)
		assert.strictEqual(validateWebviewMessage({ type: 'devpilot.ready' }).valid, true);
		assert.strictEqual(validateWebviewMessage({ type: 'devpilot.close' }).valid, true);

		// devpilot.chat.send: missing or malformed payload
		assert.strictEqual(validateWebviewMessage({ type: 'devpilot.chat.send' }).valid, false);
		assert.strictEqual(validateWebviewMessage({ type: 'devpilot.chat.send', payload: null }).valid, false);
		assert.strictEqual(validateWebviewMessage({ type: 'devpilot.chat.send', payload: 'text' }).valid, false);

		// devpilot.chat.send: invalid requestId
		assert.strictEqual(validateWebviewMessage({
			type: 'devpilot.chat.send',
			payload: { requestId: '', text: 'Valid message' }
		}).valid, false);
		assert.strictEqual(validateWebviewMessage({
			type: 'devpilot.chat.send',
			payload: { requestId: '   ', text: 'Valid message' }
		}).valid, false);
		assert.strictEqual(validateWebviewMessage({
			type: 'devpilot.chat.send',
			payload: { requestId: 'a'.repeat(MAX_REQUEST_ID_LENGTH + 1), text: 'Valid message' }
		}).valid, false);

		// devpilot.chat.send: invalid text
		assert.strictEqual(validateWebviewMessage({
			type: 'devpilot.chat.send',
			payload: { requestId: 'valid-id', text: '' }
		}).valid, false);
		assert.strictEqual(validateWebviewMessage({
			type: 'devpilot.chat.send',
			payload: { requestId: 'valid-id', text: '   ' }
		}).valid, false);
		assert.strictEqual(validateWebviewMessage({
			type: 'devpilot.chat.send',
			payload: { requestId: 'valid-id', text: 'x'.repeat(MAX_CHAT_TEXT_LENGTH + 1) }
		}).valid, false);

		// devpilot.chat.send: valid boundary lengths
		assert.strictEqual(validateWebviewMessage({
			type: 'devpilot.chat.send',
			payload: { requestId: 'a', text: 'b' }
		}).valid, true);
		assert.strictEqual(validateWebviewMessage({
			type: 'devpilot.chat.send',
			payload: { requestId: 'x'.repeat(MAX_REQUEST_ID_LENGTH), text: 'y'.repeat(MAX_CHAT_TEXT_LENGTH) }
		}).valid, true);

		// devpilot.chat.cancel: invalid & valid
		assert.strictEqual(validateWebviewMessage({ type: 'devpilot.chat.cancel' }).valid, false);
		assert.strictEqual(validateWebviewMessage({
			type: 'devpilot.chat.cancel',
			payload: { requestId: '' }
		}).valid, false);
		assert.strictEqual(validateWebviewMessage({
			type: 'devpilot.chat.cancel',
			payload: { requestId: 'a'.repeat(MAX_REQUEST_ID_LENGTH + 1) }
		}).valid, false);
		assert.strictEqual(validateWebviewMessage({
			type: 'devpilot.chat.cancel',
			payload: { requestId: 'valid-req-id' }
		}).valid, true);

		// Legacy devpilot.message: valid & invalid
		assert.strictEqual(validateWebviewMessage({
			type: 'devpilot.message',
			payload: { text: '' }
		}).valid, false);
		assert.strictEqual(validateWebviewMessage({
			type: 'devpilot.message',
			payload: { text: 'Hello' }
		}).valid, true);
	});

	test('Extension-to-Webview contract typing: chunk, complete, and error shapes', () => {
		// Verify ChatChunkMessage structure
		const chunk: ChatChunkMessage = {
			type: 'devpilot.chat.chunk',
			payload: {
				requestId: 'req-streaming-1',
				text: 'const result = calculate();'
			}
		};
		assert.strictEqual(chunk.type, 'devpilot.chat.chunk');
		assert.strictEqual(chunk.payload.requestId, 'req-streaming-1');
		assert.strictEqual(chunk.payload.text, 'const result = calculate();');

		// Verify ChatCompleteMessage structure for stop and cancelled
		const completeSuccess: ChatCompleteMessage = {
			type: 'devpilot.chat.complete',
			payload: {
				requestId: 'req-streaming-1',
				fullText: 'const result = calculate();\nreturn result;',
				finishReason: 'stop'
			}
		};
		assert.strictEqual(completeSuccess.payload.finishReason, 'stop');

		const completeCancelled: ChatCompleteMessage = {
			type: 'devpilot.chat.complete',
			payload: {
				requestId: 'req-streaming-1',
				fullText: 'const result = ',
				finishReason: 'cancelled'
			}
		};
		assert.strictEqual(completeCancelled.payload.finishReason, 'cancelled');

		// Verify ChatErrorMessage structure
		const chatError: ChatErrorMessage = {
			type: 'devpilot.chat.error',
			payload: {
				requestId: 'req-streaming-1',
				code: 'CONNECTION_REFUSED',
				message: 'Cannot reach Ollama server at http://localhost:11434',
				suggestion: 'Ensure Ollama is running and model qwen3.5:9b is installed.'
			}
		};
		assert.strictEqual(chatError.type, 'devpilot.chat.error');
		assert.strictEqual(chatError.payload.code, 'CONNECTION_REFUSED');
		assert.strictEqual(chatError.payload.suggestion, 'Ensure Ollama is running and model qwen3.5:9b is installed.');
	});

	test('Streaming engine: forwards multiple chunks in order with original requestId', async () => {
		const provider = DevPilotViewProvider.currentProvider;
		assert.ok(provider, 'Provider should be initialized');
		provider.setCustomProvider(mockProvider);

		mockProvider.mockChunks = ['Chunk 1: def ', 'quick_sort(arr):', '\n    return arr'];

		const postedMessages: ExtensionToWebviewMessage[] = [];
		provider.setOnDidPostMessage(msg => postedMessages.push(msg));

		const response = await provider.handleMessage({
			type: 'devpilot.chat.send',
			payload: {
				requestId: 'req-stream-order-1',
				text: 'Implement quicksort'
			}
		});

		assert.ok(response);
		assert.strictEqual(response?.type, 'devpilot.chat.complete');

		const chunkMessages = postedMessages.filter(
			(m): m is ChatChunkMessage => m.type === 'devpilot.chat.chunk'
		);
		assert.strictEqual(chunkMessages.length, 3, 'Should emit exactly 3 chunks');

		// 1. Chunks forwarded in correct order
		assert.strictEqual(chunkMessages[0].payload.text, 'Chunk 1: def ');
		assert.strictEqual(chunkMessages[1].payload.text, 'quick_sort(arr):');
		assert.strictEqual(chunkMessages[2].payload.text, '\n    return arr');

		// 2. Each chunk contains original requestId
		for (const chunk of chunkMessages) {
			assert.strictEqual(chunk.payload.requestId, 'req-stream-order-1');
		}

		// 4 & 5. Exactly one completion sent with assembled full text and finish reason
		const completeMessages = postedMessages.filter(
			(m): m is ChatCompleteMessage => m.type === 'devpilot.chat.complete'
		);
		assert.strictEqual(completeMessages.length, 1, 'Should emit exactly one completion message');
		assert.strictEqual(completeMessages[0].payload.requestId, 'req-stream-order-1');
		assert.strictEqual(completeMessages[0].payload.fullText, 'Chunk 1: def quick_sort(arr):\n    return arr');
		assert.strictEqual(completeMessages[0].payload.finishReason, 'stop');
	});

	test('Streaming engine: chunks are forwarded before provider promise resolves', async () => {
		const provider = DevPilotViewProvider.currentProvider;
		assert.ok(provider, 'Provider should be initialized');
		provider.setCustomProvider(mockProvider);

		let resolveDeferred!: () => void;
		const deferredPromise = new Promise<void>(resolve => {
			resolveDeferred = resolve;
		});

		mockProvider.mockChunks = ['Token 1 ', 'Token 2 '];
		mockProvider.delayCompletePromise = deferredPromise;

		const postedMessages: ExtensionToWebviewMessage[] = [];
		provider.setOnDidPostMessage(msg => postedMessages.push(msg));

		const handlePromise = provider.handleMessage({
			type: 'devpilot.chat.send',
			payload: {
				requestId: 'req-deferred-test',
				text: 'Stream tokens'
			}
		});

		// Yield event loop slightly to let chunk emission occur
		await new Promise(r => setImmediate(r));

		// Chunks MUST have been forwarded before provider resolves
		const chunksBeforeResolution = postedMessages.filter(m => m.type === 'devpilot.chat.chunk');
		const completeBeforeResolution = postedMessages.filter(m => m.type === 'devpilot.chat.complete');

		assert.strictEqual(chunksBeforeResolution.length, 2, 'Chunks must be forwarded immediately');
		assert.strictEqual(completeBeforeResolution.length, 0, 'Completion must not be sent before provider resolves');

		// Now unblock provider completion
		resolveDeferred();
		const finalResponse = await handlePromise;

		assert.ok(finalResponse);
		assert.strictEqual(finalResponse?.type, 'devpilot.chat.complete');

		const finalComplete = postedMessages.filter(m => m.type === 'devpilot.chat.complete');
		assert.strictEqual(finalComplete.length, 1, 'Exactly one completion message after resolution');
	});

	test('Streaming engine: empty chunks are filtered out and not emitted to Webview', async () => {
		const provider = DevPilotViewProvider.currentProvider;
		assert.ok(provider, 'Provider should be initialized');
		provider.setCustomProvider(mockProvider);

		mockProvider.mockChunks = ['', 'Valid chunk', '', ''];

		const postedMessages: ExtensionToWebviewMessage[] = [];
		provider.setOnDidPostMessage(msg => postedMessages.push(msg));

		const response = await provider.handleMessage({
			type: 'devpilot.chat.send',
			payload: {
				requestId: 'req-empty-chunks',
				text: 'Test empty chunks'
			}
		});

		assert.ok(response);
		const chunkMessages = postedMessages.filter(m => m.type === 'devpilot.chat.chunk');
		assert.strictEqual(chunkMessages.length, 1, 'Empty chunks must be filtered out');
		assert.strictEqual((chunkMessages[0] as ChatChunkMessage).payload.text, 'Valid chunk');
	});

	test('Streaming engine: failure emits structured error event with matching requestId and no completion', async () => {
		const provider = DevPilotViewProvider.currentProvider;
		assert.ok(provider, 'Provider should be initialized');
		provider.setCustomProvider(mockProvider);

		mockProvider.mockError = new ProviderError(
			'PROVIDER_ERROR',
			'Provider stream was terminated prematurely',
			{ userSuggestion: 'Check provider daemon status.' }
		);

		const postedMessages: ExtensionToWebviewMessage[] = [];
		provider.setOnDidPostMessage(msg => postedMessages.push(msg));

		const response = await provider.handleMessage({
			type: 'devpilot.chat.send',
			payload: {
				requestId: 'req-fail-exclusive',
				text: 'Test failure exclusivity'
			}
		});

		assert.ok(response);
		assert.strictEqual(response?.type, 'devpilot.chat.error');

		const errorMessages = postedMessages.filter((m): m is ChatErrorMessage => m.type === 'devpilot.chat.error');
		const completeMessages = postedMessages.filter((m): m is ChatCompleteMessage => m.type === 'devpilot.chat.complete');

		assert.strictEqual(errorMessages.length, 1, 'Must emit exactly one error event');
		assert.strictEqual(errorMessages[0].payload.requestId, 'req-fail-exclusive');
		assert.strictEqual(errorMessages[0].payload.code, 'PROVIDER_ERROR');
		assert.strictEqual(errorMessages[0].payload.message, 'Provider stream was terminated prematurely');
		assert.strictEqual(errorMessages[0].payload.suggestion, 'Check provider daemon status.');

		assert.strictEqual(completeMessages.length, 0, 'No completion event must be emitted on failure');
		assert.strictEqual(postedMessages.length, 1, 'Only the error event should be posted');
	});

	test('Streaming engine: concurrent requests preserve isolation without mixing text or correlation IDs', async () => {
		const provider = DevPilotViewProvider.currentProvider;
		assert.ok(provider, 'Provider should be initialized');

		const concurrentMock: ILLMProvider = {
			id: 'concurrent-mock',
			displayName: 'Concurrent Mock Provider',
			async checkHealth(): Promise<ProviderHealth> {
				return { isHealthy: true, availableModels: ['mock-model'] };
			},
			async chatStream(req: ChatRequest, onChunk: (chunk: StreamChunk) => void): Promise<ChatResponse> {
				const prompt = req.messages[0].content;
				if (prompt === 'Prompt A') {
					onChunk({ text: 'A1 ' });
					onChunk({ text: 'A2' });
					return {
						text: 'A1 A2',
						finishReason: 'stop',
						model: 'mock-model'
					};
				} else {
					onChunk({ text: 'B1 ' });
					onChunk({ text: 'B2' });
					return {
						text: 'B1 B2',
						finishReason: 'stop',
						model: 'mock-model'
					};
				}
			}
		};

		provider.setCustomProvider(concurrentMock);

		const postedMessages: ExtensionToWebviewMessage[] = [];
		provider.setOnDidPostMessage(msg => postedMessages.push(msg));

		const [resA, resB] = await Promise.all([
			provider.handleMessage({
				type: 'devpilot.chat.send',
				payload: { requestId: 'req-alpha', text: 'Prompt A' }
			}),
			provider.handleMessage({
				type: 'devpilot.chat.send',
				payload: { requestId: 'req-beta', text: 'Prompt B' }
			})
		]);

		assert.ok(resA && resB);
		assert.strictEqual(resA?.type, 'devpilot.chat.complete');
		assert.strictEqual(resB?.type, 'devpilot.chat.complete');

		const messagesA = postedMessages.filter(
			m => (m as { payload?: { requestId?: string } }).payload?.requestId === 'req-alpha'
		);
		const chunksA = messagesA.filter((m): m is ChatChunkMessage => m.type === 'devpilot.chat.chunk');
		const completeA = messagesA.find((m): m is ChatCompleteMessage => m.type === 'devpilot.chat.complete');

		assert.strictEqual(chunksA.length, 2);
		assert.strictEqual(chunksA[0].payload.text, 'A1 ');
		assert.strictEqual(chunksA[1].payload.text, 'A2');
		assert.strictEqual(completeA?.payload.fullText, 'A1 A2');

		const messagesB = postedMessages.filter(
			m => (m as { payload?: { requestId?: string } }).payload?.requestId === 'req-beta'
		);
		const chunksB = messagesB.filter((m): m is ChatChunkMessage => m.type === 'devpilot.chat.chunk');
		const completeB = messagesB.find((m): m is ChatCompleteMessage => m.type === 'devpilot.chat.complete');

		assert.strictEqual(chunksB.length, 2);
		assert.strictEqual(chunksB[0].payload.text, 'B1 ');
		assert.strictEqual(chunksB[1].payload.text, 'B2');
		assert.strictEqual(completeB?.payload.fullText, 'B1 B2');
	});

	test('Streaming engine: legacy devpilot.message emits only devpilot.response without chunk events', async () => {
		const provider = DevPilotViewProvider.currentProvider;
		assert.ok(provider, 'Provider should be initialized');
		provider.setCustomProvider(mockProvider);

		mockProvider.mockChunks = ['Legacy ', 'output'];

		const postedMessages: ExtensionToWebviewMessage[] = [];
		provider.setOnDidPostMessage(msg => postedMessages.push(msg));

		const response = await provider.handleMessage({
			type: 'devpilot.message',
			payload: { text: 'Legacy prompt' }
		});

		assert.ok(response);
		assert.strictEqual(response?.type, 'devpilot.response');
		if (response?.type === 'devpilot.response') {
			assert.strictEqual(response.payload.text, 'Legacy output');
		}

		const chunkMessages = postedMessages.filter(m => m.type === 'devpilot.chat.chunk');
		const chatCompleteMessages = postedMessages.filter(m => m.type === 'devpilot.chat.complete');
		const legacyResponses = postedMessages.filter(m => m.type === 'devpilot.response');

		assert.strictEqual(chunkMessages.length, 0, 'Legacy message must not emit chat.chunk events');
		assert.strictEqual(chatCompleteMessages.length, 0, 'Legacy message must not emit chat.complete events');
		assert.strictEqual(legacyResponses.length, 1, 'Legacy message must emit exactly one devpilot.response');
	});

	test('Cancellation lifecycle: request is registered before generation starts and active count reflects in-flight work', async () => {
		const provider = DevPilotViewProvider.currentProvider;
		assert.ok(provider, 'Provider should be initialized');
		provider.setCustomProvider(mockProvider);

		let resolveGeneration!: () => void;
		mockProvider.delayCompletePromise = new Promise(resolve => {
			resolveGeneration = resolve;
		});

		assert.strictEqual(provider.getActiveRequestCount(), 0);

		const sendPromise = provider.handleMessage({
			type: 'devpilot.chat.send',
			payload: { requestId: 'req-lifecycle-reg', text: 'Count check' }
		});

		// Yield event loop to let send begin
		await new Promise(r => setImmediate(r));

		assert.strictEqual(provider.getActiveRequestCount(), 1, 'Request must be registered in active map');

		resolveGeneration();
		const response = await sendPromise;

		assert.strictEqual(response?.type, 'devpilot.chat.complete');
		assert.strictEqual(provider.getActiveRequestCount(), 0, 'Completed request must be removed from active map');
	});

	test('Cancellation lifecycle: cancelling active request aborts the actual provider signal and cleans up state', async () => {
		const provider = DevPilotViewProvider.currentProvider;
		assert.ok(provider, 'Provider should be initialized');
		provider.setCustomProvider(mockProvider);

		let resolveGeneration!: () => void;
		mockProvider.delayCompletePromise = new Promise(resolve => {
			resolveGeneration = resolve;
		});
		mockProvider.mockChunks = ['Chunk before cancel '];

		const postedMessages: ExtensionToWebviewMessage[] = [];
		provider.setOnDidPostMessage(msg => postedMessages.push(msg));

		const sendPromise = provider.handleMessage({
			type: 'devpilot.chat.send',
			payload: { requestId: 'req-abort-sig', text: 'Abort me' }
		});

		// Yield event loop so chunk is emitted and provider enters delay
		await new Promise(r => setImmediate(r));

		assert.strictEqual(provider.getActiveRequestCount(), 1);
		assert.ok(mockProvider.lastSignal, 'Signal must be passed to provider');
		assert.strictEqual(mockProvider.lastSignal.aborted, false, 'Signal should not be aborted yet');

		// Send cancel
		const cancelResponse = await provider.handleMessage({
			type: 'devpilot.chat.cancel',
			payload: { requestId: 'req-abort-sig' }
		});

		assert.strictEqual(cancelResponse?.type, 'devpilot.chat.complete');
		if (cancelResponse?.type === 'devpilot.chat.complete') {
			assert.strictEqual(cancelResponse.payload.finishReason, 'cancelled');
			assert.strictEqual(cancelResponse.payload.fullText, 'Chunk before cancel ');
		}

		assert.strictEqual(mockProvider.lastSignal.aborted, true, 'Provider signal must be aborted');
		assert.strictEqual(provider.getActiveRequestCount(), 0, 'Active map must be cleaned up');

		// Resolve generator if still pending
		resolveGeneration();
		await sendPromise;

		// Verify no chat.error messages were emitted
		const errorMessages = postedMessages.filter(m => m.type === 'devpilot.chat.error');
		assert.strictEqual(errorMessages.length, 0, 'Cancellation must not emit chat.error');
	});

	test('Cancellation lifecycle: cancellation before first chunk emits cancelled with empty fullText', async () => {
		const provider = DevPilotViewProvider.currentProvider;
		assert.ok(provider, 'Provider should be initialized');
		provider.setCustomProvider(mockProvider);

		mockProvider.delayCompletePromise = new Promise(() => {}); // never resolves on its own
		mockProvider.mockResponseText = '';

		const sendPromise = provider.handleMessage({
			type: 'devpilot.chat.send',
			payload: { requestId: 'req-before-first-chunk', text: 'Cancel early' }
		});

		await new Promise(r => setImmediate(r));

		const cancelResponse = await provider.handleMessage({
			type: 'devpilot.chat.cancel',
			payload: { requestId: 'req-before-first-chunk' }
		});

		assert.strictEqual(cancelResponse?.type, 'devpilot.chat.complete');
		if (cancelResponse?.type === 'devpilot.chat.complete') {
			assert.strictEqual(cancelResponse.payload.finishReason, 'cancelled');
			assert.strictEqual(cancelResponse.payload.fullText, '');
		}

		await sendPromise;
		assert.strictEqual(provider.getActiveRequestCount(), 0);
	});

	test('Cancellation lifecycle: cancelling one concurrent request leaves the other running to completion', async () => {
		const provider = DevPilotViewProvider.currentProvider;
		assert.ok(provider, 'Provider should be initialized');

		let abortSignalA: AbortSignal | undefined;
		let abortSignalB: AbortSignal | undefined;
		let resolveB!: () => void;

		const customMock: ILLMProvider = {
			id: 'custom-concurrent-mock',
			displayName: 'Custom Concurrent Mock',
			async checkHealth() {
				return { isHealthy: true, availableModels: ['mock-model'] };
			},
			async chatStream(req, onChunk, signal) {
				if (req.messages[0].content === 'Task A') {
					abortSignalA = signal;
					onChunk({ text: 'A part ' });
					await new Promise((_, reject) => {
						signal?.addEventListener('abort', () => {
							reject(new ProviderError('REQUEST_CANCELLED', 'Task A cancelled'));
						});
					});
					return { text: 'A done', finishReason: 'stop', model: 'mock-model' };
				} else {
					abortSignalB = signal;
					onChunk({ text: 'B part ' });
					await new Promise<void>(resolve => {
						resolveB = resolve;
					});
					onChunk({ text: 'B done' });
					return { text: 'B part B done', finishReason: 'stop', model: 'mock-model' };
				}
			}
		};

		provider.setCustomProvider(customMock);

		const postedMessages: ExtensionToWebviewMessage[] = [];
		provider.setOnDidPostMessage(msg => postedMessages.push(msg));

		const promiseA = provider.handleMessage({
			type: 'devpilot.chat.send',
			payload: { requestId: 'req-concurrent-A', text: 'Task A' }
		});
		const promiseB = provider.handleMessage({
			type: 'devpilot.chat.send',
			payload: { requestId: 'req-concurrent-B', text: 'Task B' }
		});

		await new Promise(r => setImmediate(r));

		assert.strictEqual(provider.getActiveRequestCount(), 2);

		// Cancel Task A only
		const cancelA = await provider.handleMessage({
			type: 'devpilot.chat.cancel',
			payload: { requestId: 'req-concurrent-A' }
		});

		assert.strictEqual(cancelA?.type, 'devpilot.chat.complete');
		if (cancelA?.type === 'devpilot.chat.complete') {
			assert.strictEqual(cancelA.payload.requestId, 'req-concurrent-A');
			assert.strictEqual(cancelA.payload.finishReason, 'cancelled');
			assert.strictEqual(cancelA.payload.fullText, 'A part ');
		}

		assert.strictEqual(abortSignalA?.aborted, true, 'Task A signal must be aborted');
		assert.strictEqual(abortSignalB?.aborted, false, 'Task B signal must NOT be aborted');
		assert.strictEqual(provider.getActiveRequestCount(), 1, 'Only Task B should remain active');

		// Complete Task B
		resolveB();
		const responseB = await promiseB;
		await promiseA;

		assert.strictEqual(responseB?.type, 'devpilot.chat.complete');
		if (responseB?.type === 'devpilot.chat.complete') {
			assert.strictEqual(responseB.payload.requestId, 'req-concurrent-B');
			assert.strictEqual(responseB.payload.finishReason, 'stop');
			assert.strictEqual(responseB.payload.fullText, 'B part B done');
		}

		assert.strictEqual(provider.getActiveRequestCount(), 0);
	});

	test('Cancellation lifecycle: duplicate active requestId is rejected without replacing active request', async () => {
		const provider = DevPilotViewProvider.currentProvider;
		assert.ok(provider, 'Provider should be initialized');
		provider.setCustomProvider(mockProvider);

		let resolveOriginal!: () => void;
		mockProvider.delayCompletePromise = new Promise(resolve => {
			resolveOriginal = resolve;
		});

		const origPromise = provider.handleMessage({
			type: 'devpilot.chat.send',
			payload: { requestId: 'req-duplicate-check', text: 'Original request' }
		});

		await new Promise(r => setImmediate(r));

		assert.strictEqual(provider.getActiveRequestCount(), 1);

		// Attempt to submit identical active requestId
		const duplicateResponse = await provider.handleMessage({
			type: 'devpilot.chat.send',
			payload: { requestId: 'req-duplicate-check', text: 'Duplicate request' }
		});

		assert.strictEqual(duplicateResponse?.type, 'devpilot.chat.error');
		if (duplicateResponse?.type === 'devpilot.chat.error') {
			assert.strictEqual(duplicateResponse.payload.requestId, 'req-duplicate-check');
			assert.strictEqual(duplicateResponse.payload.code, 'INVALID_PAYLOAD');
			assert.ok(duplicateResponse.payload.message.includes('already active'));
		}

		// The original request is still active and can finish cleanly
		assert.strictEqual(provider.getActiveRequestCount(), 1);
		resolveOriginal();
		const origResponse = await origPromise;
		assert.strictEqual(origResponse?.type, 'devpilot.chat.complete');
		assert.strictEqual(provider.getActiveRequestCount(), 0);
	});

	test('Cancellation lifecycle: repeated or unknown cancellation calls are idempotent and safe', async () => {
		const provider = DevPilotViewProvider.currentProvider;
		assert.ok(provider, 'Provider should be initialized');
		provider.setCustomProvider(mockProvider);

		// Cancelling unknown request
		const unknownCancel = await provider.handleMessage({
			type: 'devpilot.chat.cancel',
			payload: { requestId: 'req-non-existent' }
		});

		assert.ok(unknownCancel);
		assert.strictEqual(unknownCancel?.type, 'devpilot.chat.complete');
		if (unknownCancel?.type === 'devpilot.chat.complete') {
			assert.strictEqual(unknownCancel.payload.requestId, 'req-non-existent');
			assert.strictEqual(unknownCancel.payload.finishReason, 'cancelled');
		}

		// Cancelling twice in a row
		const repeatedCancel = await provider.handleMessage({
			type: 'devpilot.chat.cancel',
			payload: { requestId: 'req-non-existent' }
		});
		assert.strictEqual(repeatedCancel?.type, 'devpilot.chat.complete');
	});

	test('Cancellation lifecycle: cancelAllRequests aborts all active requests and cleans up resources', async () => {
		const provider = DevPilotViewProvider.currentProvider;
		assert.ok(provider, 'Provider should be initialized');
		provider.setCustomProvider(mockProvider);

		mockProvider.delayCompletePromise = new Promise(() => {}); // hang

		const promise1 = provider.handleMessage({
			type: 'devpilot.chat.send',
			payload: { requestId: 'req-dispose-1', text: 'Prompt 1' }
		});
		const promise2 = provider.handleMessage({
			type: 'devpilot.chat.send',
			payload: { requestId: 'req-dispose-2', text: 'Prompt 2' }
		});

		await new Promise(r => setImmediate(r));
		assert.strictEqual(provider.getActiveRequestCount(), 2);

		provider.cancelAllRequests();

		assert.strictEqual(provider.getActiveRequestCount(), 0, 'All active requests should be cleared');
		await Promise.all([promise1, promise2]);
	});

	test('Failure handling: request failing after partial output forwards chunks, emits error, and cleans up registry', async () => {
		const provider = DevPilotViewProvider.currentProvider;
		assert.ok(provider, 'Provider should be initialized');

		const failingMock: ILLMProvider = {
			id: 'partial-fail-mock',
			displayName: 'Partial Fail Mock',
			async checkHealth() {
				return { isHealthy: true, availableModels: [] };
			},
			async chatStream(_req, onChunk) {
				onChunk({ text: 'Partial text 1 ' });
				onChunk({ text: 'Partial text 2' });
				throw new ProviderError('CONNECTION_REFUSED', 'Network socket reset unexpectedly.');
			}
		};
		provider.setCustomProvider(failingMock);

		const postedMessages: ExtensionToWebviewMessage[] = [];
		provider.setOnDidPostMessage(msg => postedMessages.push(msg));

		const response = await provider.handleMessage({
			type: 'devpilot.chat.send',
			payload: { requestId: 'req-partial-fail', text: 'Generate code' }
		});

		assert.ok(response);
		assert.strictEqual(response?.type, 'devpilot.chat.error');
		assert.strictEqual(provider.getActiveRequestCount(), 0, 'Registry must be cleaned up on failure');

		const chunks = postedMessages.filter((m): m is ChatChunkMessage => m.type === 'devpilot.chat.chunk');
		assert.strictEqual(chunks.length, 2);
		assert.strictEqual(chunks[0].payload.text, 'Partial text 1 ');
		assert.strictEqual(chunks[1].payload.text, 'Partial text 2');

		const errors = postedMessages.filter((m): m is ChatErrorMessage => m.type === 'devpilot.chat.error');
		assert.strictEqual(errors.length, 1);
		assert.strictEqual(errors[0].payload.code, 'CONNECTION_REFUSED');

		const completes = postedMessages.filter(m => m.type === 'devpilot.chat.complete');
		assert.strictEqual(completes.length, 0, 'Failed request must not emit completion');
	});

	test('Failure handling: cancellation racing with provider failure emits only cancelled terminal event', async () => {
		const provider = DevPilotViewProvider.currentProvider;
		assert.ok(provider, 'Provider should be initialized');

		let rejectProvider!: (err: Error) => void;
		const racingMock: ILLMProvider = {
			id: 'racing-mock',
			displayName: 'Racing Mock',
			async checkHealth() {
				return { isHealthy: true, availableModels: [] };
			},
			async chatStream(_req, onChunk, signal) {
				onChunk({ text: 'Initial chunk' });
				return new Promise((_resolve, reject) => {
					rejectProvider = reject;
					signal?.addEventListener('abort', () => {
						reject(new ProviderError('REQUEST_CANCELLED', 'Request cancelled'));
					});
				});
			}
		};
		provider.setCustomProvider(racingMock);

		const postedMessages: ExtensionToWebviewMessage[] = [];
		provider.setOnDidPostMessage(msg => postedMessages.push(msg));

		const sendPromise = provider.handleMessage({
			type: 'devpilot.chat.send',
			payload: { requestId: 'req-race-fail-cancel', text: 'Prompt' }
		});

		await new Promise(r => setImmediate(r));

		// Cancel request and trigger failure simultaneously
		const [cancelRes] = await Promise.all([
			provider.handleMessage({
				type: 'devpilot.chat.cancel',
				payload: { requestId: 'req-race-fail-cancel' }
			}),
			new Promise<void>(resolve => {
				rejectProvider(new ProviderError('PROVIDER_ERROR', 'Simultaneous server crash'));
				resolve();
			})
		]);

		await sendPromise;

		assert.strictEqual(cancelRes?.type, 'devpilot.chat.complete');
		if (cancelRes?.type === 'devpilot.chat.complete') {
			assert.strictEqual(cancelRes.payload.finishReason, 'cancelled');
		}

		const errors = postedMessages.filter(m => m.type === 'devpilot.chat.error');
		assert.strictEqual(errors.length, 0, 'Cancelled request must suppress provider error');

		assert.strictEqual(provider.getActiveRequestCount(), 0);
	});

	test('Failure handling: late cancellation after successful completion does not broadcast duplicate cancelled event', async () => {
		const provider = DevPilotViewProvider.currentProvider;
		assert.ok(provider, 'Provider should be initialized');
		provider.setCustomProvider(mockProvider);

		mockProvider.mockResponseText = 'Immediate full response';

		const postedMessages: ExtensionToWebviewMessage[] = [];
		provider.setOnDidPostMessage(msg => postedMessages.push(msg));

		// 1. Complete request normally
		const sendRes = await provider.handleMessage({
			type: 'devpilot.chat.send',
			payload: { requestId: 'req-complete-then-cancel', text: 'Quick prompt' }
		});

		assert.strictEqual(sendRes?.type, 'devpilot.chat.complete');
		assert.strictEqual(provider.getActiveRequestCount(), 0);

		const completesBefore = postedMessages.filter(m => m.type === 'devpilot.chat.complete');
		assert.strictEqual(completesBefore.length, 1);
		assert.strictEqual((completesBefore[0] as ChatCompleteMessage).payload.finishReason, 'stop');

		// 2. Late cancel arrives for the already-completed request
		const cancelRes = await provider.handleMessage({
			type: 'devpilot.chat.cancel',
			payload: { requestId: 'req-complete-then-cancel' }
		});

		// Returns acknowledgement to caller
		assert.strictEqual(cancelRes?.type, 'devpilot.chat.complete');

		// But does NOT post duplicate conflicting event to webview
		const completesAfter = postedMessages.filter(m => m.type === 'devpilot.chat.complete');
		assert.strictEqual(completesAfter.length, 1, 'Must not post conflicting cancelled completion to webview');
	});

	test('Failure handling: multiple concurrent requests failing independently clean up cleanly', async () => {
		const provider = DevPilotViewProvider.currentProvider;
		assert.ok(provider, 'Provider should be initialized');

		const independentMock: ILLMProvider = {
			id: 'independent-fail-mock',
			displayName: 'Independent Fail Mock',
			async checkHealth() {
				return { isHealthy: true, availableModels: [] };
			},
			async chatStream(req) {
				if (req.messages[0].content === 'Fail Conn') {
					throw new ProviderError('CONNECTION_REFUSED', 'Ollama offline');
				} else {
					throw new ProviderError('MODEL_NOT_FOUND', 'Model missing');
				}
			}
		};
		provider.setCustomProvider(independentMock);

		const [resA, resB] = await Promise.all([
			provider.handleMessage({
				type: 'devpilot.chat.send',
				payload: { requestId: 'req-fail-A', text: 'Fail Conn' }
			}),
			provider.handleMessage({
				type: 'devpilot.chat.send',
				payload: { requestId: 'req-fail-B', text: 'Fail Model' }
			})
		]);

		assert.strictEqual(resA?.type, 'devpilot.chat.error');
		assert.strictEqual((resA as ChatErrorMessage).payload.code, 'CONNECTION_REFUSED');

		assert.strictEqual(resB?.type, 'devpilot.chat.error');
		assert.strictEqual((resB as ChatErrorMessage).payload.code, 'MODEL_NOT_FOUND');

		assert.strictEqual(provider.getActiveRequestCount(), 0, 'Both failed requests must be cleaned up');
	});

	test('Failure handling: failed request followed by a successful request operates normally', async () => {
		const provider = DevPilotViewProvider.currentProvider;
		assert.ok(provider, 'Provider should be initialized');
		provider.setCustomProvider(mockProvider);

		// First request fails
		mockProvider.mockError = new ProviderError('PROVIDER_ERROR', 'Transient failure');
		const failRes = await provider.handleMessage({
			type: 'devpilot.chat.send',
			payload: { requestId: 'req-transient-fail', text: 'Failing prompt' }
		});
		assert.strictEqual(failRes?.type, 'devpilot.chat.error');
		assert.strictEqual(provider.getActiveRequestCount(), 0);

		// Second request succeeds
		mockProvider.mockError = undefined;
		mockProvider.mockResponseText = 'Recovered output';
		const successRes = await provider.handleMessage({
			type: 'devpilot.chat.send',
			payload: { requestId: 'req-recovered-success', text: 'Working prompt' }
		});
		assert.strictEqual(successRes?.type, 'devpilot.chat.complete');
		assert.strictEqual((successRes as ChatCompleteMessage).payload.fullText, 'Recovered output');
		assert.strictEqual(provider.getActiveRequestCount(), 0);
	});

	test('Failure handling: one failing request does not corrupt a concurrent successful request', async () => {
		const provider = DevPilotViewProvider.currentProvider;
		assert.ok(provider, 'Provider should be initialized');

		let resolveGood!: () => void;
		const mixedMock: ILLMProvider = {
			id: 'mixed-mock',
			displayName: 'Mixed Mock',
			async checkHealth() {
				return { isHealthy: true, availableModels: [] };
			},
			async chatStream(req, onChunk) {
				if (req.messages[0].content === 'Failing') {
					throw new ProviderError('TIMEOUT', 'Request timed out');
				} else {
					onChunk({ text: 'Good chunk 1 ' });
					await new Promise<void>(resolve => {
						resolveGood = resolve;
					});
					onChunk({ text: 'Good chunk 2' });
					return { text: 'Good chunk 1 Good chunk 2', finishReason: 'stop', model: 'mock' };
				}
			}
		};
		provider.setCustomProvider(mixedMock);

		const failPromise = provider.handleMessage({
			type: 'devpilot.chat.send',
			payload: { requestId: 'req-mixed-fail', text: 'Failing' }
		});
		const goodPromise = provider.handleMessage({
			type: 'devpilot.chat.send',
			payload: { requestId: 'req-mixed-good', text: 'Succeeding' }
		});

		const failRes = await failPromise;
		assert.strictEqual(failRes?.type, 'devpilot.chat.error');
		assert.strictEqual((failRes as ChatErrorMessage).payload.code, 'TIMEOUT');

		// Good request is still in-flight
		assert.strictEqual(provider.getActiveRequestCount(), 1);

		resolveGood();
		const goodRes = await goodPromise;
		assert.strictEqual(goodRes?.type, 'devpilot.chat.complete');
		assert.strictEqual((goodRes as ChatCompleteMessage).payload.fullText, 'Good chunk 1 Good chunk 2');

		assert.strictEqual(provider.getActiveRequestCount(), 0);
	});

	test('Provider resolution: getOllamaConfigFromVSCode loads valid Ollama settings from VS Code', () => {
		const config = getOllamaConfigFromVSCode();
		assert.ok(config, 'Configuration must be defined');
		assert.ok(config.baseUrl.startsWith('http'), `Base URL must be HTTP/HTTPS, got: ${config.baseUrl}`);
		assert.ok(config.model.length > 0, `Model must be non-empty string, got: ${config.model}`);
		assert.ok(config.timeoutMs > 0, `Timeout must be positive, got: ${config.timeoutMs}`);
		assert.strictEqual(typeof config.think, 'boolean');
		assert.strictEqual(config.think, false);
	});

	test('Provider resolution: DevPilotViewProvider defaults to live OllamaProvider using VS Code configuration', () => {
		const provider = DevPilotViewProvider.currentProvider;
		assert.ok(provider, 'Provider should be initialized');

		provider.setCustomProvider(undefined);
		const defaultProvider = provider.getProvider();
		assert.ok(defaultProvider instanceof OllamaProvider, 'Default provider must be an OllamaProvider instance');
		assert.strictEqual(defaultProvider.id, 'ollama');

		const vsCodeConfig = getOllamaConfigFromVSCode();
		assert.strictEqual((defaultProvider as OllamaProvider).config.baseUrl, vsCodeConfig.baseUrl);
		assert.strictEqual((defaultProvider as OllamaProvider).config.model, vsCodeConfig.model);
		assert.strictEqual((defaultProvider as OllamaProvider).config.timeoutMs, vsCodeConfig.timeoutMs);
		assert.strictEqual((defaultProvider as OllamaProvider).config.think, vsCodeConfig.think);
	});

	test('Provider resolution: DevPilotViewProvider dispatches chat.send using the default configured provider', async () => {
		const provider = DevPilotViewProvider.currentProvider;
		assert.ok(provider, 'Provider should be initialized');

		const originalFetch = globalThis.fetch;
		let fetchCalled = false;
		let fetchedUrl = '';
		let fetchedBody = '';
		try {
			globalThis.fetch = (async (input: any, init?: any) => {
				fetchCalled = true;
				fetchedUrl = String(input);
				fetchedBody = String(init?.body ?? '');
				const encoder = new TextEncoder();
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(encoder.encode(JSON.stringify({
							message: { role: 'assistant', content: 'Inference chunk' },
							done: false
						}) + '\n'));
						controller.enqueue(encoder.encode(JSON.stringify({
							done: true,
							done_reason: 'stop',
							prompt_eval_count: 5,
							eval_count: 2
						}) + '\n'));
						controller.close();
					}
				});
				return new Response(stream, {
					status: 200,
					headers: { 'Content-Type': 'application/x-ndjson' }
				});
			}) as typeof fetch;

			provider.setCustomProvider(undefined);
			const chunksReceived: string[] = [];
			provider.setOnDidPostMessage(msg => {
				if (msg.type === 'devpilot.chat.chunk') {
					chunksReceived.push(msg.payload.text);
				}
			});

			const response = await provider.handleMessage({
				type: 'devpilot.chat.send',
				payload: {
					requestId: 'req-default-provider-test',
					text: 'Testing default OllamaProvider invocation'
				}
			});

			assert.strictEqual(fetchCalled, true, 'Default provider must invoke HTTP fetch');
			assert.ok(fetchedUrl.endsWith('/api/chat'), `Must target /api/chat, got: ${fetchedUrl}`);
			const parsedPayload = JSON.parse(fetchedBody);
			assert.strictEqual(parsedPayload.model, 'qwen3.5:9b');
			assert.strictEqual(parsedPayload.think, false);
			assert.strictEqual(response?.type, 'devpilot.chat.complete');
			assert.strictEqual((response as ChatCompleteMessage).payload.fullText, 'Inference chunk');
			assert.deepStrictEqual(chunksReceived, ['Inference chunk']);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test('Generation metrics: complete event carries metrics payload when returned by provider', async () => {
		const provider = DevPilotViewProvider.currentProvider;
		assert.ok(provider);
		provider.setCustomProvider(mockProvider);

		mockProvider.mockResponseText = 'Metrics output';
		mockProvider.mockMetrics = {
			evalCount: 120,
			evalDurationMs: 5000,
			tokensPerSecond: 24,
			promptEvalCount: 15,
			promptEvalDurationMs: 150,
			totalDurationMs: 5200,
			loadDurationMs: 50
		};

		const response = await provider.handleMessage({
			type: 'devpilot.chat.send',
			payload: { requestId: 'req-metrics-complete', text: 'Hello' }
		});

		assert.strictEqual(response?.type, 'devpilot.chat.complete');
		const completeMsg = response as ChatCompleteMessage;
		assert.ok(completeMsg.payload.metrics, 'Metrics payload must be present on complete message');
		assert.strictEqual(completeMsg.payload.metrics.evalCount, 120);
		assert.strictEqual(completeMsg.payload.metrics.evalDurationMs, 5000);
		assert.strictEqual(completeMsg.payload.metrics.tokensPerSecond, 24);
		assert.strictEqual(completeMsg.payload.metrics.promptEvalCount, 15);
		assert.strictEqual(completeMsg.payload.metrics.promptEvalDurationMs, 150);
		assert.strictEqual(completeMsg.payload.metrics.totalDurationMs, 5200);
		assert.strictEqual(completeMsg.payload.metrics.loadDurationMs, 50);
	});

	test('Generation metrics: complete event omits metrics field when provider does not supply metrics', async () => {
		const provider = DevPilotViewProvider.currentProvider;
		assert.ok(provider);
		provider.setCustomProvider(mockProvider);

		mockProvider.mockResponseText = 'No metrics output';
		mockProvider.mockMetrics = undefined;

		const response = await provider.handleMessage({
			type: 'devpilot.chat.send',
			payload: { requestId: 'req-no-metrics', text: 'Hello' }
		});

		assert.strictEqual(response?.type, 'devpilot.chat.complete');
		const completeMsg = response as ChatCompleteMessage;
		assert.strictEqual(completeMsg.payload.metrics, undefined, 'Metrics payload must be omitted when provider returns none');
	});

	test('Generation metrics: concurrent requests maintain isolated metrics payloads', async () => {
		const provider = DevPilotViewProvider.currentProvider;
		assert.ok(provider);

		class DynamicMockProvider implements ILLMProvider {
			public readonly id = 'dynamic-mock';
			public readonly displayName = 'Dynamic Mock';
			public async checkHealth(): Promise<ProviderHealth> {
				return { isHealthy: true, availableModels: ['mock'] };
			}
			public async chatStream(req: ChatRequest, onChunk: (c: StreamChunk) => void): Promise<ChatResponse> {
				const isA = req.messages[0].content.includes('ReqA');
				onChunk({ text: isA ? 'A-text' : 'B-text' });
				return {
					text: isA ? 'A-text' : 'B-text',
					finishReason: 'stop',
					metrics: isA
						? { evalCount: 50, evalDurationMs: 2000, tokensPerSecond: 25 }
						: { evalCount: 100, evalDurationMs: 2500, tokensPerSecond: 40 }
				};
			}
		}

		provider.setCustomProvider(new DynamicMockProvider());

		const [resA, resB] = await Promise.all([
			provider.handleMessage({
				type: 'devpilot.chat.send',
				payload: { requestId: 'req-iso-A', text: 'ReqA' }
			}),
			provider.handleMessage({
				type: 'devpilot.chat.send',
				payload: { requestId: 'req-iso-B', text: 'ReqB' }
			})
		]);

		assert.strictEqual(resA?.type, 'devpilot.chat.complete');
		assert.strictEqual(resB?.type, 'devpilot.chat.complete');

		const compA = resA as ChatCompleteMessage;
		const compB = resB as ChatCompleteMessage;

		assert.strictEqual(compA.payload.requestId, 'req-iso-A');
		assert.strictEqual(compA.payload.metrics?.evalCount, 50);
		assert.strictEqual(compA.payload.metrics?.tokensPerSecond, 25);

		assert.strictEqual(compB.payload.requestId, 'req-iso-B');
		assert.strictEqual(compB.payload.metrics?.evalCount, 100);
		assert.strictEqual(compB.payload.metrics?.tokensPerSecond, 40);
	});

	test('deactivate executes without error', () => {
		assert.doesNotThrow(() => {
			myExtension.deactivate();
		});
	});
});
