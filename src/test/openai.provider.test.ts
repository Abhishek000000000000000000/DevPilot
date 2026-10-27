import * as assert from 'assert';
import { OpenAICompatibleProvider } from '../providers/openai/OpenAICompatibleProvider.js';
import {
	validateOpenAICompatibleConfig,
	DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
	DEFAULT_OPENAI_COMPATIBLE_MODEL,
	DEFAULT_OPENAI_COMPATIBLE_TIMEOUT_MS
} from '../providers/openai/OpenAICompatibleConfig.js';
import { ProviderError } from '../providers/errors.js';
import { ChatRequest, StreamChunk } from '../providers/types.js';

suite('OpenAICompatibleProvider & Configuration Test Suite', () => {
	// Helper to create mock SSE streaming Response
	function createMockSseResponse(
		chunks: string[],
		status = 200,
		statusText = 'OK',
		headers: Record<string, string> = { 'Content-Type': 'text/event-stream' }
	): Response {
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) {
					controller.enqueue(encoder.encode(chunk));
				}
				controller.close();
			}
		});
		return new Response(stream, {
			status,
			statusText,
			headers
		});
	}

	// Helper to create mock JSON Response
	function createMockJsonResponse(
		data: unknown,
		status = 200,
		statusText = 'OK',
		headers: Record<string, string> = { 'Content-Type': 'application/json' }
	): Response {
		return new Response(JSON.stringify(data), {
			status,
			statusText,
			headers
		});
	}

	const sampleRequest: ChatRequest = {
		messages: [{ role: 'user', content: 'What is quicksort?' }]
	};

	// --- 1. Identity & Configuration Validation ---
	test('1. Provider identity and default configuration', () => {
		const provider = new OpenAICompatibleProvider();
		assert.strictEqual(provider.id, 'openai-compatible');
		assert.strictEqual(provider.displayName, 'OpenAI-Compatible');
		assert.strictEqual(provider.config.baseUrl, DEFAULT_OPENAI_COMPATIBLE_BASE_URL);
		assert.strictEqual(provider.config.model, DEFAULT_OPENAI_COMPATIBLE_MODEL);
		assert.strictEqual(provider.config.timeoutMs, DEFAULT_OPENAI_COMPATIBLE_TIMEOUT_MS);
		assert.strictEqual(provider.config.apiKey, undefined);
	});

	test('2. Custom configuration and baseUrl normalization (strips trailing slashes)', () => {
		const provider = new OpenAICompatibleProvider({
			baseUrl: 'https://api.groq.com/openai/v1///',
			model: 'qwen-2.5-coder-32b',
			apiKey: '  gsk_custom_key_123  ',
			timeoutMs: 45000
		});
		assert.strictEqual(provider.config.baseUrl, 'https://api.groq.com/openai/v1');
		assert.strictEqual(provider.config.model, 'qwen-2.5-coder-32b');
		assert.strictEqual(provider.config.apiKey, 'gsk_custom_key_123');
		assert.strictEqual(provider.config.timeoutMs, 45000);
	});

	test('3. Configuration rejects invalid baseUrl protocol and malformed URLs', () => {
		assert.throws(() => validateOpenAICompatibleConfig({ baseUrl: 'ftp://api.example.com' }), /protocol/);
		assert.throws(() => validateOpenAICompatibleConfig({ baseUrl: 'not-a-valid-url' }), /valid HTTP or HTTPS URL/);
	});

	test('4. Configuration rejects empty model identifier', () => {
		assert.throws(() => validateOpenAICompatibleConfig({ model: '' }), /Model identifier must be a non-empty string/);
		assert.throws(() => validateOpenAICompatibleConfig({ model: '   ' }), /Model identifier must be a non-empty string/);
	});

	test('5. Configuration rejects out-of-range timeoutMs', () => {
		assert.throws(() => validateOpenAICompatibleConfig({ timeoutMs: 500 }), /timeoutMs must be a number between/);
		assert.throws(() => validateOpenAICompatibleConfig({ timeoutMs: 700000 }), /timeoutMs must be a number between/);
		assert.throws(() => validateOpenAICompatibleConfig({ timeoutMs: NaN }), /timeoutMs must be a number between/);
	});

	// --- 2. SSE Token Streaming & Chunk Assembly ---
	test('6. Streams tokens cleanly from standard OpenAI SSE event stream', async () => {
		const emittedChunks: string[] = [];
		const ssePayload = [
			'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
			'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
			'data: {"choices":[{"delta":{"content":"!"},"finish_reason":"stop"}]}\n\n',
			'data: [DONE]\n\n'
		];

		const mockFetch: typeof fetch = async () => createMockSseResponse(ssePayload);
		const provider = new OpenAICompatibleProvider({}, mockFetch);

		const response = await provider.chatStream(sampleRequest, (chunk: StreamChunk) => {
			emittedChunks.push(chunk.text);
		});

		assert.deepStrictEqual(emittedChunks, ['Hello', ' world', '!']);
		assert.strictEqual(response.text, 'Hello world!');
		assert.strictEqual(response.finishReason, 'stop');
	});

	test('7. Handles split lines and fragmented network chunks gracefully', async () => {
		const emittedChunks: string[] = [];
		// Fragmented bytes across two TCP reads
		const ssePayload = [
			'data: {"choices":[{"delta":{"con',
			'tent":"Fragmented'
		];
		const ssePayload2 = [
			' data" synchronizing}]}\n\ndata: [DONE]\n\n'
		];
		// Re-encode cleanly so JSON is split mid-string
		const chunkA = 'data: {"choices":[{"delta":{"content":"Part 1';
		const chunkB = ' and Part 2"}}]}\n\ndata: [DONE]\n\n';

		const mockFetch: typeof fetch = async () => createMockSseResponse([chunkA, chunkB]);
		const provider = new OpenAICompatibleProvider({}, mockFetch);

		const response = await provider.chatStream(sampleRequest, (chunk: StreamChunk) => {
			emittedChunks.push(chunk.text);
		});

		assert.strictEqual(response.text, 'Part 1 and Part 2');
		assert.strictEqual(emittedChunks.join(''), 'Part 1 and Part 2');
	});

	test('8. Handles multiple SSE events in a single packet and ignores comment keep-alives', async () => {
		const emittedChunks: string[] = [];
		const multiEventPacket = [
			': ping keep-alive\n\n' +
			'data: {"choices":[{"delta":{"content":"Fast"}}]}\n\n' +
			'data: {"choices":[{"delta":{"content":" stream"}}]}\n\n' +
			': another comment\n\n' +
			'data: [DONE]\n\n'
		];

		const mockFetch: typeof fetch = async () => createMockSseResponse(multiEventPacket);
		const provider = new OpenAICompatibleProvider({}, mockFetch);

		const response = await provider.chatStream(sampleRequest, (chunk: StreamChunk) => {
			emittedChunks.push(chunk.text);
		});

		assert.deepStrictEqual(emittedChunks, ['Fast', ' stream']);
		assert.strictEqual(response.text, 'Fast stream');
	});

	test('9. Accurately maps length finish reason when output was truncated', async () => {
		const ssePayload = [
			'data: {"choices":[{"delta":{"content":"Truncated answer..."},"finish_reason":"length"}]}\n\n',
			'data: [DONE]\n\n'
		];

		const mockFetch: typeof fetch = async () => createMockSseResponse(ssePayload);
		const provider = new OpenAICompatibleProvider({}, mockFetch);

		const response = await provider.chatStream(sampleRequest, () => {});
		assert.strictEqual(response.finishReason, 'length');
	});

	// --- 3. Usage & Metrics Mapping ---
	test('10. Extracts usage and computes performance metrics when returned in stream', async () => {
		const ssePayload = [
			'data: {"choices":[{"delta":{"content":"Generated response"}}]}\n\n',
			'data: {"choices":[],"usage":{"prompt_tokens":25,"completion_tokens":10,"total_tokens":35}}\n\n',
			'data: [DONE]\n\n'
		];

		const mockFetch: typeof fetch = async () => createMockSseResponse(ssePayload);
		const provider = new OpenAICompatibleProvider({}, mockFetch);

		const response = await provider.chatStream(sampleRequest, () => {});

		assert.strictEqual(response.usage?.promptTokens, 25);
		assert.strictEqual(response.usage?.completionTokens, 10);
		assert.strictEqual(response.metrics?.evalCount, 10);
		assert.strictEqual(response.metrics?.promptEvalCount, 25);
		assert.ok(response.metrics?.totalDurationMs !== undefined && response.metrics.totalDurationMs >= 0);
	});

	test('11. Omits prompt tokens if provider stream does not include usage metadata', async () => {
		const ssePayload = [
			'data: {"choices":[{"delta":{"content":"Simple"}}]}\n\n',
			'data: [DONE]\n\n'
		];

		const mockFetch: typeof fetch = async () => createMockSseResponse(ssePayload);
		const provider = new OpenAICompatibleProvider({}, mockFetch);

		const response = await provider.chatStream(sampleRequest, () => {});
		assert.strictEqual(response.usage?.promptTokens, undefined);
		assert.strictEqual(response.usage?.completionTokens, undefined);
	});

	// --- 4. Cancellation & Timeouts ---
	test('12. Aborts immediately if signal is already aborted before fetch', async () => {
		const controller = new AbortController();
		controller.abort(new Error('Pre-aborted'));

		const provider = new OpenAICompatibleProvider();
		await assert.rejects(
			async () => provider.chatStream(sampleRequest, () => {}, controller.signal),
			(err: ProviderError) => {
				assert.strictEqual(err.code, 'REQUEST_CANCELLED');
				return true;
			}
		);
	});

	test('13. Mid-stream cancellation triggers clean stream closure and REQUEST_CANCELLED', async () => {
		const controller = new AbortController();
		let callCount = 0;

		const mockFetch: typeof fetch = async () => {
			const stream = new ReadableStream<Uint8Array>({
				async pull(c) {
					callCount++;
					if (callCount === 1) {
						c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Start"}}]}\n\n'));
					} else {
						// Wait for abort
						await new Promise(r => setTimeout(r, 50));
					}
				}
			});
			return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
		};

		const provider = new OpenAICompatibleProvider({}, mockFetch);

		await assert.rejects(
			async () => {
				await provider.chatStream(
					sampleRequest,
					() => {
						controller.abort();
					},
					controller.signal
				);
			},
			(err: ProviderError) => {
				assert.strictEqual(err.code, 'REQUEST_CANCELLED');
				return true;
			}
		);
	});

	test('14. Throws TIMEOUT if response takes longer than configured timeoutMs', async () => {
		const mockFetch: typeof fetch = async (_url, init) => {
			const signal = init?.signal as AbortSignal;
			return new Promise<Response>((_, reject) => {
				signal?.addEventListener('abort', () => reject(signal.reason));
			});
		};

		const provider = new OpenAICompatibleProvider({ timeoutMs: 1000 }, mockFetch);

		await assert.rejects(
			async () => provider.chatStream(sampleRequest, () => {}),
			(err: ProviderError) => {
				assert.strictEqual(err.code, 'TIMEOUT');
				return true;
			}
		);
	});

	// --- 5. HTTP Status Code Normalization ---
	test('15. Maps HTTP 401/403 to AUTHENTICATION_FAILED with actionable user suggestion', async () => {
		const mockFetch: typeof fetch = async () =>
			createMockJsonResponse({ error: { message: 'Incorrect API key provided' } }, 401, 'Unauthorized');

		const provider = new OpenAICompatibleProvider({ apiKey: 'gsk_invalid_key' }, mockFetch);

		await assert.rejects(
			async () => provider.chatStream(sampleRequest, () => {}),
			(err: ProviderError) => {
				assert.strictEqual(err.code, 'AUTHENTICATION_FAILED');
				assert.ok(err.userSuggestion?.includes('DevPilot: Set Provider API Key'));
				return true;
			}
		);
	});

	test('16. Maps HTTP 429 to RATE_LIMITED and includes retry-after guidance when present', async () => {
		const mockFetch: typeof fetch = async () =>
			createMockJsonResponse(
				{ error: { message: 'Rate limit exceeded: TPM reached' } },
				429,
				'Too Many Requests',
				{ 'Content-Type': 'application/json', 'retry-after': '12' }
			);

		const provider = new OpenAICompatibleProvider({}, mockFetch);

		await assert.rejects(
			async () => provider.chatStream(sampleRequest, () => {}),
			(err: ProviderError) => {
				assert.strictEqual(err.code, 'RATE_LIMITED');
				assert.ok(err.message.includes('retry after 12 seconds'));
				return true;
			}
		);
	});

	test('17. Maps HTTP 404 to MODEL_NOT_FOUND', async () => {
		const mockFetch: typeof fetch = async () =>
			createMockJsonResponse({ error: { message: 'The model does not exist' } }, 404, 'Not Found');

		const provider = new OpenAICompatibleProvider({ model: 'non-existent-model' }, mockFetch);

		await assert.rejects(
			async () => provider.chatStream(sampleRequest, () => {}),
			(err: ProviderError) => {
				assert.strictEqual(err.code, 'MODEL_NOT_FOUND');
				assert.ok(err.message.includes('non-existent-model'));
				return true;
			}
		);
	});

	test('18. Maps HTTP 400 to INVALID_REQUEST', async () => {
		const mockFetch: typeof fetch = async () =>
			createMockJsonResponse({ error: { message: 'Invalid payload structure' } }, 400, 'Bad Request');

		const provider = new OpenAICompatibleProvider({}, mockFetch);

		await assert.rejects(
			async () => provider.chatStream(sampleRequest, () => {}),
			(err: ProviderError) => {
				assert.strictEqual(err.code, 'INVALID_REQUEST');
				return true;
			}
		);
	});

	test('19. Maps HTTP 500/503 to PROVIDER_ERROR', async () => {
		const mockFetch: typeof fetch = async () =>
			createMockJsonResponse({ error: { message: 'Internal server error' } }, 503, 'Service Unavailable');

		const provider = new OpenAICompatibleProvider({}, mockFetch);

		await assert.rejects(
			async () => provider.chatStream(sampleRequest, () => {}),
			(err: ProviderError) => {
				assert.strictEqual(err.code, 'PROVIDER_ERROR');
				return true;
			}
		);
	});

	test('20. Handles mid-stream error frames from provider', async () => {
		const ssePayload = [
			'data: {"choices":[{"delta":{"content":"Start"}}]}\n\n',
			'data: {"error":{"message":"Context length exceeded mid-stream"}}\n\n'
		];

		const mockFetch: typeof fetch = async () => createMockSseResponse(ssePayload);
		const provider = new OpenAICompatibleProvider({}, mockFetch);

		await assert.rejects(
			async () => provider.chatStream(sampleRequest, () => {}),
			(err: ProviderError) => {
				assert.strictEqual(err.code, 'PROVIDER_ERROR');
				assert.ok(err.message.includes('Context length exceeded mid-stream'));
				return true;
			}
		);
	});

	test('21. Throws PROVIDER_ERROR if stream disconnects prematurely without text or [DONE]', async () => {
		const ssePayload = ['\n\n']; // empty stream ending prematurely
		const mockFetch: typeof fetch = async () => createMockSseResponse(ssePayload);
		const provider = new OpenAICompatibleProvider({}, mockFetch);

		await assert.rejects(
			async () => provider.chatStream(sampleRequest, () => {}),
			(err: ProviderError) => {
				assert.strictEqual(err.code, 'PROVIDER_ERROR');
				assert.ok(err.message.includes('terminated unexpectedly'));
				return true;
			}
		);
	});

	// --- 6. API Key Security & Header Sanitization ---
	test('22. Transmits Authorization Bearer header when apiKey is configured', async () => {
		let capturedAuthHeader: string | undefined;

		const mockFetch: typeof fetch = async (_url, init) => {
			const headers = init?.headers as Record<string, string>;
			capturedAuthHeader = headers?.['Authorization'];
			return createMockSseResponse(['data: {"choices":[{"delta":{"content":"OK"}}]}\n\n', 'data: [DONE]\n\n']);
		};

		const provider = new OpenAICompatibleProvider({ apiKey: 'gsk_secure_token_999' }, mockFetch);
		await provider.chatStream(sampleRequest, () => {});

		assert.strictEqual(capturedAuthHeader, 'Bearer gsk_secure_token_999');
	});

	test('23. Never exposes raw API key in error messages even if server echoes it in response', async () => {
		const leakSecret = 'gsk_super_secret_key_to_never_leak';
		const mockFetch: typeof fetch = async () =>
			createMockJsonResponse({ error: { message: `Key ${leakSecret} was rejected` } }, 401, 'Unauthorized');

		const provider = new OpenAICompatibleProvider({ apiKey: leakSecret }, mockFetch);

		await assert.rejects(
			async () => provider.chatStream(sampleRequest, () => {}),
			(err: ProviderError) => {
				assert.ok(!err.message.includes(leakSecret), 'Error message must not contain plaintext API key');
				if (typeof err.cause === 'string') {
					assert.ok(!err.cause.includes(leakSecret), 'Error cause must not contain plaintext API key');
				}
				return true;
			}
		);
	});

	// --- 7. Health Checks ---
	test('24. checkHealth returns isHealthy: true when target model is in /models list', async () => {
		const mockFetch: typeof fetch = async () =>
			createMockJsonResponse({
				data: [
					{ id: 'llama-3.3-70b-versatile' },
					{ id: 'qwen-2.5-coder-32b' }
				]
			});

		const provider = new OpenAICompatibleProvider({ model: 'llama-3.3-70b-versatile' }, mockFetch);
		const health = await provider.checkHealth();

		assert.strictEqual(health.isHealthy, true);
		assert.ok(health.availableModels.includes('llama-3.3-70b-versatile'));
		assert.ok(health.message?.includes('Connected to provider with model'));
	});

	test('25. checkHealth returns isHealthy: false when authentication fails', async () => {
		const mockFetch: typeof fetch = async () =>
			createMockJsonResponse({ error: { message: 'Invalid token' } }, 401, 'Unauthorized');

		const provider = new OpenAICompatibleProvider({ apiKey: 'bad_key' }, mockFetch);
		const health = await provider.checkHealth();

		assert.strictEqual(health.isHealthy, false);
		assert.ok(health.message?.includes('Authentication failed'));
	});

	test('26. checkHealth throws REQUEST_CANCELLED when user aborts', async () => {
		const controller = new AbortController();
		controller.abort(new Error('User abort'));

		const provider = new OpenAICompatibleProvider();
		await assert.rejects(
			async () => provider.checkHealth(controller.signal),
			(err: ProviderError) => {
				assert.strictEqual(err.code, 'REQUEST_CANCELLED');
				return true;
			}
		);
	});
});
