"""
Google ADK で画像を送信する例
VS Code Insiders版でマルチモーダル対応のLMプロキシサーバーを使用
"""

import base64
import requests
from pathlib import Path

# プロキシサーバーのURL
BASE_URL = "http://127.0.0.1:3141"

def encode_image(image_path: str) -> tuple[str, str]:
    """画像ファイルをbase64エンコードしてMIMEタイプと共に返す"""
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

    return image_data, mime_type


def send_text_only():
    """テキストのみを送信する例"""
    payload = {
        "app_name": "vscode-lm-proxy",
        "user_id": "user-123",
        "session_id": "session-456",
        "new_message": {
            "parts": [
                {"text": "こんにちは！"}
            ],
            "role": "user"
        }
    }

    response = requests.post(f"{BASE_URL}/run", json=payload)
    print("テキストのみの応答:")
    print(response.json())
    print()


def send_with_image(image_path: str):
    """テキストと画像を送信する例"""
    image_data, mime_type = encode_image(image_path)

    payload = {
        "app_name": "vscode-lm-proxy",
        "user_id": "user-123",
        "session_id": "session-789",  # 別のセッション
        "new_message": {
            "parts": [
                {"text": "この画像には何が写っていますか？"},
                {
                    "data": {
                        "data": image_data,
                        "mime_type": mime_type
                    }
                }
            ],
            "role": "user"
        }
    }

    response = requests.post(f"{BASE_URL}/run", json=payload)
    print("画像付きの応答:")
    print(response.json())
    print()


def send_with_image_streaming(image_path: str):
    """画像をストリーミングで送信する例（SSE）"""
    image_data, mime_type = encode_image(image_path)

    payload = {
        "app_name": "vscode-lm-proxy",
        "user_id": "user-123",
        "session_id": "session-streaming",
        "new_message": {
            "parts": [
                {"text": "この画像を詳しく説明してください。"},
                {
                    "data": {
                        "data": image_data,
                        "mime_type": mime_type
                    }
                }
            ],
            "role": "user"
        }
    }

    print("ストリーミング応答:")
    response = requests.post(f"{BASE_URL}/run_sse", json=payload, stream=True)

    for line in response.iter_lines():
        if line:
            decoded = line.decode('utf-8')
            if decoded.startswith('data: '):
                data = decoded[6:]  # "data: " を削除
                if data == '[DONE]':
                    print("\n[完了]")
                    break
                print(data)
    print()


def send_multiple_images(image_paths: list[str]):
    """複数の画像を同時に送信する例"""
    parts = [{"text": "これらの画像を比較して違いを説明してください。"}]

    for image_path in image_paths:
        image_data, mime_type = encode_image(image_path)
        parts.append({
            "data": {
                "data": image_data,
                "mime_type": mime_type
            }
        })

    payload = {
        "app_name": "vscode-lm-proxy",
        "user_id": "user-123",
        "session_id": "session-multi",
        "new_message": {
            "parts": parts,
            "role": "user"
        }
    }

    response = requests.post(f"{BASE_URL}/run", json=payload)
    print("複数画像の応答:")
    print(response.json())
    print()


if __name__ == "__main__":
    # 使用例
    print("=== ADK API 画像送信例 ===\n")

    # 1. テキストのみ
    send_text_only()

    # 2. 画像を1枚送信（画像ファイルのパスを指定）
    # send_with_image("path/to/your/image.png")

    # 3. ストリーミングで画像送信
    # send_with_image_streaming("path/to/your/image.png")

    # 4. 複数画像を送信
    # send_multiple_images(["image1.png", "image2.png"])

    print("\n画像を使う場合は、上記のコメントアウトを外して画像パスを指定してください。")
