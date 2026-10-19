/**
 * Maximum character bounds for runtime message payload validation.
 */
export const MAX_REQUEST_ID_LENGTH = 128;
export const MAX_CHAT_TEXT_LENGTH = 64000;

/**
 * -----------------------------------------------------------------------------
 * Webview -> Extension Message Contracts
 * -----------------------------------------------------------------------------
 */

export interface ReadyMessage {
	readonly type: 'devpilot.ready';
}

export interface ChatSendMessage {
	readonly type: 'devpilot.chat.send';
	readonly payload: {
		readonly requestId: string;
		readonly text: string;
	};
}

export interface ChatCancelMessage {
	readonly type: 'devpilot.chat.cancel';
	readonly payload: {
		readonly requestId: string;
	};
}

export interface CloseMessage {
	readonly type: 'devpilot.close';
}

/**
 * Legacy Phase 1 user message contract maintained for backward compatibility.
 */
export interface LegacyUserMessage {
	readonly type: 'devpilot.message';
	readonly payload: {
		readonly text: string;
	};
}

export type WebviewToExtensionMessage =
	| ReadyMessage
	| ChatSendMessage
	| ChatCancelMessage
	| CloseMessage
	| LegacyUserMessage;

/**
 * -----------------------------------------------------------------------------
 * Extension -> Webview Message Contracts
 * -----------------------------------------------------------------------------
 */

export interface ReadyResponse {
	readonly type: 'devpilot.ready';
	readonly payload: {
		readonly status: 'connected';
		readonly message: string;
	};
}

export interface ChatChunkMessage {
	readonly type: 'devpilot.chat.chunk';
	readonly payload: {
		readonly requestId: string;
		readonly text: string;
	};
}

export type ChatCompleteFinishReason = 'stop' | 'length' | 'cancelled' | 'error';

export interface ChatCompleteMessage {
	readonly type: 'devpilot.chat.complete';
	readonly payload: {
		readonly requestId: string;
		readonly fullText: string;
		readonly finishReason: ChatCompleteFinishReason;
	};
}

export interface ChatErrorMessage {
	readonly type: 'devpilot.chat.error';
	readonly payload: {
		readonly requestId: string;
		readonly code: string;
		readonly message: string;
		readonly suggestion?: string;
	};
}

/**
 * Legacy Phase 1 assistant response contract maintained for backward compatibility.
 */
export interface LegacyAssistantResponse {
	readonly type: 'devpilot.response';
	readonly payload: {
		readonly text: string;
	};
}

export type ExtensionToWebviewMessage =
	| ReadyResponse
	| ChatChunkMessage
	| ChatCompleteMessage
	| ChatErrorMessage
	| LegacyAssistantResponse;

// Aliases for backward compatibility with existing tests and imports
export type AssistantResponse = LegacyAssistantResponse;
export type UserMessage = LegacyUserMessage;

/**
 * -----------------------------------------------------------------------------
 * Runtime Validation
 * -----------------------------------------------------------------------------
 */

export type ValidationResult<T = WebviewToExtensionMessage> =
	| { readonly valid: true; readonly message: T }
	| { readonly valid: false; readonly error: string };

/**
 * Validates untrusted incoming data from the Webview at the extension host boundary.
 * 
 * Ensures all required fields are present, properly typed, and within safe length bounds
 * without throwing errors or crashing the extension.
 */
export function validateWebviewMessage(raw: unknown): ValidationResult<WebviewToExtensionMessage> {
	if (!raw || typeof raw !== 'object') {
		return { valid: false, error: 'Message must be a non-null object' };
	}

	const candidate = raw as { type?: unknown; payload?: unknown };
	if (typeof candidate.type !== 'string') {
		return { valid: false, error: 'Message missing required string "type" field' };
	}

	switch (candidate.type) {
		case 'devpilot.ready':
			return { valid: true, message: { type: 'devpilot.ready' } };

		case 'devpilot.close':
			return { valid: true, message: { type: 'devpilot.close' } };

		case 'devpilot.chat.send': {
			if (!candidate.payload || typeof candidate.payload !== 'object') {
				return { valid: false, error: 'chat.send requires a non-null payload object' };
			}
			const p = candidate.payload as { requestId?: unknown; text?: unknown };

			if (typeof p.requestId !== 'string') {
				return { valid: false, error: 'chat.send requires a string "requestId"' };
			}
			const trimmedId = p.requestId.trim();
			if (trimmedId.length === 0 || p.requestId.length > MAX_REQUEST_ID_LENGTH) {
				return {
					valid: false,
					error: `chat.send "requestId" must be between 1 and ${MAX_REQUEST_ID_LENGTH} non-whitespace characters`
				};
			}

			if (typeof p.text !== 'string') {
				return { valid: false, error: 'chat.send requires a string "text"' };
			}
			const trimmedText = p.text.trim();
			if (trimmedText.length === 0 || p.text.length > MAX_CHAT_TEXT_LENGTH) {
				return {
					valid: false,
					error: `chat.send "text" must be between 1 and ${MAX_CHAT_TEXT_LENGTH} non-whitespace characters`
				};
			}

			return {
				valid: true,
				message: {
					type: 'devpilot.chat.send',
					payload: {
						requestId: p.requestId,
						text: p.text
					}
				}
			};
		}

		case 'devpilot.chat.cancel': {
			if (!candidate.payload || typeof candidate.payload !== 'object') {
				return { valid: false, error: 'chat.cancel requires a non-null payload object' };
			}
			const p = candidate.payload as { requestId?: unknown };

			if (typeof p.requestId !== 'string') {
				return { valid: false, error: 'chat.cancel requires a string "requestId"' };
			}
			const trimmedId = p.requestId.trim();
			if (trimmedId.length === 0 || p.requestId.length > MAX_REQUEST_ID_LENGTH) {
				return {
					valid: false,
					error: `chat.cancel "requestId" must be between 1 and ${MAX_REQUEST_ID_LENGTH} non-whitespace characters`
				};
			}

			return {
				valid: true,
				message: {
					type: 'devpilot.chat.cancel',
					payload: {
						requestId: p.requestId
					}
				}
			};
		}

		case 'devpilot.message': {
			if (!candidate.payload || typeof candidate.payload !== 'object') {
				return { valid: false, error: 'devpilot.message requires a non-null payload object' };
			}
			const p = candidate.payload as { text?: unknown };

			if (typeof p.text !== 'string') {
				return { valid: false, error: 'devpilot.message requires a string "text"' };
			}
			const trimmed = p.text.trim();
			if (trimmed.length === 0 || p.text.length > MAX_CHAT_TEXT_LENGTH) {
				return {
					valid: false,
					error: `devpilot.message "text" must be between 1 and ${MAX_CHAT_TEXT_LENGTH} non-whitespace characters`
				};
			}

			return {
				valid: true,
				message: {
					type: 'devpilot.message',
					payload: {
						text: p.text
					}
				}
			};
		}

		default:
			return { valid: false, error: `Unrecognized message type: "${candidate.type}"` };
	}
}
