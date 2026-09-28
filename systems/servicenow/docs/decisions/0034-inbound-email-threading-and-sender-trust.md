---
status: accepted
date: 2026-09-28
---

# ADR-0034: 受信は共有の入口（SES → S3 → SQS → mail-router）からセルの Ingest へ送り、SES の ID で冪等にし、転送 → ヘッダー → 参照の印 → 件名の番号（関係者だけ）の順で紐付ける。差出人は認証の結果で信頼の段階を決め、返信の追記は差出人の主体の ACL を通す

詳細は [notifications-and-email-ingest.md](../architecture/notifications-and-email-ingest.md) の 5 節。

## Context

[intent.md](../intent.md) は、受信したメールからのインシデント・要求の作成、返信のスレッドへの紐付け、差出人と社員の照合、自動の返信のループの防止を MVP に含める。顧客は、社内のサービスデスクの宛先（`servicedesk@example.co.jp`）へのメールを、テナントの受信のアドレスへ転送する（[architecture/README.md](../architecture/README.md) の 1.3 節）。

本家は、参照の印を優先して既存のレコードに結び、印がなければ件名の番号の接頭辞でレコードを探し、差出人を有効な利用者のメールアドレスと照合する（[Inbound email action processing](https://www.servicenow.com/docs/r/platform-administration/inbound-action-processing.html)、2026-09-28 に確認）。

SES は、受け手の条件を SMTP の封筒の受け手で比べ、SPF・DKIM・DMARC の結果とスパム・ウイルスの判定をヘッダーに入れ、S3 に 40 MB までのメールを置く（[Amazon SES email receiving concepts](https://docs.aws.amazon.com/ses/latest/dg/receiving-email-concepts.html)、2026-09-28 に確認）。転送のメールは、元の差出人の SPF が通らず、DKIM も書き換えで通らないことがある。

## Options

### 経路

1. **SES → S3 → SNS → SQS → Ingest（ECS）**
2. SES → Lambda で直接処理する
3. 自前の SMTP の受信のサーバー

### 紐付けの手がかり

- a. **転送の判定、ヘッダー（`In-Reply-To`・`References`）、参照の印、件名の番号（差出人が関係者のときだけ）の順**
- b. 本家と同じく、参照の印、次に件名の番号（差出人の条件なし）

### 差出人の信頼

- x. **認証の結果と、テナントが登録した転送の元で段階を決める。社内のドメインを名乗る認証の通らないメールは保留**
- y. `From` のアドレスをそのまま信じる

## Decision

1、a、x を採用する。

- 封筒の受け手で、制御の面の台帳からテナントとセルを決める。テナントのデータを読む前に解決する。
- S3 はバケットの既定の暗号化（SSE-KMS）にし、SES のクライアント側の暗号化を使わない。1 通 25 MB を上限にする。
- `(tenant_id, ses_message_id)` の一意で冪等にする。取り込みの効果と `processed` を 1 つのトランザクションで書く。二重の転送は `rfc_message_id` とハッシュで 7 日の間まとめる。
- 紐付けは DT-MAIL-001。ヘッダーと印が食い違えばヘッダーを採る。返信の接頭辞は使わない。
- 差出人の信頼は DT-MAIL-003（`trusted` / `trusted_via_relay` / `unverified` / `untrusted`）。
- 返信は DT-MAIL-002 で、差出人の主体で Record Service を通して追記する。変えられる状態は、再オープンと保留の解除だけ。書けないとき・未登録の差出人は保留にし、差出人にレコードの存在を知らせない。
- 新しいレコードは、順序付きの受信の規則で作る先と写し方を決める。

> 2026-09-28 の注記（経路を改める）：SES の受信の規則は受け手のアドレスで選ぶので、同じドメイン（`in.<brand>.<domain>`）の下のテナントを、受信の規則の段でセルのバケットへ振り分けられない（テナントごとの規則が要る）。そこで [ADR-0055](0055-accounts-cells-and-edge-router.md) と [infrastructure.md](../architecture/infrastructure.md) の 2.3 節の形にする。mail-ingress のアカウントの SES が一時のバケット（1 日で消える）に置き、SNS → SQS → `mail-router` が台帳の写しで封筒の受け手 → テナント → セルを決め、セルの受信のバケットへ写してセルの SQS に送る。**解決できない受け手は、送り主へバウンスしない。** 捨てて記録する（後方散乱を避ける）。専用のセルは専用の受信のサブドメインで、共有の入口を通さずに受ける。Ingest から後（冪等、紐付け、差出人の信頼）は変えない。

2 を採らない理由：他の取り込み（CMDB）と同じ Ingest のサービスで、再試行・DLQ・テナントの公平を揃えたい。Lambda の同時実行の上限と、テナントごとの流量の扱いを別に作ることになる。

3 を採らない理由：SMTP のサーバーの運用（スパム、TLS、到達性）を自分で持つことになる。

b を採らない理由：件名の番号は誰でも書けるので、無関係の人が他人のチケットに追記できる。`In-Reply-To` の照合がないと、件名を消した返信が新しいチケットになる。

y を採らない理由：社内の人を名乗るなりすましのメールで、他人のチケットにコメントを足したり、その人としてインシデントを作ったりできる。

## Consequences

- 良くなること：
  - 返信の紐付けが、ヘッダー・印・番号の順で頑健になる。
  - なりすましのメールが、社員の名前でチケットを動かせない。
- 引き受けるコスト：
  - 転送の元の登録を、テナントの導入の手順に入れる（K7 の導入の速さに影響する。導入の画面で案内する）。
  - 保留の一覧を担当者が処理する手間がある。
  - L2 の結論によっては、保存・解析の範囲を変える。

## Confirmation

- 決定表 DT-MAIL-001・002・003。
- 性質ベーステスト PROP-MAIL-001（受信の冪等）、PROP-MAIL-004（紐付けは権限を広げない）。
- 結合テスト：SES の受信の通知の形を模した S3 → SQS → Ingest の流れと、E6 の検証の環境での実際の SES の受信。
