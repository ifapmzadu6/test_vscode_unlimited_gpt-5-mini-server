# VS Code LM Proxy Server

この拡張機能は、VS Code が提供する Language Model (LM) API へのアクセスを OpenAI Responses API 互換の HTTP インターフェイスとして公開するローカルプロキシサーバーです。外部クライアントは拡張機能が立ち上げるローカルサーバーに対して OpenAI の `/v1/responses` エンドポイントと同様のリクエストを送り、その結果を VS Code 内で利用可能な言語モデルに転送して応答を取得できます。

## セットアップ

1. 依存関係をインストールし、TypeScript をビルドします。

   ```bash
   npm install
   npm run compile
   ```

2. VS Code で「Launch Extension」構成を使って拡張機能を起動するか、`vsce package` で `.vsix` を生成してインストールします。

拡張機能は起動時に自動的にサーバーを立ち上げます。初回のモデル呼び出し時には VS Code からアクセス許可ダイアログが表示される場合があります。

## サーバー設定

デフォルトでは `127.0.0.1:3141` でリッスンします。次の設定で変更できます。

| 設定キー | 説明 |
|----------|------|
| `lmProxyServer.host` | バインドするホスト名または IP。 |
| `lmProxyServer.port` | 利用するポート番号。環境変数 `VS_CODE_LM_PROXY_PORT` でも上書き可能。 |

## エンドポイント

### `GET /health`

状態確認用エンドポイント。`{"status": "ok"}` を返します。

### `POST /v1/responses`

OpenAI Responses API 互換のボディを受け取り、VS Code LM API に転送します。サポートしている主なフィールド:

```jsonc
{
  "model": "model-id",          // 省略時は VS Code で使用可能な最初のモデルが選択されます
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "こんにちは" }
      ]
    }
  ]
}
```

または `input` に文字列またはメッセージ配列を渡すこともできます。`content` は `type: text` のみサポートしています。

応答は OpenAI Responses API のレスポンス形式を模した JSON を返します。

```json
{
  "id": "resp_1710666570000",
  "object": "response",
  "created": 1710666570,
  "model": "resolved-model-id",
  "usage": {
    "input_tokens": 0,
    "output_tokens": 0,
    "total_tokens": 0
  },
  "choices": [
    {
      "index": 0,
      "type": "message",
      "message": {
        "role": "assistant",
        "content": [
          { "type": "text", "text": "モデルの応答..." }
        ]
      },
      "finish_reason": "stop"
    }
  ]
}
```

#### ストリーミング

リクエストボディで `stream: true` を指定すると、`text/event-stream` を用いた SSE 形式でレスポンスをストリーム配信します。OpenAI Responses API と同様に `response.created` や `response.output_text.delta` などのイベントが順次送られ、最後に `[DONE]` が送信されます。

```bash
curl -N \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{
        "model": "gpt-5-mini",
        "stream": true,
        "messages": [
          { "role": "user", "content": [{ "type": "text", "text": "ストリームで応答して" }] }
        ]
      }' \
  http://127.0.0.1:3141/v1/responses
```

現在はテキストデルタのみをサポートし、ツール呼び出しやその他のイベントは未対応です。

## 注意事項

- VS Code の LM API 制約により、ツール呼び出しや画像などの高度なコンテンツは未対応です。
- モデルが提供するトークン数などの詳細メトリクスは取得できないため `usage` フィールドはゼロを返します。
- モデル呼び出しはユーザー承認が必要です。初回リクエストで拒否された場合、クライアント側には 500 エラーが返ります。VS Code でアクセス許可を確認してください。
