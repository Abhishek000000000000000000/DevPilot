/**
 * DevPilot Webview to Extension Message Types
 */
export interface ReadyMessage {
	type: 'devpilot.ready';
}

export interface UserMessage {
	type: 'devpilot.message';
	payload: {
		text: string;
	};
}

export interface CloseMessage {
	type: 'devpilot.close';
}

export type WebviewToExtensionMessage = ReadyMessage | UserMessage | CloseMessage;

/**
 * DevPilot Extension to Webview Message Types
 */
export interface ReadyResponse {
	type: 'devpilot.ready';
	payload: {
		status: 'connected';
		message: string;
	};
}

export interface AssistantResponse {
	type: 'devpilot.response';
	payload: {
		text: string;
	};
}

export type ExtensionToWebviewMessage = ReadyResponse | AssistantResponse;
