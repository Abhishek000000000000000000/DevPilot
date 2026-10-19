/**
 * Configuration options for the local Ollama provider.
 */
export interface OllamaConfig {
	readonly baseUrl: string;
	readonly model: string;
	readonly timeoutMs: number;
}

export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';
export const DEFAULT_OLLAMA_MODEL = 'qwen3.5:9b';
export const DEFAULT_OLLAMA_TIMEOUT_MS = 120000;
export const MIN_TIMEOUT_MS = 1000;
export const MAX_TIMEOUT_MS = 600000; // 10 minutes

/**
 * Validates and normalizes Ollama configuration parameters.
 * Throws an Error with a descriptive message if any value is invalid.
 */
export function validateOllamaConfig(config: Partial<OllamaConfig>): OllamaConfig {
	const rawBaseUrl = config.baseUrl ?? DEFAULT_OLLAMA_BASE_URL;
	let parsedUrl: URL;
	try {
		parsedUrl = new URL(rawBaseUrl);
	} catch {
		throw new Error(`Invalid Ollama baseUrl: "${rawBaseUrl}". Must be a valid HTTP or HTTPS URL.`);
	}

	if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
		throw new Error(`Invalid Ollama baseUrl protocol: "${parsedUrl.protocol}". Must be http: or https:.`);
	}

	// Normalize baseUrl by stripping trailing slashes
	const baseUrl = rawBaseUrl.trim().replace(/\/+$/, '');

	const rawModel = config.model ?? DEFAULT_OLLAMA_MODEL;
	if (typeof rawModel !== 'string' || rawModel.trim().length === 0) {
		throw new Error('Ollama model name must be a non-empty string.');
	}
	const model = rawModel.trim();

	const rawTimeout = config.timeoutMs ?? DEFAULT_OLLAMA_TIMEOUT_MS;
	if (
		typeof rawTimeout !== 'number' ||
		isNaN(rawTimeout) ||
		rawTimeout < MIN_TIMEOUT_MS ||
		rawTimeout > MAX_TIMEOUT_MS
	) {
		throw new Error(
			`Ollama timeoutMs must be a number between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS} milliseconds.`
		);
	}
	const timeoutMs = Math.floor(rawTimeout);

	return {
		baseUrl,
		model,
		timeoutMs
	};
}
