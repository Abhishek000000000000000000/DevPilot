import * as assert from 'assert';
import * as vscode from 'vscode';
import * as myExtension from '../extension.js';
import { DevPilotViewProvider } from '../panels/DevPilotViewProvider.js';

suite('DevPilot Extension & Command Test Suite', () => {
	vscode.window.showInformationMessage('Starting DevPilot tests.');

	test('Extension is active and registered', async () => {
		const ext = vscode.extensions.all.find(e => e.packageJSON.name === 'AIEngineeringAssistant');
		assert.ok(ext, 'DevPilot extension should be installed in host');
		if (!ext.isActive) {
			await ext.activate();
		}
		assert.strictEqual(ext.isActive, true, 'DevPilot extension should be active');
	});

	test('devpilot.open command executes and focuses DevPilot view', async () => {
		const commands = await vscode.commands.getCommands(true);
		assert.ok(commands.includes('devpilot.open'), 'devpilot.open command should be registered');

		// Execute devpilot.open command
		await vscode.commands.executeCommand('devpilot.open');

		// Verify DevPilotViewProvider instance exists
		assert.ok(DevPilotViewProvider.currentProvider, 'DevPilotViewProvider.currentProvider should be defined');
	});

	test('UI <-> Extension communication contract test on ViewProvider', async () => {
		const provider = DevPilotViewProvider.currentProvider;
		assert.ok(provider, 'Provider should be initialized');

		// 1. Test devpilot.ready
		const readyResponse = provider.handleMessage({ type: 'devpilot.ready' });
		assert.ok(readyResponse, 'Ready message should return response');
		assert.strictEqual(readyResponse?.type, 'devpilot.ready');
		if (readyResponse?.type === 'devpilot.ready') {
			assert.strictEqual(readyResponse.payload.status, 'connected');
			assert.strictEqual(readyResponse.payload.message, 'DevPilot extension is connected.');
		}

		// 2. Test devpilot.message with text
		const messageResponse = provider.handleMessage({
			type: 'devpilot.message',
			payload: { text: 'Hello DevPilot' }
		});
		assert.ok(messageResponse, 'User message should return assistant response');
		assert.strictEqual(messageResponse?.type, 'devpilot.response');
		if (messageResponse?.type === 'devpilot.response') {
			assert.strictEqual(messageResponse.payload.text, 'DevPilot received your request.');
		}

		// 3. Test multiple sequential messages
		const secondMsgResponse = provider.handleMessage({
			type: 'devpilot.message',
			payload: { text: 'Can you help me with this function?' }
		});
		assert.ok(secondMsgResponse);
		assert.strictEqual(secondMsgResponse?.type, 'devpilot.response');

		// 4. Test empty / whitespace message (should be safely ignored)
		const emptyMsgResponse = provider.handleMessage({
			type: 'devpilot.message',
			payload: { text: '   ' }
		});
		assert.strictEqual(emptyMsgResponse, undefined, 'Empty message should be ignored without returning response');

		// 5. Test malformed / unknown message (should not crash)
		const unknownMsgResponse = provider.handleMessage({ type: 'unknown.type' });
		assert.strictEqual(unknownMsgResponse, undefined, 'Unknown message should be handled gracefully');
	});

	test('deactivate executes without error', () => {
		assert.doesNotThrow(() => {
			myExtension.deactivate();
		});
	});
});


