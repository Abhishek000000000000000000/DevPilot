import { ILLMProvider } from '../ILLMProvider.js';
import {
	ChatRequest,
	ChatResponse,
	StreamChunk,
	ProviderHealth,
	ChatFinishReason,
	GenerationMetrics
} from '../types.js';
import { ProviderError } from '../errors.js';
import {
	OpenAICompatibleConfig,
	validateOpenAICompatibleConfig
} from './OpenAICompatibleConfig.js';

/**
 * Concrete LLM provider adapter for generic OpenAI-compatible endpoints
 * (such as Groq, OpenRouter, Together AI, vLLM, LM Studio, etc.).
 *
 * Adheres strictly to standard OpenAI Chat Completions Server-Sent Events (SSE)
 * protocols, mapping vendor-specific status codes into normalized DevPilot ProviderErrors
 * while guaranteeing credentials never leak into logs or error messages.
 */
export class OpenAICompatibleProvider implements ILLMProvider {
	public readonly id = 'openai-compatible';
	public readonly displayName = 'OpenAI-Compatible';

	private readonly _config: OpenAICompatibleConfig;
	private readonly _fetchFn: typeof fetch;

	constructor(
		config?: Partial<OpenAICompatibleConfig>,
		fetchFn?: typeof fetch
	) {
		this._config = validateOpenAICompatibleConfig(config ?? {});
		this._fetchFn = fetchFn ?? globalThis.fetch;
	}

	public get config(): OpenAICompatibleConfig {
		return this._config;
	}

	/**
	 * Checks provider connectivity and model availability via GET /models endpoint.
	 */
	public async checkHealth(signal?: AbortSignal): Promise<ProviderHealth> {
		if (signal?.aborted) {
			throw new ProviderError('REQUEST_CANCELLED', 'Health check was cancelled by user.', { cause: signal.reason });
		}

		const url = `${this._config.baseUrl}/models`;
		const controller = new AbortController();
		const timeoutId = setTimeout(
			() => controller.abort(new Error('TIMEOUT')),
			this._config.timeoutMs
		);

		const onAbort = () => controller.abort(signal?.reason);
		signal?.addEventListener('abort', onAbort);

		try {
			const headers: Record<string, string> = {
				'Accept': 'application/json'
			};
			if (this._config.apiKey) {
				headers['Authorization'] = `Bearer ${this._config.apiKey}`;
			}

			const response = await this._fetchFn(url, {
				method: 'GET',
				headers,
				signal: controller.signal
			});

			if (!response.ok) {
				if (response.status === 401 || response.status === 403) {
					return {
						isHealthy: false,
						message: 'Authentication failed. Please verify your API key using the "DevPilot: Set Provider API Key" command.',
						availableModels: []
					};
				}

				return {
					isHealthy: false,
					message: `Provider returned HTTP ${response.status}: ${response.statusText}`,
					availableModels: []
				};
			}

			const data = (await response.json()) as { data?: Array<{ id?: string }> };
			const models: string[] = [];
			if (Array.isArray(data.data)) {
				for (const item of data.data) {
					if (typeof item.id === 'string' && item.id.trim().length > 0) {
						models.push(item.id.trim());
					}
				}
			}

			const targetModel = this._config.model;
			const modelFound = models.length === 0 || models.includes(targetModel);

			return {
				isHealthy: true,
				message: modelFound
					? `Connected to provider with model "${targetModel}".`
					: `Connected to provider, but configured model "${targetModel}" was not listed.`,
				availableModels: models
			};
		} catch (err) {
			if (signal?.aborted || (err instanceof Error && err.name === 'AbortError' && signal?.aborted)) {
				throw new ProviderError('REQUEST_CANCELLED', 'Health check was cancelled by user.', { cause: err });
			}
			if (controller.signal.aborted && !signal?.aborted) {
				return {
					isHealthy: false,
					message: `Provider health check timed out after ${this._config.timeoutMs}ms.`,
					availableModels: []
				};
			}
			return {
				isHealthy: false,
				message: `Cannot connect to provider at ${this._config.baseUrl}.`,
				availableModels: []
			};
		} finally {
			clearTimeout(timeoutId);
			signal?.removeEventListener('abort', onAbort);
		}
	}

	/**
	 * Streams chat completions token-by-token using standard OpenAI SSE /chat/completions endpoint.
	 */
	public async chatStream(
		request: ChatRequest,
		onChunk: (chunk: StreamChunk) => void,
		signal?: AbortSignal
	): Promise<ChatResponse> {
		const controller = new AbortController();
		let isTimedOut = false;
		let timeoutId: ReturnType<typeof setTimeout> | undefined;

		const resetTimeout = () => {
			if (timeoutId !== undefined) {
				clearTimeout(timeoutId);
			}
			timeoutId = setTimeout(() => {
				isTimedOut = true;
				controller.abort(new Error('TIMEOUT'));
			}, this._config.timeoutMs);
		};

		const clearTimeoutTimer = () => {
			if (timeoutId !== undefined) {
				clearTimeout(timeoutId);
				timeoutId = undefined;
			}
		};

		const onAbort = () => {
			clearTimeoutTimer();
			controller.abort(signal?.reason);
		};
		signal?.addEventListener('abort', onAbort);
		if (signal?.aborted) {
			controller.abort(signal.reason);
		}

		const targetModel = request.options?.model || this._config.model;
		const url = `${this._config.baseUrl}/chat/completions`;

		const payload: Record<string, unknown> = {
			model: targetModel,
			messages: request.messages.map(m => ({
				role: m.role,
				content: m.content
			})),
			stream: true,
			stream_options: { include_usage: true }
		};

		if (request.options?.temperature !== undefined) {
			payload.temperature = request.options.temperature;
		}
		if (request.options?.maxTokens !== undefined) {
			payload.max_tokens = request.options.maxTokens;
		}

		resetTimeout();
		const streamStartTime = Date.now();

		try {
			const headers: Record<string, string> = {
				'Content-Type': 'application/json',
				'Accept': 'text/event-stream, application/json'
			};
			if (this._config.apiKey) {
				headers['Authorization'] = `Bearer ${this._config.apiKey}`;
			}

			let response: Response;
			try {
				response = await this._fetchFn(url, {
					method: 'POST',
					headers,
					body: JSON.stringify(payload),
					signal: controller.signal
				});
			} catch (fetchErr) {
				return this._handleFetchError(fetchErr, signal, controller, isTimedOut);
			}

			if (!response.ok) {
				let errorDetails = '';
				let retryAfterSec: number | undefined;

				const retryHeader = response.headers.get('retry-after');
				if (retryHeader) {
					const parsed = parseInt(retryHeader, 10);
					if (!isNaN(parsed) && parsed > 0) {
						retryAfterSec = parsed;
					}
				}

				try {
					const errJson = (await response.json()) as {
						error?: { message?: string; type?: string; code?: string } | string;
					};
					if (typeof errJson?.error === 'object' && typeof errJson.error?.message === 'string') {
						errorDetails = errJson.error.message;
					} else if (typeof errJson?.error === 'string') {
						errorDetails = errJson.error;
					}
				} catch {
					// Response body was not JSON
				}

				// Sanitize error details to ensure API key is never exposed
				if (this._config.apiKey && errorDetails.includes(this._config.apiKey)) {
					errorDetails = errorDetails.split(this._config.apiKey).join('***');
				}

				if (response.status === 401 || response.status === 403) {
					throw new ProviderError(
						'AUTHENTICATION_FAILED',
						`Authentication failed for provider (${response.status}).`,
						{
							userSuggestion: 'Please verify your API key using the "DevPilot: Set Provider API Key" command.',
							cause: errorDetails
						}
					);
				}

				if (response.status === 429) {
					const retryMsg = retryAfterSec ? ` Please retry after ${retryAfterSec} seconds.` : ' Please wait before retrying.';
					throw new ProviderError(
						'RATE_LIMITED',
						`Rate limit exceeded for provider.${retryMsg}`,
						{
							userSuggestion: 'Consider switching models, upgrading your provider tier, or waiting for quota reset.',
							cause: errorDetails
						}
					);
				}

				if (response.status === 404) {
					const details = errorDetails ? `: ${errorDetails}` : '';
					throw new ProviderError(
						'MODEL_NOT_FOUND',
						`Model "${targetModel}" was not found by the provider${details}.`,
						{
							userSuggestion: 'Run the "DevPilot: Select Model" command to choose an active model on your account.',
							cause: errorDetails
						}
					);
				}

				if (response.status === 400) {
					throw new ProviderError(
						'INVALID_REQUEST',
						`Invalid request sent to provider: ${errorDetails || response.statusText}`,
						{
							userSuggestion: 'Check your request parameters and message structure.',
							cause: errorDetails
						}
					);
				}

				throw new ProviderError(
					'PROVIDER_ERROR',
					`Provider request failed with HTTP ${response.status}${errorDetails ? `: ${errorDetails}` : ''}`,
					{
						userSuggestion: 'Check provider status or logs for service availability.',
						cause: errorDetails
					}
				);
			}

			if (!response.body) {
				throw new ProviderError(
					'PROVIDER_ERROR',
					'No response body stream received from provider.'
				);
			}

			resetTimeout();

			try {
				return await this._consumeSseStream(
					response.body,
					onChunk,
					targetModel,
					controller.signal,
					resetTimeout,
					streamStartTime
				);
			} catch (streamErr) {
				return this._handleFetchError(streamErr, signal, controller, isTimedOut);
			}
		} finally {
			clearTimeoutTimer();
			signal?.removeEventListener('abort', onAbort);
		}
	}

	private async _readNext<T>(
		readPromise: Promise<{ done?: boolean; value?: T }>,
		signal: AbortSignal
	): Promise<{ done?: boolean; value?: T }> {
		if (signal.aborted) {
			throw signal.reason || new Error('ABORTED');
		}

		let onAbort: (() => void) | undefined;
		try {
			return await Promise.race([
				readPromise,
				new Promise<never>((_, reject) => {
					onAbort = () => reject(signal.reason || new Error('ABORTED'));
					signal.addEventListener('abort', onAbort, { once: true });
				})
			]);
		} finally {
			if (onAbort) {
				signal.removeEventListener('abort', onAbort);
			}
		}
	}

	private async _consumeSseStream(
		body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array | string>,
		onChunk: (chunk: StreamChunk) => void,
		targetModel: string,
		streamSignal: AbortSignal,
		onActivity: () => void,
		streamStartTime: number
	): Promise<ChatResponse> {
		let accumulatedText = '';
		let finishReason: ChatFinishReason = 'stop';
		let promptTokens: number | undefined;
		let completionTokens: number | undefined;
		let lineBuffer = '';
		let hasReceivedDone = false;
		const decoder = new TextDecoder('utf-8');

		const processChunkText = (rawText: string) => {
			lineBuffer += rawText;
			const lines = lineBuffer.split(/\r?\n/);
			// Keep the last potentially incomplete line slice in the buffer
			lineBuffer = lines.pop() ?? '';

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed || trimmed.startsWith(':')) {
					// Empty line or SSE comment line (keep-alive)
					continue;
				}

				if (trimmed.startsWith('data:')) {
					const dataPayload = trimmed.slice(5).trim();
					if (dataPayload === '[DONE]') {
						hasReceivedDone = true;
						continue;
					}

					try {
						const parsed = JSON.parse(dataPayload) as {
							choices?: Array<{
								delta?: { content?: string; role?: string };
								finish_reason?: string | null;
							}>;
							usage?: {
								prompt_tokens?: number;
								completion_tokens?: number;
								total_tokens?: number;
							};
							error?: { message?: string };
						};

						if (parsed.error) {
							throw new ProviderError(
								'PROVIDER_ERROR',
								`Provider error during stream: ${parsed.error.message || 'Unknown error'}`
							);
						}

						// Extract content delta
						const content = parsed.choices?.[0]?.delta?.content;
						if (typeof content === 'string' && content.length > 0) {
							accumulatedText += content;
							onChunk({ text: content });
						}

						// Extract finish reason if present
						const rawFinish = parsed.choices?.[0]?.finish_reason;
						if (rawFinish === 'length') {
							finishReason = 'length';
						} else if (rawFinish && typeof rawFinish === 'string') {
							finishReason = 'stop';
						}

						// Extract usage if provider returns it (via stream_options: { include_usage: true })
						if (parsed.usage) {
							if (typeof parsed.usage.prompt_tokens === 'number') {
								promptTokens = parsed.usage.prompt_tokens;
							}
							if (typeof parsed.usage.completion_tokens === 'number') {
								completionTokens = parsed.usage.completion_tokens;
							}
						}
					} catch (jsonErr) {
						if (jsonErr instanceof ProviderError) {
							throw jsonErr;
						}
						// Silently skip unexpected non-JSON data frames without breaking stream
					}
				}
			}
		};

		// Support both standard Web Streams (getReader) and AsyncIterables
		if ('getReader' in body && typeof body.getReader === 'function') {
			const reader = body.getReader();
			try {
				while (true) {
					const { done, value } = await this._readNext(reader.read(), streamSignal);
					if (done) {
						break;
					}
					onActivity();
					if (value) {
						processChunkText(decoder.decode(value, { stream: true }));
					}
				}
			} finally {
				reader.releaseLock?.();
			}
		} else if (body && typeof body === 'object' && Symbol.asyncIterator in body) {
			const iterator = (body as AsyncIterable<Uint8Array | string>)[Symbol.asyncIterator]();
			try {
				while (true) {
					const { done, value } = await this._readNext(iterator.next(), streamSignal);
					if (done) {
						break;
					}
					onActivity();
					if (value !== undefined) {
						const str = typeof value === 'string' ? value : decoder.decode(value, { stream: true });
						processChunkText(str);
					}
				}
			} finally {
				if (typeof iterator.return === 'function') {
					await iterator.return();
				}
			}
		} else {
			throw new ProviderError('PROVIDER_ERROR', 'Unsupported response stream type received from provider.');
		}

		// Flush any trailing line left in the buffer
		if (lineBuffer.trim().length > 0) {
			processChunkText(lineBuffer.trim() + '\n');
		}

		// Fail cleanly if stream disconnected prematurely without emitting text or [DONE]
		if (!hasReceivedDone && accumulatedText.length === 0) {
			throw new ProviderError(
				'PROVIDER_ERROR',
				'Provider stream terminated unexpectedly before generating any content.'
			);
		}

		const totalDurationMs = Date.now() - streamStartTime;
		const evalCount = completionTokens ?? (accumulatedText.length > 0 ? undefined : 0);
		let tokensPerSecond: number | undefined;

		if (evalCount !== undefined && evalCount > 0 && totalDurationMs > 0) {
			tokensPerSecond = Math.round((evalCount / (totalDurationMs / 1000)) * 10) / 10;
		}

		const metrics: GenerationMetrics | undefined =
			evalCount !== undefined || promptTokens !== undefined || totalDurationMs > 0
				? {
					evalCount,
					evalDurationMs: totalDurationMs,
					promptEvalCount: promptTokens,
					totalDurationMs,
					tokensPerSecond
				}
				: undefined;

		return {
			text: accumulatedText,
			finishReason,
			model: targetModel,
			...(promptTokens !== undefined || completionTokens !== undefined
				? {
					usage: {
						promptTokens,
						completionTokens
					}
				}
				: {}),
			...(metrics ? { metrics } : {})
		};
	}

	private _handleFetchError(
		err: unknown,
		signal: AbortSignal | undefined,
		controller: AbortController,
		isTimedOut: boolean
	): never {
		if (signal?.aborted || (err instanceof Error && err.name === 'AbortError' && signal?.aborted)) {
			throw new ProviderError('REQUEST_CANCELLED', 'Request was cancelled by user.', { cause: err });
		}
		if (isTimedOut || (err instanceof Error && err.message === 'TIMEOUT') || (controller.signal.aborted && !signal?.aborted)) {
			throw new ProviderError('TIMEOUT', `Request timed out after ${this._config.timeoutMs}ms of inactivity.`, {
				userSuggestion: 'Check your internet connection or verify provider availability.',
				cause: err
			});
		}
		if (err instanceof ProviderError) {
			throw err;
		}

		const rawMessage = err instanceof Error ? err.message : String(err);
		// Sanitize to ensure API key is never reflected
		const sanitizedMessage = this._config.apiKey && rawMessage.includes(this._config.apiKey)
			? rawMessage.split(this._config.apiKey).join('***')
			: rawMessage;

		throw new ProviderError('CONNECTION_REFUSED', `Cannot connect to provider at ${this._config.baseUrl}: ${sanitizedMessage}`, {
			userSuggestion: 'Verify your internet connection and check if the provider endpoint is reachable.',
			cause: err
		});
	}
}
