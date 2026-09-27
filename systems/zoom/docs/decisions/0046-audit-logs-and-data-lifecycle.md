---
status: accepted
date: 2026-09-27
---

# ADR-0046: 監査ログは 3 系統に分けて DB に 1 年、log-archive に 7 年置く。会議の内容は既定で残さず、IP と品質の記録は短く持つ

## Context

各領域が、保持を security.md で決めるとした記録がある。

- 主催者の操作の監査 `meeting_audit_events`（[signaling-and-meetings.md](../architecture/signaling-and-meetings.md) の 13 節）
- 管理の操作の監査 `admin_audit_events`（[accounts-and-admin.md](../architecture/accounts-and-admin.md)）
- Media Node と TURN のログに残る利用者の IP（[network-traversal.md](../architecture/network-traversal.md) の 11.4 節は 30 日を仮置き）
- 録画の鍵の分け方（[recording-and-transcription.md](../architecture/recording-and-transcription.md) の 6.1 節）

会議は通信である。会議の内容（音声、映像、チャット、字幕）と、誰がいつ誰と話したか（通信の構成要素）は、通信の秘密の対象になりうる（[intent.md](../intent.md) の L2。法務の確認待ち）。残す記録が多いほど、漏えいのときの被害と、捜査機関からの照会（L4）に応じる範囲が広がる。一方で、濫用の調査、品質の調査、請求の根拠には記録が要る。

他の題材（Auth0 の [ADR-0054](../../../auth0/docs/decisions/0054-audit-log.md)・[ADR-0055](../../../auth0/docs/decisions/0055-data-retention-and-deletion.md)）は、監査ログを DB に 1 年、log-archive に 7 年置き、リーガルホールドを保持の期限に優先させている。

## Options

1. **監査ログを 3 系統（組織の監査、会議の監査、プラットフォームの監査）に分け、DB に 1 年、log-archive に 7 年。内容は既定で残さず、IP は 30 日、品質の生の記録は 30 日**
2. すべての記録を長く（7 年）残す
3. 監査ログを持たず、アプリのログで代える

## Decision

1 を採用する。期間はすべて既定案で、法務の確認（L2・L4・L6・L8）で確定する。

- **監査ログの系統**：
  - 組織の監査 `admin_audit_events`：管理の操作（ユーザー、ロール、SSO、設定と鍵、録画の保全、レポートの書き出し）。組織の管理者が画面で 1 年見られる。
  - 会議の監査 `meeting_audit_events`：主催者の操作（退出させる、ロック、役割の変更、録画・字幕の開始と停止、E2EE の選択、会議の終了）。操作の名前、主体、対象の `participant_id`、時刻、理由のコードだけ。会議の内容は含めない。
  - プラットフォームの監査 `platform_audit_events`：運用者の本番へのアクセス、`media-prod` のアカウントでの操作、防御のモードと EIP の保護の操作、捜査機関への対応、リーガルホールド、組織の停止。
- どの系統も、outbox と同じトランザクションで Aurora に書き、Worker が log-archive（S3 Object Lock、東京 → 大阪へ複製）へ送る。行ごとに前の行のハッシュを持たせ、毎日連鎖を検証する（Auth0 の ADR-0054 と同じ）。
- **会議の内容は既定で残さない。** 残すのは、主催者か組織が明示して選んだものだけ（録画、文字起こし、`save_chat`）。品質の診断・濫用の調査のために、内容を取り出す経路を作らない。
- **利用者の IP**：
  - Media Node・TURN・ALB・WAF のログの IP は 30 日で消す。
  - Aurora に IP をそのまま置かない。置くのは、濫用の判定のための `ip_prefix_hash`（[meeting-security.md](../architecture/meeting-security.md)）と、報告に添える暗号文（`abuse_reports.ip_ciphertext`。90 日。[meeting-security.md](../architecture/meeting-security.md) の 10 節）だけ。
- **品質の記録**：参加者ごとの生の記録（10 秒ごと）は 30 日。参加ごとの要約は 12 か月（[observability.md](../architecture/observability.md) の 3 節）。
- **リーガルホールド**は、保持の期限に優先する。付け外しはプラットフォームの監査に残す。
- 2 を採らない理由：漏えいと照会の範囲が広がる。通信の構成要素を長く持つ根拠がない。
- 3 を採らない理由：アプリのログは 30 日で消え、改ざんを検知できない。

## Consequences

- 良くなること：
  - 誰がいつ何を変えたかを、組織の管理者と運用者が後から確かめられる。
  - 通信の内容と IP を長く持たないので、漏えいと照会の影響が小さい。
- 引き受けるコスト：
  - 30 日を過ぎた濫用の報告は、IP で調べられない。報告の受付の時点で `abuse_reports` に暗号文で添える。
  - 捜査機関からの照会（L4）に、30 日を過ぎた IP では応じられない。これは法務の確認で許されるかを確かめる。

## Confirmation

- 性質ベーステスト：任意の操作の列で、監査ログのハッシュの連鎖を切らずに書ける。1 行を書き換えると検証が失敗する。
- 毎日の監査：Media Node・TURN のログのグループで、30 日を超えたログが 0 件。`meeting_audit_events` の `detail` に、チャットの本文・パスコード・表示の名前の形の値がない（秘密の形の走査）。
- レビュー：新しい表・ログを足す PR で、[security.md](../architecture/security.md) の 9 節の表に保持の期間を足している。
