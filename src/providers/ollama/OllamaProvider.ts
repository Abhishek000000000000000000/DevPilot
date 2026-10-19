import { ILLMProvider } from '../ILLMProvider.js';
import { ChatRequest, ChatResponse, StreamChunk, ProviderHealth, ChatFinishReason } from '../types.js';
import { ProviderError } from '../errors.js';
import { OllamaConfig, validateOllamaConfig } from './OllamaConfig.js';

/**
 * Concrete LLM provider adapter for local Ollama runtimes.
 * 
 * Implements the provider-independent ILLMProvider contract, keeping all
 * Ollama-specific REST endpoints, wire payloads, and NDJSON streaming parsing
 * strictly contained within this adapter.
 */
export class OllamaProvider implements ILLMProvider {
	public readonly id = 'ollama';
	public readonly displayName = 'Ollama (Local)';

	private readonly _config: OllamaConfig;
	private readonly _fetchFn: typeof fetch;

	constructor(
		config?: Partial<OllamaConfig>,
		fetchFn?: typeof fetch
	) {
		this._config = validateOllamaConfig(config ?? {});
		this._fetchFn = fetchFn ?? globalThis.fetch;
	}

	public get config(): OllamaConfig {
		return this._config;
	}

	/**
	 * Checks whether the Ollama daemon is reachable and whether the configured model is installed.
	 */
	public async checkHealth(signal?: AbortSignal): Promise<ProviderHealth> {
		const url = `${this._config.baseUrl}/api/tags`;
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(new Error('TIMEOUT')), this._config.timeoutMs);

		const onAbort = () => controller.abort(signal?.reason);
		signal?.addEventListener('abort', onAbort);

		try {
			const response = await this._fetchFn(url, {
				method: 'GET',
				headers: { 'Accept': 'application/json' },
				signal: controller.signal
			});

			if (!response.ok) {
				return {
					isHealthy: false,
					message: `Ollama returned HTTP ${response.status}: ${response.statusText}`,
					availableModels: []
				};
			}

			const data = (await response.json()) as { models?: Array<{ name?: string; model?: string }> };
			const models: string[] = [];
			if (Array.isArray(data.models)) {
				for (const m of data.models) {
					const name = m.name || m.model;
					if (typeof name === 'string' && name.trim().length > 0) {
						models.push(name.trim());
					}
				}
			}

			const targetModel = this._config.model;
			const modelFound = models.some(m => m === targetModel || m.startsWith(`${targetModel}:`));

			return {
				isHealthy: modelFound,
				message: modelFound
					? `Ollama is running with model "${targetModel}".`
					: `Ollama is running, but configured model "${targetModel}" was not found. Available models: ${models.join(', ') || 'none'}.`,
				availableModels: models
			};
		} catch (err) {
			if (signal?.aborted || (err instanceof Error && err.name === 'AbortError' && signal?.aborted)) {
				throw new ProviderError('REQUEST_CANCELLED', 'Health check was cancelled by user.', { cause: err });
			}
			if (controller.signal.aborted && !signal?.aborted) {
				return {
					isHealthy: false,
					message: `Ollama health check timed out after ${this._config.timeoutMs}ms.`,
					availableModels: []
				};
			}
			return {
				isHealthy: false,
				message: `Cannot connect to Ollama at ${this._config.baseUrl}. Please verify the Ollama service is running.`,
				availableModels: []
			};
		} finally {
			clearTimeout(timeoutId);
			signal?.removeEventListener('abort', onAbort);
		}
	}

	/**
	 * Streams chat completions token-by-token from Ollama's /api/chat endpoint.
	 */
	public async chatStream(
		request: ChatRequest,
		onChunk: (chunk: StreamChunk) => void,
		signal?: AbortSignal
	): Promise<ChatResponse> {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(new Error('TIMEOUT')), this._config.timeoutMs);

		const onAbort = () => controller.abort(signal?.reason);
		signal?.addEventListener('abort', onAbort);
		if (signal?.aborted) {
			controller.abort(signal.reason);
		}

		const targetModel = request.options?.model || this._config.model;
		const url = `${this._config.baseUrl}/api/chat`;

		const payload = {
			model: targetModel,
			messages: request.messages.map(m => ({
				role: m.role,
				content: m.content
			})),
			stream: true,
			...(request.options?.temperature !== undefined || request.options?.maxTokens !== undefined ? {
				options: {
					...(request.options?.temperature !== undefined ? { temperature: request.options.temperature } : {}),
					...(request.options?.maxTokens !== undefined ? { num_predict: request.options.maxTokens } : {})
				}
			} : {})
		};

		try {
			let response: Response;
			try {
				response = await this._fetchFn(url, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'Accept': 'application/x-ndjson, application/json'
					},
					body: JSON.stringify(payload),
					signal: controller.signal
				});
			} catch (fetchErr) {
				return this._handleFetchError(fetchErr, signal, controller);
			}

			if (!response.ok) {
				let errorDetails = '';
				try {
					const errJson = (await response.json()) as { error?: string };
					if (typeof errJson?.error === 'string') {
						errorDetails = errJson.error;
					}
				} catch {
					// Response body was not JSON
				}

				if (response.status === 404) {
					const isMissingModel = errorDetails.toLowerCase().includes('model');

					if (isMissingModel) {
						throw new ProviderError(
							'MODEL_NOT_FOUND',
							`Model "${targetModel}" was not found in Ollama.`,
							{
								userSuggestion: `Run "ollama pull ${targetModel}" in your terminal to install the model.`,
								cause: errorDetails
							}
						);
					}
					throw new ProviderError(
						'INVALID_REQUEST',
						`Ollama endpoint not found at ${url} (HTTP 404).`,
						{
							userSuggestion: 'Verify the Ollama baseUrl setting in DevPilot configuration.',
							cause: errorDetails
						}
					);
				}

				if (response.status === 401 || response.status === 403) {
					throw new ProviderError(
						'AUTHENTICATION_FAILED',
						`Ollama request failed with HTTP ${response.status}${errorDetails ? `: ${errorDetails}` : ''}.`,
						{
							userSuggestion: 'Verify authentication credentials or proxy authorization for Ollama.',
							cause: errorDetails
						}
					);
				}

				throw new ProviderError(
					'PROVIDER_ERROR',
					`Ollama request failed with HTTP ${response.status}${errorDetails ? `: ${errorDetails}` : ''}`,
					{
						userSuggestion: 'Check Ollama server logs for troubleshooting details.',
						cause: errorDetails
					}
				);
			}

			if (!response.body) {
				throw new ProviderError(
					'PROVIDER_ERROR',
					'No response body received from Ollama server.'
				);
			}

			try {
				return await this._consumeStream(response.body, onChunk, targetModel);
			} catch (streamErr) {
				return this._handleFetchError(streamErr, signal, controller);
			}
		} finally {
			clearTimeout(timeoutId);
			signal?.removeEventListener('abort', onAbort);
		}
	}

	private async _consumeStream(
		body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array | string>,
		onChunk: (chunk: StreamChunk) => void,
		targetModel: string
	): Promise<ChatResponse> {
		let accumulatedText = '';
		let finishReason: ChatFinishReason = 'stop';
		let promptEvalCount: number | undefined;
		let evalCount: number | undefined;
		let lineBuffer = '';
		let hasReceivedDone = false;
		const decoder = new TextDecoder('utf-8');

		const processLines = (chunkText: string) => {
			lineBuffer += chunkText;
			const lines = lineBuffer.split('\n');
			// Keep the last incomplete slice in lineBuffer
			lineBuffer = lines.pop() ?? '';

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed) {
					continue;
				}
				this._processNdjsonLine(trimmed, onChunk, meta => {
					if (meta.content) {
						accumulatedText += meta.content;
					}
					if (meta.done) {
						hasReceivedDone = true;
					}
					if (meta.doneReason) {
						finishReason = meta.doneReason;
					}
					if (meta.promptEvalCount !== undefined) {
						promptEvalCount = meta.promptEvalCount;
					}
					if (meta.evalCount !== undefined) {
						evalCount = meta.evalCount;
					}
				});
			}
		};

		// Support both standard Web Streams (getReader) and AsyncIterables
		if ('getReader' in body && typeof body.getReader === 'function') {
			const reader = body.getReader();
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) {
						break;
					}
					if (value) {
						processLines(decoder.decode(value, { stream: true }));
					}
				}
			} finally {
				reader.releaseLock?.();
			}
		} else if (body && typeof body === 'object' && Symbol.asyncIterator in body) {
			for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
				const str = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
				processLines(str);
			}
		} else {
			throw new ProviderError('PROVIDER_ERROR', 'Unsupported response stream type received from Ollama.');
		}

		// Process any remaining bytes left in the lineBuffer
		if (lineBuffer.trim().length > 0) {
			this._processNdjsonLine(lineBuffer.trim(), onChunk, meta => {
				if (meta.content) {
					accumulatedText += meta.content;
				}
				if (meta.done) {
					hasReceivedDone = true;
				}
				if (meta.doneReason) {
					finishReason = meta.doneReason;
				}
			});
		}

		if (!hasReceivedDone) {
			throw new ProviderError(
				'PROVIDER_ERROR',
				'Ollama stream terminated unexpectedly before completion was signaled by the provider.'
			);
		}

		return {
			text: accumulatedText,
			finishReason,
			model: targetModel,
			usage: {
				promptTokens: promptEvalCount,
				completionTokens: evalCount
			}
		};
	}

	private _processNdjsonLine(
		line: string,
		onChunk: (chunk: StreamChunk) => void,
		onMeta: (meta: {
			content?: string;
			done?: boolean;
			doneReason?: ChatFinishReason;
			promptEvalCount?: number;
			evalCount?: number;
		}) => void
	): void {
		try {
			const parsed = JSON.parse(line) as {
				message?: { content?: string };
				done?: boolean;
				done_reason?: string;
				prompt_eval_count?: number;
				eval_count?: number;
				error?: string;
			};

			if (parsed.error) {
				throw new ProviderError('PROVIDER_ERROR', `Ollama returned error: ${parsed.error}`);
			}

			const content = parsed.message?.content;
			if (typeof content === 'string' && content.length > 0) {
				onChunk({ text: content });
			}

			let doneReason: ChatFinishReason | undefined;
			if (parsed.done_reason === 'length') {
				doneReason = 'length';
			} else if (parsed.done) {
				doneReason = 'stop';
			}

			onMeta({
				content: typeof content === 'string' ? content : undefined,
				done: parsed.done,
				doneReason,
				promptEvalCount: parsed.prompt_eval_count,
				evalCount: parsed.eval_count
			});
		} catch (err) {
			if (err instanceof ProviderError) {
				throw err;
			}
			// Safely skip malformed or unexpected non-JSON lines without crashing
			console.warn('[DevPilot Ollama] Ignored unparseable stream line:', line);
		}
	}

	private _handleFetchError(
		err: unknown,
		signal?: AbortSignal,
		controller?: AbortController
	): never {
		if (signal?.aborted || (err instanceof Error && err.name === 'AbortError' && signal?.aborted)) {
			throw new ProviderError(
				'REQUEST_CANCELLED',
				'Ollama request was cancelled by user.',
				{ cause: err }
			);
		}

		if (controller?.signal.aborted && !signal?.aborted) {
			throw new ProviderError(
				'TIMEOUT',
				`Ollama request timed out after ${this._config.timeoutMs}ms.`,
				{
					userSuggestion: 'Consider increasing devpilot.ollama.timeoutMs in settings or verify server performance.',
					cause: err
				}
			);
		}

		if (err instanceof ProviderError) {
			throw err;
		}

		throw new ProviderError(
			'CONNECTION_REFUSED',
			`Cannot connect to Ollama at ${this._config.baseUrl}.`,
			{
				userSuggestion: 'Ensure Ollama is installed and running on port 11434.',
				cause: err
			}
		);
	}
}
