import * as http from 'http';
import express, { Request, Response } from 'express';
import * as vscode from 'vscode';

const DEFAULT_PORT = 3141;
const DEFAULT_HOST = '127.0.0.1';

interface ResponsesApiRequestBody {
	model?: string;
	stream?: boolean;
	[key: string]: unknown;
}

// ADK API types
interface AdkContentPart {
	text?: string;
	data?: {
		data: string; // base64 encoded image data
		mime_type: string; // e.g., "image/png", "image/jpeg"
	};
	// Future: function_call, function_response, etc.
}

interface AdkContent {
	parts: AdkContentPart[];
	role: string; // "user" | "model"
}

interface AdkRunRequest {
	app_name: string;
	user_id: string;
	session_id: string;
	new_message: AdkContent;
	streaming?: boolean;
	state_delta?: Record<string, unknown>;
}

interface AdkEvent {
	id: string;
	invocation_id: string;
	timestamp: number;
	author: string;
	content?: AdkContent;
	actions?: Record<string, unknown>;
}

// Simple in-memory session store
interface Session {
	id: string;
	userId: string;
	appName: string;
	createdAt: number;
	history: AdkContent[];
}

// OpenAI Assistants API types
type OaiContentPart =
	| { type: 'text'; text: { value: string } }
	| {
			type: 'image_url';
			image_url: { url: string }; // data:image/png;base64,... or http(s) URL
	  }
	| {
			type: 'image_file';
			image_file: { file_id: string };
	  };

interface OaiMessage {
	id: string;
	object: 'thread.message';
	created_at: number;
	thread_id: string;
	role: 'user' | 'assistant';
	content: OaiContentPart[];
	metadata?: Record<string, string>;
}

interface OaiThread {
	id: string;
	object: 'thread';
	created_at: number;
	metadata?: Record<string, string>;
	messages: OaiMessage[];
}

interface OaiRun {
	id: string;
	object: 'thread.run';
	created_at: number;
	thread_id: string;
	assistant_id: string;
	status: 'queued' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
	started_at?: number;
	completed_at?: number;
	model: string;
	instructions?: string;
}

class LmProxyServer implements vscode.Disposable {
	private server: http.Server | undefined;
	private requestCounter = 0;
	private eventCounter = 0;
	private sessions: Map<string, Session> = new Map();
	private threads: Map<string, OaiThread> = new Map();
	private messageCounter = 0;
	private runCounter = 0;

	public async start(): Promise<void> {
		const configuration = vscode.workspace.getConfiguration('lmProxyServer');
		const host =
			configuration.get<string>('host') ?? process.env.VS_CODE_LM_PROXY_HOST ?? DEFAULT_HOST;
		const port =
			configuration.get<number>('port') ??
			Number.parseInt(process.env.VS_CODE_LM_PROXY_PORT ?? `${DEFAULT_PORT}`, 10);

		if (Number.isNaN(port)) {
			throw new Error('Invalid port configuration for LM proxy server.');
		}

		const app = express();
		app.use(express.json({ limit: '1mb' }));

		app.get('/health', (_req, res) => {
			res.json({ status: 'ok' });
		});

		app.post('/v1/responses', async (req, res) => {
			let requestId: string | undefined;
			let startedAt = Date.now();
			try {
				const body = req.body as ResponsesApiRequestBody | undefined;
				if (!body || typeof body !== 'object') {
					this.sendError(res, 400, 'Invalid request body');
					return;
				}

				requestId = this.nextRequestId();
				startedAt = Date.now();
				const rawBodyString = this.safeStringify(req.body);
				console.log(`[LM Proxy][${requestId}] Incoming request body (${rawBodyString.length} chars)`);

				const model = await this.resolveModel(body.model);
				if (!model) {
					console.warn(
						`[LM Proxy][${requestId}] No chat model available for request (requested=${body.model ?? 'default'})`,
					);
					this.sendError(res, 404, `No chat model found for id "${body.model ?? 'default'}"`);
					return;
				}

				console.log(
					`[LM Proxy][${requestId}] Using model ${model.id} (vendor=${model.vendor}, family=${model.family}, maxTokens=${model.maxInputTokens})`,
				);

				const vsMessages = [this.toVsCodeMessage(req.body)];
				console.log(`[LM Proxy][${requestId}] Serialized payload token estimation requested`);
				const tokenSource = new vscode.CancellationTokenSource();
				try {
					console.log(`[LM Proxy][${requestId}] Dispatching request to VS Code LM API`);
					const response = await model.sendRequest(
						vsMessages,
						{
							justification:
								'External HTTP request routed through VS Code LM proxy server provided by the extension.',
						},
						tokenSource.token,
					);

					const textFragments: string[] = [];
					const responseStream = (response as { stream?: AsyncIterable<unknown> }).stream;

					if (responseStream) {
						console.log(`[LM Proxy][${requestId}] Streaming response detected (async iterable)`);

						let chunkIndex = 0;
						const streamStart = Date.now();
						const logChunk = (label: string, detail: unknown) => {
							console.log(
								`[LM Proxy][${requestId}] Stream chunk #${chunkIndex} (${Date.now() - streamStart}ms since start) -> ${label}`,
								detail,
							);
						};

						for await (const part of responseStream) {
							chunkIndex += 1;

							if (typeof part === 'string') {
								logChunk('string', part.slice(0, 80));
								textFragments.push(part);
								continue;
							}

							if (part && typeof part === 'object') {
								if ('value' in part && typeof (part as { value: unknown }).value === 'string') {
									logChunk('LanguageModelTextPart', (part as { value: string }).value.slice(0, 80));
									textFragments.push((part as { value: string }).value);
									continue;
								}

								if ('text' in part && typeof (part as { text: unknown }).text === 'string') {
									logChunk('TextPart', (part as { text: string }).text.slice(0, 80));
									textFragments.push((part as { text: string }).text);
									continue;
								}

								if ('callId' in part) {
									const toolCall = part as { callId: unknown; content?: unknown };
									console.log(`[LM Proxy][${requestId}] Tool call part received`, {
										callId: toolCall.callId,
										content: toolCall.content,
									});
									continue;
								}
							}

							logChunk('Non-text', part);
						}

						console.log(
							`[LM Proxy][${requestId}] Stream completed after ${Date.now() - streamStart}ms with ${chunkIndex} chunk(s)`,
						);
					} else {
						console.log(`[LM Proxy][${requestId}] Streaming interface unavailable; falling back to text iterator`);
						let chunkIndex = 0;
						const streamStart = Date.now();
						for await (const chunk of response.text) {
							chunkIndex += 1;
							console.log(
								`[LM Proxy][${requestId}] Text iterator chunk #${chunkIndex} (${Date.now() - streamStart}ms):`,
								chunk.slice(0, 80),
							);
							textFragments.push(chunk);
						}
						console.log(
							`[LM Proxy][${requestId}] Text iterator completed after ${Date.now() - streamStart}ms with ${chunkIndex} chunk(s)`,
						);
					}

					const aggregatedText = textFragments.join('');
					console.log(
						`[LM Proxy][${requestId}] Response text length=${aggregatedText.length} chars`,
					);
					console.log(
						`[LM Proxy][${requestId}] Collected ${textFragments.length} text fragment(s) from model`,
					);
					if (aggregatedText.length === 0) {
						console.warn(
							`[LM Proxy][${requestId}] No text returned from model; check tool/call requirements or model output.`,
						);
					}
					const outputContent =
						aggregatedText.length > 0
							? [
								{
									type: 'output_text',
									text: aggregatedText,
								} as const,
							]
							: [];

					const now = Date.now();
					const responseId = `resp_${now}`;
					const messageId = `msg_${now}`;

					res.json({
						id: responseId,
						object: 'response',
						created: Math.floor(now / 1000),
						model: model.id,
						status: 'completed',
						output: [
							{
								id: messageId,
								type: 'message',
								role: 'assistant',
								content: outputContent,
							},
						],
						output_text: aggregatedText.length > 0 ? [aggregatedText] : [],
						usage: {
							input_tokens: 0,
							output_tokens: 0,
							total_tokens: 0,
						},
					});
					console.log(
						`[LM Proxy][${requestId}] Request completed in ${Date.now() - startedAt}ms`,
					);
				} finally {
					tokenSource.dispose();
				}
			} catch (error) {
				const errorMessage =
					error instanceof Error
						? `${error.name}: ${error.message}`
						: typeof error === 'string'
							? error
							: this.safeStringify(error);
				console.error('[LM Proxy] request failed', error);
				if (requestId) {
					console.error(
						`[LM Proxy][${requestId}] Request failed after ${Date.now() - startedAt}ms`,
					);
				}
				console.error(`[LM Proxy] request failure details: ${errorMessage}`);
				this.sendError(res, 500, 'Failed to fulfill request via VS Code LM API');
			}
		});

		// ==================== ADK API Endpoints ====================

		// GET /list-apps - List available apps (virtual implementation)
		app.get('/list-apps', (_req, res) => {
			res.json(['vscode-lm-proxy']);
		});

		// POST /run - Execute agent run (non-streaming)
		app.post('/run', async (req, res) => {
			const requestId = this.nextRequestId();
			const startedAt = Date.now();
			try {
				const body = req.body as AdkRunRequest | undefined;
				const validationError = this.validateAdkRequest(body);
				if (validationError) {
					this.sendAdkError(res, 400, validationError);
					return;
				}

				console.log(`[ADK][${requestId}] /run request: app=${body!.app_name}, user=${body!.user_id}, session=${body!.session_id}`);

				const model = await this.resolveModel(undefined);
				if (!model) {
					this.sendAdkError(res, 503, 'No language model available');
					return;
				}

				// Get or create session for conversation history
				let session = this.sessions.get(body!.session_id);
				if (!session) {
					session = {
						id: body!.session_id,
						userId: body!.user_id,
						appName: body!.app_name,
						createdAt: Date.now(),
						history: [],
					};
					this.sessions.set(body!.session_id, session);
				}

				// Build message array from history + new message (with image support)
				const vsMessages: vscode.LanguageModelChatMessage[] = [];
				for (const historyItem of session.history) {
					vsMessages.push(this.convertAdkContentToVsCodeMessage(historyItem));
				}
				// Add current user message
				vsMessages.push(this.convertAdkContentToVsCodeMessage(body!.new_message));

				console.log(`[ADK][${requestId}] Sending ${vsMessages.length} messages (${session.history.length} from history)`);

				const tokenSource = new vscode.CancellationTokenSource();

				try {
					const response = await model.sendRequest(
						vsMessages,
						{ justification: 'ADK API request via VS Code LM proxy' },
						tokenSource.token,
					);

					// Collect full response
					const textFragments: string[] = [];
					for await (const chunk of response.text) {
						textFragments.push(chunk);
					}
					const aggregatedText = textFragments.join('');

					// Save to history
					session.history.push(body!.new_message);
					session.history.push({
						parts: [{ text: aggregatedText }],
						role: 'model',
					});

					// Create ADK Event response
					const invocationId = `inv_${Date.now()}`;
					const event = this.createAdkEvent(invocationId, 'assistant', aggregatedText);

					console.log(`[ADK][${requestId}] /run completed in ${Date.now() - startedAt}ms, response length=${aggregatedText.length}, history now=${session.history.length}`);
					res.json([event]);
				} finally {
					tokenSource.dispose();
				}
			} catch (error) {
				console.error(`[ADK][${requestId}] /run failed:`, error);
				this.sendAdkError(res, 500, 'Internal server error');
			}
		});

		// POST /run_sse - Execute agent run with SSE streaming
		app.post('/run_sse', async (req, res) => {
			const requestId = this.nextRequestId();
			const startedAt = Date.now();
			try {
				const body = req.body as AdkRunRequest | undefined;
				const validationError = this.validateAdkRequest(body);
				if (validationError) {
					this.sendAdkError(res, 400, validationError);
					return;
				}

				console.log(`[ADK][${requestId}] /run_sse request: app=${body!.app_name}, user=${body!.user_id}, session=${body!.session_id}`);

				const model = await this.resolveModel(undefined);
				if (!model) {
					this.sendAdkError(res, 503, 'No language model available');
					return;
				}

				// Get or create session for conversation history
				let session = this.sessions.get(body!.session_id);
				if (!session) {
					session = {
						id: body!.session_id,
						userId: body!.user_id,
						appName: body!.app_name,
						createdAt: Date.now(),
						history: [],
					};
					this.sessions.set(body!.session_id, session);
				}

				// Build message array from history + new message (with image support)
				const vsMessages: vscode.LanguageModelChatMessage[] = [];
				for (const historyItem of session.history) {
					vsMessages.push(this.convertAdkContentToVsCodeMessage(historyItem));
				}
				vsMessages.push(this.convertAdkContentToVsCodeMessage(body!.new_message));

				// Set up SSE headers
				res.setHeader('Content-Type', 'text/event-stream');
				res.setHeader('Cache-Control', 'no-cache');
				res.setHeader('Connection', 'keep-alive');
				res.flushHeaders();

				const tokenSource = new vscode.CancellationTokenSource();
				const invocationId = `inv_${Date.now()}`;

				try {
					const response = await model.sendRequest(
						vsMessages,
						{ justification: 'ADK SSE API request via VS Code LM proxy' },
						tokenSource.token,
					);

					// Stream response as SSE events
					let accumulatedText = '';
					for await (const chunk of response.text) {
						accumulatedText += chunk;
						const event = this.createAdkEvent(invocationId, 'assistant', accumulatedText);
						res.write(`data: ${JSON.stringify(event)}\n\n`);
					}

					// Save to history
					session.history.push(body!.new_message);
					session.history.push({
						parts: [{ text: accumulatedText }],
						role: 'model',
					});

					console.log(`[ADK][${requestId}] /run_sse completed in ${Date.now() - startedAt}ms, history now=${session.history.length}`);
					res.write('data: [DONE]\n\n');
					res.end();
				} finally {
					tokenSource.dispose();
				}
			} catch (error) {
				console.error(`[ADK][${requestId}] /run_sse failed:`, error);
				res.write(`data: ${JSON.stringify({ error: 'Internal server error' })}\n\n`);
				res.end();
			}
		});

		// Session management endpoints
		app.get('/apps/:app_name/users/:user_id/sessions', (req, res) => {
			const { app_name, user_id } = req.params;
			const sessions = Array.from(this.sessions.values())
				.filter(s => s.appName === app_name && s.userId === user_id)
				.map(s => ({ id: s.id, created_at: s.createdAt }));
			res.json(sessions);
		});

		app.post('/apps/:app_name/users/:user_id/sessions', (req, res) => {
			const { app_name, user_id } = req.params;
			const sessionId = `session_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
			const session: Session = {
				id: sessionId,
				userId: user_id,
				appName: app_name,
				createdAt: Date.now(),
				history: [],
			};
			this.sessions.set(sessionId, session);
			res.status(201).json({ id: sessionId, created_at: session.createdAt });
		});

		app.get('/apps/:app_name/users/:user_id/sessions/:session_id', (req, res) => {
			const { session_id } = req.params;
			const session = this.sessions.get(session_id);
			if (!session) {
				res.status(404).json({ error: 'Session not found' });
				return;
			}
			res.json({ id: session.id, created_at: session.createdAt, history: session.history });
		});

		app.delete('/apps/:app_name/users/:user_id/sessions/:session_id', (req, res) => {
			const { session_id } = req.params;
			if (this.sessions.delete(session_id)) {
				res.status(204).send();
			} else {
				res.status(404).json({ error: 'Session not found' });
			}
		});

		// ==================== End ADK API Endpoints ====================

		// ==================== OpenAI Assistants API Endpoints ====================

		// Virtual Assistants (fixed response)
		app.get('/v1/assistants', (_req, res) => {
			res.json({
				object: 'list',
				data: [{
					id: 'asst_default',
					object: 'assistant',
					created_at: Math.floor(Date.now() / 1000),
					name: 'VS Code LM Proxy Assistant',
					model: 'gpt-5-mini',
					instructions: 'You are a helpful assistant.',
				}],
			});
		});

		app.get('/v1/assistants/:assistant_id', (req, res) => {
			res.json({
				id: req.params.assistant_id || 'asst_default',
				object: 'assistant',
				created_at: Math.floor(Date.now() / 1000),
				name: 'VS Code LM Proxy Assistant',
				model: 'gpt-5-mini',
				instructions: 'You are a helpful assistant.',
			});
		});

		// Threads CRUD
		app.post('/v1/threads', (req, res) => {
			const threadId = `thread_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
			const thread: OaiThread = {
				id: threadId,
				object: 'thread',
				created_at: Math.floor(Date.now() / 1000),
				metadata: req.body?.metadata || {},
				messages: [],
			};
			this.threads.set(threadId, thread);
			console.log(`[Assistants] Created thread: ${threadId}`);
			res.status(201).json({
				id: thread.id,
				object: thread.object,
				created_at: thread.created_at,
				metadata: thread.metadata,
			});
		});

		app.get('/v1/threads/:thread_id', (req, res) => {
			const thread = this.threads.get(req.params.thread_id);
			if (!thread) {
				res.status(404).json({ error: { message: 'Thread not found', type: 'invalid_request_error' } });
				return;
			}
			res.json({
				id: thread.id,
				object: thread.object,
				created_at: thread.created_at,
				metadata: thread.metadata,
			});
		});

		app.delete('/v1/threads/:thread_id', (req, res) => {
			if (this.threads.delete(req.params.thread_id)) {
				res.json({ id: req.params.thread_id, object: 'thread.deleted', deleted: true });
			} else {
				res.status(404).json({ error: { message: 'Thread not found', type: 'invalid_request_error' } });
			}
		});

		// Messages
		app.post('/v1/threads/:thread_id/messages', (req, res) => {
			const thread = this.threads.get(req.params.thread_id);
			if (!thread) {
				res.status(404).json({ error: { message: 'Thread not found', type: 'invalid_request_error' } });
				return;
			}
			this.messageCounter++;
			const messageId = `msg_${this.messageCounter.toString(16).padStart(8, '0')}`;

			// Support both string and array content formats (with image support)
			let contentParts: OaiContentPart[];
			if (typeof req.body?.content === 'string') {
				contentParts = [{ type: 'text', text: { value: req.body.content } }];
			} else if (Array.isArray(req.body?.content)) {
				contentParts = req.body.content;
			} else {
				contentParts = [{ type: 'text', text: { value: '' } }];
			}

			const message: OaiMessage = {
				id: messageId,
				object: 'thread.message',
				created_at: Math.floor(Date.now() / 1000),
				thread_id: thread.id,
				role: req.body?.role || 'user',
				content: contentParts,
				metadata: req.body?.metadata || {},
			};
			thread.messages.push(message);
			res.status(201).json(message);
		});

		app.get('/v1/threads/:thread_id/messages', (req, res) => {
			const thread = this.threads.get(req.params.thread_id);
			if (!thread) {
				res.status(404).json({ error: { message: 'Thread not found', type: 'invalid_request_error' } });
				return;
			}
			res.json({ object: 'list', data: thread.messages });
		});

		app.get('/v1/threads/:thread_id/messages/:message_id', (req, res) => {
			const thread = this.threads.get(req.params.thread_id);
			if (!thread) {
				res.status(404).json({ error: { message: 'Thread not found', type: 'invalid_request_error' } });
				return;
			}
			const message = thread.messages.find(m => m.id === req.params.message_id);
			if (!message) {
				res.status(404).json({ error: { message: 'Message not found', type: 'invalid_request_error' } });
				return;
			}
			res.json(message);
		});

		// Runs - execute synchronously
		app.post('/v1/threads/:thread_id/runs', async (req, res) => {
			const requestId = this.nextRequestId();
			const startedAt = Date.now();
			const thread = this.threads.get(req.params.thread_id);
			if (!thread) {
				res.status(404).json({ error: { message: 'Thread not found', type: 'invalid_request_error' } });
				return;
			}

			this.runCounter++;
			const runId = `run_${this.runCounter.toString(16).padStart(8, '0')}`;
			const assistantId = req.body?.assistant_id || 'asst_default';

			console.log(`[Assistants][${requestId}] Run ${runId} started for thread ${thread.id}`);

			try {
				const model = await this.resolveModel(undefined);
				if (!model) {
					res.status(503).json({ error: { message: 'No language model available', type: 'server_error' } });
					return;
				}

				// Build messages from thread (with image support)
				const vsMessages: vscode.LanguageModelChatMessage[] = [];
				for (const msg of thread.messages) {
					vsMessages.push(this.convertOaiContentToVsCodeMessage(msg.content, msg.role));
				}

				if (vsMessages.length === 0) {
					res.status(400).json({ error: { message: 'Thread has no messages', type: 'invalid_request_error' } });
					return;
				}

				const tokenSource = new vscode.CancellationTokenSource();
				try {
					const response = await model.sendRequest(
						vsMessages,
						{ justification: 'OpenAI Assistants API request via VS Code LM proxy' },
						tokenSource.token,
					);

					const textFragments: string[] = [];
					for await (const chunk of response.text) {
						textFragments.push(chunk);
					}
					const responseText = textFragments.join('');

					// Add assistant response to thread
					this.messageCounter++;
					const assistantMsg: OaiMessage = {
						id: `msg_${this.messageCounter.toString(16).padStart(8, '0')}`,
						object: 'thread.message',
						created_at: Math.floor(Date.now() / 1000),
						thread_id: thread.id,
						role: 'assistant',
						content: [{ type: 'text', text: { value: responseText } }],
					};
					thread.messages.push(assistantMsg);

					const run: OaiRun = {
						id: runId,
						object: 'thread.run',
						created_at: Math.floor(startedAt / 1000),
						thread_id: thread.id,
						assistant_id: assistantId,
						status: 'completed',
						started_at: Math.floor(startedAt / 1000),
						completed_at: Math.floor(Date.now() / 1000),
						model: model.id,
					};

					console.log(`[Assistants][${requestId}] Run ${runId} completed in ${Date.now() - startedAt}ms`);
					res.json(run);
				} finally {
					tokenSource.dispose();
				}
			} catch (error) {
				console.error(`[Assistants][${requestId}] Run ${runId} failed:`, error);
				res.status(500).json({ error: { message: 'Internal server error', type: 'server_error' } });
			}
		});

		// Create thread and run together
		app.post('/v1/threads/runs', async (req, res) => {
			// Create thread first
			const threadId = `thread_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
			const thread: OaiThread = {
				id: threadId,
				object: 'thread',
				created_at: Math.floor(Date.now() / 1000),
				metadata: {},
				messages: [],
			};

			// Add messages from request (with image support)
			if (req.body?.thread?.messages) {
				for (const msg of req.body.thread.messages) {
					this.messageCounter++;

					// Support both string and array content formats
					let contentParts: OaiContentPart[];
					if (typeof msg.content === 'string') {
						contentParts = [{ type: 'text', text: { value: msg.content } }];
					} else if (Array.isArray(msg.content)) {
						contentParts = msg.content;
					} else {
						contentParts = [{ type: 'text', text: { value: '' } }];
					}

					const message: OaiMessage = {
						id: `msg_${this.messageCounter.toString(16).padStart(8, '0')}`,
						object: 'thread.message',
						created_at: Math.floor(Date.now() / 1000),
						thread_id: threadId,
						role: msg.role || 'user',
						content: contentParts,
					};
					thread.messages.push(message);
				}
			}

			this.threads.set(threadId, thread);

			// Now forward to the run handler by modifying request params
			req.params = { thread_id: threadId };
			// Recursively call the run endpoint logic (inline for simplicity)
			const requestId = this.nextRequestId();
			const startedAt = Date.now();
			this.runCounter++;
			const runId = `run_${this.runCounter.toString(16).padStart(8, '0')}`;
			const assistantId = req.body?.assistant_id || 'asst_default';

			try {
				const model = await this.resolveModel(undefined);
				if (!model) {
					res.status(503).json({ error: { message: 'No language model available', type: 'server_error' } });
					return;
				}

				const vsMessages: vscode.LanguageModelChatMessage[] = [];
				for (const msg of thread.messages) {
					vsMessages.push(this.convertOaiContentToVsCodeMessage(msg.content, msg.role));
				}

				if (vsMessages.length === 0) {
					res.status(400).json({ error: { message: 'No messages provided', type: 'invalid_request_error' } });
					return;
				}

				const tokenSource = new vscode.CancellationTokenSource();
				try {
					const response = await model.sendRequest(
						vsMessages,
						{ justification: 'OpenAI Assistants API request via VS Code LM proxy' },
						tokenSource.token,
					);

					const textFragments: string[] = [];
					for await (const chunk of response.text) {
						textFragments.push(chunk);
					}
					const responseText = textFragments.join('');

					this.messageCounter++;
					const assistantMsg: OaiMessage = {
						id: `msg_${this.messageCounter.toString(16).padStart(8, '0')}`,
						object: 'thread.message',
						created_at: Math.floor(Date.now() / 1000),
						thread_id: thread.id,
						role: 'assistant',
						content: [{ type: 'text', text: { value: responseText } }],
					};
					thread.messages.push(assistantMsg);

					const run: OaiRun = {
						id: runId,
						object: 'thread.run',
						created_at: Math.floor(startedAt / 1000),
						thread_id: thread.id,
						assistant_id: assistantId,
						status: 'completed',
						started_at: Math.floor(startedAt / 1000),
						completed_at: Math.floor(Date.now() / 1000),
						model: model.id,
					};

					console.log(`[Assistants][${requestId}] Thread+Run ${runId} completed`);
					res.json(run);
				} finally {
					tokenSource.dispose();
				}
			} catch (error) {
				console.error(`[Assistants][${requestId}] Thread+Run failed:`, error);
				res.status(500).json({ error: { message: 'Internal server error', type: 'server_error' } });
			}
		});

		// ==================== End OpenAI Assistants API Endpoints ====================

		await new Promise<void>((resolve, reject) => {
			this.server = app
				.listen(port, host, () => {
					console.log(`[LM Proxy] Listening on http://${host}:${port}`);
					resolve();
				})
				.on('error', reject);
		});
	}

	public dispose(): void {
		if (this.server) {
			this.server.close((err) => {
				if (err) {
					console.error('[LM Proxy] Failed to close server', err);
				}
			});
			this.server = undefined;
		}
	}

	private sendError(res: Response, status: number, message: string): void {
		res.status(status).json({
			error: {
				message,
				type: 'invalid_request_error',
			},
		});
	}

	// ==================== ADK Helper Methods ====================

	private validateAdkRequest(body: AdkRunRequest | undefined): string | null {
		if (!body || typeof body !== 'object') {
			return 'Invalid request body';
		}
		if (!body.app_name || typeof body.app_name !== 'string') {
			return 'Missing or invalid app_name';
		}
		if (!body.user_id || typeof body.user_id !== 'string') {
			return 'Missing or invalid user_id';
		}
		if (!body.session_id || typeof body.session_id !== 'string') {
			return 'Missing or invalid session_id';
		}
		if (!body.new_message || typeof body.new_message !== 'object') {
			return 'Missing or invalid new_message';
		}
		return null;
	}

	private sendAdkError(res: Response, status: number, message: string): void {
		res.status(status).json({
			error: message,
		});
	}

	private extractTextFromAdkContent(content: AdkContent): string {
		if (!content.parts || !Array.isArray(content.parts)) {
			return '';
		}
		return content.parts
			.filter(part => part.text && typeof part.text === 'string')
			.map(part => part.text!)
			.join('\n');
	}

	private createAdkEvent(invocationId: string, author: string, text: string): AdkEvent {
		this.eventCounter = (this.eventCounter + 1) % Number.MAX_SAFE_INTEGER;
		const eventId = `evt_${this.eventCounter.toString(16).padStart(8, '0')}`;
		return {
			id: eventId,
			invocation_id: invocationId,
			timestamp: Date.now() / 1000,
			author,
			content: {
				parts: [{ text }],
				role: 'model',
			},
		};
	}

	// ==================== End ADK Helper Methods ====================


	private toVsCodeMessage(raw: unknown): vscode.LanguageModelChatMessage {
		let text = '';
		if (raw !== undefined && raw !== null) {
			if (typeof raw === 'string') {
				text = raw;
			} else {
				try {
					text = JSON.stringify(raw);
				} catch (error) {
					console.error('[LM Proxy] Failed to stringify request payload', error);
					text = String(raw);
				}
			}
		}

		return vscode.LanguageModelChatMessage.User(text);
	}

	private async resolveModel(_preferredModelId: string | undefined) {
		try {
			const models = await vscode.lm.selectChatModels({ id: 'gpt-5-mini' });
			if (models.length > 0) {
				return models[0];
			}

			console.warn('[LM Proxy] Preferred model "gpt-5-mini" not found; using first available model.');
			const fallbackModels = await vscode.lm.selectChatModels();
			return fallbackModels[0];
		} catch (error) {
			console.error('[LM Proxy] Unable to select chat models', error);
			return undefined;
		}
	}

	private nextRequestId(): string {
		this.requestCounter = (this.requestCounter + 1) % Number.MAX_SAFE_INTEGER;
		const id = this.requestCounter.toString(16).padStart(6, '0');
		return `req_${id}`;
	}

	private safeStringify(value: unknown): string {
		try {
			return JSON.stringify(value);
		} catch (error) {
			console.error('[LM Proxy] Failed to stringify value', error);
			return '[unserializable]';
		}
	}

	/**
	 * Decode base64 string to Uint8Array
	 */
	private base64ToUint8Array(base64: string): Uint8Array {
		// Remove data URI prefix if present (e.g., "data:image/png;base64,")
		const base64Data = base64.includes(',') ? base64.split(',')[1] : base64;
		const binaryString = Buffer.from(base64Data, 'base64');
		return new Uint8Array(binaryString);
	}

	/**
	 * Convert ADK content to VS Code LanguageModelChatMessage with image support
	 */
	private convertAdkContentToVsCodeMessage(
		content: AdkContent,
	): vscode.LanguageModelChatMessage {
		if (!content.parts || !Array.isArray(content.parts) || content.parts.length === 0) {
			// Empty content, return empty user message
			return vscode.LanguageModelChatMessage.User('');
		}

		// Check if we have any image data parts
		const hasImages = content.parts.some(part => part.data);

		if (!hasImages) {
			// Text-only message, use simple string content
			const text = content.parts
				.filter(part => part.text && typeof part.text === 'string')
				.map(part => part.text!)
				.join('\n');

			return content.role === 'model'
				? vscode.LanguageModelChatMessage.Assistant(text)
				: vscode.LanguageModelChatMessage.User(text);
		}

		// Mixed content (text + images), need to use content array
		const contentParts: Array<
			string | vscode.LanguageModelTextPart | vscode.LanguageModelDataPart
		> = [];

		for (const part of content.parts) {
			if (part.text && typeof part.text === 'string') {
				contentParts.push(part.text);
			} else if (part.data) {
				try {
					const imageData = this.base64ToUint8Array(part.data.data);
					// Use LanguageModelDataPart (Proposed API)
					const dataPart = new (vscode as any).LanguageModelDataPart(
						part.data.mime_type,
						imageData,
					);
					contentParts.push(dataPart);
				} catch (error) {
					console.error('[LM Proxy] Failed to decode image data:', error);
					contentParts.push('[Image data failed to decode]');
				}
			}
		}

		return content.role === 'model'
			? vscode.LanguageModelChatMessage.Assistant(contentParts)
			: vscode.LanguageModelChatMessage.User(contentParts);
	}

	/**
	 * Convert OpenAI content parts to VS Code LanguageModelChatMessage with image support
	 */
	private convertOaiContentToVsCodeMessage(
		content: OaiContentPart[],
		role: 'user' | 'assistant',
	): vscode.LanguageModelChatMessage {
		if (!content || content.length === 0) {
			// Empty content
			return role === 'assistant'
				? vscode.LanguageModelChatMessage.Assistant('')
				: vscode.LanguageModelChatMessage.User('');
		}

		// Check if we have any images
		const hasImages = content.some(part => part.type === 'image_url' || part.type === 'image_file');

		if (!hasImages) {
			// Text-only message
			const text = content
				.filter((part): part is { type: 'text'; text: { value: string } } => part.type === 'text')
				.map(part => part.text.value)
				.join('\n');

			return role === 'assistant'
				? vscode.LanguageModelChatMessage.Assistant(text)
				: vscode.LanguageModelChatMessage.User(text);
		}

		// Mixed content (text + images)
		const contentParts: Array<
			string | vscode.LanguageModelTextPart | vscode.LanguageModelDataPart
		> = [];

		for (const part of content) {
			if (part.type === 'text') {
				contentParts.push(part.text.value);
			} else if (part.type === 'image_url') {
				try {
					const url = part.image_url.url;
					// Check if it's a data URI
					if (url.startsWith('data:')) {
						// Extract mime type and base64 data
						const match = url.match(/^data:([^;]+);base64,(.+)$/);
						if (match) {
							const mimeType = match[1];
							const base64Data = match[2];
							const imageData = this.base64ToUint8Array(base64Data);
							const dataPart = new (vscode as any).LanguageModelDataPart(mimeType, imageData);
							contentParts.push(dataPart);
						} else {
							console.warn('[LM Proxy] Invalid data URI format:', url);
							contentParts.push('[Invalid image data URI]');
						}
					} else {
						// HTTP(S) URL - we'll need to fetch it
						console.warn('[LM Proxy] HTTP(S) image URLs are not yet supported:', url);
						contentParts.push(`[Image URL: ${url}]`);
					}
				} catch (error) {
					console.error('[LM Proxy] Failed to process image_url:', error);
					contentParts.push('[Image processing failed]');
				}
			} else if (part.type === 'image_file') {
				// File IDs are not supported in this proxy
				console.warn('[LM Proxy] image_file type is not supported:', part.image_file.file_id);
				contentParts.push(`[Image file ID: ${part.image_file.file_id}]`);
			}
		}

		return role === 'assistant'
			? vscode.LanguageModelChatMessage.Assistant(contentParts)
			: vscode.LanguageModelChatMessage.User(contentParts);
	}

	// No token-counting helper needed; the proxy forwards payloads directly.
}

let serverInstance: LmProxyServer | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	serverInstance = new LmProxyServer();
	try {
		await serverInstance.start();
		context.subscriptions.push(serverInstance);
	} catch (error) {
		console.error('[LM Proxy] Failed to start HTTP server', error);
		vscode.window.showErrorMessage(
			'The LM proxy server failed to start. Check the extension host logs for details.',
		);
	}
}

export function deactivate(): void {
	serverInstance?.dispose();
	serverInstance = undefined;
}
