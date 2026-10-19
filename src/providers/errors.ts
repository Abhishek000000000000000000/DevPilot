/**
 * Standardized error codes for LLM provider operations.
 */
export type ProviderErrorCode =
	| 'CONNECTION_REFUSED'
	| 'MODEL_NOT_FOUND'
	| 'AUTHENTICATION_FAILED'
	| 'RATE_LIMITED'
	| 'TIMEOUT'
	| 'REQUEST_CANCELLED'
	| 'INVALID_REQUEST'
	| 'PROVIDER_ERROR';

/**
 * Standardized error thrown by LLM provider implementations.
 * Provides safe, user-friendly error messages and actionable suggestions
 * while preserving underlying diagnostic causes without exposing credentials.
 */
export class ProviderError extends Error {
	public readonly code: ProviderErrorCode;
	public readonly userSuggestion?: string;

	constructor(
		code: ProviderErrorCode,
		message: string,
		options?: {
			userSuggestion?: string;
			cause?: unknown;
		}
	) {
		super(message, options?.cause ? { cause: options.cause } : undefined);
		this.name = 'ProviderError';
		this.code = code;
		this.userSuggestion = options?.userSuggestion;

		// Maintain proper prototype chain for instanceof checks
		Object.setPrototypeOf(this, ProviderError.prototype);
	}
}
