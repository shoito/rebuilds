# Messaging: Slack

## 投稿

1. クライアントが `client_msg_id`（UUID）を生成し、画面に「送信中」で仮表示する。
2. `POST /workspaces/{ws}/channels/{id}/messages` を送る。
3. 認証ミドルウェアがメンバーを解決し、テナントのコンテキストを設定したトランザクションを開始する（[data-model.md](data-model.md) の「テナントのコンテキスト」）。API はその中で次を行う。
   - チャンネルのメンバーであることを確認する
   - `last_seq` を採番する
   - `messages` に INSERT する（`client_msg_id` の一意制約に当たったら、既存の行を返す）
   - `mentions` と `outbox` に INSERT する
4. コミット後、`seq` 付きのメッセージを返す。クライアントは仮表示を確定させる。
5. Relay が outbox を読み、Redis の `ws:{workspace_id}:ch:{channel_id}` に publish する。
6. 購読中の Gateway が、接続中のメンバーへ WebSocket で push する。

