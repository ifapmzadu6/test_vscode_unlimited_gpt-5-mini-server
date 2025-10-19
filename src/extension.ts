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

class LmProxyServer implements vscode.Disposable {
	private server: http.Server | undefined;
	private requestCounter = 0;

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
				const tokenEstimate = await this.countTokensWithTimeout(model, vsMessages[0], requestId, 5000);
				if (tokenEstimate !== undefined) {
					console.log(`[LM Proxy][${requestId}] VS Code LM token estimate=${tokenEstimate}`);
				}

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

	private async countTokensWithTimeout(
		model: vscode.LanguageModelChat,
		message: vscode.LanguageModelChatMessage,
		requestId: string,
		timeoutMs: number,
	): Promise<number | undefined> {
		const start = Date.now();
		let timeoutHandle: NodeJS.Timeout | undefined;
		const timeout = new Promise<undefined>((resolve) => {
			timeoutHandle = setTimeout(() => {
				console.warn(
					`[LM Proxy][${requestId}] Token estimation timed out after ${timeoutMs}ms; continuing without value.`,
				);
				resolve(undefined);
			}, timeoutMs);
		});

		try {
			const estimation = (await Promise.race([model.countTokens(message), timeout])) as
				| number
				| undefined;
			if (timeoutHandle) {
				clearTimeout(timeoutHandle);
			}
			if (estimation !== undefined) {
				console.log(
					`[LM Proxy][${requestId}] Token estimation completed in ${Date.now() - start}ms`,
				);
			}
			return estimation;
		} catch (error) {
			if (timeoutHandle) {
				clearTimeout(timeoutHandle);
			}
			console.warn(
				`[LM Proxy][${requestId}] Failed to estimate tokens: ${
					error instanceof Error ? error.message : error
				}`,
			);
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
