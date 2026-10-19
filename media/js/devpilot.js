// DevPilot Webview Client Script
(function (global) {
	function initDevPilot(options) {
		const vscode = options?.vscode || (typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : undefined);
		const doc = options?.document || (typeof document !== 'undefined' ? document : undefined);
		const win = options?.window || (typeof window !== 'undefined' ? window : undefined);
		if (!doc || !vscode) {
			return null;
		}

		// DOM Elements
		const composerInput = doc.getElementById('composer-input');
		const sendButton = doc.getElementById('composer-send');
		const stopButton = doc.getElementById('composer-stop');
		const newChatBtn = doc.getElementById('action-new-chat');
		const closeBtn = doc.getElementById('action-close');
		const welcomeSection = doc.querySelector('.welcome-section');
		const messagesContainer = doc.getElementById('messages-container');
		const bodyContainer = doc.querySelector('.devpilot-body');

		// In-memory request correlation map: requestId -> requestState
		const activeRequests = new Map();

		// Notify extension host that Webview is ready
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

		if (stopButton) {
			stopButton.addEventListener('click', function () {
				const activeList = getActiveGeneratingRequests();
				if (activeList.length > 0) {
					// Stop the most recent active request
					const target = activeList[activeList.length - 1];
					stopRequest(target.requestId);
				}
			});
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

		// Helper to retrieve currently generating requests
		function getActiveGeneratingRequests() {
			const list = [];
			for (const record of activeRequests.values()) {
				if (!record.isFinalized) {
					list.push(record);
				}
			}
			return list;
		}

		// Show/hide composer Stop button depending on active requests
		function updateStopButtonVisibility() {
			const activeList = getActiveGeneratingRequests();
			if (stopButton) {
				if (activeList.length > 0) {
					stopButton.style.display = 'flex';
					stopButton.removeAttribute('disabled');
				} else {
					stopButton.style.display = 'none';
					stopButton.setAttribute('disabled', 'true');
				}
			}
		}

		// Initial stop button state
		updateStopButtonVisibility();

		// Stop a specific request by ID
		function stopRequest(requestId) {
			const req = activeRequests.get(requestId);
			if (!req || req.isFinalized) {
				return;
			}

			// 1. Post devpilot.chat.cancel to extension host
			vscode.postMessage({
				type: 'devpilot.chat.cancel',
				payload: {
					requestId: requestId
				}
			});

			// 2. Mark finalized locally
			req.isFinalized = true;

			// 3. Clean up thinking indicators, cursors, and inline stop buttons
			if (req.indicatorElement && req.indicatorElement.parentNode) {
				req.indicatorElement.remove();
				req.indicatorElement = null;
			}
			if (req.cursorElement && req.cursorElement.parentNode) {
				req.cursorElement.remove();
				req.cursorElement = null;
			}
			if (req.stopButtonElement && req.stopButtonElement.parentNode) {
				req.stopButtonElement.remove();
				req.stopButtonElement = null;
			}

			// 4. Append subtle "Generation stopped" notice
			if (!req.hasCancelledNotice) {
				req.hasCancelledNotice = true;
				const noticeDiv = doc.createElement('div');
				noticeDiv.className = 'message-meta cancelled-notice';
				noticeDiv.textContent = '⏹ Generation stopped';
				req.bubbleElement.appendChild(noticeDiv);
			}

			updateStopButtonVisibility();
			scrollToBottomIfNeeded();
		}

		// Handle messages sent from the extension host
		function onMessage(event) {
			const message = event && event.data;
			if (!message || typeof message !== 'object') return;

			switch (message.type) {
				case 'devpilot.ready':
					console.log('DevPilot connection ready:', message.payload?.message || 'connected');
					break;

				case 'devpilot.response':
					if (message.payload && typeof message.payload.text === 'string') {
						appendAssistantMessage(message.payload.text);
					}
					break;

				case 'devpilot.chat.chunk': {
					const { requestId, text } = message.payload || {};
					if (!requestId || typeof text !== 'string' || text.length === 0) return;

					const req = activeRequests.get(requestId);
					if (!req || req.isFinalized) {
						// Late chunk or unknown request ID safely ignored
						return;
					}

					const wasNearBottom = isNearBottom();

					// Remove initial "Thinking..." label upon first arriving chunk
					if (req.indicatorElement && req.indicatorElement.parentNode) {
						req.indicatorElement.remove();
						req.indicatorElement = null;
					}

					// Attach streaming cursor if not already attached
					if (!req.cursorElement) {
						const cursor = doc.createElement('span');
						cursor.className = 'streaming-indicator';
						cursor.setAttribute('aria-hidden', 'true');
						req.bubbleElement.appendChild(cursor);
						req.cursorElement = cursor;
					}

					// Append text safely as a TextNode (never innerHTML)
					req.accumulatedText += text;
					const textNode = doc.createTextNode(text);
					req.textElement.appendChild(textNode);

					// Keep cursor and inline stop button positioned after the text
					if (req.cursorElement && req.cursorElement.parentNode === req.bubbleElement) {
						req.bubbleElement.appendChild(req.cursorElement);
					}
					if (req.stopButtonElement && req.stopButtonElement.parentNode === req.bubbleElement) {
						req.bubbleElement.appendChild(req.stopButtonElement);
					}

					updateStopButtonVisibility();

					if (wasNearBottom) {
						scrollToBottom();
					}
					break;
				}

				case 'devpilot.chat.complete': {
					const { requestId, fullText, finishReason } = message.payload || {};
					if (!requestId) return;

					const req = activeRequests.get(requestId);
					if (!req || req.isFinalized) {
						// Duplicate completion or unknown requestId safely ignored
						return;
					}

					const wasNearBottom = isNearBottom();
					req.isFinalized = true;

					// Remove generating indicator, cursor, and stop button
					if (req.indicatorElement && req.indicatorElement.parentNode) {
						req.indicatorElement.remove();
						req.indicatorElement = null;
					}
					if (req.cursorElement && req.cursorElement.parentNode) {
						req.cursorElement.remove();
						req.cursorElement = null;
					}
					if (req.stopButtonElement && req.stopButtonElement.parentNode) {
						req.stopButtonElement.remove();
						req.stopButtonElement = null;
					}

					if (finishReason === 'cancelled') {
						// Preserve accumulated partial text and append cancelled notice
						if (!req.hasCancelledNotice) {
							req.hasCancelledNotice = true;
							const noticeDiv = doc.createElement('div');
							noticeDiv.className = 'message-meta cancelled-notice';
							noticeDiv.textContent = '⏹ Generation stopped';
							req.bubbleElement.appendChild(noticeDiv);
						}
					} else {
						// Reconcile displayed text with authoritative fullText
						const authoritativeText = typeof fullText === 'string' ? fullText : req.accumulatedText;
						const finalText = authoritativeText.trim().length > 0
							? authoritativeText
							: '(No output generated by model)';

						if (req.accumulatedText !== finalText) {
							req.textElement.textContent = finalText;
							req.accumulatedText = finalText;
						}

						// Subtly inform user if generation ended due to length limit
						if (finishReason === 'length') {
							const metaDiv = doc.createElement('div');
							metaDiv.className = 'message-meta';
							metaDiv.textContent = '⚠️ Truncated: model reached length limit.';
							req.bubbleElement.appendChild(metaDiv);
						}
					}

					updateStopButtonVisibility();

					if (wasNearBottom) {
						scrollToBottom();
					}
					break;
				}

				case 'devpilot.chat.error': {
					const { requestId, code, message: errorMsg, suggestion } = message.payload || {};
					if (!requestId) return;

					const req = activeRequests.get(requestId);
					if (!req || req.isFinalized) {
						return;
					}

					const wasNearBottom = isNearBottom();
					req.isFinalized = true;

					// Remove generating indicators, cursor, and stop button
					if (req.indicatorElement && req.indicatorElement.parentNode) {
						req.indicatorElement.remove();
						req.indicatorElement = null;
					}
					if (req.cursorElement && req.cursorElement.parentNode) {
						req.cursorElement.remove();
						req.cursorElement = null;
					}
					if (req.stopButtonElement && req.stopButtonElement.parentNode) {
						req.stopButtonElement.remove();
						req.stopButtonElement = null;
					}

					req.bubbleElement.classList.add('error');

					const safeCode = typeof code === 'string' && code ? code : 'PROVIDER_ERROR';
					const safeMsg = typeof errorMsg === 'string' && errorMsg ? errorMsg : 'An error occurred during inference.';
					const safeSuggestion = typeof suggestion === 'string' && suggestion ? suggestion : '';

					const displayError = `⚠️ Error [${safeCode}]: ${safeMsg}${safeSuggestion ? '\n\n💡 Suggestion: ' + safeSuggestion : ''}`;

					if (req.accumulatedText.trim().length > 0) {
						// Preserve already streamed content; append error notice below it
						const noticeDiv = doc.createElement('div');
						noticeDiv.className = 'message-meta error-notice';
						noticeDiv.textContent = displayError;
						req.bubbleElement.appendChild(noticeDiv);
					} else {
						req.textElement.textContent = displayError;
					}

					updateStopButtonVisibility();

					if (wasNearBottom) {
						scrollToBottom();
					}
					break;
				}
			}
		}

		if (win) {
			win.addEventListener('message', onMessage);
		}

		function handleSend() {
			if (!composerInput) return;
			const text = composerInput.value.trim();
			if (!text) return;

			// Clear input immediately to prevent double submissions
			composerInput.value = '';
			composerInput.style.height = 'auto';

			// Switch from welcome state to conversation view
			if (welcomeSection) {
				welcomeSection.style.display = 'none';
			}
			if (messagesContainer) {
				messagesContainer.style.display = 'flex';
			}

			// 1. Generate unique requestId
			const requestId = generateRequestId();

			// 2. Append user bubble
			appendUserMessage(text);

			// 3. Create assistant bubble with initial loading state and inline stop button
			createAssistantBubble(requestId);

			// 4. Send devpilot.chat.send message to extension host
			vscode.postMessage({
				type: 'devpilot.chat.send',
				payload: {
					requestId: requestId,
					text: text
				}
			});

			// Prune old completed requests to maintain bounded memory
			if (activeRequests.size > 50) {
				for (const [id, record] of activeRequests.entries()) {
					if (record.isFinalized) {
						activeRequests.delete(id);
						if (activeRequests.size <= 30) break;
					}
				}
			}

			updateStopButtonVisibility();
			composerInput.focus();
		}

		function generateRequestId() {
			if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
				return 'req-' + crypto.randomUUID();
			}
			return 'req-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
		}

		function appendUserMessage(text) {
			if (!messagesContainer) return;

			const msgDiv = doc.createElement('div');
			msgDiv.className = 'message-item user';

			const bubble = doc.createElement('div');
			bubble.className = 'message-bubble';
			bubble.textContent = text;

			msgDiv.appendChild(bubble);
			messagesContainer.appendChild(msgDiv);
			scrollToBottom();
		}

		function createAssistantBubble(requestId) {
			if (!messagesContainer) return null;

			const msgDiv = doc.createElement('div');
			msgDiv.className = 'message-item assistant';
			msgDiv.setAttribute('data-request-id', requestId);

			const bubble = doc.createElement('div');
			bubble.className = 'message-bubble';

			const textSpan = doc.createElement('span');
			textSpan.className = 'message-text';

			const indicator = doc.createElement('span');
			indicator.className = 'generating-label';

			const dot = doc.createElement('span');
			dot.className = 'generating-dot';

			const labelText = doc.createTextNode(' Thinking...');
			indicator.appendChild(dot);
			indicator.appendChild(labelText);

			// Inline Stop button on generating assistant bubble
			const inlineStopBtn = doc.createElement('button');
			inlineStopBtn.className = 'bubble-stop-btn';
			inlineStopBtn.setAttribute('title', 'Stop Generation');
			inlineStopBtn.setAttribute('aria-label', 'Stop Generation');
			inlineStopBtn.addEventListener('click', function (e) {
				if (e && typeof e.stopPropagation === 'function') {
					e.stopPropagation();
				}
				stopRequest(requestId);
			});

			bubble.appendChild(textSpan);
			bubble.appendChild(indicator);
			bubble.appendChild(inlineStopBtn);
			msgDiv.appendChild(bubble);

			messagesContainer.appendChild(msgDiv);
			scrollToBottom();

			const record = {
				requestId: requestId,
				itemElement: msgDiv,
				bubbleElement: bubble,
				textElement: textSpan,
				indicatorElement: indicator,
				cursorElement: null,
				stopButtonElement: inlineStopBtn,
				hasCancelledNotice: false,
				accumulatedText: '',
				isFinalized: false
			};

			activeRequests.set(requestId, record);
			updateStopButtonVisibility();
			return record;
		}

		function appendAssistantMessage(text) {
			if (!messagesContainer) return;

			const msgDiv = doc.createElement('div');
			msgDiv.className = 'message-item assistant';

			const bubble = doc.createElement('div');
			bubble.className = 'message-bubble';

			const textSpan = doc.createElement('span');
			textSpan.className = 'message-text';
			textSpan.textContent = text;

			bubble.appendChild(textSpan);
			msgDiv.appendChild(bubble);
			messagesContainer.appendChild(msgDiv);
			scrollToBottom();
		}

		function resetToWelcomeState() {
			activeRequests.clear();
			updateStopButtonVisibility();
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

		function isNearBottom() {
			if (!bodyContainer) return true;
			const threshold = 60;
			return (bodyContainer.scrollHeight - bodyContainer.scrollTop - bodyContainer.clientHeight) <= threshold;
		}

		function scrollToBottom() {
			if (bodyContainer) {
				bodyContainer.scrollTop = bodyContainer.scrollHeight;
			}
		}

		function scrollToBottomIfNeeded() {
			if (isNearBottom()) {
				scrollToBottom();
			}
		}

		return {
			handleSend,
			stopRequest,
			appendUserMessage,
			appendAssistantMessage,
			createAssistantBubble,
			activeRequests,
			getActiveGeneratingRequests,
			updateStopButtonVisibility,
			resetToWelcomeState,
			onMessage,
			isNearBottom,
			scrollToBottom
		};
	}

	// Export for testing environments
	if (typeof module !== 'undefined' && module.exports) {
		module.exports = { initDevPilot };
	}
	if (typeof global !== 'undefined') {
		global.initDevPilot = initDevPilot;
	}

	// Auto-run in Webview
	if (typeof acquireVsCodeApi === 'function') {
		initDevPilot();
	}
})(typeof globalThis !== 'undefined' ? globalThis : window);
