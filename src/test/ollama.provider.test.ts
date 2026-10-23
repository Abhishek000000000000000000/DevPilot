import * as assert from 'assert';
import { OllamaProvider, parseOllamaMetrics } from '../providers/ollama/OllamaProvider.js';
import {
	validateOllamaConfig,
	DEFAULT_OLLAMA_BASE_URL,
	DEFAULT_OLLAMA_MODEL,
	DEFAULT_OLLAMA_TIMEOUT_MS,
	DEFAULT_OLLAMA_THINK
} from '../providers/ollama/OllamaConfig.js';
import { ProviderError } from '../providers/errors.js';
import { ChatRequest, StreamChunk } from '../providers/types.js';

suite('OllamaProvider & Configuration Test Suite', () => {
	// Helper to create mock streaming Response
	function createMockStreamResponse(chunks: string[], status = 200, statusText = 'OK'): Response {
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
			headers: { 'Content-Type': 'application/x-ndjson' }
		});
	}

	// Helper to create mock JSON Response
	function createMockJsonResponse(data: unknown, status = 200, statusText = 'OK'): Response {
		return new Response(JSON.stringify(data), {
			status,
			statusText,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	const sampleRequest: ChatRequest = {
		messages: [
			{ role: 'user', content: 'Explain quicksort in one sentence.' }
		]
	};

	// 1. Provider identity and default configuration
	test('1. Provider identity and default configuration', () => {
		const provider = new OllamaProvider();
		assert.strictEqual(provider.id, 'ollama');
		assert.strictEqual(provider.displayName, 'Ollama (Local)');
		assert.strictEqual(provider.config.baseUrl, DEFAULT_OLLAMA_BASE_URL);
		assert.strictEqual(provider.config.model, DEFAULT_OLLAMA_MODEL);
		assert.strictEqual(provider.config.timeoutMs, DEFAULT_OLLAMA_TIMEOUT_MS);
		assert.strictEqual(provider.config.think, false);
	});

	// 2. Valid configuration and invalid configuration values
	test('2. Valid configuration and invalid configuration values', () => {
		// Valid custom config
		const custom = validateOllamaConfig({
			baseUrl: 'http://127.0.0.1:11434/',
			model: 'llama3:8b',
			timeoutMs: 45000,
			think: true
		});
		assert.strictEqual(custom.baseUrl, 'http://127.0.0.1:11434'); // Trailing slash stripped
		assert.strictEqual(custom.model, 'llama3:8b');
		assert.strictEqual(custom.timeoutMs, 45000);
		assert.strictEqual(custom.think, true);

		// Default think is false
		const withoutThink = validateOllamaConfig({});
		assert.strictEqual(withoutThink.think, false);

		// Invalid think
		assert.throws(() => {
			validateOllamaConfig({ think: 'invalid' as any });
		}, /Ollama think option must be a boolean/);

		// Invalid URL
		assert.throws(() => {
			validateOllamaConfig({ baseUrl: 'not-a-valid-url' });
		}, /Invalid Ollama baseUrl/);

		// Invalid protocol (e.g. ftp:)
		assert.throws(() => {
			validateOllamaConfig({ baseUrl: 'ftp://localhost:11434' });
		}, /protocol/);

		// Empty model name
		assert.throws(() => {
			validateOllamaConfig({ model: '   ' });
		}, /model name must be a non-empty string/);

		// Timeout too low
		assert.throws(() => {
			validateOllamaConfig({ timeoutMs: 500 });
		}, /timeoutMs must be a number between/);

		// Timeout too high
		assert.throws(() => {
			validateOllamaConfig({ timeoutMs: 9999999 });
		}, /timeoutMs must be a number between/);
	});

	// 3. Health-check success
	test('3. Health-check success when model is installed', async () => {
		const mockFetch: typeof fetch = async (input, init) => {
			assert.ok(String(input).endsWith('/api/tags'));
			assert.strictEqual(init?.method, 'GET');
			return createMockJsonResponse({
				models: [
					{ name: 'qwen3.5:9b', size: 6550825550 },
					{ name: 'codellama:7b', size: 3800000000 }
				]
			});
		};

		const provider = new OllamaProvider({ model: 'qwen3.5:9b' }, mockFetch);
		const health = await provider.checkHealth();

		assert.strictEqual(health.isHealthy, true);
		assert.ok(health.availableModels.includes('qwen3.5:9b'));
		assert.ok(health.message?.includes('qwen3.5:9b'));
	});

	// 4. Health-check connection failure
	test('4. Health-check connection failure maps gracefully without crashing', async () => {
		const mockFetch: typeof fetch = async () => {
			throw new TypeError('fetch failed: connect ECONNREFUSED 127.0.0.1:11434');
		};

		const provider = new OllamaProvider({}, mockFetch);
		const health = await provider.checkHealth();

		assert.strictEqual(health.isHealthy, false);
		assert.strictEqual(health.availableModels.length, 0);
		assert.ok(health.message?.includes('Cannot connect to Ollama'));
	});

	// 5. Successful streaming response parsing
	test('5. Successful streaming response parsing with single chunk', async () => {
		const ndjsonLine = JSON.stringify({
			model: 'qwen3.5:9b',
			message: { role: 'assistant', content: 'Quicksort divides and conquers.' },
			done: true,
			done_reason: 'stop',
			prompt_eval_count: 15,
			eval_count: 8
		}) + '\n';

		const mockFetch: typeof fetch = async () => {
			return createMockStreamResponse([ndjsonLine]);
		};

		const chunks: StreamChunk[] = [];
		const provider = new OllamaProvider({}, mockFetch);
		const response = await provider.chatStream(sampleRequest, chunk => chunks.push(chunk));

		assert.strictEqual(chunks.length, 1);
		assert.strictEqual(chunks[0].text, 'Quicksort divides and conquers.');
		assert.strictEqual(response.text, 'Quicksort divides and conquers.');
		assert.strictEqual(response.finishReason, 'stop');
	});

	// 6. Multiple newline-delimited response chunks
	test('6. Multiple newline-delimited response chunks streamed in succession', async () => {
		const chunk1 = JSON.stringify({ message: { role: 'assistant', content: 'Hello ' }, done: false }) + '\n';
		const chunk2 = JSON.stringify({ message: { role: 'assistant', content: 'world' }, done: false }) + '\n';
		const chunk3 = JSON.stringify({ message: { role: 'assistant', content: '!' }, done: true, done_reason: 'stop' }) + '\n';

		const mockFetch: typeof fetch = async () => {
			return createMockStreamResponse([chunk1, chunk2, chunk3]);
		};

		const receivedChunks: string[] = [];
		const provider = new OllamaProvider({}, mockFetch);
		const response = await provider.chatStream(sampleRequest, chunk => receivedChunks.push(chunk.text));

		assert.deepStrictEqual(receivedChunks, ['Hello ', 'world', '!']);
		assert.strictEqual(response.text, 'Hello world!');
		assert.strictEqual(response.finishReason, 'stop');
	});

	// 7. Final response assembly and finish reason
	test('7. Final response assembly preserves model, token usage, and finish reason', async () => {
		const ndjson = JSON.stringify({
			message: { role: 'assistant', content: 'Done' },
			done: true,
			done_reason: 'stop',
			prompt_eval_count: 42,
			eval_count: 10
		}) + '\n';

		const mockFetch: typeof fetch = async () => {
			return createMockStreamResponse([ndjson]);
		};

		const provider = new OllamaProvider({ model: 'qwen3.5:9b' }, mockFetch);
		const response = await provider.chatStream(sampleRequest, () => {});

		assert.strictEqual(response.text, 'Done');
		assert.strictEqual(response.model, 'qwen3.5:9b');
		assert.strictEqual(response.finishReason, 'stop');
		assert.strictEqual(response.usage?.promptTokens, 42);
		assert.strictEqual(response.usage?.completionTokens, 10);
	});

	// 8. Missing-model responses
	test('8. Missing-model response (HTTP 404) maps to MODEL_NOT_FOUND ProviderError', async () => {
		const mockFetch: typeof fetch = async () => {
			return createMockJsonResponse(
				{ error: 'model "nonexistent:model" not found, try pulling it first' },
				404,
				'Not Found'
			);
		};

		const provider = new OllamaProvider({ model: 'nonexistent:model' }, mockFetch);

		await assert.rejects(
			async () => {
				await provider.chatStream(sampleRequest, () => {});
			},
			(err: unknown) => {
				assert.ok(err instanceof ProviderError);
				assert.strictEqual(err.code, 'MODEL_NOT_FOUND');
				assert.ok(err.userSuggestion?.includes('ollama pull nonexistent:model'));
				return true;
			}
		);
	});

	// 9. HTTP error responses
	test('9. HTTP 500 error response maps to PROVIDER_ERROR', async () => {
		const mockFetch: typeof fetch = async () => {
			return createMockJsonResponse(
				{ error: 'CUDA out of memory' },
				500,
				'Internal Server Error'
			);
		};

		const provider = new OllamaProvider({}, mockFetch);

		await assert.rejects(
			async () => {
				await provider.chatStream(sampleRequest, () => {});
			},
			(err: unknown) => {
				assert.ok(err instanceof ProviderError);
				assert.strictEqual(err.code, 'PROVIDER_ERROR');
				assert.ok(err.message.includes('CUDA out of memory'));
				return true;
			}
		);
	});

	// 10. Malformed or incomplete JSON responses
	test('10. Malformed and broken lines are skipped gracefully without crashing', async () => {
		const valid1 = JSON.stringify({ message: { role: 'assistant', content: 'Part 1. ' }, done: false }) + '\n';
		const brokenLine = 'INVALID_NON_JSON_CORRUPTED_LINE\n';
		const valid2 = JSON.stringify({ message: { role: 'assistant', content: 'Part 2.' }, done: true, done_reason: 'stop' }) + '\n';

		const mockFetch: typeof fetch = async () => {
			return createMockStreamResponse([valid1, brokenLine, valid2]);
		};

		const received: string[] = [];
		const provider = new OllamaProvider({}, mockFetch);
		const response = await provider.chatStream(sampleRequest, c => received.push(c.text));

		assert.deepStrictEqual(received, ['Part 1. ', 'Part 2.']);
		assert.strictEqual(response.text, 'Part 1. Part 2.');
	});

	// 11. Aborted requests and timeout behavior
	test('11. User cancellation via AbortSignal throws REQUEST_CANCELLED ProviderError', async () => {
		const controller = new AbortController();

		const mockFetch: typeof fetch = async (_input, init) => {
			init?.signal?.addEventListener('abort', () => {});
			// Simulate abort mid-request
			controller.abort();
			const abortErr = new Error('The user aborted a request.');
			abortErr.name = 'AbortError';
			throw abortErr;
		};

		const provider = new OllamaProvider({}, mockFetch);

		await assert.rejects(
			async () => {
				await provider.chatStream(sampleRequest, () => {}, controller.signal);
			},
			(err: unknown) => {
				assert.ok(err instanceof ProviderError);
				assert.strictEqual(err.code, 'REQUEST_CANCELLED');
				return true;
			}
		);
	});

	// 12. Safe error mapping without exposing internal details
	test('12. Connection failures map to safe CONNECTION_REFUSED with actionable suggestion', async () => {
		const mockFetch: typeof fetch = async () => {
			throw new TypeError('fetch failed: connect ECONNREFUSED 127.0.0.1:11434');
		};

		const provider = new OllamaProvider({ baseUrl: 'http://localhost:11434' }, mockFetch);

		await assert.rejects(
			async () => {
				await provider.chatStream(sampleRequest, () => {});
			},
			(err: unknown) => {
				assert.ok(err instanceof ProviderError);
				assert.strictEqual(err.code, 'CONNECTION_REFUSED');
				assert.ok(err.message.includes('Cannot connect to Ollama at http://localhost:11434'));
				assert.ok(err.userSuggestion?.includes('Ensure Ollama is installed and running on port 11434'));
				return true;
			}
		);
	});

	// 13. Split network reads
	test('13. Handles JSON records split across network reads correctly', async () => {
		const part1 = '{"message": {"role": "assista';
		const part2 = 'nt", "content": "Split across network."}';
		const part3 = ', "done": true, "done_reason": "stop"}\n';

		const mockFetch: typeof fetch = async () => {
			return createMockStreamResponse([part1, part2, part3]);
		};

		const received: string[] = [];
		const provider = new OllamaProvider({}, mockFetch);
		const response = await provider.chatStream(sampleRequest, c => received.push(c.text));

		assert.deepStrictEqual(received, ['Split across network.']);
		assert.strictEqual(response.text, 'Split across network.');
		assert.strictEqual(response.finishReason, 'stop');
	});

	// 14. Abrupt stream termination without done signal
	test('14. Unexpected stream termination before done=true throws PROVIDER_ERROR', async () => {
		const incompleteChunk = JSON.stringify({ message: { role: 'assistant', content: 'Partial answer...' }, done: false }) + '\n';

		const mockFetch: typeof fetch = async () => {
			return createMockStreamResponse([incompleteChunk]);
		};

		const provider = new OllamaProvider({}, mockFetch);

		await assert.rejects(
			async () => {
				await provider.chatStream(sampleRequest, () => {});
			},
			(err: unknown) => {
				assert.ok(err instanceof ProviderError);
				assert.strictEqual(err.code, 'PROVIDER_ERROR');
				assert.ok(err.message.includes('terminated unexpectedly'));
				return true;
			}
		);
	});

	// 15. HTTP 401/403 Authentication failure
	test('15. HTTP 401 and 403 error responses map to AUTHENTICATION_FAILED', async () => {
		const mockFetch401: typeof fetch = async () => {
			return createMockJsonResponse({ error: 'Unauthorized access' }, 401, 'Unauthorized');
		};

		const provider401 = new OllamaProvider({}, mockFetch401);
		await assert.rejects(
			async () => {
				await provider401.chatStream(sampleRequest, () => {});
			},
			(err: unknown) => {
				assert.ok(err instanceof ProviderError);
				assert.strictEqual(err.code, 'AUTHENTICATION_FAILED');
				assert.ok(err.userSuggestion?.includes('authentication credentials'));
				return true;
			}
		);

		const mockFetch403: typeof fetch = async () => {
			return createMockJsonResponse({ error: 'Forbidden' }, 403, 'Forbidden');
		};

		const provider403 = new OllamaProvider({}, mockFetch403);
		await assert.rejects(
			async () => {
				await provider403.chatStream(sampleRequest, () => {});
			},
			(err: unknown) => {
				assert.ok(err instanceof ProviderError);
				assert.strictEqual(err.code, 'AUTHENTICATION_FAILED');
				return true;
			}
		);
	});

	// 16. HTTP 404 endpoint not found
	test('16. HTTP 404 without model-not-found error maps to INVALID_REQUEST', async () => {
		const mockFetch: typeof fetch = async () => {
			return createMockJsonResponse({ error: '404 page not found' }, 404, 'Not Found');
		};

		const provider = new OllamaProvider({}, mockFetch);
		await assert.rejects(
			async () => {
				await provider.chatStream(sampleRequest, () => {});
			},
			(err: unknown) => {
				assert.ok(err instanceof ProviderError);
				assert.strictEqual(err.code, 'INVALID_REQUEST');
				assert.ok(err.userSuggestion?.includes('Verify the Ollama baseUrl setting'));
				return true;
			}
		);
	});

	// 17. Empty or missing response body
	test('17. Null or missing response body maps to PROVIDER_ERROR', async () => {
		const mockFetch: typeof fetch = async () => {
			return new Response(null, { status: 200, statusText: 'OK' });
		};

		const provider = new OllamaProvider({}, mockFetch);
		await assert.rejects(
			async () => {
				await provider.chatStream(sampleRequest, () => {});
			},
			(err: unknown) => {
				assert.ok(err instanceof ProviderError);
				assert.strictEqual(err.code, 'PROVIDER_ERROR');
				assert.ok(err.message.includes('No response body received'));
				return true;
			}
		);
	});

	// 18. Mid-stream network failure after partial chunks
	test('18. Network failure mid-stream releases reader lock and throws safe error', async () => {
		const encoder = new TextEncoder();
		let readCount = 0;

		const customStream = new ReadableStream<Uint8Array>({
			pull(controller) {
				readCount++;
				if (readCount === 1) {
					const chunk = JSON.stringify({ message: { role: 'assistant', content: 'First chunk ' }, done: false }) + '\n';
					controller.enqueue(encoder.encode(chunk));
				} else {
					controller.error(new TypeError('network socket reset'));
				}
			}
		});

		const mockFetch: typeof fetch = async () => {
			return new Response(customStream, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
		};

		const received: string[] = [];
		const provider = new OllamaProvider({}, mockFetch);

		await assert.rejects(
			async () => {
				await provider.chatStream(sampleRequest, chunk => received.push(chunk.text));
			},
			(err: unknown) => {
				assert.ok(err instanceof ProviderError);
				assert.strictEqual(err.code, 'CONNECTION_REFUSED');
				return true;
			}
		);

		assert.strictEqual(received.length, 1);
		assert.strictEqual(received[0], 'First chunk ');
	});

	// 19. Mid-stream user cancellation via AbortSignal
	test('19. Mid-stream cancellation via user AbortSignal throws REQUEST_CANCELLED', async () => {
		const controller = new AbortController();
		const encoder = new TextEncoder();
		let readCount = 0;

		const customStream = new ReadableStream<Uint8Array>({
			start(streamController) {
				controller.signal.addEventListener('abort', () => {
					const abortErr = new Error('The user aborted a request.');
					abortErr.name = 'AbortError';
					streamController.error(abortErr);
				});
			},
			pull(streamController) {
				readCount++;
				if (readCount === 1) {
					const chunk = JSON.stringify({ message: { role: 'assistant', content: 'Stream started ' }, done: false }) + '\n';
					streamController.enqueue(encoder.encode(chunk));
				} else {
					// User aborts during stream
					controller.abort();
				}
			}
		});

		const mockFetch: typeof fetch = async () => {
			return new Response(customStream, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
		};

		const received: string[] = [];
		const provider = new OllamaProvider({}, mockFetch);

		await assert.rejects(
			async () => {
				await provider.chatStream(sampleRequest, chunk => received.push(chunk.text), controller.signal);
			},
			(err: unknown) => {
				assert.ok(err instanceof ProviderError);
				assert.strictEqual(err.code, 'REQUEST_CANCELLED');
				return true;
			}
		);

		assert.strictEqual(received.length, 1);
		assert.strictEqual(received[0], 'Stream started ');
	});

	// 20. NDJSON line with explicit error field
	test('20. NDJSON record containing error field throws PROVIDER_ERROR', async () => {
		const errLine = JSON.stringify({ error: 'context window limit reached' }) + '\n';

		const mockFetch: typeof fetch = async () => {
			return createMockStreamResponse([errLine]);
		};

		const provider = new OllamaProvider({}, mockFetch);

		await assert.rejects(
			async () => {
				await provider.chatStream(sampleRequest, () => {});
			},
			(err: unknown) => {
				assert.ok(err instanceof ProviderError);
				assert.strictEqual(err.code, 'PROVIDER_ERROR');
				assert.ok(err.message.includes('context window limit reached'));
				return true;
			}
		);
	});

	// 21. Empty model response
	test('21. Empty model response returns empty text with stop finishReason without throwing', async () => {
		const emptyDoneLine = JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' }) + '\n';

		const mockFetch: typeof fetch = async () => {
			return createMockStreamResponse([emptyDoneLine]);
		};

		const provider = new OllamaProvider({}, mockFetch);
		const result = await provider.chatStream(sampleRequest, () => {});

		assert.strictEqual(result.text, '');
		assert.strictEqual(result.finishReason, 'stop');
	});

	// 22. Request timeout during stream reading
	test('22. Request timeout triggers TIMEOUT ProviderError with suggestion', async () => {
		const mockFetch: typeof fetch = async (_input, init) => {
			return new Promise((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () => {
					const err = new Error('The operation was aborted');
					err.name = 'AbortError';
					reject(err);
				});
			});
		};

		// 1000ms minimum timeout
		const provider = new OllamaProvider({ timeoutMs: 1000 }, mockFetch);

		await assert.rejects(
			async () => {
				await provider.chatStream(sampleRequest, () => {});
			},
			(err: unknown) => {
				assert.ok(err instanceof ProviderError);
				assert.strictEqual(err.code, 'TIMEOUT');
				assert.ok(err.userSuggestion?.includes('devpilot.ollama.timeoutMs'));
				return true;
			}
		);
	});

	// 23. Request payload includes think: false by default
	test('23. Request payload includes think: false by default', async () => {
		let capturedBody: any;
		const mockFetch: typeof fetch = async (_input, init) => {
			capturedBody = JSON.parse(init?.body as string);
			const doneLine = JSON.stringify({ message: { role: 'assistant', content: 'Result' }, done: true, done_reason: 'stop' }) + '\n';
			return createMockStreamResponse([doneLine]);
		};

		const provider = new OllamaProvider({}, mockFetch);
		await provider.chatStream(sampleRequest, () => {});

		assert.ok(capturedBody);
		assert.strictEqual(capturedBody.think, false);
	});

	// 24. Request payload includes think: true when configured
	test('24. Request payload includes think: true when configured', async () => {
		let capturedBody: any;
		const mockFetch: typeof fetch = async (_input, init) => {
			capturedBody = JSON.parse(init?.body as string);
			const doneLine = JSON.stringify({ message: { role: 'assistant', content: 'Result' }, done: true, done_reason: 'stop' }) + '\n';
			return createMockStreamResponse([doneLine]);
		};

		const provider = new OllamaProvider({ think: true }, mockFetch);
		await provider.chatStream(sampleRequest, () => {});

		assert.ok(capturedBody);
		assert.strictEqual(capturedBody.think, true);
	});

	// 25. A healthy stream spanning longer than timeoutMs overall completes successfully
	test('25. Healthy stream spanning longer than timeoutMs overall completes successfully', async () => {
		const encoder = new TextEncoder();
		let chunkIdx = 0;
		const chunks = [
			JSON.stringify({ message: { role: 'assistant', content: 'Chunk1 ' }, done: false }) + '\n',
			JSON.stringify({ message: { role: 'assistant', content: 'Chunk2 ' }, done: false }) + '\n',
			JSON.stringify({ message: { role: 'assistant', content: 'Chunk3' }, done: true, done_reason: 'stop' }) + '\n'
		];

		const customStream = new ReadableStream<Uint8Array>({
			async pull(controller) {
				if (chunkIdx < chunks.length) {
					// 500ms delay between chunks (each interval is < 1000ms timeoutMs, but total 1500ms > 1000ms)
					await new Promise(r => setTimeout(r, 500));
					controller.enqueue(encoder.encode(chunks[chunkIdx++]));
				} else {
					controller.close();
				}
			}
		});

		const mockFetch: typeof fetch = async () => {
			return new Response(customStream, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
		};

		const provider = new OllamaProvider({ timeoutMs: 1000 }, mockFetch);
		const received: string[] = [];
		const result = await provider.chatStream(sampleRequest, c => received.push(c.text));

		assert.deepStrictEqual(received, ['Chunk1 ', 'Chunk2 ', 'Chunk3']);
		assert.strictEqual(result.text, 'Chunk1 Chunk2 Chunk3');
	});

	// 26. A stream that stalls beyond timeoutMs fails with TIMEOUT
	test('26. Stream that stalls mid-stream beyond timeoutMs fails with TIMEOUT', async () => {
		const encoder = new TextEncoder();
		let chunkIdx = 0;

		const customStream = new ReadableStream<Uint8Array>({
			async pull(controller) {
				chunkIdx++;
				if (chunkIdx === 1) {
					const chunk = JSON.stringify({ message: { role: 'assistant', content: 'Start ' }, done: false }) + '\n';
					controller.enqueue(encoder.encode(chunk));
				} else {
					// Stall indefinitely without closing or enqueuing
					await new Promise(() => {});
				}
			}
		});

		const mockFetch: typeof fetch = async () => {
			return new Response(customStream, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
		};

		const provider = new OllamaProvider({ timeoutMs: 1000 }, mockFetch);
		const received: string[] = [];

		await assert.rejects(
			async () => {
				await provider.chatStream(sampleRequest, c => received.push(c.text));
			},
			(err: unknown) => {
				assert.ok(err instanceof ProviderError);
				assert.strictEqual(err.code, 'TIMEOUT');
				assert.ok(err.message.includes('1000ms of inactivity'));
				return true;
			}
		);

		assert.strictEqual(received.length, 1);
		assert.strictEqual(received[0], 'Start ');
	});

	// 27. Thinking-only chunks reset activity timeout and do not leak to onChunk
	test('27. Thinking-only chunks reset activity timeout and do not emit text to onChunk', async () => {
		const encoder = new TextEncoder();
		let pullCount = 0;
		const stream = new ReadableStream<Uint8Array>({
			async pull(controller) {
				pullCount++;
				if (pullCount === 1) {
					// Thinking chunk at 500ms
					await new Promise(r => setTimeout(r, 500));
					const thinkChunk = JSON.stringify({ message: { role: 'assistant', content: '', thinking: 'Analyzing problem...' }, done: false }) + '\n';
					controller.enqueue(encoder.encode(thinkChunk));
				} else if (pullCount === 2) {
					// Content chunk at another 500ms (total 1000ms > 1000ms total elapsed)
					await new Promise(r => setTimeout(r, 500));
					const contentChunk = JSON.stringify({ message: { role: 'assistant', content: 'Final answer' }, done: true, done_reason: 'stop' }) + '\n';
					controller.enqueue(encoder.encode(contentChunk));
				} else {
					controller.close();
				}
			}
		});

		const mockFetch: typeof fetch = async () => {
			return new Response(stream, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
		};

		const provider = new OllamaProvider({ timeoutMs: 1000 }, mockFetch);
		const received: string[] = [];
		const result = await provider.chatStream(sampleRequest, c => received.push(c.text));

		// Thinking text must NOT be emitted to onChunk
		assert.deepStrictEqual(received, ['Final answer']);
		assert.strictEqual(result.text, 'Final answer');
	});

	// 28. Initial connection / response stall is aborted with TIMEOUT
	test('28. Initial connection stall triggers TIMEOUT ProviderError', async () => {
		const mockFetch: typeof fetch = async (_input, init) => {
			return new Promise((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () => {
					const err = new Error('The operation was aborted');
					err.name = 'AbortError';
					reject(err);
				});
			});
		};

		const provider = new OllamaProvider({ timeoutMs: 1000 }, mockFetch);

		await assert.rejects(
			async () => {
				await provider.chatStream(sampleRequest, () => {});
			},
			(err: unknown) => {
				assert.ok(err instanceof ProviderError);
				assert.strictEqual(err.code, 'TIMEOUT');
				return true;
			}
		);
	});

	// 29. User cancellation while stream is pending throws REQUEST_CANCELLED instead of TIMEOUT
	test('29. User cancellation while stream is pending throws REQUEST_CANCELLED instead of TIMEOUT', async () => {
		const abortController = new AbortController();
		const customStream = new ReadableStream<Uint8Array>({
			async pull() {
				// Pending forever
				await new Promise(() => {});
			}
		});

		const mockFetch: typeof fetch = async () => {
			return new Response(customStream, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
		};

		const provider = new OllamaProvider({ timeoutMs: 10000 }, mockFetch);

		// Cancel after 100ms, well before the 10000ms timeout
		setTimeout(() => abortController.abort(), 100);

		await assert.rejects(
			async () => {
				await provider.chatStream(sampleRequest, () => {}, abortController.signal);
			},
			(err: unknown) => {
				assert.ok(err instanceof ProviderError);
				assert.strictEqual(err.code, 'REQUEST_CANCELLED');
				return true;
			}
		);
	});

	// 30. Clean release of reader locks and timers
	test('30. Stream completion releases reader locks and cleans up timers without leak', async () => {
		let lockReleased = false;
		const encoder = new TextEncoder();
		const doneLine = JSON.stringify({ message: { role: 'assistant', content: 'Finished' }, done: true, done_reason: 'stop' }) + '\n';
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(doneLine));
				controller.close();
			}
		});

		const origGetReader = stream.getReader.bind(stream);
		(stream as any).getReader = () => {
			const reader = origGetReader();
			const origRelease = reader.releaseLock.bind(reader);
			reader.releaseLock = () => {
				lockReleased = true;
				origRelease();
			};
			return reader;
		};

		const mockFetch: typeof fetch = async () => {
			return new Response(stream, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
		};

		const provider = new OllamaProvider({ timeoutMs: 5000 }, mockFetch);
		const result = await provider.chatStream(sampleRequest, () => {});

		assert.strictEqual(result.text, 'Finished');
		assert.strictEqual(lockReleased, true, 'Reader lock must be released in finally block');
	});

	// 31. parseOllamaMetrics with valid metrics, explicit ns -> ms conversion and speed calculation
	test('31. parseOllamaMetrics converts units explicitly and computes tokensPerSecond', () => {
		const raw = {
			eval_count: 120,
			eval_duration: 5_000_000_000, // 5.0 seconds in ns
			prompt_eval_count: 25,
			prompt_eval_duration: 250_000_000, // 250 ms in ns
			total_duration: 5_300_000_000, // 5300 ms in ns
			load_duration: 50_000_000 // 50 ms in ns
		};

		const metrics = parseOllamaMetrics(raw);
		assert.ok(metrics, 'Metrics must be defined for valid raw input');
		assert.strictEqual(metrics.evalCount, 120);
		assert.strictEqual(metrics.evalDurationMs, 5000);
		assert.strictEqual(metrics.promptEvalCount, 25);
		assert.strictEqual(metrics.promptEvalDurationMs, 250);
		assert.strictEqual(metrics.totalDurationMs, 5300);
		assert.strictEqual(metrics.loadDurationMs, 50);
		// Speed = 120 / (5_000_000_000 / 1e9) = 120 / 5 = 24 tokens/sec
		assert.strictEqual(metrics.tokensPerSecond, 24);
	});

	// 32. parseOllamaMetrics with zero inference duration prevents division by zero
	test('32. parseOllamaMetrics handles zero eval_duration safely without division by zero', () => {
		const raw = {
			eval_count: 10,
			eval_duration: 0,
			total_duration: 100_000_000
		};

		const metrics = parseOllamaMetrics(raw);
		assert.ok(metrics);
		assert.strictEqual(metrics.evalCount, 10);
		assert.strictEqual(metrics.evalDurationMs, 0);
		assert.strictEqual(metrics.tokensPerSecond, undefined, 'Speed must be undefined when duration is 0');
		assert.strictEqual(metrics.totalDurationMs, 100);
	});

	// 33. parseOllamaMetrics returns undefined when no valid metrics are present
	test('33. parseOllamaMetrics returns undefined when no metrics are provided', () => {
		assert.strictEqual(parseOllamaMetrics(undefined), undefined);
		assert.strictEqual(parseOllamaMetrics({}), undefined);
		assert.strictEqual(parseOllamaMetrics(null as any), undefined);
	});

	// 34. parseOllamaMetrics safely filters negative, NaN, and Infinity values
	test('34. parseOllamaMetrics rejects negative, NaN, and non-finite values', () => {
		const raw = {
			eval_count: -50,
			eval_duration: -1000,
			prompt_eval_count: NaN,
			prompt_eval_duration: Infinity,
			total_duration: -Infinity
		};

		const metrics = parseOllamaMetrics(raw);
		assert.strictEqual(metrics, undefined, 'Invalid values must not produce metrics object');
	});

	// 35. parseOllamaMetrics safely filters non-numeric types
	test('35. parseOllamaMetrics rejects non-numeric types like strings and booleans', () => {
		const raw = {
			eval_count: '120' as any,
			eval_duration: true as any,
			prompt_eval_count: {} as any
		};

		const metrics = parseOllamaMetrics(raw);
		assert.strictEqual(metrics, undefined, 'String or boolean metrics must not be parsed');
	});

	// 36. parseOllamaMetrics handles partial metrics safely
	test('36. parseOllamaMetrics handles partial metrics safely', () => {
		const raw = {
			prompt_eval_count: 42,
			prompt_eval_duration: 150_000_000
		};

		const metrics = parseOllamaMetrics(raw);
		assert.ok(metrics);
		assert.strictEqual(metrics.promptEvalCount, 42);
		assert.strictEqual(metrics.promptEvalDurationMs, 150);
		assert.strictEqual(metrics.evalCount, undefined);
		assert.strictEqual(metrics.tokensPerSecond, undefined);
	});

	// 37. Streaming integration: end-of-stream chunk with metrics populates result.metrics
	test('37. chatStream captures metrics from the terminal Ollama stream chunk', async () => {
		const encoder = new TextEncoder();
		const chunk1 = JSON.stringify({ message: { role: 'assistant', content: 'Hello ' }, done: false }) + '\n';
		const chunk2 = JSON.stringify({
			message: { role: 'assistant', content: 'World!' },
			done: true,
			done_reason: 'stop',
			eval_count: 50,
			eval_duration: 2_000_000_000,
			prompt_eval_count: 10,
			prompt_eval_duration: 100_000_000,
			total_duration: 2_200_000_000,
			load_duration: 30_000_000
		}) + '\n';

		const mockFetch: typeof fetch = async () => {
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(encoder.encode(chunk1));
					controller.enqueue(encoder.encode(chunk2));
					controller.close();
				}
			});
			return new Response(stream, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
		};

		const provider = new OllamaProvider({}, mockFetch);
		const chunks: StreamChunk[] = [];
		const result = await provider.chatStream(sampleRequest, c => chunks.push(c));

		assert.strictEqual(result.text, 'Hello World!');
		assert.strictEqual(result.finishReason, 'stop');
		assert.ok(result.metrics, 'Result metrics must be present');
		assert.strictEqual(result.metrics.evalCount, 50);
		assert.strictEqual(result.metrics.evalDurationMs, 2000);
		assert.strictEqual(result.metrics.tokensPerSecond, 25);
		assert.strictEqual(result.metrics.promptEvalCount, 10);
		assert.strictEqual(result.metrics.promptEvalDurationMs, 100);
		assert.strictEqual(result.metrics.totalDurationMs, 2200);
		assert.strictEqual(result.metrics.loadDurationMs, 30);
	});

	// 38. Streaming integration: completion without metrics omits result.metrics
	test('38. chatStream leaves metrics undefined when Ollama does not supply metrics', async () => {
		const encoder = new TextEncoder();
		const chunk1 = JSON.stringify({ message: { role: 'assistant', content: 'Plain ' }, done: false }) + '\n';
		const chunk2 = JSON.stringify({ message: { role: 'assistant', content: 'response' }, done: true, done_reason: 'stop' }) + '\n';

		const mockFetch: typeof fetch = async () => {
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(encoder.encode(chunk1));
					controller.enqueue(encoder.encode(chunk2));
					controller.close();
				}
			});
			return new Response(stream, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
		};

		const provider = new OllamaProvider({}, mockFetch);
		const result = await provider.chatStream(sampleRequest, () => {});

		assert.strictEqual(result.text, 'Plain response');
		assert.strictEqual(result.metrics, undefined, 'Metrics must be undefined when not supplied');
	});
});

