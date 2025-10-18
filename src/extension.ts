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

				console.log('[LM Proxy] Incoming request body:', req.body);

				const model = await this.resolveModel(body.model);
				if (!model) {
					this.sendError(res, 404, `No chat model found for id "${body.model ?? 'default'}"`);
					return;
				}

				const vsMessages = [this.toVsCodeMessage(req.body)];

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
					console.log('[LM Proxy] Response text:', aggregatedText);
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
