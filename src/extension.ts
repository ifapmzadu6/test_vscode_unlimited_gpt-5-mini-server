import * as http from 'http';
import express, { Response } from 'express';
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
}

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

				const model = await this.resolveModel(body.model);
				if (!model) {
					this.sendError(res, 404, `No chat model found for id "${body.model ?? 'default'}"`);
					return;
				}

				const vsMessages = normalizedMessages.map((message) =>
					this.toVsCodeMessage(message.role, message.content),
				);

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
