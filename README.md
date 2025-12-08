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

または `input` に文字列またはメッセージ配列を渡すこともできます。`content` は `type: text` をサポートしています。VS Code Insiders版では画像入力（`type: image_url`）もサポートします（詳細は「マルチモーダル（画像）対応」セクションを参照）。

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

## Google ADK 互換 API

このサーバーは Google Agent Development Kit (ADK) クライアントからも接続可能です。

### `GET /list-apps`

利用可能なアプリ一覧を返します。

```bash
curl http://127.0.0.1:3141/list-apps
# => ["vscode-lm-proxy"]
```

### `POST /run`

ADK 形式でエージェントを実行します（非ストリーミング）。

```bash
curl -X POST http://127.0.0.1:3141/run \
  -H "Content-Type: application/json" \
  -d '{
    "app_name": "vscode-lm-proxy",
    "user_id": "user-123",
    "session_id": "session-456",
    "new_message": {
      "parts": [{"text": "こんにちは"}],
      "role": "user"
    }
  }'
```

レスポンスは ADK Event 配列形式:

```json
[
  {
    "id": "evt_00000001",
    "invocation_id": "inv_1234567890",
    "timestamp": 1234567890.123,
    "author": "assistant",
    "content": {
      "parts": [{"text": "こんにちは！何かお手伝いできることはありますか？"}],
      "role": "model"
    }
  }
]
```

### `POST /run_sse`

ADK 形式でエージェントを実行します（SSE ストリーミング）。

```bash
curl -N http://127.0.0.1:3141/run_sse \
  -H "Content-Type: application/json" \
  -d '{
    "app_name": "vscode-lm-proxy",
    "user_id": "user-123",
    "session_id": "session-456",
    "new_message": {
      "parts": [{"text": "長い説明をしてください"}],
      "role": "user"
    }
  }'
```

### セッション管理

- `GET /apps/{app_name}/users/{user_id}/sessions` - セッション一覧
- `POST /apps/{app_name}/users/{user_id}/sessions` - 新規セッション作成
- `GET /apps/{app_name}/users/{user_id}/sessions/{session_id}` - セッション詳細
- `DELETE /apps/{app_name}/users/{user_id}/sessions/{session_id}` - セッション削除

### ADK クライアントからの接続

ADK クライアントで `base_url` をこのサーバーに向けて設定してください:

```python
# 例: ADK を LiteLLM 経由で接続する場合
# このサーバーを http://127.0.0.1:3141 で起動した状態で
# ADK の設定でエンドポイントを指定
```

## マルチモーダル（画像）対応

**VS Code Insiders版で画像入力をサポートします**（Proposed API: `languageModelDataPart`）

### Google ADK API

画像を送信するには、`parts`に`data`フィールドを含めます：

```jsonc
{
  "app_name": "vscode-lm-proxy",
  "user_id": "user-123",
  "session_id": "session-456",
  "new_message": {
    "parts": [
      {"text": "この画像には何が写っていますか？"},
      {
        "data": {
          "data": "iVBORw0KGgoAAAANSUhEUgAAAAUA...", // base64エンコードされた画像データ
          "mime_type": "image/png"
        }
      }
    ],
    "role": "user"
  }
}
```

### OpenAI Assistants API

画像を送信するには、`content`配列に`image_url`タイプを含めます：

```jsonc
{
  "role": "user",
  "content": [
    {"type": "text", "text": {"value": "この画像には何が写っていますか？"}},
    {
      "type": "image_url",
      "image_url": {
        "url": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA..."
      }
    }
  ]
}
```

**注意：**
- 現在、data URI形式（`data:image/...;base64,...`）のみサポートしています
- HTTP(S) URLからの画像取得は未対応です
- `image_file`タイプ（ファイルID）は未対応です

## 注意事項

- **画像対応**：VS Code Insiders版のProposed APIを使用して画像入力をサポートしています。安定版VS Codeでは画像機能は利用できません。
- **ツール呼び出し**：現在未対応です。
- モデルが提供するトークン数などの詳細メトリクスは取得できないため `usage` フィールドはゼロを返します。
- モデル呼び出しはユーザー承認が必要です。初回リクエストで拒否された場合、クライアント側には 500 エラーが返ります。VS Code でアクセス許可を確認してください。
- ADK API: セッション状態はメモリ内のみ保存され、サーバー再起動で消失します。
