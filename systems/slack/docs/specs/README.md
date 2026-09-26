# Specs

実装済みの振る舞いの正本。capability（機能領域）ごとに `<capability>/spec.md` を置く。

- ここは直接編集しない。変更は `changes/YYMMDD-<slug>/spec.md` に差分として書き、変更の最後の PR（アーカイブ）で反映する。
- まだ実装がないため、現時点では空。最初の反映は [260926-post-and-list-messages](../changes/260926-post-and-list-messages/) の完了時に行う。

| Capability | 接頭辞 | 内容 |
| --- | --- | --- |
| workspaces | `WS` | アカウント、ワークスペース、メンバー、テナント境界 |
| messaging | `MSG` | 投稿、履歴、編集・削除、スレッド、リアクション、メンション |
| channels | `CHN` | チャンネル、チャンネルのメンバー、権限 |
| sync | `SYNC` | リアルタイム配信、差分取得 |
| read-state | `READ` | 既読位置、未読数、通知 |
| search | `SRCH` | 全文検索 |
| files | `FILE` | ファイル添付 |
| web-client | `WEB` | Web クライアントの骨格、画面の振る舞い |
| infrastructure | `INFRA` | AWS のアカウント、ネットワーク、Terraform の基盤 |
| delivery | `DLV` | CI、ブランチの保護、追跡と衝突の検査 |
| observability | `OBS` | 計装、ログ、テナントのラベル |
| flags | `FLAG` | フィーチャーフラグの定義と評価 |
| agent-tooling | `AGT` | エージェントの Skills・Subagent・eval |
