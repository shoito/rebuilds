---
status: accepted
date: 2026-09-27
---

# ADR-0047: 鍵は用途ごとに KMS の鍵を分け、録画は組織を暗号化の文脈で分ける。運用者は会議に見えない形で入れず、メディアに触れるアカウントは別にする

## Context

本システムには、次の秘密と鍵がある。各領域で個別に決めたものを、ここで 1 つの階層にまとめる。

| 秘密・鍵 | 決めた領域 |
| --- | --- |
| 参加のトークンの署名の鍵（Ed25519） | [signaling-and-meetings.md](../architecture/signaling-and-meetings.md) の 13 節 |
| TURN の静的な秘密（HMAC） | [ADR-0015](0015-turn-coturn-and-ephemeral-credentials.md) |
| パスコードの暗号文と HMAC の pepper | [ADR-0031](0031-waiting-room-and-passcode-rules.md) |
| E2EE の AS の中間 CA の鍵 | [e2ee.md](../architecture/e2ee.md) |
| 録画・文字起こし・チャットの保存の暗号化 | [recording-and-transcription.md](../architecture/recording-and-transcription.md)、[chat-and-reactions.md](../architecture/chat-and-reactions.md) |
| カレンダーのリフレッシュトークン | [scheduling-and-calendar.md](../architecture/scheduling-and-calendar.md) |

録画の領域は、組織ごとに鍵を分けるか、顧客が持つ鍵（BYOK）を許すかを、この領域に委ねた。

通常の会議では、Media Node・Recorder・Transcriber・Composer の上でメディアが平文になる（[ADR-0004](0004-encryption-and-e2ee.md)）。運用者がここに触れられると、通信の秘密（[intent.md](../intent.md) の L2）を損なう。特に「参加者の一覧に出ない形で会議に入る」機能は、作った時点で悪用と照会（L4）の対象になる。

## Options

鍵：

1. **用途ごとに KMS の鍵を分け、録画などは 1 つの鍵と、組織の ID の暗号化の文脈で分ける。BYOK は S1 で作らない**
2. 組織ごとに KMS の鍵を作る
3. S1 から BYOK（顧客の AWS アカウントの KMS の鍵）を許す

運用者のアクセス：

- a. **メディアに触れる部品を `media-prod` のアカウントに分け、常設の権限を持たせない。会議に見えない形で入る機能を作らない**
- b. 制御の側と同じアカウント・同じ権限で運用する

## Decision

1 と a を採用する。

- **KMS の鍵**（マルチリージョン。主は東京、レプリカは大阪）：

| 鍵 | 守るもの | 使える主体 |
| --- | --- | --- |
| `<brand>-join-signing` | 参加のトークンの署名（非対称、Ed25519 の対応が無ければ ECDSA P-256。**未検証**：KMS の Ed25519 の対応を E2 で確かめる） | API のタスクのロール（`Sign`）。検証は公開鍵を配る |
| `<brand>-meeting-secrets` | パスコードの暗号文、HMAC の pepper、チャットの暗号文、カレンダーのリフレッシュトークン（エンベロープ暗号化。暗号化の文脈に `org_id`） | API、Actor Host、Worker |
| `<brand>-content` | 録画、文字起こし、チャットのファイルの S3 の SSE-KMS。暗号化の文脈に `org_id` と `recording_id` | `media-prod` の Recorder・Transcriber・Composer、署名付き URL を出す API の読み取りのロール |
| `<brand>-e2ee-as` | E2EE の AS の中間 CA の署名 | Actor Host（`Sign` だけ） |
| `<brand>-data` | Aurora・Valkey のスナップショット・SQS・Secrets Manager の保存の暗号化 | 各 AWS のサービス（`kms:ViaService`） |

- **組織ごとの鍵は、S1 で作らない。** 1 つの鍵の暗号化の文脈で組織を分け、キーポリシーの条件（`kms:EncryptionContext:org_id`）で、1 つの要求が他の組織のデータを復号できないようにする。組織ごとの暗号学的な消去が要るとき（組織の削除）は、S3 の実体を消す。
- **BYOK は MVP の後の Epic で扱う。** 顧客の鍵が止められると録画を読めなくなる振る舞い、鍵の呼び出しの上限、サポートの手順を、先に決める必要がある。
- **Secrets Manager**：TURN の静的な秘密（90 日で入れ替え。今と次の 2 つ）、外部送信の資格情報（メール、カレンダーの OAuth のクライアント）。
- **短命の鍵（保存しない）**：Media Node の DTLS の証明書（Node の起動ごとに作る）、Recorder・Transcriber との PlainTransport の SRTP の鍵（会議ごとに Actor が作り、メモリだけ）、Actor Host と Node Agent の相互 TLS の証明書（AWS Private CA、7 日）。
- **`media-prod` のアカウント**：Media Node、TURN、Recorder、Transcriber、Composer と、`raw/`・`final/`・`transcripts/` のバケットを置く（[infrastructure.md](../architecture/infrastructure.md) の 1 節）。
  - 人のロールの常設の権限は、メトリクスと、内容を含まないログの参照だけ。
  - シェル（SSM Session Manager）は、インシデントの指揮者の承認で 4 時間まで。操作はすべて記録し、プラットフォームの監査に残す。
  - Media Node の上で、ペイロードを含むパケットの取得（`tcpdump` の既定の長さ）をしない。取るときは、ヘッダーまで（`-s 96`）に限り、7 日で消す。
  - コアダンプを無効にする（[media-server-sfu.md](../architecture/media-server-sfu.md) の 11 節）。
- **会議に見えない形で入る機能を作らない。** 運用者・サポート・管理者のいずれも、参加者の一覧に出ずに会議のメディアやチャットを受け取る経路を持たない。Recorder と Transcriber は参加者の一覧に出ないが、動いていることを全員に表示する（[ADR-0027](0027-capture-consent-and-indicators.md)）。
- **AI エージェントは本番に経路を持たない**（他の題材と同じ）。
- 2 を採らない理由：組織の数だけ鍵ができ、鍵の月額と呼び出しの上限の管理が増える。S1 では文脈で分ければ足りる。
- 3 を採らない理由：上の振る舞いを決めずに作ると、顧客の操作で録画が失われる。
- b を採らない理由：制御の側の運用の権限で、平文のメディアに触れられる。

## Consequences

- 良くなること：
  - 1 つの鍵の呼び出しで、他の組織の録画を復号できない。
  - 平文のメディアに触れる部品と人の権限が、1 つのアカウントの境界にまとまる。法務の確認（L2）で説明しやすい。
- 引き受けるコスト：
  - Recorder が Media Node から RTP を受ける経路と、API が録画を配る経路は、アカウントをまたぐ。VPC のピアリングと、アカウントをまたぐロールが要る。
  - Media Node の障害の調査で、ペイロードを見られない。ヘッダーと mediasoup の `trace` のイベントで調べる。

## Confirmation

- Terraform の検査：`<brand>-content` のキーポリシーが、`kms:EncryptionContext:org_id` の条件なしの `Decrypt` を許さない。`media-prod` の人のロールに、常設の `ssm:StartSession` がない。
- 結合テスト：組織 A の `org_id` の文脈で、組織 B の録画のオブジェクトを復号すると失敗する。
- レビュー：参加者の一覧に出ない受け手を Media Node に足す `subscriptions.apply` は、`rec_`・`asr_` の受け手だけで、どちらも録画・字幕の表示の状態と結び付いている。
