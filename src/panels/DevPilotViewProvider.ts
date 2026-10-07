import * as vscode from 'vscode';
import {
	WebviewToExtensionMessage,
	ExtensionToWebviewMessage,
	ReadyResponse,
	AssistantResponse
} from '../types/messages.js';

/**
 * Manages the DevPilot WebviewView rendered in the VS Code Sidebar / Auxiliary Bar.
 */
export class DevPilotViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'devpilot.view';
	public static currentProvider: DevPilotViewProvider | undefined;

	private _view?: vscode.WebviewView;

	constructor(private readonly _extensionUri: vscode.Uri) {
		DevPilotViewProvider.currentProvider = this;
	}

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken
	): void {
		this._view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				vscode.Uri.joinPath(this._extensionUri, 'media')
			]
		};

		webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

		// Handle messages sent from the Webview UI
		webviewView.webview.onDidReceiveMessage(
			(message: unknown) => {
				this.handleMessage(message);
			}
		);

		webviewView.onDidDispose(() => {
			this._view = undefined;
		});
	}

	/**
	 * Focus or reveal the DevPilot WebviewView.
	 */
	public show(): void {
		if (this._view) {
			this._view.show?.(true);
		} else {
			vscode.commands.executeCommand('devpilot.view.focus');
		}
	}

	/**
	 * Post a typed message to the Webview UI.
	 */
	public postMessage(message: ExtensionToWebviewMessage): Thenable<boolean> | undefined {
		return this._view?.webview.postMessage(message);
	}

	/**
	 * Process and handle messages arriving from the Webview UI.
	 */
	public handleMessage(message: unknown): ExtensionToWebviewMessage | void {
		if (!message || typeof message !== 'object') {
			console.warn('[DevPilot] Received malformed message:', message);
			return;
		}

		const msg = message as WebviewToExtensionMessage;

		switch (msg.type) {
			case 'devpilot.ready': {
				console.log('[DevPilot] Webview is ready.');
				const response: ReadyResponse = {
					type: 'devpilot.ready',
					payload: {
						status: 'connected',
						message: 'DevPilot extension is connected.'
					}
				};
				this.postMessage(response);
				return response;
			}

			case 'devpilot.message': {
				const text = msg.payload?.text?.trim();
				if (!text) {
					console.warn('[DevPilot] Ignored empty or missing message payload.');
					return;
				}

				console.log(`Received message: ${text}`);

				const response: AssistantResponse = {
					type: 'devpilot.response',
					payload: {
						text: 'DevPilot received your request.'
					}
				};
				this.postMessage(response);
				return response;
			}

			case 'devpilot.close': {
				// Hide / collapse the secondary sidebar view
				vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
				return;
			}

			default: {
				if ((message as { command?: string }).command === 'close') {
					vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
					return;
				}
				console.warn('[DevPilot] Received unknown message type:', message);
				return;
			}
		}
	}

	private _getHtmlForWebview(webview: vscode.Webview): string {
		const stylesUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this._extensionUri, 'media', 'css', 'devpilot.css')
		);
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this._extensionUri, 'media', 'js', 'devpilot.js')
		);

		// Use a nonce to only allow specific scripts to run
		const nonce = getNonce();

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} https: data:;">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link rel="stylesheet" href="${stylesUri}">
	<title>DevPilot</title>
</head>
<body>
	<div class="devpilot-container">
		<!-- HEADER -->
		<header class="devpilot-header">
			<div class="header-brand">
				<div class="brand-icon">
					<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
						<defs>
							<linearGradient id="headerLogoGrad" x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">
								<stop stop-color="#3B82F6"/>
								<stop offset="1" stop-color="#8B5CF6"/>
							</linearGradient>
						</defs>
						<path d="M5.5 3.5C4.67157 3.02197 3.6 3.61984 3.6 4.57723V19.4228C3.6 20.3802 4.67157 20.978 5.5 20.5L19.5 13.0772C20.3333 12.5992 20.3333 11.4008 19.5 10.9228L5.5 3.5Z" fill="url(#headerLogoGrad)"/>
					</svg>
				</div>
				<span class="brand-name">DevPilot</span>
				<span class="brand-badge">PRO</span>
			</div>
			<div class="header-actions">
				<button class="action-btn" id="action-new-chat" title="New Chat">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
						<line x1="12" y1="5" x2="12" y2="19"></line>
						<line x1="5" y1="12" x2="19" y2="12"></line>
					</svg>
				</button>
				<button class="action-btn" id="action-history" title="History">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
						<circle cx="12" cy="12" r="9"></circle>
						<polyline points="12 7 12 12 15 15"></polyline>
					</svg>
				</button>
				<button class="action-btn" id="action-more" title="More Options">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
						<circle cx="12" cy="12" r="1"></circle>
						<circle cx="19" cy="12" r="1"></circle>
						<circle cx="5" cy="12" r="1"></circle>
					</svg>
				</button>
				<button class="action-btn" id="action-close" title="Close">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
						<line x1="18" y1="6" x2="6" y2="18"></line>
						<line x1="6" y1="6" x2="18" y2="18"></line>
					</svg>
				</button>
			</div>
		</header>

		<!-- BODY / EMPTY STATE -->
		<main class="devpilot-body">
			<section class="welcome-section">
				<div class="welcome-logo-wrapper">
					<div class="welcome-glow"></div>
					<svg class="welcome-logo" viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg">
						<defs>
							<linearGradient id="mainLogoGrad" x1="10" y1="8" x2="70" y2="72" gradientUnits="userSpaceOnUse">
								<stop stop-color="#3B82F6"/>
								<stop offset="0.5" stop-color="#6366F1"/>
								<stop offset="1" stop-color="#9333EA"/>
							</linearGradient>
							<linearGradient id="mainLogoShine" x1="20" y1="12" x2="55" y2="45" gradientUnits="userSpaceOnUse">
								<stop stop-color="#93C5FD" stop-opacity="0.8"/>
								<stop offset="1" stop-color="#C084FC" stop-opacity="0"/>
							</linearGradient>
							<filter id="logoShadow" x="0" y="0" width="80" height="80" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
								<feDropShadow dx="0" dy="8" stdDeviation="10" flood-color="#4F46E5" flood-opacity="0.5"/>
							</filter>
						</defs>
						<path d="M22 14.5C18.6667 12.5755 14.5 14.9812 14.5 18.8267V61.1733C14.5 65.0188 18.6667 67.4245 22 65.5L58.6726 44.3267C62.0059 42.4022 62.0059 37.5978 58.6726 35.6733L22 14.5Z" fill="url(#mainLogoGrad)" filter="url(#logoShadow)"/>
						<path d="M22 14.5C18.6667 12.5755 14.5 14.9812 14.5 18.8267V61.1733C14.5 65.0188 18.6667 67.4245 22 65.5L58.6726 44.3267C62.0059 42.4022 62.0059 37.5978 58.6726 35.6733L22 14.5Z" stroke="url(#mainLogoShine)" stroke-width="1.5"/>
					</svg>
				</div>
				<h1 class="welcome-title">Hi there! <span class="wave-emoji">👋</span></h1>
				<h2 class="welcome-subtitle">I'm DevPilot, your AI development agent.</h2>
				<p class="welcome-description">I can help you analyze, build, test, and review code in this project.</p>
			</section>

			<!-- Placeholder conversation container -->
			<div class="devpilot-messages" id="messages-container"></div>
		</main>

		<!-- MESSAGE COMPOSER -->
		<footer class="composer-wrapper">
			<div class="composer-card">
				<textarea 
					id="composer-input"
					class="composer-input"
					rows="1"
					placeholder="Ask anything about your code..."></textarea>
				<div class="composer-toolbar">
					<div class="composer-actions-left">
						<button class="composer-tool-btn" id="composer-attach" title="Attach Context">
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
								<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path>
							</svg>
						</button>
					</div>
					<button class="composer-send-btn" id="composer-send" title="Send Message">
						<svg viewBox="0 0 24 24" fill="currentColor">
							<path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
						</svg>
					</button>
				</div>
			</div>
		</footer>
	</div>

	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}
}

function getNonce(): string {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}
