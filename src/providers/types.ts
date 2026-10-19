/**
 * Role of the participant in a conversation turn.
 */
export type ChatRole = 'system' | 'user' | 'assistant';

/**
 * Normalized conversation message used across all LLM providers.
 */
export interface ChatMessage {
	readonly role: ChatRole;
	readonly content: string;
}

/**
 * Common configuration options for a chat generation request.
 */
export interface ChatOptions {
	readonly temperature?: number;
	readonly maxTokens?: number;
	readonly model?: string;
}

/**
 * Normalized request payload sent to any LLM provider.
 */
export interface ChatRequest {
	readonly messages: readonly ChatMessage[];
	readonly options?: ChatOptions;
}

/**
 * Real-time text chunk emitted during generation streaming.
 */
export interface StreamChunk {
	readonly text: string;
}

/**
 * Termination reason for generation completion.
 */
export type ChatFinishReason = 'stop' | 'length' | 'cancelled' | 'error';

/**
 * Aggregated response metadata returned when generation finishes.
 */
export interface ChatResponse {
	readonly text: string;
	readonly finishReason: ChatFinishReason;
	readonly model?: string;
	readonly usage?: {
		readonly promptTokens?: number;
		readonly completionTokens?: number;
	};
}

/**
 * Provider connectivity and operational status.
 */
export interface ProviderHealth {
	readonly isHealthy: boolean;
	readonly message?: string;
	readonly availableModels: readonly string[];
}
