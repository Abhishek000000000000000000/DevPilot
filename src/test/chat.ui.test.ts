import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

/**
 * Lightweight mock of DOM nodes for offline Webview client testing.
 */
class MockNode {
	public parentNode: MockNode | null = null;
	public childNodes: MockNode[] = [];

	public appendChild<T extends MockNode>(child: T): T {
		if (child.parentNode) {
			child.remove();
		}
		child.parentNode = this;
		this.childNodes.push(child);
		return child;
	}

	public remove(): void {
		if (this.parentNode) {
			const idx = this.parentNode.childNodes.indexOf(this);
			if (idx !== -1) {
				this.parentNode.childNodes.splice(idx, 1);
			}
			this.parentNode = null;
		}
	}

	public get textContent(): string {
		return this.childNodes.map(c => c.textContent).join('');
	}

	public set textContent(val: string) {
		this.childNodes = [];
		if (val) {
			const textNode = new MockTextNode(val);
			textNode.parentNode = this;
			this.childNodes.push(textNode);
		}
	}
}

class MockTextNode extends MockNode {
	constructor(public text: string) {
		super();
	}

	public override get textContent(): string {
		return this.text;
	}

	public override set textContent(val: string) {
		this.text = val;
	}
}

class MockElement extends MockNode {
	public className = '';
	public style: Record<string, string> = { height: 'auto', display: 'block' };
	public attributes = new Map<string, string>();
	public value = '';
	public scrollTop = 0;
	public scrollHeight = 100;
	public clientHeight = 100;

	private eventListeners: Record<string, ((...args: any[]) => void)[]> = {};

	constructor(public tagName: string) {
		super();
	}

	public title = '';

	public get classList() {
		return {
			add: (c: string) => {
				const classes = new Set(this.className.split(' ').filter(Boolean));
				classes.add(c);
				this.className = Array.from(classes).join(' ');
			},
			remove: (c: string) => {
				const classes = new Set(this.className.split(' ').filter(Boolean));
				classes.delete(c);
				this.className = Array.from(classes).join(' ');
			},
			contains: (c: string) => {
				return this.className.split(' ').includes(c);
			}
		};
	}

	public setAttribute(name: string, value: string): void {
		this.attributes.set(name, value);
	}

	public getAttribute(name: string): string | null {
		return this.attributes.get(name) ?? null;
	}

	public removeAttribute(name: string): void {
		this.attributes.delete(name);
	}

	public hasAttribute(name: string): boolean {
		return this.attributes.has(name);
	}

	public querySelector(selector: string): MockElement | null {
		for (const child of this.childNodes) {
			if (child instanceof MockElement) {
				if (selector.startsWith('.') && child.classList.contains(selector.slice(1))) {
					return child;
				}
				if (selector.startsWith('#') && child.attributes.get('id') === selector.slice(1)) {
					return child;
				}
				const found = child.querySelector(selector);
				if (found) {
					return found;
				}
			}
		}
		return null;
	}

	public addEventListener(event: string, handler: (...args: any[]) => void): void {
		if (!this.eventListeners[event]) {
			this.eventListeners[event] = [];
		}
		this.eventListeners[event].push(handler);
	}

	public trigger(event: string, eventData: any = {}): void {
		for (const handler of this.eventListeners[event] || []) {
			handler(eventData);
		}
	}

	public focus(): void {}
}

class MockDocument {
	private elementsById = new Map<string, MockElement>();
	private elementsByQuery = new Map<string, MockElement>();

	public registerElement(idOrSelector: string, el: MockElement): void {
		if (idOrSelector.startsWith('#')) {
			this.elementsById.set(idOrSelector.slice(1), el);
		} else if (idOrSelector.startsWith('.')) {
			this.elementsByQuery.set(idOrSelector, el);
		} else {
			this.elementsById.set(idOrSelector, el);
		}
	}

	public getElementById(id: string): MockElement | null {
		return this.elementsById.get(id) ?? null;
	}

	public querySelector(selector: string): MockElement | null {
		return this.elementsByQuery.get(selector) ?? null;
	}

	public createElement(tagName: string): MockElement {
		return new MockElement(tagName);
	}

	public createTextNode(text: string): MockTextNode {
		return new MockTextNode(text);
	}
}

suite('DevPilot Chat UI Integration Test Suite (Phase 2.5)', () => {
	const devpilotJsPath = path.resolve(__dirname, '../../media/js/devpilot.js');
	const devpilotJsCode = fs.readFileSync(devpilotJsPath, 'utf-8');

	function setupEnvironment() {
		const doc = new MockDocument();
		const composerInput = new MockElement('textarea');
		const sendButton = new MockElement('button');
		const composerStop = new MockElement('button');
		const newChatBtn = new MockElement('button');
		const closeBtn = new MockElement('button');
		const welcomeSection = new MockElement('section');
		const messagesContainer = new MockElement('div');
		const bodyContainer = new MockElement('main');

		doc.registerElement('#composer-input', composerInput);
		doc.registerElement('#composer-send', sendButton);
		doc.registerElement('#composer-stop', composerStop);
		doc.registerElement('#action-new-chat', newChatBtn);
		doc.registerElement('#action-close', closeBtn);
		doc.registerElement('.welcome-section', welcomeSection);
		doc.registerElement('#messages-container', messagesContainer);
		doc.registerElement('.devpilot-body', bodyContainer);

		const postedMessages: any[] = [];
		const vscode = {
			postMessage: (msg: any) => postedMessages.push(msg)
		};

		let messageListener: ((event: any) => void) | undefined;
		const win = {
			addEventListener: (event: string, handler: (e: any) => void) => {
				if (event === 'message') {
					messageListener = handler;
				}
			}
		};

		const sandbox: Record<string, any> = {
			acquireVsCodeApi: undefined,
			document: doc,
			window: win,
			console: console,
			module: { exports: {} },
			globalThis: {}
		};
		vm.createContext(sandbox);
		vm.runInContext(devpilotJsCode, sandbox);

		const controller = sandbox.module.exports.initDevPilot({
			vscode,
			document: doc,
			window: win
		});

		return {
			doc,
			composerInput,
			sendButton,
			composerStop,
			newChatBtn,
			closeBtn,
			welcomeSection,
			messagesContainer,
			bodyContainer,
			postedMessages,
			controller,
			dispatchMessage: (data: any) => messageListener?.({ data })
		};
	}

	test('1. Submitting a prompt sends exactly one devpilot.chat.send message', () => {
		const env = setupEnvironment();
		env.composerInput.value = 'Explain quicksort algorithm';
		env.sendButton.trigger('click');

		const sendMsgs = env.postedMessages.filter(m => m.type === 'devpilot.chat.send');
		assert.strictEqual(sendMsgs.length, 1, 'Should send exactly one chat.send message');
		assert.strictEqual(sendMsgs[0].payload.text, 'Explain quicksort algorithm');
	});

	test('2. A unique request ID is included with each submission', () => {
		const env = setupEnvironment();
		env.composerInput.value = 'First request';
		env.sendButton.trigger('click');

		env.composerInput.value = 'Second request';
		env.sendButton.trigger('click');

		const sendMsgs = env.postedMessages.filter(m => m.type === 'devpilot.chat.send');
		assert.strictEqual(sendMsgs.length, 2);

		const id1 = sendMsgs[0].payload.requestId;
		const id2 = sendMsgs[1].payload.requestId;

		assert.ok(id1.startsWith('req-'), 'RequestId should start with prefix req-');
		assert.ok(id2.startsWith('req-'), 'RequestId should start with prefix req-');
		assert.notStrictEqual(id1, id2, 'Requests must have distinct correlation IDs');
	});

	test('3. The first chunk updates the correct assistant bubble and removes thinking indicator', () => {
		const env = setupEnvironment();
		env.composerInput.value = 'Hello DevPilot';
		env.sendButton.trigger('click');

		const sendMsg = env.postedMessages.find(m => m.type === 'devpilot.chat.send');
		const reqId = sendMsg.payload.requestId;

		const assistantDiv = env.messagesContainer.childNodes.find(
			(n: any) => n.attributes?.get('data-request-id') === reqId
		) as MockElement;
		assert.ok(assistantDiv, 'Assistant message container should exist');

		// Before chunk: should contain "Thinking..."
		assert.ok(assistantDiv.textContent.includes('Thinking...'), 'Bubble should show initial thinking state');

		// Send first chunk
		env.dispatchMessage({
			type: 'devpilot.chat.chunk',
			payload: { requestId: reqId, text: 'Hello! ' }
		});

		// After chunk: thinking label removed, text contains first chunk
		assert.ok(!assistantDiv.textContent.includes('Thinking...'), 'Thinking label should be removed');
		assert.ok(assistantDiv.textContent.includes('Hello! '), 'Bubble should display chunk text');
	});

	test('4. Multiple chunks append in order to the same bubble', () => {
		const env = setupEnvironment();
		env.composerInput.value = 'Write a function';
		env.sendButton.trigger('click');

		const sendMsg = env.postedMessages.find(m => m.type === 'devpilot.chat.send');
		const reqId = sendMsg.payload.requestId;

		env.dispatchMessage({
			type: 'devpilot.chat.chunk',
			payload: { requestId: reqId, text: 'def ' }
		});
		env.dispatchMessage({
			type: 'devpilot.chat.chunk',
			payload: { requestId: reqId, text: 'solve():\n' }
		});
		env.dispatchMessage({
			type: 'devpilot.chat.chunk',
			payload: { requestId: reqId, text: '    return 42' }
		});

		// Assistant bubbles in messagesContainer
		const assistantBubbles = env.messagesContainer.childNodes.filter(
			(n: any) => n.className?.includes('assistant')
		);
		assert.strictEqual(assistantBubbles.length, 1, 'Should NOT create a new bubble for each chunk');

		const bubbleText = assistantBubbles[0].textContent;
		assert.strictEqual(bubbleText, 'def solve():\n    return 42');
	});

	test('5. Chunks from two concurrent requests update separate bubbles without mixing', () => {
		const env = setupEnvironment();

		// Request A
		env.composerInput.value = 'Prompt A';
		env.sendButton.trigger('click');
		const reqA = env.postedMessages.filter(m => m.type === 'devpilot.chat.send')[0].payload.requestId;

		// Request B
		env.composerInput.value = 'Prompt B';
		env.sendButton.trigger('click');
		const reqB = env.postedMessages.filter(m => m.type === 'devpilot.chat.send')[1].payload.requestId;

		// Interleaved chunks
		env.dispatchMessage({
			type: 'devpilot.chat.chunk',
			payload: { requestId: reqA, text: 'Alpha 1; ' }
		});
		env.dispatchMessage({
			type: 'devpilot.chat.chunk',
			payload: { requestId: reqB, text: 'Beta 1; ' }
		});
		env.dispatchMessage({
			type: 'devpilot.chat.chunk',
			payload: { requestId: reqA, text: 'Alpha 2' }
		});
		env.dispatchMessage({
			type: 'devpilot.chat.chunk',
			payload: { requestId: reqB, text: 'Beta 2' }
		});

		const bubbleA = env.messagesContainer.childNodes.find(
			(n: any) => n.attributes?.get('data-request-id') === reqA
		) as MockElement;
		const bubbleB = env.messagesContainer.childNodes.find(
			(n: any) => n.attributes?.get('data-request-id') === reqB
		) as MockElement;

		assert.strictEqual(bubbleA.textContent, 'Alpha 1; Alpha 2');
		assert.strictEqual(bubbleB.textContent, 'Beta 1; Beta 2');
	});

	test('6. Completion finalizes the correct bubble without duplicating full text', () => {
		const env = setupEnvironment();
		env.composerInput.value = 'Test full text';
		env.sendButton.trigger('click');

		const reqId = env.postedMessages.find(m => m.type === 'devpilot.chat.send').payload.requestId;

		env.dispatchMessage({
			type: 'devpilot.chat.chunk',
			payload: { requestId: reqId, text: 'Chunk 1 ' }
		});
		env.dispatchMessage({
			type: 'devpilot.chat.chunk',
			payload: { requestId: reqId, text: 'Chunk 2' }
		});

		// Complete event with authoritative fullText
		env.dispatchMessage({
			type: 'devpilot.chat.complete',
			payload: {
				requestId: reqId,
				fullText: 'Chunk 1 Chunk 2',
				finishReason: 'stop'
			}
		});

		const assistantBubble = env.messagesContainer.childNodes.find(
			(n: any) => n.attributes?.get('data-request-id') === reqId
		) as MockElement;

		// Must NOT duplicate: e.g. "Chunk 1 Chunk 2Chunk 1 Chunk 2"
		assert.strictEqual(assistantBubble.textContent, 'Chunk 1 Chunk 2');
	});

	test('7. The final displayed text reconciles correctly with fullText and handles empty output', () => {
		const env = setupEnvironment();
		env.composerInput.value = 'Empty output test';
		env.sendButton.trigger('click');

		const reqId = env.postedMessages.find(m => m.type === 'devpilot.chat.send').payload.requestId;

		env.dispatchMessage({
			type: 'devpilot.chat.complete',
			payload: {
				requestId: reqId,
				fullText: '   ',
				finishReason: 'stop'
			}
		});

		const assistantBubble = env.messagesContainer.childNodes.find(
			(n: any) => n.attributes?.get('data-request-id') === reqId
		) as MockElement;

		assert.strictEqual(assistantBubble.textContent, '(No output generated by model)');
	});

	test('8. The loading indicator disappears on completion', () => {
		const env = setupEnvironment();
		env.composerInput.value = 'Indicator test';
		env.sendButton.trigger('click');

		const reqId = env.postedMessages.find(m => m.type === 'devpilot.chat.send').payload.requestId;
		const req = env.controller.activeRequests.get(reqId);

		assert.ok(req.indicatorElement, 'Indicator should exist initially');

		env.dispatchMessage({
			type: 'devpilot.chat.complete',
			payload: { requestId: reqId, fullText: 'Completed', finishReason: 'stop' }
		});

		assert.strictEqual(req.indicatorElement, null, 'Loading indicator must be removed on complete');
		assert.strictEqual(req.cursorElement, null, 'Streaming cursor must be removed on complete');
	});

	test('9. Error events display safe messages and suggestions', () => {
		const env = setupEnvironment();
		env.composerInput.value = 'Failing prompt';
		env.sendButton.trigger('click');

		const reqId = env.postedMessages.find(m => m.type === 'devpilot.chat.send').payload.requestId;

		env.dispatchMessage({
			type: 'devpilot.chat.error',
			payload: {
				requestId: reqId,
				code: 'CONNECTION_REFUSED',
				message: 'Cannot reach Ollama',
				suggestion: 'Ensure Ollama is running on port 11434.'
			}
		});

		const assistantBubble = env.messagesContainer.childNodes.find(
			(n: any) => n.attributes?.get('data-request-id') === reqId
		) as MockElement;

		assert.ok(assistantBubble.textContent.includes('⚠️ Error [CONNECTION_REFUSED]: Cannot reach Ollama'));
		assert.ok(assistantBubble.textContent.includes('💡 Suggestion: Ensure Ollama is running'));

		const bubbleEl = (assistantBubble.childNodes[0] as MockElement);
		assert.ok(bubbleEl.classList.contains('error'), 'Bubble must have error class');
	});

	test('10. The loading indicator disappears on error', () => {
		const env = setupEnvironment();
		env.composerInput.value = 'Indicator on error test';
		env.sendButton.trigger('click');

		const reqId = env.postedMessages.find(m => m.type === 'devpilot.chat.send').payload.requestId;
		const req = env.controller.activeRequests.get(reqId);

		assert.ok(req.indicatorElement, 'Indicator should exist initially');

		env.dispatchMessage({
			type: 'devpilot.chat.error',
			payload: {
				requestId: reqId,
				code: 'PROVIDER_ERROR',
				message: 'Internal error'
			}
		});

		assert.strictEqual(req.indicatorElement, null, 'Loading indicator must be removed on error');
		assert.strictEqual(req.cursorElement, null, 'Cursor must be removed on error');
	});

	test('11. Late or unknown request events are handled safely', () => {
		const env = setupEnvironment();

		// Unknown requestId should not crash
		assert.doesNotThrow(() => {
			env.dispatchMessage({
				type: 'devpilot.chat.chunk',
				payload: { requestId: 'req-unknown-404', text: 'Ghost chunk' }
			});
			env.dispatchMessage({
				type: 'devpilot.chat.complete',
				payload: { requestId: 'req-unknown-404', fullText: 'Ghost done', finishReason: 'stop' }
			});
		});

		// Finalized request ignores late chunks
		env.composerInput.value = 'Finalize test';
		env.sendButton.trigger('click');
		const reqId = env.postedMessages.find(m => m.type === 'devpilot.chat.send').payload.requestId;

		env.dispatchMessage({
			type: 'devpilot.chat.complete',
			payload: { requestId: reqId, fullText: 'Done', finishReason: 'stop' }
		});

		// Late chunk arriving after completion
		env.dispatchMessage({
			type: 'devpilot.chat.chunk',
			payload: { requestId: reqId, text: ' Late addition' }
		});

		const assistantBubble = env.messagesContainer.childNodes.find(
			(n: any) => n.attributes?.get('data-request-id') === reqId
		) as MockElement;
		assert.strictEqual(assistantBubble.textContent, 'Done', 'Late chunk must not be appended after finalization');
	});

	test('12. Duplicate terminal events do not duplicate content or corrupt state', () => {
		const env = setupEnvironment();
		env.composerInput.value = 'Duplicate terminal test';
		env.sendButton.trigger('click');
		const reqId = env.postedMessages.find(m => m.type === 'devpilot.chat.send').payload.requestId;

		env.dispatchMessage({
			type: 'devpilot.chat.complete',
			payload: { requestId: reqId, fullText: 'Final text', finishReason: 'stop' }
		});
		// Duplicate complete event
		env.dispatchMessage({
			type: 'devpilot.chat.complete',
			payload: { requestId: reqId, fullText: 'Duplicate text', finishReason: 'stop' }
		});

		const assistantBubble = env.messagesContainer.childNodes.find(
			(n: any) => n.attributes?.get('data-request-id') === reqId
		) as MockElement;
		assert.strictEqual(assistantBubble.textContent, 'Final text');
	});

	test('13. Streamed text is inserted safely via TextNode without HTML execution', () => {
		const env = setupEnvironment();
		env.composerInput.value = 'Security test';
		env.sendButton.trigger('click');
		const reqId = env.postedMessages.find(m => m.type === 'devpilot.chat.send').payload.requestId;

		const maliciousScript = '<script>alert("hacked")</script><img src=x onerror=alert(1)>';
		env.dispatchMessage({
			type: 'devpilot.chat.chunk',
			payload: { requestId: reqId, text: maliciousScript }
		});

		const req = env.controller.activeRequests.get(reqId);
		const lastNode = req.textElement.childNodes[0];

		// Proves text is stored in MockTextNode, meaning doc.createTextNode was used
		assert.ok(lastNode instanceof MockTextNode, 'Must use doc.createTextNode for raw text safety');
		assert.strictEqual(lastNode.textContent, maliciousScript);
	});

	test('14. Legacy response handling still works seamlessly for Phase 1 compatibility', () => {
		const env = setupEnvironment();

		env.dispatchMessage({
			type: 'devpilot.response',
			payload: { text: 'Legacy Phase 1 response message' }
		});

		const assistantBubbles = env.messagesContainer.childNodes.filter(
			(n: any) => n.className?.includes('assistant')
		);
		assert.strictEqual(assistantBubbles.length, 1);
		assert.strictEqual(assistantBubbles[0].textContent, 'Legacy Phase 1 response message');
	});

	test('15. Length limit finishReason displays a clear, subtle truncation notice', () => {
		const env = setupEnvironment();
		env.composerInput.value = 'Length truncation test';
		env.sendButton.trigger('click');
		const reqId = env.postedMessages.find(m => m.type === 'devpilot.chat.send').payload.requestId;

		env.dispatchMessage({
			type: 'devpilot.chat.chunk',
			payload: { requestId: reqId, text: 'Partial code snippet...' }
		});
		env.dispatchMessage({
			type: 'devpilot.chat.complete',
			payload: {
				requestId: reqId,
				fullText: 'Partial code snippet...',
				finishReason: 'length'
			}
		});

		const assistantBubble = env.messagesContainer.childNodes.find(
			(n: any) => n.attributes?.get('data-request-id') === reqId
		) as MockElement;

		assert.ok(assistantBubble.textContent.includes('⚠️ Truncated: model reached length limit.'));
	});

	test('16. Stop control is visible when generation is active and hidden when request terminates', () => {
		const env = setupEnvironment();

		// Initially hidden/disabled
		assert.strictEqual(env.composerStop.style.display, 'none');
		assert.strictEqual(env.composerStop.getAttribute('disabled'), 'true');

		// Send request
		env.composerInput.value = 'Long generation prompt';
		env.sendButton.trigger('click');

		// Now visible and enabled
		assert.strictEqual(env.composerStop.style.display, 'flex');
		assert.strictEqual(env.composerStop.hasAttribute('disabled'), false);

		// Terminate request
		const reqId = env.postedMessages.find(m => m.type === 'devpilot.chat.send').payload.requestId;
		env.dispatchMessage({
			type: 'devpilot.chat.complete',
			payload: { requestId: reqId, fullText: 'Done', finishReason: 'stop' }
		});

		// Hidden/disabled after completion
		assert.strictEqual(env.composerStop.style.display, 'none');
		assert.strictEqual(env.composerStop.getAttribute('disabled'), 'true');
	});

	test('17. Activating composer Stop control sends devpilot.chat.cancel with correct requestId', () => {
		const env = setupEnvironment();
		env.composerInput.value = 'Cancel via stop button';
		env.sendButton.trigger('click');

		const sendMsg = env.postedMessages.find(m => m.type === 'devpilot.chat.send');
		assert.ok(sendMsg);
		const reqId = sendMsg.payload.requestId;

		// Click Stop control in composer
		env.composerStop.trigger('click');

		const cancelMsg = env.postedMessages.find(m => m.type === 'devpilot.chat.cancel');
		assert.ok(cancelMsg, 'Clicking Stop must emit devpilot.chat.cancel');
		assert.strictEqual(cancelMsg.payload.requestId, reqId);
	});

	test('18. Cancellation event preserves partial text, cleans up cursor/indicator, and displays generation stopped status', () => {
		const env = setupEnvironment();
		env.composerInput.value = 'Cancel stream test';
		env.sendButton.trigger('click');

		const reqId = env.postedMessages.find(m => m.type === 'devpilot.chat.send').payload.requestId;

		env.dispatchMessage({
			type: 'devpilot.chat.chunk',
			payload: { requestId: reqId, text: 'Partial code written before ' }
		});
		env.dispatchMessage({
			type: 'devpilot.chat.chunk',
			payload: { requestId: reqId, text: 'interruption.' }
		});

		// Dispatch cancellation complete event
		env.dispatchMessage({
			type: 'devpilot.chat.complete',
			payload: {
				requestId: reqId,
				fullText: 'Partial code written before interruption.',
				finishReason: 'cancelled'
			}
		});

		const req = env.controller.activeRequests.get(reqId);
		assert.strictEqual(req.indicatorElement, null, 'Indicator must be removed on cancel');
		assert.strictEqual(req.cursorElement, null, 'Cursor must be removed on cancel');
		assert.strictEqual(req.stopButtonElement, null, 'Inline stop button must be removed on cancel');

		const assistantBubble = env.messagesContainer.childNodes.find(
			(n: any) => n.attributes?.get('data-request-id') === reqId
		) as MockElement;

		assert.ok(assistantBubble.textContent.includes('Partial code written before interruption.'));
		assert.ok(assistantBubble.textContent.includes('⏹ Generation stopped'));
		assert.strictEqual(env.composerStop.style.display, 'none', 'Stop button must be hidden when all finished');
	});

	test('19. Late chunks and late completions after cancellation cannot overwrite or corrupt cancelled state', () => {
		const env = setupEnvironment();
		env.composerInput.value = 'Late events test';
		env.sendButton.trigger('click');

		const reqId = env.postedMessages.find(m => m.type === 'devpilot.chat.send').payload.requestId;

		env.dispatchMessage({
			type: 'devpilot.chat.chunk',
			payload: { requestId: reqId, text: 'Initial text' }
		});

		// Cancellation occurs
		env.dispatchMessage({
			type: 'devpilot.chat.complete',
			payload: {
				requestId: reqId,
				fullText: 'Initial text',
				finishReason: 'cancelled'
			}
		});

		const assistantBubble = env.messagesContainer.childNodes.find(
			(n: any) => n.attributes?.get('data-request-id') === reqId
		) as MockElement;

		const textAfterCancel = assistantBubble.textContent;
		assert.ok(textAfterCancel.includes('Initial text'));
		assert.ok(textAfterCancel.includes('⏹ Generation stopped'));

		// Late chunk arrives
		env.dispatchMessage({
			type: 'devpilot.chat.chunk',
			payload: { requestId: reqId, text: ' --- LATE CHUNK ---' }
		});

		// Late completion arrives
		env.dispatchMessage({
			type: 'devpilot.chat.complete',
			payload: {
				requestId: reqId,
				fullText: 'Completely overwritten text',
				finishReason: 'stop'
			}
		});

		// Verify state was NOT overwritten
		assert.strictEqual(assistantBubble.textContent, textAfterCancel, 'Late events must not mutate cancelled state');
	});

	test('20. Inline Stop button cancels only its specific request in concurrent generation', () => {
		const env = setupEnvironment();

		// Request A
		env.composerInput.value = 'Prompt A';
		env.sendButton.trigger('click');
		const reqA = env.postedMessages.filter(m => m.type === 'devpilot.chat.send')[0].payload.requestId;

		// Request B
		env.composerInput.value = 'Prompt B';
		env.sendButton.trigger('click');
		const reqB = env.postedMessages.filter(m => m.type === 'devpilot.chat.send')[1].payload.requestId;

		// Both are active
		const recordA = env.controller.activeRequests.get(reqA);
		const recordB = env.controller.activeRequests.get(reqB);
		assert.ok(recordA.stopButtonElement, 'Bubble A should have inline stop button');
		assert.ok(recordB.stopButtonElement, 'Bubble B should have inline stop button');

		// Click Stop button for Request A only
		recordA.stopButtonElement.trigger('click');

		const cancelMessages = env.postedMessages.filter(m => m.type === 'devpilot.chat.cancel');
		assert.strictEqual(cancelMessages.length, 1);
		assert.strictEqual(cancelMessages[0].payload.requestId, reqA, 'Must cancel only Request A');

		// Simulate cancel completion for Request A
		env.dispatchMessage({
			type: 'devpilot.chat.complete',
			payload: { requestId: reqA, fullText: '', finishReason: 'cancelled' }
		});

		// Stop button in composer should still be visible because Request B is still active
		assert.strictEqual(env.composerStop.style.display, 'flex');

		// Simulate completion for Request B
		env.dispatchMessage({
			type: 'devpilot.chat.complete',
			payload: { requestId: reqB, fullText: 'B finished', finishReason: 'stop' }
		});

		// Now both are done, stop control is hidden
		assert.strictEqual(env.composerStop.style.display, 'none');
	});

	test('21. Partial text remains visible when generation encounters an error mid-stream', () => {
		const env = setupEnvironment();
		env.composerInput.value = 'Generate function';
		env.sendButton.trigger('click');

		const reqId = env.postedMessages.find(m => m.type === 'devpilot.chat.send').payload.requestId;

		env.dispatchMessage({
			type: 'devpilot.chat.chunk',
			payload: { requestId: reqId, text: 'function calculateSum(a, b) {\n    return a + b;' }
		});

		// Mid-stream error
		env.dispatchMessage({
			type: 'devpilot.chat.error',
			payload: {
				requestId: reqId,
				code: 'CONNECTION_REFUSED',
				message: 'Connection lost mid-generation.',
				suggestion: 'Restart Ollama service.'
			}
		});

		const req = env.controller.activeRequests.get(reqId);
		assert.strictEqual(req.indicatorElement, null, 'Indicator must be removed on error');
		assert.strictEqual(req.cursorElement, null, 'Cursor must be removed on error');
		assert.strictEqual(req.stopButtonElement, null, 'Inline stop must be removed on error');

		const assistantBubble = env.messagesContainer.childNodes.find(
			(n: any) => n.attributes?.get('data-request-id') === reqId
		) as MockElement;

		// Verified partial text preserved
		assert.ok(assistantBubble.textContent.includes('function calculateSum(a, b)'));
		// Verified error notice appended
		assert.ok(assistantBubble.textContent.includes('⚠️ Error [CONNECTION_REFUSED]: Connection lost mid-generation.'));
		assert.ok(assistantBubble.textContent.includes('💡 Suggestion: Restart Ollama service.'));
	});

	test('22. Composer remains usable and accepts new submissions after a request failure', () => {
		const env = setupEnvironment();

		// 1. First prompt fails
		env.composerInput.value = 'First prompt';
		env.sendButton.trigger('click');
		const req1 = env.postedMessages.find(m => m.type === 'devpilot.chat.send').payload.requestId;

		env.dispatchMessage({
			type: 'devpilot.chat.error',
			payload: {
				requestId: req1,
				code: 'MODEL_NOT_FOUND',
				message: 'Model not installed.'
			}
		});

		assert.strictEqual(env.composerStop.style.display, 'none');

		// 2. Second prompt submitted
		env.composerInput.value = 'Second prompt';
		env.sendButton.trigger('click');

		const sendMessages = env.postedMessages.filter(m => m.type === 'devpilot.chat.send');
		assert.strictEqual(sendMessages.length, 2);
		const req2 = sendMessages[1].payload.requestId;
		assert.notStrictEqual(req1, req2);

		assert.strictEqual(env.composerStop.style.display, 'flex');

		// Complete second prompt
		env.dispatchMessage({
			type: 'devpilot.chat.complete',
			payload: {
				requestId: req2,
				fullText: 'Success on retry',
				finishReason: 'stop'
			}
		});

		assert.strictEqual(env.composerStop.style.display, 'none');

		const assistantBubble2 = env.messagesContainer.childNodes.find(
			(n: any) => n.attributes?.get('data-request-id') === req2
		) as MockElement;

		assert.strictEqual(assistantBubble2.textContent, 'Success on retry');
	});

	test('23. Stop control returns to hidden/disabled after a request fails', () => {
		const env = setupEnvironment();
		env.composerInput.value = 'Prompt leading to error';
		env.sendButton.trigger('click');

		assert.strictEqual(env.composerStop.style.display, 'flex');

		const reqId = env.postedMessages.find(m => m.type === 'devpilot.chat.send').payload.requestId;
		env.dispatchMessage({
			type: 'devpilot.chat.error',
			payload: {
				requestId: reqId,
				code: 'TIMEOUT',
				message: 'Timed out waiting for response.'
			}
		});

		assert.strictEqual(env.composerStop.style.display, 'none');
		assert.strictEqual(env.composerStop.getAttribute('disabled'), 'true');
	});

	test('24. Error message and suggestion strings are rendered safely via text nodes without HTML execution', () => {
		const env = setupEnvironment();
		env.composerInput.value = 'Test XSS payload';
		env.sendButton.trigger('click');

		const reqId = env.postedMessages.find(m => m.type === 'devpilot.chat.send').payload.requestId;

		const xssMessage = '<img src="x" onerror="evil()" /><b>Bold Error</b>';
		const xssSuggestion = '<script>alert("hacked")</script>';

		env.dispatchMessage({
			type: 'devpilot.chat.error',
			payload: {
				requestId: reqId,
				code: 'PROVIDER_ERROR',
				message: xssMessage,
				suggestion: xssSuggestion
			}
		});

		const assistantBubble = env.messagesContainer.childNodes.find(
			(n: any) => n.attributes?.get('data-request-id') === reqId
		) as MockElement;

		// Text contains literal characters, not parsed DOM elements
		assert.ok(assistantBubble.textContent.includes('<img src="x" onerror="evil()" />'));
		assert.ok(assistantBubble.textContent.includes('<script>alert("hacked")</script>'));

		// Bubble has no <img> or <script> element children
		const imgTag = assistantBubble.querySelector('img');
		const scriptTag = assistantBubble.querySelector('script');
		assert.strictEqual(imgTag, null);
		assert.strictEqual(scriptTag, null);
	});

	test('25. Late error event after successful completion does not overwrite or corrupt finalized response', () => {
		const env = setupEnvironment();
		env.composerInput.value = 'Completed prompt';
		env.sendButton.trigger('click');

		const reqId = env.postedMessages.find(m => m.type === 'devpilot.chat.send').payload.requestId;

		env.dispatchMessage({
			type: 'devpilot.chat.complete',
			payload: {
				requestId: reqId,
				fullText: 'Authoritative completed response',
				finishReason: 'stop'
			}
		});

		const assistantBubble = env.messagesContainer.childNodes.find(
			(n: any) => n.attributes?.get('data-request-id') === reqId
		) as MockElement;

		assert.strictEqual(assistantBubble.textContent, 'Authoritative completed response');

		// Late error arriving after completion
		env.dispatchMessage({
			type: 'devpilot.chat.error',
			payload: {
				requestId: reqId,
				code: 'PROVIDER_ERROR',
				message: 'Late network drop'
			}
		});

		// Must remain unchanged
		assert.strictEqual(assistantBubble.textContent, 'Authoritative completed response');
		const bubbleDiv = (assistantBubble.childNodes[0] as MockElement);
		assert.strictEqual(bubbleDiv.classList.contains('error'), false);
	});
});
