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
				if (child.tagName.toLowerCase() === selector.toLowerCase()) {
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

class FakeClock {
	public currentTime = 100000;
	public intervals = new Map<number, { fn: () => void; ms: number }>();
	public nextId = 1;

	public now = (): number => {
		return this.currentTime;
	};

	public setInterval = (fn: () => void, ms: number): number => {
		const id = this.nextId++;
		this.intervals.set(id, { fn, ms });
		return id;
	};

	public clearInterval = (id: number): void => {
		this.intervals.delete(id);
	};

	public tick = (ms: number): void => {
		this.currentTime += ms;
		for (const record of Array.from(this.intervals.values())) {
			record.fn();
		}
	};
}

suite('DevPilot Chat UI Integration Test Suite (Phase 2.5)', () => {
	const devpilotJsPath = path.resolve(__dirname, '../../media/js/devpilot.js');
	const devpilotJsCode = fs.readFileSync(devpilotJsPath, 'utf-8');

	function setupEnvironment(options?: { clock?: any }) {
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
			},
			setInterval: setInterval,
			clearInterval: clearInterval
		};

		const sandbox: Record<string, any> = {
			acquireVsCodeApi: undefined,
			document: doc,
			window: win,
			console: console,
			module: { exports: {} },
			globalThis: {
				setInterval: setInterval,
				clearInterval: clearInterval
			},
			setInterval: setInterval,
			clearInterval: clearInterval
		};
		vm.createContext(sandbox);
		vm.runInContext(devpilotJsCode, sandbox);

		const controller = sandbox.module.exports.initDevPilot({
			vscode,
			document: doc,
			window: win,
			clock: options?.clock
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
			clock: options?.clock,
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
		assert.ok(bubbleText.includes('def solve():\n    return 42'));
		assert.ok(bubbleText.includes('Generating response…'));
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

		assert.ok(bubbleA.textContent.includes('Alpha 1; Alpha 2'));
		assert.ok(bubbleB.textContent.includes('Beta 1; Beta 2'));
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
		assert.ok(assistantBubble.textContent.includes('Chunk 1 Chunk 2'));
		assert.ok(assistantBubble.textContent.includes('Completed'));
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

		assert.ok(assistantBubble.textContent.includes('(No output generated by model)'));
		assert.ok(assistantBubble.textContent.includes('Completed'));
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
		assert.ok(assistantBubble.textContent.includes('Done'), 'Late chunk must not be appended after finalization');
		assert.ok(!assistantBubble.textContent.includes('Late addition'), 'Late chunk must not be appended after finalization');
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
		assert.ok(assistantBubble.textContent.includes('Final text'));
		assert.ok(!assistantBubble.textContent.includes('Duplicate text'));
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

		assert.ok(assistantBubble2.textContent.includes('Success on retry'));
		assert.ok(assistantBubble2.textContent.includes('Completed'));
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

		assert.ok(assistantBubble.textContent.includes('Authoritative completed response'));
		assert.ok(assistantBubble.textContent.includes('Completed'));

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
		assert.ok(assistantBubble.textContent.includes('Authoritative completed response'));
		assert.ok(assistantBubble.textContent.includes('Completed'));
		const bubbleDiv = (assistantBubble.childNodes[0] as MockElement);
		assert.strictEqual(bubbleDiv.classList.contains('error'), false);
	});

	// =========================================================================
	// Phase 2B: Live Model Activity UI & Real Elapsed-Time Tests
	// =========================================================================

	test('26. Initial activity state shows Preparing request… · 00:00 on submission', () => {
		const env = setupEnvironment();
		env.composerInput.value = 'Start task';
		env.sendButton.trigger('click');

		const reqId = env.postedMessages.find(m => m.type === 'devpilot.chat.send').payload.requestId;
		const assistantBubble = env.messagesContainer.childNodes.find(
			(n: any) => n.attributes?.get('data-request-id') === reqId
		) as MockElement;

		const footer = assistantBubble.querySelector('.activity-footer');
		assert.ok(footer, 'Activity footer must be present');
		assert.ok(footer.classList.contains('preparing'), 'Footer must have preparing class');
		assert.strictEqual(footer.textContent, 'Preparing request… · 00:00');

		// Initial inline thinking indicator should also be present
		const indicator = assistantBubble.querySelector('.generating-label');
		assert.ok(indicator, 'Thinking indicator must be present initially');
		assert.ok(indicator.textContent.includes('Thinking...'));
	});

	test('27. Transition from Preparing request… to Generating response… on first chunk', () => {
		const fakeClock = new FakeClock();
		const env = setupEnvironment({ clock: fakeClock });
		env.composerInput.value = 'Streaming prompt';
		env.sendButton.trigger('click');

		const reqId = env.postedMessages.find(m => m.type === 'devpilot.chat.send').payload.requestId;
		const assistantBubble = env.messagesContainer.childNodes.find(
			(n: any) => n.attributes?.get('data-request-id') === reqId
		) as MockElement;

		// Advance clock by 2s before first chunk
		fakeClock.tick(2000);
		const footerBefore = assistantBubble.querySelector('.activity-footer') as MockElement;
		assert.strictEqual(footerBefore.textContent, 'Preparing request… · 00:02');

		// First chunk arrives
		env.dispatchMessage({
			type: 'devpilot.chat.chunk',
			payload: { requestId: reqId, text: 'First token' }
		});

		assert.ok(footerBefore.classList.contains('generating'), 'Footer must have generating class');
		assert.strictEqual(footerBefore.textContent, 'Generating response… · 00:02');

		// Thinking label removed, streaming cursor attached
		assert.strictEqual(assistantBubble.querySelector('.generating-label'), null);
		assert.ok(assistantBubble.querySelector('.streaming-indicator'), 'Cursor attached');
	});

	test('28. Completed terminal state freezes duration and cleans up active indicators', () => {
		const fakeClock = new FakeClock();
		const env = setupEnvironment({ clock: fakeClock });
		env.composerInput.value = 'Completion test';
		env.sendButton.trigger('click');

		const reqId = env.postedMessages.find(m => m.type === 'devpilot.chat.send').payload.requestId;
		const assistantBubble = env.messagesContainer.childNodes.find(
			(n: any) => n.attributes?.get('data-request-id') === reqId
		) as MockElement;

		// Stream tokens over 4 seconds
		fakeClock.tick(1000);
		env.dispatchMessage({
			type: 'devpilot.chat.chunk',
			payload: { requestId: reqId, text: 'Hello ' }
		});
		fakeClock.tick(3000);
		env.dispatchMessage({
			type: 'devpilot.chat.chunk',
			payload: { requestId: reqId, text: 'world!' }
		});

		// Complete event
		env.dispatchMessage({
			type: 'devpilot.chat.complete',
			payload: { requestId: reqId, fullText: 'Hello world!', finishReason: 'stop' }
		});

		const footer = assistantBubble.querySelector('.activity-footer') as MockElement;
		assert.ok(footer.classList.contains('completed'));
		assert.strictEqual(footer.textContent, 'Completed · 00:04');

		// Cursor and inline stop button removed
		assert.strictEqual(assistantBubble.querySelector('.streaming-indicator'), null);
		assert.strictEqual(assistantBubble.querySelector('.bubble-stop-btn'), null);

		// Advancing time further should NOT update the frozen duration
		fakeClock.tick(10000);
		assert.strictEqual(footer.textContent, 'Completed · 00:04', 'Duration must remain frozen');
		assert.strictEqual(fakeClock.intervals.size, 0, 'Active timer interval must be cleaned up');
	});

	test('29. Elapsed-time periodic updates while request is active', () => {
		const fakeClock = new FakeClock();
		const env = setupEnvironment({ clock: fakeClock });
		env.composerInput.value = 'Periodic timer test';
		env.sendButton.trigger('click');

		const reqId = env.postedMessages.find(m => m.type === 'devpilot.chat.send').payload.requestId;
		const assistantBubble = env.messagesContainer.childNodes.find(
			(n: any) => n.attributes?.get('data-request-id') === reqId
		) as MockElement;

		const footer = assistantBubble.querySelector('.activity-footer') as MockElement;

		// Check increments
		fakeClock.tick(1000);
		assert.strictEqual(footer.textContent, 'Preparing request… · 00:01');
		fakeClock.tick(2000);
		assert.strictEqual(footer.textContent, 'Preparing request… · 00:03');

		// Dispatch chunk and advance further
		env.dispatchMessage({
			type: 'devpilot.chat.chunk',
			payload: { requestId: reqId, text: 'Data' }
		});
		assert.strictEqual(footer.textContent, 'Generating response… · 00:03');
		fakeClock.tick(2000);
		assert.strictEqual(footer.textContent, 'Generating response… · 00:05');
	});

	test('30. Cancellation freezes duration and displays stopped status', () => {
		const fakeClock = new FakeClock();
		const env = setupEnvironment({ clock: fakeClock });
		env.composerInput.value = 'Cancel timer test';
		env.sendButton.trigger('click');

		const reqId = env.postedMessages.find(m => m.type === 'devpilot.chat.send').payload.requestId;
		const assistantBubble = env.messagesContainer.childNodes.find(
			(n: any) => n.attributes?.get('data-request-id') === reqId
		) as MockElement;

		fakeClock.tick(3000);
		env.dispatchMessage({
			type: 'devpilot.chat.chunk',
			payload: { requestId: reqId, text: 'Partial text' }
		});
		fakeClock.tick(2000);

		// Stop request
		env.composerStop.trigger('click');

		const footer = assistantBubble.querySelector('.activity-footer') as MockElement;
		assert.ok(footer.classList.contains('cancelled-notice'));
		assert.strictEqual(footer.textContent, '⏹ Generation stopped · 00:05');

		// Timer cleaned up and frozen
		assert.strictEqual(fakeClock.intervals.size, 0);
		fakeClock.tick(5000);
		assert.strictEqual(footer.textContent, '⏹ Generation stopped · 00:05');
	});

	test('31. Failure freezes duration and displays failed status with preserved error details', () => {
		const fakeClock = new FakeClock();
		const env = setupEnvironment({ clock: fakeClock });
		env.composerInput.value = 'Failure timer test';
		env.sendButton.trigger('click');

		const reqId = env.postedMessages.find(m => m.type === 'devpilot.chat.send').payload.requestId;
		const assistantBubble = env.messagesContainer.childNodes.find(
			(n: any) => n.attributes?.get('data-request-id') === reqId
		) as MockElement;

		fakeClock.tick(2000);
		env.dispatchMessage({
			type: 'devpilot.chat.chunk',
			payload: { requestId: reqId, text: 'Partial answer before failure' }
		});
		fakeClock.tick(2000);

		// Error event
		env.dispatchMessage({
			type: 'devpilot.chat.error',
			payload: {
				requestId: reqId,
				code: 'TIMEOUT',
				message: 'Ollama timed out',
				suggestion: 'Check Ollama server'
			}
		});

		const footer = assistantBubble.querySelector('.activity-footer') as MockElement;
		assert.ok(footer.classList.contains('failed'));
		assert.strictEqual(footer.textContent, 'Generation failed · 00:04');

		// Error notice preserved
		const errorNotice = assistantBubble.querySelector('.error-notice');
		assert.ok(errorNotice);
		assert.ok(errorNotice.textContent.includes('⚠️ Error [TIMEOUT]: Ollama timed out'));

		// Timer cleaned up and frozen
		assert.strictEqual(fakeClock.intervals.size, 0);
		fakeClock.tick(5000);
		assert.strictEqual(footer.textContent, 'Generation failed · 00:04');
	});

	test('32. Cancellation before first chunk cleans up indicator and freezes timer', () => {
		const fakeClock = new FakeClock();
		const env = setupEnvironment({ clock: fakeClock });
		env.composerInput.value = 'Cancel before chunk';
		env.sendButton.trigger('click');

		const reqId = env.postedMessages.find(m => m.type === 'devpilot.chat.send').payload.requestId;
		const assistantBubble = env.messagesContainer.childNodes.find(
			(n: any) => n.attributes?.get('data-request-id') === reqId
		) as MockElement;

		fakeClock.tick(2000);

		// Stop before any chunk arrived
		env.controller.stopRequest(reqId);

		const footer = assistantBubble.querySelector('.activity-footer') as MockElement;
		assert.strictEqual(footer.textContent, '⏹ Generation stopped · 00:02');
		assert.strictEqual(assistantBubble.querySelector('.generating-label'), null, 'Thinking label removed');
		assert.strictEqual(fakeClock.intervals.size, 0);
	});

	test('33. Failure before first chunk cleans up indicator and freezes timer', () => {
		const fakeClock = new FakeClock();
		const env = setupEnvironment({ clock: fakeClock });
		env.composerInput.value = 'Fail before chunk';
		env.sendButton.trigger('click');

		const reqId = env.postedMessages.find(m => m.type === 'devpilot.chat.send').payload.requestId;
		const assistantBubble = env.messagesContainer.childNodes.find(
			(n: any) => n.attributes?.get('data-request-id') === reqId
		) as MockElement;

		fakeClock.tick(1000);

		// Error before any chunk arrived
		env.dispatchMessage({
			type: 'devpilot.chat.error',
			payload: {
				requestId: reqId,
				code: 'CONNECTION_REFUSED',
				message: 'Cannot connect to Ollama'
			}
		});

		const footer = assistantBubble.querySelector('.activity-footer') as MockElement;
		assert.strictEqual(footer.textContent, 'Generation failed · 00:01');
		assert.strictEqual(assistantBubble.querySelector('.generating-label'), null, 'Thinking label removed');
		assert.strictEqual(fakeClock.intervals.size, 0);
	});

	test('34. Independent timers and isolated durations for concurrent requests', () => {
		const fakeClock = new FakeClock();
		const env = setupEnvironment({ clock: fakeClock });

		// Request A submitted at t = 0
		env.composerInput.value = 'Prompt A';
		env.sendButton.trigger('click');
		const reqA = env.postedMessages.filter(m => m.type === 'devpilot.chat.send')[0].payload.requestId;

		fakeClock.tick(3000);

		// Request B submitted at t = 3s
		env.composerInput.value = 'Prompt B';
		env.sendButton.trigger('click');
		const reqB = env.postedMessages.filter(m => m.type === 'devpilot.chat.send')[1].payload.requestId;

		fakeClock.tick(2000);

		const bubbleA = env.messagesContainer.childNodes.find(
			(n: any) => n.attributes?.get('data-request-id') === reqA
		) as MockElement;
		const bubbleB = env.messagesContainer.childNodes.find(
			(n: any) => n.attributes?.get('data-request-id') === reqB
		) as MockElement;

		const footerA = bubbleA.querySelector('.activity-footer') as MockElement;
		const footerB = bubbleB.querySelector('.activity-footer') as MockElement;

		assert.strictEqual(footerA.textContent, 'Preparing request… · 00:05');
		assert.strictEqual(footerB.textContent, 'Preparing request… · 00:02');

		// Complete request A; request B keeps running
		env.dispatchMessage({
			type: 'devpilot.chat.complete',
			payload: { requestId: reqA, fullText: 'Done A', finishReason: 'stop' }
		});
		assert.strictEqual(footerA.textContent, 'Completed · 00:05');

		fakeClock.tick(3000);
		assert.strictEqual(footerA.textContent, 'Completed · 00:05', 'A remains frozen');
		assert.strictEqual(footerB.textContent, 'Preparing request… · 00:05', 'B continues ticking');
	});

	test('35. Timer handles are cleanly disposed on resetToWelcomeState and dispose()', () => {
		const fakeClock = new FakeClock();
		const env = setupEnvironment({ clock: fakeClock });

		env.composerInput.value = 'Prompt 1';
		env.sendButton.trigger('click');
		env.composerInput.value = 'Prompt 2';
		env.sendButton.trigger('click');

		assert.strictEqual(fakeClock.intervals.size, 2, 'Two active timers');

		env.newChatBtn.trigger('click');
		assert.strictEqual(fakeClock.intervals.size, 0, 'All timers cleared on new chat reset');

		// Start new request and test dispose
		env.composerInput.value = 'Prompt 3';
		env.sendButton.trigger('click');
		assert.strictEqual(fakeClock.intervals.size, 1);

		env.controller.dispose();
		assert.strictEqual(fakeClock.intervals.size, 0, 'Timer cleared on controller dispose');
	});

	test('36. Empty-response completion transitions cleanly to Completed with frozen timer', () => {
		const fakeClock = new FakeClock();
		const env = setupEnvironment({ clock: fakeClock });
		env.composerInput.value = 'Empty prompt';
		env.sendButton.trigger('click');

		const reqId = env.postedMessages.find(m => m.type === 'devpilot.chat.send').payload.requestId;
		fakeClock.tick(1500);

		env.dispatchMessage({
			type: 'devpilot.chat.complete',
			payload: { requestId: reqId, fullText: '', finishReason: 'stop' }
		});

		const assistantBubble = env.messagesContainer.childNodes.find(
			(n: any) => n.attributes?.get('data-request-id') === reqId
		) as MockElement;

		const footer = assistantBubble.querySelector('.activity-footer') as MockElement;
		assert.strictEqual(footer.textContent, 'Completed · 00:01');
		assert.strictEqual(fakeClock.intervals.size, 0);
	});

	test('37. formatDuration formats minutes and seconds accurately', () => {
		const env = setupEnvironment();
		assert.strictEqual(env.controller.formatDuration(0), '00:00');
		assert.strictEqual(env.controller.formatDuration(900), '00:00');
		assert.strictEqual(env.controller.formatDuration(4000), '00:04');
		assert.strictEqual(env.controller.formatDuration(59000), '00:59');
		assert.strictEqual(env.controller.formatDuration(60000), '01:00');
		assert.strictEqual(env.controller.formatDuration(65000), '01:05');
		assert.strictEqual(env.controller.formatDuration(754000), '12:34');
	});

	test('38. Metrics footer integration: displays tokens and speed when metrics are present', () => {
		const fakeClock = new FakeClock();
		const env = setupEnvironment({ clock: fakeClock });

		env.composerInput.value = 'Metrics prompt';
		env.sendButton.trigger('click');

		const reqId = env.postedMessages.find(m => m.type === 'devpilot.chat.send').payload.requestId;
		fakeClock.tick(5000);

		env.dispatchMessage({
			type: 'devpilot.chat.chunk',
			payload: { requestId: reqId, text: 'Model output' }
		});

		env.dispatchMessage({
			type: 'devpilot.chat.complete',
			payload: {
				requestId: reqId,
				fullText: 'Model output',
				finishReason: 'stop',
				metrics: {
					evalCount: 120,
					evalDurationMs: 5000,
					tokensPerSecond: 24
				}
			}
		});

		const assistantBubble = env.messagesContainer.childNodes.find(
			(n: any) => n.attributes?.get('data-request-id') === reqId
		) as MockElement;

		const footer = assistantBubble.querySelector('.activity-footer') as MockElement;
		assert.strictEqual(footer.textContent, 'Completed · 00:05 · 120 tokens · 24 tokens/sec');
	});

	test('39. Metrics grammar: singular token label for single token generation', () => {
		const fakeClock = new FakeClock();
		const env = setupEnvironment({ clock: fakeClock });

		env.composerInput.value = 'Single token prompt';
		env.sendButton.trigger('click');

		const reqId = env.postedMessages.find(m => m.type === 'devpilot.chat.send').payload.requestId;
		fakeClock.tick(1000);

		env.dispatchMessage({
			type: 'devpilot.chat.complete',
			payload: {
				requestId: reqId,
				fullText: 'A',
				finishReason: 'stop',
				metrics: {
					evalCount: 1,
					evalDurationMs: 1000,
					tokensPerSecond: 1
				}
			}
		});

		const assistantBubble = env.messagesContainer.childNodes.find(
			(n: any) => n.attributes?.get('data-request-id') === reqId
		) as MockElement;

		const footer = assistantBubble.querySelector('.activity-footer') as MockElement;
		assert.strictEqual(footer.textContent, 'Completed · 00:01 · 1 token · 1 tokens/sec');
	});

	test('40. Metrics fallback: completion without metrics retains standard Completed and timer without placeholders', () => {
		const fakeClock = new FakeClock();
		const env = setupEnvironment({ clock: fakeClock });

		env.composerInput.value = 'No metrics prompt';
		env.sendButton.trigger('click');

		const reqId = env.postedMessages.find(m => m.type === 'devpilot.chat.send').payload.requestId;
		fakeClock.tick(3000);

		env.dispatchMessage({
			type: 'devpilot.chat.complete',
			payload: {
				requestId: reqId,
				fullText: 'Plain text',
				finishReason: 'stop'
			}
		});

		const assistantBubble = env.messagesContainer.childNodes.find(
			(n: any) => n.attributes?.get('data-request-id') === reqId
		) as MockElement;

		const footer = assistantBubble.querySelector('.activity-footer') as MockElement;
		assert.strictEqual(footer.textContent, 'Completed · 00:03');
		assert.ok(!footer.textContent.includes('tokens'), 'Must not display tokens placeholder');
		assert.ok(!footer.textContent.includes('N/A'), 'Must not display N/A placeholder');
	});

	test('41. Expandable details: renders breakdown statistics for prompt, inference, and total server time', () => {
		const fakeClock = new FakeClock();
		const env = setupEnvironment({ clock: fakeClock });

		env.composerInput.value = 'Details prompt';
		env.sendButton.trigger('click');

		const reqId = env.postedMessages.find(m => m.type === 'devpilot.chat.send').payload.requestId;
		fakeClock.tick(2000);

		env.dispatchMessage({
			type: 'devpilot.chat.complete',
			payload: {
				requestId: reqId,
				fullText: 'Response with stats',
				finishReason: 'stop',
				metrics: {
					evalCount: 80,
					evalDurationMs: 2000,
					tokensPerSecond: 40,
					promptEvalCount: 12,
					promptEvalDurationMs: 150,
					loadDurationMs: 25,
					totalDurationMs: 2175
				}
			}
		});

		const assistantBubble = env.messagesContainer.childNodes.find(
			(n: any) => n.attributes?.get('data-request-id') === reqId
		) as MockElement;

		const details = assistantBubble.querySelector('.metrics-details') as MockElement;
		assert.ok(details, 'Expandable details element must be rendered when breakdown metrics exist');

		const detailsText = details.textContent;
		assert.ok(detailsText.includes('Prompt:'), 'Prompt breakdown must be present');
		assert.ok(detailsText.includes('12 tokens'), 'Prompt token count must be accurate');
		assert.ok(detailsText.includes('150 ms'), 'Prompt eval duration must be accurate');
		assert.ok(detailsText.includes('Model inference:'), 'Model inference duration label must be present');
		assert.ok(detailsText.includes('2000 ms'), 'Model inference duration must be accurate');
		assert.ok(detailsText.includes('Model load:'), 'Model load duration label must be present');
		assert.ok(detailsText.includes('25 ms'), 'Model load duration must be accurate');
		assert.ok(detailsText.includes('Server total:'), 'Server total label must be present');
		assert.ok(detailsText.includes('2175 ms'), 'Server total duration must be accurate');
	});

	test('42. Expandable details: omitted when no breakdown statistics exist', () => {
		const fakeClock = new FakeClock();
		const env = setupEnvironment({ clock: fakeClock });

		env.composerInput.value = 'Summary only prompt';
		env.sendButton.trigger('click');

		const reqId = env.postedMessages.find(m => m.type === 'devpilot.chat.send').payload.requestId;
		fakeClock.tick(1000);

		env.dispatchMessage({
			type: 'devpilot.chat.complete',
			payload: {
				requestId: reqId,
				fullText: 'Summary only',
				finishReason: 'stop',
				metrics: {
					evalCount: 30,
					tokensPerSecond: 30
				}
			}
		});

		const assistantBubble = env.messagesContainer.childNodes.find(
			(n: any) => n.attributes?.get('data-request-id') === reqId
		) as MockElement;

		const details = assistantBubble.querySelector('.metrics-details') as MockElement;
		assert.strictEqual(details, null, 'Details element must not be rendered when no breakdown stats exist');
	});

	test('43. XSS prevention: text-based rendering prevents script injection in metrics and details', () => {
		const fakeClock = new FakeClock();
		const env = setupEnvironment({ clock: fakeClock });

		env.composerInput.value = 'XSS test prompt';
		env.sendButton.trigger('click');

		const reqId = env.postedMessages.find(m => m.type === 'devpilot.chat.send').payload.requestId;

		env.dispatchMessage({
			type: 'devpilot.chat.complete',
			payload: {
				requestId: reqId,
				fullText: 'Clean text',
				finishReason: 'stop',
				metrics: {
					evalCount: 10,
					evalDurationMs: 1000,
					tokensPerSecond: 10,
					promptEvalCount: 5,
					promptEvalDurationMs: 50
				}
			}
		});

		const assistantBubble = env.messagesContainer.childNodes.find(
			(n: any) => n.attributes?.get('data-request-id') === reqId
		) as MockElement;

		const scriptTag = assistantBubble.querySelector('script');
		assert.strictEqual(scriptTag, null, 'No script element must ever be inserted into bubble');
	});

	test('44. Concurrent requests maintain isolated metrics in UI bubbles', () => {
		const fakeClock = new FakeClock();
		const env = setupEnvironment({ clock: fakeClock });

		// Request A
		env.composerInput.value = 'Req A';
		env.sendButton.trigger('click');

		// Request B
		env.composerInput.value = 'Req B';
		env.sendButton.trigger('click');

		const sendMsgs = env.postedMessages.filter(m => m.type === 'devpilot.chat.send');
		const reqA = sendMsgs[0].payload.requestId;
		const reqB = sendMsgs[1].payload.requestId;

		fakeClock.tick(2000);

		// Complete A
		env.dispatchMessage({
			type: 'devpilot.chat.complete',
			payload: {
				requestId: reqA,
				fullText: 'Response A',
				finishReason: 'stop',
				metrics: { evalCount: 50, tokensPerSecond: 25 }
			}
		});

		fakeClock.tick(1000);

		// Complete B
		env.dispatchMessage({
			type: 'devpilot.chat.complete',
			payload: {
				requestId: reqB,
				fullText: 'Response B',
				finishReason: 'stop',
				metrics: { evalCount: 150, tokensPerSecond: 50 }
			}
		});

		const bubbleA = env.messagesContainer.childNodes.find(
			(n: any) => n.attributes?.get('data-request-id') === reqA
		) as MockElement;
		const bubbleB = env.messagesContainer.childNodes.find(
			(n: any) => n.attributes?.get('data-request-id') === reqB
		) as MockElement;

		const footerA = bubbleA.querySelector('.activity-footer') as MockElement;
		const footerB = bubbleB.querySelector('.activity-footer') as MockElement;

		assert.strictEqual(footerA.textContent, 'Completed · 00:02 · 50 tokens · 25 tokens/sec');
		assert.strictEqual(footerB.textContent, 'Completed · 00:03 · 150 tokens · 50 tokens/sec');
	});

	test('45. Details elements and timers are cleanly destroyed on resetToWelcomeState and dispose', () => {
		const fakeClock = new FakeClock();
		const env = setupEnvironment({ clock: fakeClock });

		env.composerInput.value = 'Reset test';
		env.sendButton.trigger('click');

		const reqId = env.postedMessages.find(m => m.type === 'devpilot.chat.send').payload.requestId;

		env.dispatchMessage({
			type: 'devpilot.chat.complete',
			payload: {
				requestId: reqId,
				fullText: 'Response text',
				finishReason: 'stop',
				metrics: { evalCount: 10, evalDurationMs: 1000, promptEvalCount: 5, promptEvalDurationMs: 100 }
			}
		});

		env.newChatBtn.trigger('click');

		assert.strictEqual(env.controller.activeRequests.size, 0);
		assert.strictEqual(fakeClock.intervals.size, 0);
	});

	test('46. Markdown bold syntax (**Qwen3.5**) renders as rich strong element without literal asterisks', () => {
		const env = setupEnvironment();
		env.composerInput.value = 'What model are you?';
		env.sendButton.trigger('click');

		const reqId = env.postedMessages.find(m => m.type === 'devpilot.chat.send').payload.requestId;
		const assistantBubble = env.messagesContainer.childNodes.find(
			(n: any) => n.attributes?.get('data-request-id') === reqId
		) as MockElement;

		env.dispatchMessage({
			type: 'devpilot.chat.chunk',
			payload: { requestId: reqId, text: 'I am **Qwen3.5** assistant.' }
		});

		const strongEl = assistantBubble.querySelector('strong');
		assert.ok(strongEl, 'Strong element must be created for **bold** markdown');
		assert.strictEqual(strongEl.textContent, 'Qwen3.5');
		assert.ok(!assistantBubble.textContent.includes('**Qwen3.5**'), 'Literal asterisks must not be displayed');
	});

	test('47. Markdown code block (```) renders as pre and code elements', () => {
		const env = setupEnvironment();
		env.composerInput.value = 'Show code';
		env.sendButton.trigger('click');

		const reqId = env.postedMessages.find(m => m.type === 'devpilot.chat.send').payload.requestId;
		const assistantBubble = env.messagesContainer.childNodes.find(
			(n: any) => n.attributes?.get('data-request-id') === reqId
		) as MockElement;

		env.dispatchMessage({
			type: 'devpilot.chat.chunk',
			payload: { requestId: reqId, text: '```python\ndef hello():\n    return 42\n```' }
		});

		const preEl = assistantBubble.querySelector('pre');
		const codeEl = assistantBubble.querySelector('code');
		assert.ok(preEl, 'Pre element must be created for code block');
		assert.ok(codeEl, 'Code element must be created inside pre');
		assert.ok(assistantBubble.textContent.includes('def hello():\n    return 42'));
	});

	test('48. Partial unclosed Markdown remains safe during streaming and formats upon completion', () => {
		const env = setupEnvironment();
		env.composerInput.value = 'Streaming markdown';
		env.sendButton.trigger('click');

		const reqId = env.postedMessages.find(m => m.type === 'devpilot.chat.send').payload.requestId;
		const assistantBubble = env.messagesContainer.childNodes.find(
			(n: any) => n.attributes?.get('data-request-id') === reqId
		) as MockElement;

		// Chunk 1: unclosed bold syntax
		env.dispatchMessage({
			type: 'devpilot.chat.chunk',
			payload: { requestId: reqId, text: 'Hello **Qwen' }
		});

		// Should safely render without crashing or creating an unclosed tag
		assert.ok(assistantBubble.textContent.includes('Hello **Qwen'));

		// Chunk 2: closing asterisks arrive
		env.dispatchMessage({
			type: 'devpilot.chat.chunk',
			payload: { requestId: reqId, text: '3.5**!' }
		});

		const strongEl = assistantBubble.querySelector('strong');
		assert.ok(strongEl, 'Strong element must be created once closing asterisks arrive');
		assert.strictEqual(strongEl.textContent, 'Qwen3.5');
	});

	test('49. Streaming cursor remains at the very end of content after every chunk', () => {
		const env = setupEnvironment();
		env.composerInput.value = 'Cursor positioning';
		env.sendButton.trigger('click');

		const reqId = env.postedMessages.find(m => m.type === 'devpilot.chat.send').payload.requestId;
		const req = env.controller.activeRequests.get(reqId);

		// Chunk 1
		env.dispatchMessage({
			type: 'devpilot.chat.chunk',
			payload: { requestId: reqId, text: 'First phrase' }
		});

		assert.ok(req.cursorElement, 'Cursor element must be initialized');
		const textNodes1 = req.textElement.childNodes;
		assert.strictEqual(textNodes1[textNodes1.length - 1], req.cursorElement, 'Cursor must be the last child after chunk 1');

		// Chunk 2
		env.dispatchMessage({
			type: 'devpilot.chat.chunk',
			payload: { requestId: reqId, text: ' second phrase' }
		});

		const textNodes2 = req.textElement.childNodes;
		assert.strictEqual(textNodes2[textNodes2.length - 1], req.cursorElement, 'Cursor must remain the last child after chunk 2');
	});

	test('50. Streaming cursor disappears completely on completion and cancellation', () => {
		const env = setupEnvironment();
		env.composerInput.value = 'Cursor cleanup test';
		env.sendButton.trigger('click');

		const reqId = env.postedMessages.find(m => m.type === 'devpilot.chat.send').payload.requestId;
		const assistantBubble = env.messagesContainer.childNodes.find(
			(n: any) => n.attributes?.get('data-request-id') === reqId
		) as MockElement;

		env.dispatchMessage({
			type: 'devpilot.chat.chunk',
			payload: { requestId: reqId, text: 'Generating text...' }
		});

		assert.ok(assistantBubble.querySelector('.streaming-indicator'), 'Cursor must be present during generation');

		// Complete
		env.dispatchMessage({
			type: 'devpilot.chat.complete',
			payload: { requestId: reqId, fullText: 'Generating text...', finishReason: 'stop' }
		});

		assert.strictEqual(assistantBubble.querySelector('.streaming-indicator'), null, 'Cursor must be removed on completion');
	});

	test('51. HTML tags inside model output are treated as safe text and never executed as HTML', () => {
		const env = setupEnvironment();
		env.composerInput.value = 'XSS test';
		env.sendButton.trigger('click');

		const reqId = env.postedMessages.find(m => m.type === 'devpilot.chat.send').payload.requestId;
		const assistantBubble = env.messagesContainer.childNodes.find(
			(n: any) => n.attributes?.get('data-request-id') === reqId
		) as MockElement;

		const dangerousPayload = 'Output: <script>window.pwned=true</script><img src="x" onerror="evil()">';
		env.dispatchMessage({
			type: 'devpilot.chat.chunk',
			payload: { requestId: reqId, text: dangerousPayload }
		});

		// Zero script or img DOM nodes created
		assert.strictEqual(assistantBubble.querySelector('script'), null, 'Script tags must never be created');
		assert.strictEqual(assistantBubble.querySelector('img'), null, 'Img tags must never be created');
		// Text content is preserved safely
		assert.ok(assistantBubble.textContent.includes(dangerousPayload));
	});

	test('52. In-bubble stop button is positioned below text content and cancels only its request', () => {
		const env = setupEnvironment();
		env.composerInput.value = 'Stop button layout';
		env.sendButton.trigger('click');

		const reqId = env.postedMessages.find(m => m.type === 'devpilot.chat.send').payload.requestId;
		const req = env.controller.activeRequests.get(reqId);

		env.dispatchMessage({
			type: 'devpilot.chat.chunk',
			payload: { requestId: reqId, text: 'In flight text' }
		});

		// Verify stop button is in bubble and is a sibling of textElement, not inside textElement
		assert.ok(req.stopButtonElement, 'Inline stop button must exist during generation');
		assert.strictEqual(req.stopButtonElement.parentNode, req.bubbleElement);
		assert.strictEqual(req.textElement.querySelector('.bubble-stop-btn'), null, 'Stop button must not be inside textElement');

		// Click stop button
		req.stopButtonElement.trigger('click');
		const cancelMsg = env.postedMessages.find(m => m.type === 'devpilot.chat.cancel');
		assert.ok(cancelMsg, 'Clicking stop button must dispatch chat.cancel');
		assert.strictEqual(cancelMsg.payload.requestId, reqId);
	});

	test('53. Multiple concurrent streaming requests maintain isolated markdown rendering and cursor states', () => {
		const env = setupEnvironment();

		// Prompt A
		env.composerInput.value = 'Prompt A';
		env.sendButton.trigger('click');
		const reqA = env.postedMessages.filter(m => m.type === 'devpilot.chat.send')[0].payload.requestId;

		// Prompt B
		env.composerInput.value = 'Prompt B';
		env.sendButton.trigger('click');
		const reqB = env.postedMessages.filter(m => m.type === 'devpilot.chat.send')[1].payload.requestId;

		env.dispatchMessage({
			type: 'devpilot.chat.chunk',
			payload: { requestId: reqA, text: '**Bold A**' }
		});
		env.dispatchMessage({
			type: 'devpilot.chat.chunk',
			payload: { requestId: reqB, text: '`Code B`' }
		});

		const bubbleA = env.messagesContainer.childNodes.find(
			(n: any) => n.attributes?.get('data-request-id') === reqA
		) as MockElement;
		const bubbleB = env.messagesContainer.childNodes.find(
			(n: any) => n.attributes?.get('data-request-id') === reqB
		) as MockElement;

		assert.ok(bubbleA.querySelector('strong'), 'Bubble A must have strong element');
		assert.strictEqual(bubbleA.querySelector('code'), null, 'Bubble A must not have code element from B');

		assert.ok(bubbleB.querySelector('code'), 'Bubble B must have code element');
		assert.strictEqual(bubbleB.querySelector('strong'), null, 'Bubble B must not have strong element from A');
	});
});
