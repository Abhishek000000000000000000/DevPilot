// DevPilot Webview Client Script
(function () {
	// Acquire the VS Code API
	const vscode = acquireVsCodeApi();

	// Elements
	const composerInput = document.getElementById('composer-input');
	const sendButton = document.getElementById('composer-send');
	const newChatBtn = document.getElementById('action-new-chat');
	const closeBtn = document.getElementById('action-close');
	const welcomeSection = document.querySelector('.welcome-section');
	const messagesContainer = document.getElementById('messages-container');
	const bodyContainer = document.querySelector('.devpilot-body');

	// Notify extension that Webview is ready
	vscode.postMessage({ type: 'devpilot.ready' });

	// Auto-expand textarea as user types
	if (composerInput) {
		composerInput.addEventListener('input', function () {
			this.style.height = 'auto';
			this.style.height = Math.min(this.scrollHeight, 160) + 'px';
		});

		// Enter to trigger send (Shift+Enter for newline)
		composerInput.addEventListener('keydown', function (e) {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				handleSend();
			}
		});
	}

	if (sendButton) {
		sendButton.addEventListener('click', handleSend);
	}

	if (newChatBtn) {
		newChatBtn.addEventListener('click', function () {
			resetToWelcomeState();
		});
	}

	if (closeBtn) {
		closeBtn.addEventListener('click', function () {
			vscode.postMessage({ type: 'devpilot.close' });
		});
	}

	// Handle messages sent from the extension to the webview
	window.addEventListener('message', function (event) {
		const message = event.data;
		if (!message || typeof message !== 'object') return;

		switch (message.type) {
			case 'devpilot.ready':
				console.log('DevPilot connection ready:', message.payload?.message || 'connected');
				break;

			case 'devpilot.response':
				if (message.payload && message.payload.text) {
					appendAssistantMessage(message.payload.text);
				}
				break;
		}
	});

	function handleSend() {
		if (!composerInput) return;
		const text = composerInput.value.trim();
		if (!text) return;

		// Switch from welcome state to conversation view
		if (welcomeSection) {
			welcomeSection.style.display = 'none';
		}
		if (messagesContainer) {
			messagesContainer.style.display = 'flex';
		}

		// Append user message to UI
		appendUserMessage(text);

		// Post message to extension host
		vscode.postMessage({
			type: 'devpilot.message',
			payload: { text: text }
		});

		// Clear input
		composerInput.value = '';
		composerInput.style.height = 'auto';
		composerInput.focus();
	}

	function appendUserMessage(text) {
		if (!messagesContainer) return;

		const msgDiv = document.createElement('div');
		msgDiv.className = 'message-item user';

		const bubble = document.createElement('div');
		bubble.className = 'message-bubble';
		bubble.textContent = text;

		msgDiv.appendChild(bubble);
		messagesContainer.appendChild(msgDiv);
		scrollToBottom();
	}

	function appendAssistantMessage(text) {
		if (!messagesContainer) return;

		const msgDiv = document.createElement('div');
		msgDiv.className = 'message-item assistant';

		const bubble = document.createElement('div');
		bubble.className = 'message-bubble';
		bubble.textContent = text;

		msgDiv.appendChild(bubble);
		messagesContainer.appendChild(msgDiv);
		scrollToBottom();
	}

	function resetToWelcomeState() {
		if (messagesContainer) {
			messagesContainer.innerHTML = '';
			messagesContainer.style.display = 'none';
		}
		if (welcomeSection) {
			welcomeSection.style.display = 'flex';
		}
		if (composerInput) {
			composerInput.value = '';
			composerInput.style.height = 'auto';
			composerInput.focus();
		}
	}

	function scrollToBottom() {
		if (bodyContainer) {
			bodyContainer.scrollTop = bodyContainer.scrollHeight;
		}
	}
})();
