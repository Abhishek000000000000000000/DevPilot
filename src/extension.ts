import * as vscode from 'vscode';
import { DevPilotViewProvider } from './panels/DevPilotViewProvider.js';

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

	// Register DevPilot WebviewViewProvider for native sidebar integration
	const provider = new DevPilotViewProvider(context.extensionUri);
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

	context.subscriptions.push(devPilotOutputChannel, viewDisposable, openCommandDisposable);
}

/**
 * VS Code Extension Deactivation entry point.
 * Called when the extension is deactivated.
 */
export function deactivate(): void {
	console.log('DevPilot extension deactivated.');
}

