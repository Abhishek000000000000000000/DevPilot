/**
 * Capabilities supported by a specific LLM provider.
 */
export interface ProviderCapabilities {
	readonly supportsStreaming: boolean;
	readonly supportsThinking: boolean;
	readonly supportsCancellation: boolean;
}

/**
 * Metadata descriptor defining a supported LLM provider backend in DevPilot.
 */
export interface ProviderDescriptor {
	readonly id: string;
	readonly displayName: string;
	readonly isLocal: boolean;
	readonly requiresApiKey: boolean;
	readonly defaultBaseUrl: string;
	readonly defaultModel: string;
	readonly defaultTimeoutMs: number;
	readonly capabilities: ProviderCapabilities;
}

export const OLLAMA_DESCRIPTOR: ProviderDescriptor = {
	id: 'ollama',
	displayName: 'Ollama (Local)',
	isLocal: true,
	requiresApiKey: false,
	defaultBaseUrl: 'http://localhost:11434',
	defaultModel: 'qwen3.5:9b',
	defaultTimeoutMs: 120000,
	capabilities: {
		supportsStreaming: true,
		supportsThinking: true,
		supportsCancellation: true
	}
};

export const OPENAI_COMPATIBLE_DESCRIPTOR: ProviderDescriptor = {
	id: 'openai-compatible',
	displayName: 'OpenAI-Compatible (Groq / OpenRouter / Custom)',
	isLocal: false,
	requiresApiKey: true,
	defaultBaseUrl: 'https://api.groq.com/openai/v1',
	defaultModel: 'openai/gpt-oss-20b',
	defaultTimeoutMs: 60000,
	capabilities: {
		supportsStreaming: true,
		supportsThinking: false,
		supportsCancellation: true
	}
};

/**
 * Registry of supported LLM provider descriptors.
 * Decouples provider metadata, endpoints, and capabilities from core chat execution logic.
 */
export class ProviderRegistry {
	private static readonly _descriptors = new Map<string, ProviderDescriptor>([
		[OLLAMA_DESCRIPTOR.id, OLLAMA_DESCRIPTOR],
		[OPENAI_COMPATIBLE_DESCRIPTOR.id, OPENAI_COMPATIBLE_DESCRIPTOR]
	]);

	private static readonly _aliases = new Map<string, string>([
		['groq', OPENAI_COMPATIBLE_DESCRIPTOR.id]
	]);

	/**
	 * Retrieves the descriptor for a provider ID (case-insensitive).
	 */
	public static getDescriptor(id: string): ProviderDescriptor | undefined {
		if (!id || typeof id !== 'string') {
			return undefined;
		}
		const key = id.trim().toLowerCase();
		const canonicalId = this._aliases.get(key) ?? key;
		return this._descriptors.get(canonicalId);
	}

	/**
	 * Returns all registered provider descriptors.
	 */
	public static getAllDescriptors(): readonly ProviderDescriptor[] {
		return Array.from(this._descriptors.values());
	}

	/**
	 * Checks whether the specified provider ID is supported.
	 */
	public static isSupported(id: string): boolean {
		return this.getDescriptor(id) !== undefined;
	}
}
