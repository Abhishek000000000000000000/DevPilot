// DevPilot Webview Client Script
(function (global) {
	function initDevPilot(options) {
		const vscode = options?.vscode || (typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : undefined);
		const doc = options?.document || (typeof document !== 'undefined' ? document : undefined);
		const win = options?.window || (typeof window !== 'undefined' ? window : undefined);
		if (!doc || !vscode) {
			return null;
		}

		// Injectable clock for real elapsed-time measurement and deterministic testing
		const clock = options?.clock || {
			now: () => Date.now(),
			setInterval: (fn, ms) => {
				if (typeof win?.setInterval === 'function') {
					return win.setInterval(fn, ms);
				}
				if (typeof globalThis !== 'undefined' && typeof globalThis.setInterval === 'function') {
					return globalThis.setInterval(fn, ms);
				}
				if (typeof setInterval === 'function') {
					return setInterval(fn, ms);
				}
				return null;
			},
			clearInterval: (id) => {
				if (typeof win?.clearInterval === 'function') {
					return win.clearInterval(id);
				}
				if (typeof globalThis !== 'undefined' && typeof globalThis.clearInterval === 'function') {
					return globalThis.clearInterval(id);
				}
				if (typeof clearInterval === 'function') {
					return clearInterval(id);
				}
			}
		};

		// Helper to format elapsed milliseconds into mm:ss
		function formatDuration(ms) {
			const totalSeconds = Math.max(0, Math.floor(ms / 1000));
			const minutes = Math.floor(totalSeconds / 60);
			const seconds = totalSeconds % 60;
			const pad = (n) => (n < 10 ? '0' + n : String(n));
			return `${pad(minutes)}:${pad(seconds)}`;
		}

		// Inline markdown formatting tokenizer (bold, italic, inline code)
		// Strictly uses doc.createElement and doc.createTextNode (zero innerHTML)
		function appendInlineMarkdown(parent, inlineText, d) {
			if (!inlineText) return;

			// Matches inline code (`code`), bold-italic (***text***), bold (**text**), italic (*text* or _text_)
			const tokenRegex = /(`[^`]+`|\*\*\*[^*]+\*\*\*|\*\*[^*]+\*\*|\*[^*]+\*|_[^_]+_)/g;
			let lastIndex = 0;
			let match;

			while ((match = tokenRegex.exec(inlineText)) !== null) {
				if (match.index > lastIndex) {
					parent.appendChild(d.createTextNode(inlineText.slice(lastIndex, match.index)));
				}

				const token = match[0];
				if (token.startsWith('`') && token.endsWith('`')) {
					const code = d.createElement('code');
					code.appendChild(d.createTextNode(token.slice(1, -1)));
					parent.appendChild(code);
				} else if (token.startsWith('***') && token.endsWith('***')) {
					const strong = d.createElement('strong');
					const em = d.createElement('em');
					em.appendChild(d.createTextNode(token.slice(3, -3)));
					strong.appendChild(em);
					parent.appendChild(strong);
				} else if (token.startsWith('**') && token.endsWith('**')) {
					const strong = d.createElement('strong');
					strong.appendChild(d.createTextNode(token.slice(2, -2)));
					parent.appendChild(strong);
				} else if (token.startsWith('*') && token.endsWith('*')) {
					const em = d.createElement('em');
					em.appendChild(d.createTextNode(token.slice(1, -1)));
					parent.appendChild(em);
				} else if (token.startsWith('_') && token.endsWith('_')) {
					const em = d.createElement('em');
					em.appendChild(d.createTextNode(token.slice(1, -1)));
					parent.appendChild(em);
				}

				lastIndex = tokenRegex.lastIndex;
			}

			if (lastIndex < inlineText.length) {
				parent.appendChild(d.createTextNode(inlineText.slice(lastIndex)));
			}
		}

		// Safe DOM-based Markdown renderer (code blocks, headers, lists, inline formatting)
		// Never uses innerHTML. Safely attaches cursor element at the very end of active stream.
		function renderMarkdownInto(container, text, d, cursorElement) {
			// Clear existing children cleanly in both real DOM and MockNode
			while (container.firstChild) {
				if (typeof container.firstChild.remove === 'function') {
					container.firstChild.remove();
				} else if (typeof container.removeChild === 'function') {
					container.removeChild(container.firstChild);
				} else {
					break;
				}
			}
			if (container.childNodes) {
				while (container.childNodes.length > 0) {
					const c = container.childNodes[0];
					if (typeof c.remove === 'function') {
						c.remove();
					} else if (typeof container.removeChild === 'function') {
						container.removeChild(c);
					} else {
						container.childNodes.shift();
					}
				}
			}

			if (!text) {
				if (cursorElement) {
					container.appendChild(cursorElement);
				}
				return;
			}

			const lines = text.split('\n');
			let inCodeBlock = false;
			let codeBlockLang = '';
			let codeBlockLines = [];
			let currentList = null;

			function flushList() {
				if (currentList) {
					container.appendChild(currentList.el);
					currentList = null;
				}
			}

			function flushCodeBlock() {
				const pre = d.createElement('pre');
				const code = d.createElement('code');
				if (codeBlockLang) {
					code.className = 'language-' + codeBlockLang;
				}
				code.appendChild(d.createTextNode(codeBlockLines.join('\n')));
				pre.appendChild(code);
				container.appendChild(pre);
				codeBlockLines = [];
				codeBlockLang = '';
			}

			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];

				// Code block delimiter ```
				if (line.trim().startsWith('```')) {
					if (inCodeBlock) {
						inCodeBlock = false;
						flushCodeBlock();
					} else {
						flushList();
						inCodeBlock = true;
						codeBlockLang = line.trim().slice(3).trim();
						codeBlockLines = [];
					}
					continue;
				}

				if (inCodeBlock) {
					codeBlockLines.push(line);
					continue;
				}

				// Empty line -> paragraph break
				if (line.trim() === '') {
					flushList();
					if (i > 0 && i < lines.length - 1) {
						container.appendChild(d.createTextNode('\n\n'));
					}
					continue;
				}

				// Headers: #, ##, ###
				const headerMatch = line.match(/^(#{1,6})\s+(.*)$/);
				if (headerMatch) {
					flushList();
					const level = Math.min(headerMatch[1].length, 3);
					const h = d.createElement('h' + (level + 2));
					appendInlineMarkdown(h, headerMatch[2], d);
					container.appendChild(h);
					continue;
				}

				// Unordered list item: - or *
				const ulMatch = line.match(/^[\*\-]\s+(.*)$/);
				if (ulMatch) {
					if (!currentList || currentList.type !== 'ul') {
						flushList();
						currentList = { type: 'ul', el: d.createElement('ul') };
					}
					const li = d.createElement('li');
					appendInlineMarkdown(li, ulMatch[1], d);
					currentList.el.appendChild(li);
					continue;
				}

				// Ordered list item: 1.
				const olMatch = line.match(/^(\d+)\.\s+(.*)$/);
				if (olMatch) {
					if (!currentList || currentList.type !== 'ol') {
						flushList();
						currentList = { type: 'ol', el: d.createElement('ol') };
					}
					const li = d.createElement('li');
					appendInlineMarkdown(li, olMatch[2], d);
					currentList.el.appendChild(li);
					continue;
				}

				// Regular line
				flushList();
				if (i > 0 && !lines[i - 1].trim().startsWith('```') && !lines[i - 1].match(/^(#{1,6})\s+/) && !lines[i - 1].match(/^[\*\-]\s+/) && !lines[i - 1].match(/^(\d+)\.\s+/) && lines[i - 1].trim() !== '') {
					container.appendChild(d.createTextNode('\n'));
				}
				appendInlineMarkdown(container, line, d);
			}

			if (inCodeBlock) {
				flushCodeBlock();
			}
			flushList();

			// Place streaming cursor at the very end of the rendered content
			if (cursorElement) {
				container.appendChild(cursorElement);
			}
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

		// Helper to transition activity state and update compact footer
		function setActivityState(req, stateText, stateClass, freezeDurationMs, metrics) {
			if (!req || !req.activityFooterElement) return;
			const elapsedMs = freezeDurationMs !== undefined ? freezeDurationMs : (clock.now() - req.startTime);
			req.lastElapsedMs = elapsedMs;
			req.currentStateText = stateText;
			if (metrics !== undefined) {
				req.metrics = metrics;
			}
			const currentMetrics = req.metrics;

			const parts = [`${stateText} · ${formatDuration(elapsedMs)}`];

			if (currentMetrics && typeof currentMetrics === 'object') {
				if (typeof currentMetrics.evalCount === 'number' && Number.isFinite(currentMetrics.evalCount) && currentMetrics.evalCount >= 0) {
					const tokenLabel = currentMetrics.evalCount === 1 ? 'token' : 'tokens';
					parts.push(`${currentMetrics.evalCount} ${tokenLabel}`);
				}
				if (typeof currentMetrics.tokensPerSecond === 'number' && Number.isFinite(currentMetrics.tokensPerSecond) && currentMetrics.tokensPerSecond >= 0) {
					const tpsFormatted = currentMetrics.tokensPerSecond % 1 === 0
						? currentMetrics.tokensPerSecond.toString()
						: currentMetrics.tokensPerSecond.toFixed(1);
					parts.push(`${tpsFormatted} tokens/sec`);
				}
			}

			req.activityFooterElement.className = 'message-meta activity-footer' + (stateClass ? ' ' + stateClass : '');
			req.activityFooterElement.textContent = parts.join(' · ');

			renderMetricsDetails(req, currentMetrics);
		}

		function renderMetricsDetails(req, metrics) {
			if (!metrics || typeof metrics !== 'object' || !req.bubbleElement) return;

			// Check if there are breakdown statistics beyond the summary
			const hasDetails =
				metrics.evalDurationMs !== undefined ||
				metrics.promptEvalCount !== undefined ||
				metrics.promptEvalDurationMs !== undefined ||
				metrics.totalDurationMs !== undefined ||
				metrics.loadDurationMs !== undefined;

			if (!hasDetails) return;

			// Avoid duplicate details element
			if (req.detailsElement && req.detailsElement.parentNode) {
				req.detailsElement.remove();
				req.detailsElement = null;
			}

			const details = doc.createElement('details');
			details.className = 'metrics-details';

			const summary = doc.createElement('summary');
			summary.className = 'metrics-summary';
			summary.textContent = 'Inference stats';
			details.appendChild(summary);

			const breakdown = doc.createElement('div');
			breakdown.className = 'metrics-breakdown';

			if (metrics.promptEvalCount !== undefined || metrics.promptEvalDurationMs !== undefined) {
				const row = doc.createElement('div');
				row.className = 'metrics-row';
				const label = doc.createElement('span');
				label.className = 'metrics-label';
				label.textContent = 'Prompt:';
				const val = doc.createElement('span');
				val.className = 'metrics-value';
				const countStr = metrics.promptEvalCount !== undefined
					? `${metrics.promptEvalCount} ${metrics.promptEvalCount === 1 ? 'token' : 'tokens'}`
					: '';
				const durStr = metrics.promptEvalDurationMs !== undefined ? `${metrics.promptEvalDurationMs} ms` : '';
				val.textContent = countStr && durStr ? `${countStr} (${durStr})` : (countStr || durStr);
				row.appendChild(label);
				row.appendChild(val);
				breakdown.appendChild(row);
			}

			if (metrics.evalDurationMs !== undefined) {
				const row = doc.createElement('div');
				row.className = 'metrics-row';
				const label = doc.createElement('span');
				label.className = 'metrics-label';
				label.textContent = 'Model inference:';
				const val = doc.createElement('span');
				val.className = 'metrics-value';
				val.textContent = `${metrics.evalDurationMs} ms`;
				row.appendChild(label);
				row.appendChild(val);
				breakdown.appendChild(row);
			}

			if (metrics.loadDurationMs !== undefined) {
				const row = doc.createElement('div');
				row.className = 'metrics-row';
				const label = doc.createElement('span');
				label.className = 'metrics-label';
				label.textContent = 'Model load:';
				const val = doc.createElement('span');
				val.className = 'metrics-value';
				val.textContent = `${metrics.loadDurationMs} ms`;
				row.appendChild(label);
				row.appendChild(val);
				breakdown.appendChild(row);
			}

			if (metrics.totalDurationMs !== undefined) {
				const row = doc.createElement('div');
				row.className = 'metrics-row';
				const label = doc.createElement('span');
				label.className = 'metrics-label';
				label.textContent = 'Server total:';
				const val = doc.createElement('span');
				val.className = 'metrics-value';
				val.textContent = `${metrics.totalDurationMs} ms`;
				row.appendChild(label);
				row.appendChild(val);
				breakdown.appendChild(row);
			}

			details.appendChild(breakdown);
			req.detailsElement = details;
			req.bubbleElement.appendChild(details);
		}

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

			// 2. Mark finalized locally and stop active timer
			req.isFinalized = true;
			if (req.timerHandle) {
				clock.clearInterval(req.timerHandle);
				req.timerHandle = null;
			}
			const finalElapsed = clock.now() - req.startTime;

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

			// 4. Update activity state to stopped with frozen duration
			setActivityState(req, '⏹ Generation stopped', 'cancelled-notice', finalElapsed);
			req.hasCancelledNotice = true;

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

					// Transition from "Preparing request…" to "Generating response…"
					if (req.isPreparing) {
						req.isPreparing = false;
						setActivityState(req, 'Generating response…', 'generating');
					}

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
						req.cursorElement = cursor;
					}

					req.accumulatedText += text;
					req.domChunkCount = (req.domChunkCount || 0) + 1;
					const chunkElapsed = clock.now() - req.startTime;
					console.log('[DevPilot Webview] [t=' + chunkElapsed + 'ms] [' + requestId + '] Chunk #' + req.domChunkCount + ' (' + text.length + ' chars) rendered to DOM');

					// Render formatted markdown safely into textElement with cursor positioned at the very end
					renderMarkdownInto(req.textElement, req.accumulatedText, doc, req.cursorElement);

					// Keep inline stop button and activity footer in correct order below text:
					if (req.stopButtonElement && req.stopButtonElement.parentNode === req.bubbleElement) {
						req.bubbleElement.appendChild(req.stopButtonElement);
					}
					if (req.activityFooterElement && req.activityFooterElement.parentNode === req.bubbleElement) {
						req.bubbleElement.appendChild(req.activityFooterElement);
					}

					updateStopButtonVisibility();

					if (wasNearBottom) {
						scrollToBottom();
					}
					break;
				}

				case 'devpilot.chat.complete': {
					const { requestId, fullText, finishReason, metrics } = message.payload || {};
					if (!requestId) return;

					const req = activeRequests.get(requestId);
					if (!req || req.isFinalized) {
						// Duplicate completion or unknown requestId safely ignored
						return;
					}

					const wasNearBottom = isNearBottom();
					req.isFinalized = true;

					// Stop active timer and freeze final duration
					if (req.timerHandle) {
						clock.clearInterval(req.timerHandle);
						req.timerHandle = null;
					}
					const finalElapsed = clock.now() - req.startTime;
					console.log('[DevPilot Webview] [t=' + finalElapsed + 'ms] [' + requestId + '] chat.complete received (finishReason=' + finishReason + ')');

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
						setActivityState(req, '⏹ Generation stopped', 'cancelled-notice', finalElapsed);
						req.hasCancelledNotice = true;
						renderMarkdownInto(req.textElement, req.accumulatedText, doc, null);
					} else {
						// Reconcile displayed text with authoritative fullText
						const authoritativeText = typeof fullText === 'string' ? fullText : req.accumulatedText;
						const finalText = authoritativeText.trim().length > 0
							? authoritativeText
							: '(No output generated by model)';

						req.accumulatedText = finalText;
						renderMarkdownInto(req.textElement, finalText, doc, null);

						// Transition to "Completed" with optional metrics
						setActivityState(req, 'Completed', 'completed', finalElapsed, metrics);

						// Subtly inform user if generation ended due to length limit
						if (finishReason === 'length') {
							const metaDiv = doc.createElement('div');
							metaDiv.className = 'message-meta length-limit-notice';
							metaDiv.textContent = '⚠️ Truncated: model reached length limit.';
							req.bubbleElement.appendChild(metaDiv);
						}
					}

					// Ensure activity footer and details stay at the very bottom
					if (req.activityFooterElement && req.activityFooterElement.parentNode === req.bubbleElement) {
						req.bubbleElement.appendChild(req.activityFooterElement);
					}
					if (req.detailsElement && req.detailsElement.parentNode === req.bubbleElement) {
						req.bubbleElement.appendChild(req.detailsElement);
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

					// Stop active timer and freeze final duration
					if (req.timerHandle) {
						clock.clearInterval(req.timerHandle);
						req.timerHandle = null;
					}
					const finalElapsed = clock.now() - req.startTime;

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

					// Transition to "Generation failed"
					setActivityState(req, 'Generation failed', 'failed', finalElapsed);

					if (req.accumulatedText.trim().length > 0) {
						// Preserve already streamed content; append error notice below it
						const noticeDiv = doc.createElement('div');
						noticeDiv.className = 'message-meta error-notice';
						noticeDiv.textContent = displayError;
						req.bubbleElement.appendChild(noticeDiv);
					} else {
						req.textElement.textContent = displayError;
					}

					// Ensure activity footer stays at the very bottom
					if (req.activityFooterElement && req.activityFooterElement.parentNode === req.bubbleElement) {
						req.bubbleElement.appendChild(req.activityFooterElement);
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
			console.log('[DevPilot Webview] [t=0ms] [' + requestId + '] chat.send dispatched');
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
						if (record.timerHandle) {
							clock.clearInterval(record.timerHandle);
							record.timerHandle = null;
						}
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

			// Activity footer (compact status & real elapsed-time indicator)
			const footerDiv = doc.createElement('div');
			footerDiv.className = 'message-meta activity-footer preparing';

			bubble.appendChild(textSpan);
			bubble.appendChild(indicator);
			bubble.appendChild(inlineStopBtn);
			bubble.appendChild(footerDiv);
			msgDiv.appendChild(bubble);

			messagesContainer.appendChild(msgDiv);
			scrollToBottom();

			const startTime = clock.now();
			const record = {
				requestId: requestId,
				itemElement: msgDiv,
				bubbleElement: bubble,
				textElement: textSpan,
				indicatorElement: indicator,
				cursorElement: null,
				stopButtonElement: inlineStopBtn,
				activityFooterElement: footerDiv,
				detailsElement: null,
				metrics: null,
				hasCancelledNotice: false,
				accumulatedText: '',
				isFinalized: false,
				isPreparing: true,
				startTime: startTime,
				lastElapsedMs: 0,
				currentStateText: 'Preparing request…',
				timerHandle: null
			};

			setActivityState(record, 'Preparing request…', 'preparing', 0);

			// Start active duration timer ticking approximately once per second
			record.timerHandle = clock.setInterval(function () {
				if (record.isFinalized) {
					if (record.timerHandle) {
						clock.clearInterval(record.timerHandle);
						record.timerHandle = null;
					}
					return;
				}
				setActivityState(record, record.currentStateText);
			}, 1000);

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
			renderMarkdownInto(textSpan, text, doc, null);

			bubble.appendChild(textSpan);
			msgDiv.appendChild(bubble);
			messagesContainer.appendChild(msgDiv);
			scrollToBottom();
		}

		function resetToWelcomeState() {
			for (const record of activeRequests.values()) {
				if (record.timerHandle) {
					clock.clearInterval(record.timerHandle);
					record.timerHandle = null;
				}
				if (record.detailsElement && record.detailsElement.parentNode) {
					record.detailsElement.remove();
					record.detailsElement = null;
				}
			}
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

		function dispose() {
			for (const record of activeRequests.values()) {
				if (record.timerHandle) {
					clock.clearInterval(record.timerHandle);
					record.timerHandle = null;
				}
				if (record.detailsElement && record.detailsElement.parentNode) {
					record.detailsElement.remove();
					record.detailsElement = null;
				}
			}
			activeRequests.clear();
			if (win && typeof win.removeEventListener === 'function') {
				win.removeEventListener('message', onMessage);
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
			dispose,
			formatDuration,
			setActivityState,
			renderMarkdownInto,
			appendInlineMarkdown,
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

