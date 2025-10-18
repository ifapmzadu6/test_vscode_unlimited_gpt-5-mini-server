import * as http from 'http';
import express, { Request, Response } from 'express';
import * as vscode from 'vscode';

const DEFAULT_PORT = 3141;
const DEFAULT_HOST = '127.0.0.1';

type TextContentPart = { type: 'text'; text: string };

type ResponseApiContent =
	| string
	| TextContentPart
	| Array<TextContentPart | { type: string; [key: string]: unknown }>;

interface ResponseApiMessage {
	role: 'user' | 'assistant' | 'system';
	content?: ResponseApiContent;
}

interface ResponsesApiRequestBody {
	model?: string;
	input?: ResponseApiMessage[] | string;
	messages?: ResponseApiMessage[];
	stream?: boolean;
}

type ResponseOutputTextPart = {
	type: 'output_text';
	text: string;
	annotations: unknown[];
	logprobs?: unknown[];
};

type ResponseMessageItem = {
	id: string;
	type: 'message';
	role: 'assistant';
	status: 'in_progress' | 'completed';
	content: ResponseOutputTextPart[];
};

type ResponseUsageLike = {
	input_tokens: number;
	output_tokens: number;
	total_tokens: number;
	input_tokens_details: {
		cached_tokens: number;
	};
	output_tokens_details: {
		reasoning_tokens: number;
	};
};

class LmProxyServer implements vscode.Disposable {
	private server: http.Server | undefined;

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
			try {
				const body = req.body as ResponsesApiRequestBody | undefined;
				if (!body || typeof body !== 'object') {
					this.sendError(res, 400, 'Invalid request body');
					return;
				}

				const normalizedMessages = this.normalizeMessages(body);
				if (normalizedMessages.length === 0) {
					this.sendError(res, 400, 'Request must include at least one message');
					return;
				}

				const logMessages = normalizedMessages.map((message) => ({
					role: message.role,
					content: message.content,
				}));

				console.log('[LM Proxy] Incoming request', {
					model: body.model ?? 'auto',
					stream: body.stream === true,
					message_count: normalizedMessages.length,
					messages: logMessages,
				});

				const model = await this.resolveModel(body.model);
				if (!model) {
					this.sendError(res, 404, `No chat model found for id "${body.model ?? 'default'}"`);
					return;
				}

				const vsMessages = normalizedMessages.map((message) =>
					this.toVsCodeMessage(message.role, message.content),
				);

				if (this.isStreamRequest(req, body)) {
					await this.handleStreamResponse(req, res, model, vsMessages);
					return;
				}

				const tokenSource = new vscode.CancellationTokenSource();
				try {
					const response = await model.sendRequest(
						vsMessages,
						{
							justification:
								'External HTTP request routed through VS Code LM proxy server provided by the extension.',
						},
						tokenSource.token,
					);

					const textFragments: string[] = [];
					for await (const chunk of response.text) {
						textFragments.push(chunk);
					}

					const aggregatedText = textFragments.join('');
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
				} finally {
					tokenSource.dispose();
				}
			} catch (error) {
				console.error('[LM Proxy] request failed', error);
				this.sendError(res, 500, 'Failed to fulfill request via VS Code LM API');
			}
		});

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

	private isStreamRequest(req: Request, body: ResponsesApiRequestBody): boolean {
		if (body.stream === true) {
			return true;
		}
		const acceptHeader = req.get('accept') ?? '';
		return acceptHeader.includes('text/event-stream');
	}

	private startSse(res: Response): void {
		res.set({
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache, no-transform',
			Connection: 'keep-alive',
		});
		const anyRes = res as unknown as { flushHeaders?: () => void };
		anyRes.flushHeaders?.();
	}

	private writeSseEvent(res: Response, event: string, payload: unknown): void {
		res.write(`event: ${event}\n`);
		res.write(`data: ${JSON.stringify(payload)}\n\n`);
		const anyRes = res as unknown as { flush?: () => void };
		anyRes.flush?.();
	}

	private endSse(res: Response): void {
		res.write('data: [DONE]\n\n');
		res.end();
	}

	private createEmptyUsage(): ResponseUsageLike {
		return {
			input_tokens: 0,
			output_tokens: 0,
			total_tokens: 0,
			input_tokens_details: {
				cached_tokens: 0,
			},
			output_tokens_details: {
				reasoning_tokens: 0,
			},
		};
	}

	private createTextPart(text: string): ResponseOutputTextPart {
		return {
			type: 'output_text',
			text,
			annotations: [],
		};
	}

	private createMessageItem(
		id: string,
		status: 'in_progress' | 'completed',
		content: ResponseOutputTextPart[],
	): ResponseMessageItem {
		return {
			id,
			type: 'message',
			role: 'assistant',
			status,
			content,
		};
	}

	private createBaseResponse(
		modelId: string,
		responseId: string,
		createdAtSeconds: number,
		usage: ResponseUsageLike,
	): Record<string, unknown> {
		return {
			id: responseId,
			object: 'response',
			model: modelId,
			created_at: createdAtSeconds,
			status: 'in_progress',
			output: [] as ResponseMessageItem[],
			output_text: '',
			metadata: null,
			instructions: null,
			incomplete_details: null,
			error: null,
			parallel_tool_calls: false,
			temperature: null,
			tool_choice: 'none',
			tools: [] as unknown[],
			top_p: null,
			usage,
			service_tier: 'auto',
		};
	}

	private async handleStreamResponse(
		req: Request,
		res: Response,
		model: vscode.LanguageModelChat,
		messages: vscode.LanguageModelChatMessage[],
	): Promise<void> {
		const tokenSource = new vscode.CancellationTokenSource();
		const now = Date.now();
		const responseId = `resp_${now}`;
		const messageId = `msg_${now}`;
		const usage = this.createEmptyUsage();
		const baseResponse = this.createBaseResponse(model.id, responseId, Math.floor(now / 1000), usage);
		let sequenceNumber = 0;

		try {
			req.socket.setTimeout(0);
			req.socket.setNoDelay(true);
			req.socket.setKeepAlive(true);
		} catch {
			// Ignored: socket tuning best-effort only.
		}

		this.startSse(res);
		req.once('close', () => tokenSource.cancel());

		try {
			const response = await model.sendRequest(
				messages,
				{
					justification:
						'External HTTP request routed through VS Code LM proxy server provided by the extension.',
				},
				tokenSource.token,
			);

			const messageItem = this.createMessageItem(messageId, 'in_progress', []);
			const outputArray = baseResponse.output as ResponseMessageItem[];

			this.writeSseEvent(res, 'response.created', {
				type: 'response.created',
				response: baseResponse,
				sequence_number: sequenceNumber++,
			});

			this.writeSseEvent(res, 'response.in_progress', {
				type: 'response.in_progress',
				response: baseResponse,
				sequence_number: sequenceNumber++,
			});

			this.writeSseEvent(res, 'response.output_item.added', {
				type: 'response.output_item.added',
				item: { ...messageItem, content: [] },
				output_index: 0,
				sequence_number: sequenceNumber++,
			});

			outputArray.push(messageItem);

			const textPart = this.createTextPart('');

			this.writeSseEvent(res, 'response.content_part.added', {
				type: 'response.content_part.added',
				item_id: messageId,
				output_index: 0,
				content_index: 0,
				part: { ...textPart },
				sequence_number: sequenceNumber++,
			});

			messageItem.content.push(textPart);

			let aggregatedText = '';

			for await (const chunk of response.text) {
				if (typeof chunk !== 'string' || chunk.length === 0) {
					continue;
				}

				aggregatedText += chunk;
				textPart.text = aggregatedText;
				baseResponse.output_text = aggregatedText;

				this.writeSseEvent(res, 'response.output_text.delta', {
					type: 'response.output_text.delta',
					item_id: messageId,
					output_index: 0,
					content_index: 0,
					delta: chunk,
					sequence_number: sequenceNumber++,
				});
			}

			messageItem.content = [textPart];
			messageItem.status = 'completed';
			baseResponse.status = 'completed';
			baseResponse.output_text = textPart.text;

			this.writeSseEvent(res, 'response.output_text.done', {
				type: 'response.output_text.done',
				item_id: messageId,
				output_index: 0,
				content_index: 0,
				text: textPart.text,
				logprobs: [],
				sequence_number: sequenceNumber++,
			});

			this.writeSseEvent(res, 'response.content_part.done', {
				type: 'response.content_part.done',
				item_id: messageId,
				output_index: 0,
				content_index: 0,
				part: { ...textPart },
				sequence_number: sequenceNumber++,
			});

			this.writeSseEvent(res, 'response.output_item.done', {
				type: 'response.output_item.done',
				item: {
					...messageItem,
					content: messageItem.content.map((part) => ({
						...part,
						annotations: Array.isArray(part.annotations) ? [...part.annotations] : [],
					})),
				},
				output_index: 0,
				sequence_number: sequenceNumber++,
			});

			baseResponse.output = [messageItem];

			this.writeSseEvent(res, 'response.completed', {
				type: 'response.completed',
				response: baseResponse,
				sequence_number: sequenceNumber++,
			});

			this.endSse(res);
		} catch (error) {
			console.error('[LM Proxy] streaming request failed', error);

			if (!res.headersSent) {
				this.sendError(res, 500, 'Failed to fulfill request via VS Code LM API');
			} else {
				baseResponse.status = 'failed';
				baseResponse.error = {
					code: 'server_error',
					message: 'Failed to fulfill request via VS Code LM API',
				};

				this.writeSseEvent(res, 'response.failed', {
					type: 'response.failed',
					response: baseResponse,
					sequence_number: sequenceNumber++,
				});

				this.endSse(res);
			}
		} finally {
			tokenSource.dispose();
		}
	}

	private normalizeMessages(body: ResponsesApiRequestBody): ResponseApiMessage[] {
		const fromArray = (messages: unknown[]): ResponseApiMessage[] =>
			messages
				.filter((item): item is { role?: unknown; content?: unknown } => typeof item === 'object' && item !== null)
				.map((item) => {
					const candidateRole = typeof item.role === 'string' ? item.role : 'user';
					return {
						role: this.normalizeRole(candidateRole),
						content: item.content as ResponseApiContent | undefined,
					};
				});

		if (Array.isArray(body.messages)) {
			return fromArray(body.messages);
		}

		if (Array.isArray(body.input)) {
			return fromArray(body.input);
		}

		if (typeof body.input === 'string') {
			return [{ role: 'user', content: { type: 'text', text: body.input } }];
		}

		return [];
	}

	private normalizeRole(candidate: string): ResponseApiMessage['role'] {
		if (candidate === 'assistant') {
			return 'assistant';
		}
		if (candidate === 'system') {
			return 'system';
		}
		return 'user';
	}

	private toVsCodeMessage(
		role: ResponseApiMessage['role'],
		content: ResponseApiContent | undefined,
	): vscode.LanguageModelChatMessage {
		const text = this.extractTextContent(content);

		if (role === 'assistant') {
			return vscode.LanguageModelChatMessage.Assistant(text);
		}

		if (role === 'user') {
			return vscode.LanguageModelChatMessage.User(text);
		}

		// VS Code LM API does not currently expose a system role. Treat it as user context.
		return vscode.LanguageModelChatMessage.User(`[system prompt]\n${text}`);
	}

	private extractTextContent(content: ResponseApiContent | undefined): string {
		if (!content) {
			return '';
		}

		if (typeof content === 'string') {
			return content;
		}

		if (Array.isArray(content)) {
			return content
				.map((part) => {
					if (typeof part !== 'object' || !part) {
						return '';
					}
					if ('text' in part && typeof part.text === 'string') {
						return part.text;
					}
					return '';
				})
				.filter((value) => value.length > 0)
				.join('\n');
		}

		if (typeof content === 'object' && 'text' in content && typeof content.text === 'string') {
			return content.text;
		}

		return '';
	}

	private async resolveModel(preferredModelId: string | undefined) {
		try {
			if (preferredModelId) {
				const [model] = await vscode.lm.selectChatModels({ id: preferredModelId });
				if (model) {
					return model;
				}
			}

			const models = await vscode.lm.selectChatModels();
			return models[0];
		} catch (error) {
			console.error('[LM Proxy] Unable to select chat models', error);
			return undefined;
		}
	}
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
