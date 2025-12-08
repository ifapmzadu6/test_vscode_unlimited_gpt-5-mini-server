"""
OpenAI Assistants API (互換) で画像を送信する例
VS Code Insiders版でマルチモーダル対応のLMプロキシサーバーを使用
"""

import base64
import requests
from pathlib import Path

# プロキシサーバーのURL
BASE_URL = "http://127.0.0.1:3141/v1"


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


def example_1_create_thread_with_image(image_path: str):
    """方法1: スレッドを作成してメッセージに画像を追加"""
    print("=== 方法1: スレッド作成 + メッセージ追加 ===\n")

    # 1. スレッドを作成
    thread_response = requests.post(f"{BASE_URL}/threads")
    thread = thread_response.json()
    thread_id = thread['id']
    print(f"スレッド作成: {thread_id}")

    # 2. テキストと画像を含むメッセージを追加
    image_uri = encode_image_to_data_uri(image_path)
    message_payload = {
        "role": "user",
        "content": [
            {"type": "text", "text": {"value": "この画像には何が写っていますか？"}},
            {
                "type": "image_url",
                "image_url": {"url": image_uri}
            }
        ]
    }

    message_response = requests.post(
        f"{BASE_URL}/threads/{thread_id}/messages",
        json=message_payload
    )
    message = message_response.json()
    print(f"メッセージ追加: {message['id']}")

    # 3. Runを実行してAIの応答を取得
    run_payload = {
        "assistant_id": "asst_default"
    }
    run_response = requests.post(
        f"{BASE_URL}/threads/{thread_id}/runs",
        json=run_payload
    )
    run = run_response.json()
    print(f"\nRun実行: {run['id']}")
    print(f"ステータス: {run['status']}")

    # 4. スレッドのメッセージ一覧を取得（AIの応答を含む）
    messages_response = requests.get(f"{BASE_URL}/threads/{thread_id}/messages")
    messages = messages_response.json()

    print("\n=== 会話履歴 ===")
    for msg in messages['data']:
        role = msg['role']
        content = msg['content'][0]
        if content['type'] == 'text':
            text = content['text']['value']
            print(f"{role}: {text}")
        elif content['type'] == 'image_url':
            print(f"{role}: [画像]")

    print()


def example_2_create_and_run_with_image(image_path: str):
    """方法2: スレッド作成とRun実行を同時に行う"""
    print("=== 方法2: スレッド作成 + Run実行（同時） ===\n")

    image_uri = encode_image_to_data_uri(image_path)

    payload = {
        "assistant_id": "asst_default",
        "thread": {
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": {"value": "この画像を詳しく説明してください。"}},
                        {
                            "type": "image_url",
                            "image_url": {"url": image_uri}
                        }
                    ]
                }
            ]
        }
    }

    response = requests.post(f"{BASE_URL}/threads/runs", json=payload)
    run = response.json()

    print(f"スレッドID: {run['thread_id']}")
    print(f"Run ID: {run['id']}")
    print(f"ステータス: {run['status']}")

    # スレッドのメッセージを取得
    thread_id = run['thread_id']
    messages_response = requests.get(f"{BASE_URL}/threads/{thread_id}/messages")
    messages = messages_response.json()

    print("\n=== 会話内容 ===")
    for msg in messages['data']:
        role = msg['role']
        for content_part in msg['content']:
            if content_part['type'] == 'text':
                text = content_part['text']['value']
                print(f"{role}: {text}")
            elif content_part['type'] == 'image_url':
                print(f"{role}: [画像が添付されています]")

    print()


def example_3_text_and_multiple_images(image_paths: list[str]):
    """方法3: 複数の画像を同時に送信"""
    print("=== 方法3: 複数画像を送信 ===\n")

    # contentの配列を構築
    content = [
        {"type": "text", "text": {"value": "これらの画像を比較して、違いを教えてください。"}}
    ]

    for image_path in image_paths:
        image_uri = encode_image_to_data_uri(image_path)
        content.append({
            "type": "image_url",
            "image_url": {"url": image_uri}
        })

    payload = {
        "assistant_id": "asst_default",
        "thread": {
            "messages": [
                {
                    "role": "user",
                    "content": content
                }
            ]
        }
    }

    response = requests.post(f"{BASE_URL}/threads/runs", json=payload)
    run = response.json()

    print(f"送信した画像数: {len(image_paths)}")
    print(f"Run ステータス: {run['status']}")

    # 応答を取得
    thread_id = run['thread_id']
    messages_response = requests.get(f"{BASE_URL}/threads/{thread_id}/messages")
    messages = messages_response.json()

    # アシスタントの応答を表示
    for msg in messages['data']:
        if msg['role'] == 'assistant':
            text = msg['content'][0]['text']['value']
            print(f"\nアシスタント: {text}")

    print()


def example_4_text_only():
    """比較用: テキストのみの送信"""
    print("=== 比較: テキストのみ ===\n")

    payload = {
        "assistant_id": "asst_default",
        "thread": {
            "messages": [
                {
                    "role": "user",
                    "content": "こんにちは！今日の天気はどうですか？"
                }
            ]
        }
    }

    response = requests.post(f"{BASE_URL}/threads/runs", json=payload)
    run = response.json()

    # 応答を取得
    thread_id = run['thread_id']
    messages_response = requests.get(f"{BASE_URL}/threads/{thread_id}/messages")
    messages = messages_response.json()

    for msg in messages['data']:
        role = msg['role']
        text = msg['content'][0]['text']['value']
        print(f"{role}: {text}")

    print()


if __name__ == "__main__":
    print("=== OpenAI Assistants API 画像送信例 ===\n")

    # テキストのみの例（すぐに実行可能）
    example_4_text_only()

    # 画像を使う例（画像パスを指定する必要があります）
    # example_1_create_thread_with_image("path/to/your/image.png")
    # example_2_create_and_run_with_image("path/to/your/image.png")
    # example_3_text_and_multiple_images(["image1.png", "image2.png"])

    print("\n画像を使う場合は、上記のコメントアウトを外して画像パスを指定してください。")
