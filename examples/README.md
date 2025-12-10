# 使用例

このディレクトリには、VS Code LM Proxy Server を使用した画像マルチモーダル対応の実装例が含まれています。

## 必要な環境

- **VS Code Insiders版** が必要です（Proposed API `languageModelDataPart` を使用）
- Python 3.7+
- `requests` ライブラリ（ADK例、OpenAI直接API例）
- `openai` ライブラリ（OpenAI SDK例）

## インストール

```bash
# requests のインストール
pip install requests

# OpenAI SDK のインストール（SDK例を使う場合）
pip install openai
```

## ファイル一覧

### 1. `adk_image_example.py`
**Google ADK API を使った画像送信例**

- テキストのみの送信
- 画像1枚の送信
- ストリーミング（SSE）での画像送信
- 複数画像の同時送信

```bash
python examples/adk_image_example.py
```

### 2. `openai_image_example.py`
**OpenAI Assistants API（直接HTTP）を使った画像送信例**

- スレッド作成 → メッセージ追加 → Run実行
- スレッド作成とRun実行を同時に行う
- 複数画像の送信
- テキストのみの送信（比較用）

```bash
python examples/openai_image_example.py
```

### 3. `openai_sdk_example.py`
**OpenAI Python SDK を使った画像送信例**

公式のOpenAI SDKを使用して、より簡潔に画像を送信できます。

- SDK経由でテキストのみ送信
- SDK経由で画像を送信
- ステップごとの詳細な実行
- 複数画像の送信

```bash
python examples/openai_sdk_example.py
```

## 使い方

### 基本的な流れ

1. **VS Code Insiders版でプロキシサーバーを起動**
   - 拡張機能をインストールして起動
   - デフォルトで `http://127.0.0.1:3141` で待機

2. **画像を準備**
   - PNG, JPEG, GIF, WebP などの画像ファイル
   - 例: `test_image.png`

3. **サンプルコードを編集**
   - コメントアウトされている部分を有効化
   - 画像パスを実際のファイルパスに変更

4. **実行**
   ```bash
   python examples/adk_image_example.py
   # または
   python examples/openai_image_example.py
   # または
   python examples/openai_sdk_example.py
   ```

## ADK vs OpenAI SDK の選択

### Google ADK API を使う場合

- **エンドポイント**: `/run`, `/run_sse`
- **フォーマット**: ADK形式のJSON
- **セッション管理**: サーバー側で自動管理
- **ストリーミング**: SSE形式のストリーミング対応

```python
{
    "app_name": "vscode-lm-proxy",
    "user_id": "user-123",
    "session_id": "session-456",
    "new_message": {
        "parts": [
            {"text": "質問内容"},
            {"data": {"data": "base64画像", "mime_type": "image/png"}}
        ],
        "role": "user"
    }
}
```

### OpenAI Assistants API を使う場合

- **エンドポイント**: `/v1/threads`, `/v1/threads/:id/messages`, `/v1/threads/:id/runs`
- **フォーマット**: OpenAI Assistants API互換
- **スレッド管理**: 明示的なスレッド作成が必要
- **SDK対応**: 公式OpenAI SDKが使える

```python
{
    "role": "user",
    "content": [
        {"type": "text", "text": {"value": "質問内容"}},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,..."}}
    ]
}
```

## 画像フォーマット

### サポートしている形式

- **ADK**: base64エンコード + MIMEタイプ指定
- **OpenAI**: data URI形式（`data:image/png;base64,...`）

### 現在の制限

- ✅ data URI形式（base64エンコード）
- ❌ HTTP(S) URLからの画像取得
- ❌ ファイルID（`image_file`タイプ）

## トラブルシューティング

### エラー: "No language model available"
- VS Code Insiders でモデルが選択されているか確認
- 初回実行時にアクセス許可ダイアログが表示されるので、許可してください

### エラー: "LanguageModelDataPart is not defined"
- VS Code Insiders版を使用していることを確認
- package.json に `"enabledApiProposals": ["languageModelDataPart"]` が設定されているか確認

### 画像が送信されない
- base64エンコードが正しいか確認
- MIMEタイプが正しいか確認（image/png, image/jpeg など）
- 画像ファイルサイズが大きすぎないか確認

### モデルが画像を認識しない
- 使用しているモデルがビジョン機能をサポートしているか確認
- VS Code で選択されているモデルの `capabilities.imageInput` が `true` であることを確認

## その他の例

より詳しい使い方は各ファイルのコメントを参照してください。各例には複数のシナリオが含まれています。
