# Read state and notifications: Slack

## 既読と未読数

- 未読数は `channels.last_seq - channel_members.last_read_seq` を基本とする。自分の投稿やスレッド返信など、本来は数えないものが含まれても近似として許容する（正確な数よりもバッジの有無が重要なため）。
- 既読更新は `POST /workspaces/{ws}/channels/{id}/read {seq}` で行い、`GREATEST(last_read_seq, :seq)` で後退しないようにする。
- 既読イベントは、同じメンバーの他端末にだけ配信する。

