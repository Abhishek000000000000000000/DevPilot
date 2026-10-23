import { ILLMProvider } from '../ILLMProvider.js';
import { ChatRequest, ChatResponse, StreamChunk, ProviderHealth, ChatFinishReason, GenerationMetrics } from '../types.js';
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
		const url = `${this._config.baseUrl}/api/chat`;

		const payload = {
			model: targetModel,
			messages: request.messages.map(m => ({
				role: m.role,
				content: m.content
			})),
			stream: true,
			think: this._config.think,
			...(request.options?.temperature !== undefined || request.options?.maxTokens !== undefined ? {
				options: {
					...(request.options?.temperature !== undefined ? { temperature: request.options.temperature } : {}),
					...(request.options?.maxTokens !== undefined ? { num_predict: request.options.maxTokens } : {})
				}
			} : {})
		};

		// Arm initial connect and response header timeout
		resetTimeout();
		const streamStartTime = Date.now();
		console.log(`[DevPilot OllamaProvider] [t=0ms] chatStream started (model="${targetModel}", think=${this._config.think})`);

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
				return this._handleFetchError(fetchErr, signal, controller, isTimedOut);
			}

			console.log(`[DevPilot OllamaProvider] [t=${Date.now() - streamStartTime}ms] HTTP ${response.status} response headers received`);

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

			// Arm activity timeout for first stream chunk
			resetTimeout();

			try {
				return await this._consumeStream(
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

	private async _consumeStream(
		body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array | string>,
		onChunk: (chunk: StreamChunk) => void,
		targetModel: string,
		streamSignal: AbortSignal,
		onActivity: () => void,
		streamStartTime: number = Date.now()
	): Promise<ChatResponse> {
		let accumulatedText = '';
		let finishReason: ChatFinishReason = 'stop';
		let promptEvalCount: number | undefined;
		let evalCount: number | undefined;
		let rawMetrics: {
			eval_count?: unknown;
			eval_duration?: unknown;
			prompt_eval_count?: unknown;
			prompt_eval_duration?: unknown;
			total_duration?: unknown;
			load_duration?: unknown;
		} = {};
		let lineBuffer = '';
		let hasReceivedDone = false;
		const decoder = new TextDecoder('utf-8');
		const chunkStats = { count: 0, firstChunkLogged: false, firstContentLogged: false };

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
					if (meta.metrics) {
						rawMetrics = { ...rawMetrics, ...meta.metrics };
					}
				}, streamStartTime, chunkStats);
			}
		};

		// Support both standard Web Streams (getReader) and AsyncIterables with activity timeouts
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
						processLines(decoder.decode(value, { stream: true }));
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
						processLines(str);
					}
				}
			} finally {
				if (typeof iterator.return === 'function') {
					await iterator.return();
				}
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
				if (meta.promptEvalCount !== undefined) {
					promptEvalCount = meta.promptEvalCount;
				}
				if (meta.evalCount !== undefined) {
					evalCount = meta.evalCount;
				}
				if (meta.metrics) {
					rawMetrics = { ...rawMetrics, ...meta.metrics };
				}
			}, streamStartTime, chunkStats);
		}

		if (!hasReceivedDone) {
			throw new ProviderError(
				'PROVIDER_ERROR',
				'Ollama stream terminated unexpectedly before completion was signaled by the provider.'
			);
		}

		console.log(`[DevPilot OllamaProvider] [t=${Date.now() - streamStartTime}ms] Stream finished (${accumulatedText.length} chars, finishReason=${finishReason})`);
		const metrics = parseOllamaMetrics(rawMetrics);

		return {
			text: accumulatedText,
			finishReason,
			model: targetModel,
			usage: {
				promptTokens: promptEvalCount,
				completionTokens: evalCount
			},
			...(metrics ? { metrics } : {})
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
			metrics?: {
				eval_count?: unknown;
				eval_duration?: unknown;
				prompt_eval_count?: unknown;
				prompt_eval_duration?: unknown;
				total_duration?: unknown;
				load_duration?: unknown;
			};
		}) => void,
		streamStartTime?: number,
		chunkStats?: { count: number; firstChunkLogged: boolean; firstContentLogged: boolean }
	): void {
		try {
			const parsed = JSON.parse(line) as {
				message?: { content?: string; thinking?: string };
				done?: boolean;
				done_reason?: string;
				prompt_eval_count?: number;
				prompt_eval_duration?: number;
				eval_count?: number;
				eval_duration?: number;
				total_duration?: number;
				load_duration?: number;
				error?: string;
			};

			if (parsed.error) {
				throw new ProviderError('PROVIDER_ERROR', `Ollama returned error: ${parsed.error}`);
			}

			if (chunkStats && streamStartTime !== undefined) {
				const now = Date.now() - streamStartTime;
				if (!chunkStats.firstChunkLogged) {
					chunkStats.firstChunkLogged = true;
					const isThinking = Boolean(parsed.message?.thinking && parsed.message.thinking.length > 0);
					console.log(`[DevPilot OllamaProvider] [t=${now}ms] First Ollama chunk arrived (thinking=${isThinking})`);
				}
			}

			const content = parsed.message?.content;
			if (typeof content === 'string' && content.length > 0) {
				if (chunkStats && streamStartTime !== undefined) {
					const now = Date.now() - streamStartTime;
					chunkStats.count++;
					if (!chunkStats.firstContentLogged) {
						chunkStats.firstContentLogged = true;
						console.log(`[DevPilot OllamaProvider] [t=${now}ms] First non-empty text delta arrived (${content.length} chars)`);
					} else {
						console.log(`[DevPilot OllamaProvider] [t=${now}ms] Ollama chunk #${chunkStats.count} emitted (${content.length} chars)`);
					}
				}
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
				evalCount: parsed.eval_count,
				metrics: {
					eval_count: parsed.eval_count,
					eval_duration: parsed.eval_duration,
					prompt_eval_count: parsed.prompt_eval_count,
					prompt_eval_duration: parsed.prompt_eval_duration,
					total_duration: parsed.total_duration,
					load_duration: parsed.load_duration
				}
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
		controller?: AbortController,
		isTimedOut?: boolean
	): never {
		if (signal?.aborted || (err instanceof Error && err.name === 'AbortError' && signal?.aborted)) {
			throw new ProviderError(
				'REQUEST_CANCELLED',
				'Ollama request was cancelled by user.',
				{ cause: err }
			);
		}

		if (isTimedOut || (err instanceof Error && err.message === 'TIMEOUT') || (controller?.signal.aborted && !signal?.aborted)) {
			throw new ProviderError(
				'TIMEOUT',
				`Ollama request timed out after ${this._config.timeoutMs}ms of inactivity.`,
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

/**
 * Raw metric payload shape as emitted by Ollama's /api/chat terminal response chunk.
 */
export interface RawOllamaMetrics {
	readonly eval_count?: unknown;
	readonly eval_duration?: unknown;
	readonly prompt_eval_count?: unknown;
	readonly prompt_eval_duration?: unknown;
	readonly total_duration?: unknown;
	readonly load_duration?: unknown;
}

/**
 * Parses and validates raw Ollama response metrics into normalized GenerationMetrics.
 * Converts nanoseconds durations to milliseconds and calculates generation tokens-per-second.
 * Returns undefined if no valid metrics are present.
 */
export function parseOllamaMetrics(raw?: RawOllamaMetrics): GenerationMetrics | undefined {
	if (!raw || typeof raw !== 'object') {
		return undefined;
	}

	const parseCount = (val: unknown): number | undefined => {
		if (typeof val === 'number' && Number.isFinite(val) && !Number.isNaN(val) && val >= 0) {
			return Math.floor(val);
		}
		return undefined;
	};

	const parseDurationNs = (val: unknown): number | undefined => {
		if (typeof val === 'number' && Number.isFinite(val) && !Number.isNaN(val) && val >= 0) {
			return val;
		}
		return undefined;
	};

	const nsToMs = (ns: number): number => {
		return Math.round((ns / 1_000_000) * 10) / 10;
	};

	const evalCount = parseCount(raw.eval_count);
	const promptEvalCount = parseCount(raw.prompt_eval_count);

	const evalDurationNs = parseDurationNs(raw.eval_duration);
	const promptEvalDurationNs = parseDurationNs(raw.prompt_eval_duration);
	const totalDurationNs = parseDurationNs(raw.total_duration);
	const loadDurationNs = parseDurationNs(raw.load_duration);

	let tokensPerSecond: number | undefined;
	if (evalCount !== undefined && evalDurationNs !== undefined && evalDurationNs > 0) {
		const seconds = evalDurationNs / 1_000_000_000;
		tokensPerSecond = Math.round((evalCount / seconds) * 10) / 10;
	}

	const evalDurationMs = evalDurationNs !== undefined ? nsToMs(evalDurationNs) : undefined;
	const promptEvalDurationMs = promptEvalDurationNs !== undefined ? nsToMs(promptEvalDurationNs) : undefined;
	const totalDurationMs = totalDurationNs !== undefined ? nsToMs(totalDurationNs) : undefined;
	const loadDurationMs = loadDurationNs !== undefined ? nsToMs(loadDurationNs) : undefined;

	const hasAnyMetric =
		evalCount !== undefined ||
		evalDurationMs !== undefined ||
		promptEvalCount !== undefined ||
		promptEvalDurationMs !== undefined ||
		totalDurationMs !== undefined ||
		loadDurationMs !== undefined ||
		tokensPerSecond !== undefined;

	if (!hasAnyMetric) {
		return undefined;
	}

	return {
		...(evalCount !== undefined ? { evalCount } : {}),
		...(evalDurationMs !== undefined ? { evalDurationMs } : {}),
		...(promptEvalCount !== undefined ? { promptEvalCount } : {}),
		...(promptEvalDurationMs !== undefined ? { promptEvalDurationMs } : {}),
		...(totalDurationMs !== undefined ? { totalDurationMs } : {}),
		...(loadDurationMs !== undefined ? { loadDurationMs } : {}),
		...(tokensPerSecond !== undefined ? { tokensPerSecond } : {})
	};
}
