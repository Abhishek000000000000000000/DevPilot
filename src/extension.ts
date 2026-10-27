import * as vscode from 'vscode';
import { DevPilotViewProvider } from './panels/DevPilotViewProvider.js';
import { SecretStorageService } from './services/SecretStorageService.js';
import { ProviderFactory } from './providers/ProviderFactory.js';
import { registerApiKeyCommands } from './commands/apiKeyCommands.js';

let devPilotOutputChannel: vscode.OutputChannel | undefined;

/**
 * VS Code Extension Activation entry point.
 * Called when the extension is activated by VS Code.
 */
export function activate(context: vscode.ExtensionContext): void {
	// Create dedicated DevPilot Output Channel for logging
	devPilotOutputChannel = vscode.window.createOutputChannel('DevPilot');
	devPilotOutputChannel.appendLine('DevPilot extension activated successfully.');
	console.log('DevPilot extension activated successfully.');

	// Initialize secure credential storage for LLM provider API keys
	const secretStorageService = new SecretStorageService(context.secrets);
	const providerFactory = new ProviderFactory(secretStorageService);

	// Register API key and model management commands
	const apiKeyCommandDisposables = registerApiKeyCommands(context, secretStorageService, providerFactory);

	// Register DevPilot WebviewViewProvider for native sidebar integration
	const provider = new DevPilotViewProvider(context.extensionUri, undefined, secretStorageService, providerFactory);
	const viewDisposable = vscode.window.registerWebviewViewProvider(
		DevPilotViewProvider.viewType,
		provider
	);

	// Register devpilot.open command to reveal and focus the DevPilot view
	const openCommandDisposable = vscode.commands.registerCommand('devpilot.open', () => {
		provider.show();
		if (devPilotOutputChannel) {
			devPilotOutputChannel.appendLine('DevPilot view focused.');
		}
	});

	context.subscriptions.push(
		devPilotOutputChannel,
		viewDisposable,
		openCommandDisposable,
		...apiKeyCommandDisposables
	);
}

/**
 * VS Code Extension Deactivation entry point.
 * Called when the extension is deactivated.
 */
export function deactivate(): void {
	console.log('DevPilot extension deactivated.');
}

