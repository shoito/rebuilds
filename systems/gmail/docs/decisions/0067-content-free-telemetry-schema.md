---
status: accepted
date: 2026-10-10
---

# ADR-0067: 計装の属性は、型で決めた許可の一覧（ID、理由のコード、数、大きさの段、層、プール、事業者の群）だけを出せる。メールアドレス、件名、本文、検索の語、URL のパス、添付の名前の型は、ログ・指標・トレースの属性の関数に渡すとコンパイルで失敗させる。ドメインは集計の指標でだけ、上位 50 と「その他」に丸めて出す。毎日のログの走査で C3 の検出 0 を確かめる

詳細は [observability.md](../architecture/observability.md) の 2 節。

## Context

- 中身（C3：件名、本文、添付、表示の名前、アドレスのローカル部、検索の語）をログ・指標・トレースの属性に書かない。宛先と差出人のドメインも集計の外のログに書かない（`AGENTS.md`、[ADR-0008](0008-spam-pipeline-boundary-and-secrecy.md)）。通信の構成の要素も通信の秘密に当たると説明されることが多い（法務の L1）。
- [ADR-0008](0008-spam-pipeline-boundary-and-secrecy.md) は、C3 の型（`MessageContent`）をログ・トレースの属性に渡すとコンパイルで失敗させるとした。アドレス・検索の語・URL のパスなど、`MessageContent` の外の C3 も同じに扱う必要がある。
- 指標の次元にドメインやアカウントを入れると、系列が爆発し、特定の利用者のやりとりが指標から見える。
- 型の検査は、文字列の組み立て（エラーの文）からの漏れを防げない。

## Options

1. **型の許可の一覧と、ビルドの検査と、毎日の走査**
2. 出力の時に、ログの文字列から C3 らしいものを消す（マスキング）
3. ログを出さず、指標だけにする

## Decision

1 を採用する。

- 許可の型：ID（`AccountId`・`TenantId`・`MessageId`・`SpoolId`・`SubmissionId`・`ThreadId`・`BlobId`。ログとトレースだけ）、理由（`ReasonCode`・`VerdictCode`・`SmtpReplyCode`）、分類（`Tier`・`Pool`・`ProviderGroup`・`SizeBucket`・`FilterVersion`・`Region`・`Az`）。`IpAddr` はログに出せ、指標では /24・ASN の上位 50 に丸める。`Domain` は集計の指標だけで、受け手 100 以上の上位 50 と `other`。
- 禁止の型：`EmailAddress`・`LocalPart`・`Subject`・`MessageContent`・`SearchQuery`・`UrlPath`・`AttachmentName`・`DisplayName`。計装の関数は `TelemetryAttr` だけを受け、禁止の型は実装しない（Rust はトレイトの境界、TypeScript はブランドの型と lint）。
- エラーの文は型で包み、C3 を `Display` に含めない。解析の誤りは位置と理由のコードだけ。
- 宛先・差出人を示すログは `addr_hmac`（テナントの鍵の HMAC）。
- 指標の系列は 1 つ 1 万まで。アカウント・テナントの ID を次元にしない。
- 毎日、各ログの群の 10 万行を C3 の検出器で走査し、件数だけを数える。1 件で `content-in-logs.md`。許可の形の一覧の変更は QA の承認。

### 他の案を選ばなかった理由

- **2**：マスキングは形の分からない C3（日本語の件名、壊れた文字コード）を取りこぼす。消す前の値がメモリーと経路に残る。
- **3**：障害の調べ（`spool_id` で配送を追う）ができない。

## Consequences

- 良くなること：
  - C3 の漏れの多くがビルドで止まる。
  - 指標から特定の利用者のやりとりが見えない。
- 引き受けるコスト：
  - 型と lint の保守、新しい属性ごとの型の決め。
  - ドメインごとの細かい調べは、指標でなく ID で引く道具で行う（手間が増える）。
  - 検出器の誤検出の扱い。

## Confirmation

- 試験：PROP-OBS-001（禁止の型を渡すとビルドが失敗する）。
- 試験：走査の検出器を、わざと C3 を入れたログで確かめる。
- 本番：毎日の走査の件数 0（[quality.md](../quality.md) の 4.1 節）。
