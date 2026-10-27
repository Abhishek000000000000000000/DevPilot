import * as vscode from 'vscode';
import {
	OpenAICompatibleConfig,
	validateOpenAICompatibleConfig,
	DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
	DEFAULT_OPENAI_COMPATIBLE_MODEL,
	DEFAULT_OPENAI_COMPATIBLE_TIMEOUT_MS
} from './OpenAICompatibleConfig.js';

/**
 * Reads and validates generic OpenAI-compatible configuration from VS Code settings.
 */
export function getOpenAICompatibleConfigFromVSCode(apiKey?: string): OpenAICompatibleConfig {
	const configuration = vscode.workspace.getConfiguration('devpilot.openaiCompatible');
	const baseUrl = configuration.get<string>('baseUrl', DEFAULT_OPENAI_COMPATIBLE_BASE_URL);
	const model = configuration.get<string>('model', DEFAULT_OPENAI_COMPATIBLE_MODEL);
	const timeoutMs = configuration.get<number>('timeoutMs', DEFAULT_OPENAI_COMPATIBLE_TIMEOUT_MS);

	return validateOpenAICompatibleConfig({
		baseUrl,
		model,
		timeoutMs,
		apiKey
	});
}
