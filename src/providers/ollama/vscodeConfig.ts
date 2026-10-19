import * as vscode from 'vscode';
import {
	OllamaConfig,
	validateOllamaConfig,
	DEFAULT_OLLAMA_BASE_URL,
	DEFAULT_OLLAMA_MODEL,
	DEFAULT_OLLAMA_TIMEOUT_MS
} from './OllamaConfig.js';

/**
 * Reads and validates Ollama configuration from VS Code workspace settings.
 */
export function getOllamaConfigFromVSCode(): OllamaConfig {
	const configuration = vscode.workspace.getConfiguration('devpilot.ollama');
	const baseUrl = configuration.get<string>('baseUrl', DEFAULT_OLLAMA_BASE_URL);
	const model = configuration.get<string>('model', DEFAULT_OLLAMA_MODEL);
	const timeoutMs = configuration.get<number>('timeoutMs', DEFAULT_OLLAMA_TIMEOUT_MS);

	return validateOllamaConfig({
		baseUrl,
		model,
		timeoutMs
	});
}
