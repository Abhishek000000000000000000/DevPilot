/**
 * Configuration options for generic OpenAI-compatible LLM endpoints
 * (e.g., Groq, OpenRouter, Together AI, vLLM, LM Studio, etc.).
 */
export interface OpenAICompatibleConfig {
	readonly baseUrl: string;
	readonly model: string;
	readonly apiKey?: string;
	readonly timeoutMs: number;
}

export const DEFAULT_OPENAI_COMPATIBLE_BASE_URL = 'https://api.groq.com/openai/v1';
export const DEFAULT_OPENAI_COMPATIBLE_MODEL = 'openai/gpt-oss-20b';
export const DEFAULT_OPENAI_COMPATIBLE_TIMEOUT_MS = 60000;
export const MIN_TIMEOUT_MS = 1000;
export const MAX_TIMEOUT_MS = 600000; // 10 minutes

/**
 * Validates and normalizes OpenAI-compatible configuration parameters.
 * Throws an Error with a descriptive message if any value is invalid.
 */
export function validateOpenAICompatibleConfig(
	config: Partial<OpenAICompatibleConfig>
): OpenAICompatibleConfig {
	const rawBaseUrl = config.baseUrl ?? DEFAULT_OPENAI_COMPATIBLE_BASE_URL;
	let parsedUrl: URL;
	try {
		parsedUrl = new URL(rawBaseUrl);
	} catch {
		throw new Error(`Invalid baseUrl: "${rawBaseUrl}". Must be a valid HTTP or HTTPS URL.`);
	}

	if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
		throw new Error(`Invalid baseUrl protocol: "${parsedUrl.protocol}". Must be http: or https:.`);
	}

	// Normalize baseUrl by stripping trailing slashes
	const baseUrl = rawBaseUrl.trim().replace(/\/+$/, '');

	const rawModel = config.model ?? DEFAULT_OPENAI_COMPATIBLE_MODEL;
	if (typeof rawModel !== 'string' || rawModel.trim().length === 0) {
		throw new Error('Model identifier must be a non-empty string.');
	}
	const model = rawModel.trim();

	const rawTimeout = config.timeoutMs ?? DEFAULT_OPENAI_COMPATIBLE_TIMEOUT_MS;
	if (
		typeof rawTimeout !== 'number' ||
		isNaN(rawTimeout) ||
		rawTimeout < MIN_TIMEOUT_MS ||
		rawTimeout > MAX_TIMEOUT_MS
	) {
		throw new Error(
			`timeoutMs must be a number between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS} milliseconds.`
		);
	}
	const timeoutMs = Math.floor(rawTimeout);

	let apiKey: string | undefined;
	if (config.apiKey !== undefined && config.apiKey !== null) {
		if (typeof config.apiKey !== 'string') {
			throw new Error('API key must be a string.');
		}
		const trimmedKey = config.apiKey.trim();
		if (trimmedKey.length > 0) {
			apiKey = trimmedKey;
		}
	}

	return {
		baseUrl,
		model,
		...(apiKey ? { apiKey } : {}),
		timeoutMs
	};
}
