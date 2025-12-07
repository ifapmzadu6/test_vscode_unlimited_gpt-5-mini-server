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

class LmProxyServer implements vscode.Disposable {
	private server: http.Server | undefined;
	private requestCounter = 0;
	private eventCounter = 0;
	private sessions: Map<string, Session> = new Map();

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

				const userText = this.extractTextFromAdkContent(body!.new_message);
				if (!userText) {
					this.sendAdkError(res, 400, 'No text content in new_message');
					return;
				}

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

				// Build message array from history + new message
				const vsMessages: vscode.LanguageModelChatMessage[] = [];
				for (const historyItem of session.history) {
					const text = this.extractTextFromAdkContent(historyItem);
					if (historyItem.role === 'user') {
						vsMessages.push(vscode.LanguageModelChatMessage.User(text));
					} else {
						vsMessages.push(vscode.LanguageModelChatMessage.Assistant(text));
					}
				}
				// Add current user message
				vsMessages.push(vscode.LanguageModelChatMessage.User(userText));

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

				const userText = this.extractTextFromAdkContent(body!.new_message);
				if (!userText) {
					this.sendAdkError(res, 400, 'No text content in new_message');
					return;
				}

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

				// Build message array from history + new message
				const vsMessages: vscode.LanguageModelChatMessage[] = [];
				for (const historyItem of session.history) {
					const text = this.extractTextFromAdkContent(historyItem);
					if (historyItem.role === 'user') {
						vsMessages.push(vscode.LanguageModelChatMessage.User(text));
					} else {
						vsMessages.push(vscode.LanguageModelChatMessage.Assistant(text));
					}
				}
				vsMessages.push(vscode.LanguageModelChatMessage.User(userText));

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
