import * as assert from 'assert';
import { OllamaProvider } from '../providers/ollama/OllamaProvider.js';
import {
	validateOllamaConfig,
	DEFAULT_OLLAMA_BASE_URL,
	DEFAULT_OLLAMA_MODEL,
	DEFAULT_OLLAMA_TIMEOUT_MS
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
	});

	// 2. Valid configuration and invalid configuration values
	test('2. Valid configuration and invalid configuration values', () => {
		// Valid custom config
		const custom = validateOllamaConfig({
			baseUrl: 'http://127.0.0.1:11434/',
			model: 'llama3:8b',
			timeoutMs: 45000
		});
		assert.strictEqual(custom.baseUrl, 'http://127.0.0.1:11434'); // Trailing slash stripped
		assert.strictEqual(custom.model, 'llama3:8b');
		assert.strictEqual(custom.timeoutMs, 45000);

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
});

