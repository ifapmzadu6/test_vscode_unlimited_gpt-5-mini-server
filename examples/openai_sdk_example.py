"""
OpenAI Python SDK を使った画像送信例
VS Code Insiders版でマルチモーダル対応のLMプロキシサーバーを使用

インストール:
    pip install openai
"""

import base64
from pathlib import Path
from openai import OpenAI

# プロキシサーバーに接続
client = OpenAI(
    base_url="http://127.0.0.1:3141/v1",
    api_key="dummy-key"  # プロキシサーバーではAPI keyは不要ですが、SDKの要件で必要
)


def encode_image_to_data_uri(image_path: str) -> str:
    """画像ファイルをdata URI形式にエンコード"""
    path = Path(image_path)
    mime_types = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp'
    }
    mime_type = mime_types.get(path.suffix.lower(), 'image/png')

    with open(image_path, 'rb') as f:
        image_data = base64.b64encode(f.read()).decode('utf-8')

    return f"data:{mime_type};base64,{image_data}"


def example_sdk_text_only():
    """OpenAI SDK でテキストのみを送信"""
    print("=== OpenAI SDK: テキストのみ ===\n")

    # スレッド作成とRun実行を同時に
    run = client.beta.threads.create_and_run(
        assistant_id="asst_default",
        thread={
            "messages": [
                {
                    "role": "user",
                    "content": "こんにちは！元気ですか？"
                }
            ]
        }
    )

    print(f"Thread ID: {run.thread_id}")
    print(f"Run ID: {run.id}")
    print(f"Status: {run.status}")

    # メッセージを取得
    messages = client.beta.threads.messages.list(thread_id=run.thread_id)
    for message in messages.data:
        role = message.role
        content = message.content[0].text.value
        print(f"{role}: {content}")

    print()


def example_sdk_with_image(image_path: str):
    """OpenAI SDK で画像を送信"""
    print("=== OpenAI SDK: 画像付き ===\n")

    image_uri = encode_image_to_data_uri(image_path)

    run = client.beta.threads.create_and_run(
        assistant_id="asst_default",
        thread={
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": "この画像には何が写っていますか？"
                        },
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": image_uri
                            }
                        }
                    ]
                }
            ]
        }
    )

    print(f"Thread ID: {run.thread_id}")
    print(f"Run ID: {run.id}")
    print(f"Status: {run.status}")

    # メッセージを取得
    messages = client.beta.threads.messages.list(thread_id=run.thread_id)

    print("\n=== 会話 ===")
    for message in reversed(messages.data):
        role = message.role
        for content in message.content:
            if content.type == 'text':
                print(f"{role}: {content.text.value}")
            elif hasattr(content, 'image_url'):
                print(f"{role}: [画像]")

    print()


def example_sdk_step_by_step(image_path: str):
    """OpenAI SDK でステップごとに実行"""
    print("=== OpenAI SDK: ステップ実行 ===\n")

    # 1. スレッド作成
    thread = client.beta.threads.create()
    print(f"1. スレッド作成: {thread.id}")

    # 2. メッセージを追加（画像付き）
    image_uri = encode_image_to_data_uri(image_path)
    message = client.beta.threads.messages.create(
        thread_id=thread.id,
        role="user",
        content=[
            {
                "type": "text",
                "text": "この画像を分析して、詳しく説明してください。"
            },
            {
                "type": "image_url",
                "image_url": {"url": image_uri}
            }
        ]
    )
    print(f"2. メッセージ追加: {message.id}")

    # 3. Runを実行
    run = client.beta.threads.runs.create(
        thread_id=thread.id,
        assistant_id="asst_default"
    )
    print(f"3. Run実行: {run.id}")
    print(f"   ステータス: {run.status}")

    # 4. メッセージ履歴を取得
    messages = client.beta.threads.messages.list(thread_id=thread.id)

    print("\n4. メッセージ履歴:")
    for msg in reversed(messages.data):
        role = msg.role
        print(f"\n[{role.upper()}]")
        for content in msg.content:
            if content.type == 'text':
                print(f"  {content.text.value}")
            elif hasattr(content, 'image_url'):
                print(f"  [画像が添付されています]")

    print()


def example_sdk_multiple_images(image_paths: list[str]):
    """OpenAI SDK で複数画像を送信"""
    print("=== OpenAI SDK: 複数画像 ===\n")

    # contentを構築
    content = [
        {
            "type": "text",
            "text": f"{len(image_paths)}枚の画像を送ります。それぞれの特徴を説明してください。"
        }
    ]

    for i, image_path in enumerate(image_paths, 1):
        image_uri = encode_image_to_data_uri(image_path)
        content.append({
            "type": "image_url",
            "image_url": {"url": image_uri}
        })

    run = client.beta.threads.create_and_run(
        assistant_id="asst_default",
        thread={
            "messages": [
                {
                    "role": "user",
                    "content": content
                }
            ]
        }
    )

    print(f"送信画像数: {len(image_paths)}")
    print(f"Thread ID: {run.thread_id}")
    print(f"Status: {run.status}")

    # 応答取得
    messages = client.beta.threads.messages.list(thread_id=run.thread_id)
    for message in messages.data:
        if message.role == 'assistant':
            print(f"\nアシスタント: {message.content[0].text.value}")

    print()


if __name__ == "__main__":
    print("=== OpenAI SDK を使った画像送信例 ===\n")

    # テキストのみの例（すぐに実行可能）
    example_sdk_text_only()

    # 画像を使う例（画像パスを指定する必要があります）
    # example_sdk_with_image("path/to/your/image.png")
    # example_sdk_step_by_step("path/to/your/image.png")
    # example_sdk_multiple_images(["image1.png", "image2.png", "image3.png"])

    print("\n画像を使う場合は、上記のコメントアウトを外して画像パスを指定してください。")
    print("\n必要なパッケージ: pip install openai")
