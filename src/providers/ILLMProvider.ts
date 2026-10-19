import { ChatRequest, ChatResponse, StreamChunk, ProviderHealth } from './types.js';

/**
 * Common abstraction interface for all LLM providers in DevPilot.
 * 
 * Implementations (such as Ollama or OpenAI-compatible backends) must adhere to this
 * contract to ensure the core extension remains fully provider-independent.
 */
export interface ILLMProvider {
	/**
	 * Stable unique identifier for the provider (e.g., 'ollama', 'openai-compatible').
	 */
	readonly id: string;

	/**
	 * Human-readable display name for UI rendering and settings.
	 */
	readonly displayName: string;

	/**
	 * Checks provider connectivity and queries available models.
	 * 
	 * @param signal Optional AbortSignal to cancel in-flight health checks.
	 */
	checkHealth(signal?: AbortSignal): Promise<ProviderHealth>;

	/**
	 * Streams chat completions token-by-token.
	 * 
	 * @param request Normalized conversation messages and generation options.
	 * @param onChunk Callback invoked when each text chunk arrives from the provider stream.
	 * @param signal Standard AbortSignal to cancel generation at any point.
	 * @returns Promise resolving to the final aggregated ChatResponse when streaming completes.
	 */
	chatStream(
		request: ChatRequest,
		onChunk: (chunk: StreamChunk) => void,
		signal?: AbortSignal
	): Promise<ChatResponse>;
}
