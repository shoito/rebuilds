# Events and Webhooks: Stripe

状態の変化を Event として記録し、加盟店の URL（Webhook エンドポイント）へ署名付きで届ける仕組み。Event の形は [ADR-0026](../decisions/0026-snapshot-event-model.md)、配信と署名は [ADR-0025](../decisions/0025-webhook-signing-and-isolated-delivery.md) にある。

本家の振る舞いに寄せる。本家の仕様は docs.stripe.com で 2026-09-26 に確認した。確認できなかったものは「未検証」と書き、確かめ方を 15 節に置く。

## 1. 原則

- **Event は、状態の変化と同じトランザクションで作る。** 成功を返した決済に、対応する Event が欠けることはない（ADR-0003 と同じく、状態・仕訳・Event を 1 つのトランザクションで書く）。
- **Event は作ったら変えない。** 中身は作成の時点のスナップショットで、後の更新で書き換えない（本家と同じ。[Webhook の文書](https://docs.stripe.com/webhooks#api-versions)）。
- **配信は「少なくとも 1 回」。順序は保証しない。** 加盟店には Event の `id` で重複を捨ててもらう（本家と同じ。[イベントの順序付け](https://docs.stripe.com/webhooks#event-ordering)）。
- **外部の URL への送信は、内部に届かない隔離された経路からだけ行う。** 署名は VPC の中で行い、送信器に秘密を渡さない（Slack の [ADR-0016](../../../slack/docs/decisions/0016-isolated-link-unfurling.md) と apps.md の 13 節の考え方を引き継ぐ）。
- **テスト環境（サンドボックス）と本番環境は分ける。** Event・エンドポイント・署名の秘密は、環境ごとに別の DB のクラスタに置く（[ADR-0002](../decisions/0002-account-tenancy.md)）。サンドボックスは test のクラスタの中の独立したアカウントで、作成時に本番の Webhook のエンドポイントを写さない（[api.md](api.md) の 11 節）。この文書の「テスト環境」はサンドボックスを指す。

## 2. 全体の流れ

```
API / Worker（Payments・Refund・Dispute・Payout・Checkout）
  │ 1 トランザクション：状態の遷移 ＋ 仕訳 ＋ events に INSERT ＋ outbox に INSERT
  ▼
Relay ─▶ SQS webhook-fanout
          ▼
webhook-router（Worker、VPC 内）
  │ そのアカウント・環境の enabled なエンドポイントのうち、enabled_events に合うものを引く
  │ webhook_deliveries に INSERT ... ON CONFLICT DO NOTHING（キーは (endpoint_id, event_id)）
  ▼
SQS webhook-delivery ─▶ webhook-sender（Worker、VPC 内）
  │ 1. エンドポイントが enabled か確かめる（外れたら abandoned）
  │ 2. Event をエンドポイントの API の版で描画する（6 節）
  │ 3. 署名する（7 節）
  │ 4. webhook-egress（Lambda、専用の egress VPC、権限なし）を同期で呼ぶ
  │ 5. 結果を webhook_delivery_attempts に書く。失敗なら next_attempt_at を決める
  ▼
webhook-scheduler（advisory lock で 1 台）：next_attempt_at を過ぎた配信を 10 秒ごとに webhook-delivery へ戻す
```

- 最初の試行は、SQS からすぐに行う。再試行の予定は DB（`next_attempt_at`）に置く。SQS の遅延は最大 15 分で、数時間の間隔を表せないため（Slack の apps.md の 7.3 節と同じ）。
- NFR-006 の「最初の配信の p95 10 秒以内」は、コミットから egress の送信開始までで測る。加盟店の応答時間は含めない。
- 1 つの Event を複数のエンドポイントへ送るときは、エンドポイントごとに独立に配る。あるエンドポイントの失敗が、他のエンドポイントへの配信を遅らせない。

## 3. Event

### 3.1 形（本家の v1 の Event に合わせる）

```json
{
  "id": "evt_1Q...",
  "object": "event",
  "api_version": "2026-09-26",
  "created": 1790400000,
  "data": {
    "object": { "id": "pi_3Q...", "object": "payment_intent", "status": "succeeded", "amount": 1200, "currency": "jpy" },
    "previous_attributes": { "status": "processing" }
  },
  "livemode": true,
  "pending_webhooks": 1,
  "request": { "id": "req_...", "idempotency_key": "8f1c..." },
  "type": "payment_intent.succeeded"
}
```

| 項目 | 意味 |
| --- | --- |
| `id` | `evt_` で始まる ID。再試行・手動の再送でも変わらない |
| `api_version` | `data` を描画した版。作成の時点のアカウントの既定の版で固定し、後から変えない（本家と同じ。[Event object](https://docs.stripe.com/api/events/object)） |
| `created` | UNIX 秒。秒の精度なので、順序の判断には使えない（本家も同じ注意を書いている） |
| `data.object` | 作成の時点のリソース。公開 API の GET と同じ形 |
| `data.previous_attributes` | `*.updated` など、変わった項目の変更前の値 |
| `pending_webhooks` | まだ成功していない配信の数。`webhook_deliveries` から求める |
| `request` | Event を起こした API の要求の ID と冪等キー。自動の処理（コンビニ払いの入金、Dispute の通知など）では `id` が null |

- `account`・`context` は Connect の項目なので、MVP では出さない（[intent.md](../intent.md) の Non-goals）。
- `data.object` には、カード番号を含めない。本体はそもそもトークンと表示用の情報しか持たない（[ADR-0005](../decisions/0005-pci-scope-segmentation.md)）。

### 3.2 生成（outbox）

- ドメインの処理は、状態を変えるトランザクションの中で `events` に 1 行を書き、同じトランザクションで `outbox` に「Event ができた」ことを書く。
- `events` の行には、その時点のリソースの **正規形**（内部の最新の型）と `previous_attributes` と `api_version` を入れる。版ごとの描画は保存しない（ADR-0026）。
- Event の生成は冪等にする。`events` に `(account_id, idempotency_source)` の一意制約を置き、同じ内部の操作 ID（[ADR-0004](../decisions/0004-idempotency.md) の内部の層）から 2 つの Event を作らない。本家は「まれに 2 つの Event が別々に作られる」ことがあるとしている（[重複するイベントを処理する](https://docs.stripe.com/webhooks#handle-duplicate-events)）。本システムは作らない設計にするが、加盟店向けの案内は本家と同じにする（9 節）。

### 3.3 MVP で出す種類

本家の名前をそのまま使う（[Event types](https://docs.stripe.com/api/events/types)）。

| リソース | 種類 |
| --- | --- |
| PaymentIntent | `payment_intent.created`、`.processing`、`.requires_action`、`.amount_capturable_updated`、`.partially_funded`、`.succeeded`、`.payment_failed`、`.canceled` |
| Charge | `charge.succeeded`、`.failed`、`.captured`、`.refunded`、`.updated` |
| Refund | `refund.created`、`refund.updated`、`refund.failed` |
| Dispute | `charge.dispute.created`、`.updated`、`.closed`、`.funds_withdrawn`、`.funds_reinstated` |
| Payout | `payout.created`、`.updated`、`.paid`、`.failed`、`.canceled` |
| Customer・PaymentMethod | `customer.created`、`.updated`、`.deleted`、`payment_method.attached`、`.detached` |
| 銀行振込 | `customer_cash_balance_transaction.created` |
| Checkout | `checkout.session.completed`、`.async_payment_succeeded`、`.async_payment_failed`、`.expired` |
| 残高 | `balance.available` |
| 不正検知 | `radar.early_fraud_warning.created`、`review.opened`、`review.closed`（[fraud.md](fraud.md) の 8 節） |
| SetupIntent | `setup_intent.created`、`.requires_action`、`.succeeded`、`.setup_failed`、`.canceled`（[payments.md](payments.md) の 13 節） |
| アカウント | `account.updated`（審査の状態と capability。[merchant-onboarding.md](merchant-onboarding.md) の 3 節） |

- 種類の一覧は `packages/contract` の Zod スキーマに置き、公開の文書と SDK の型をここから生成する。
- 種類を足すのは、版をまたがない追加の変更として扱う（[api.md](api.md) の版の方針）。

### 3.4 保持

| 範囲 | 期間 | 本家 |
| --- | --- | --- |
| API（`GET /v1/events`、`/v1/events/{id}`）で全体を返す | 30 日 | 同じ（[Events API](https://docs.stripe.com/api/events)） |
| ダッシュボードで全体・配信の試行を見る、手動で再送する | 15 日 | 同じ（[イベントの保持](https://docs.stripe.com/event-destinations#event-retention)） |
| ダッシュボードで全体を見る（再送・試行は不可） | 30 日 | 同じ |
| ダッシュボードで要約だけを見る | 13 か月 | 同じ |

- `events` は日ごとのパーティションにし、31 日を過ぎたものを `DROP` する。その前に、要約（`id`、`type`、`created`、`data.object.id`、`request.id`）を `event_summaries` に写す。要約は月ごとのパーティションで 13 か月保つ。
- `webhook_delivery_attempts` は 15 日で消す。
- 一覧の API は本家と同じく `type`、`types[]`、`created`、`delivery_success`、`ending_before`・`starting_after` で絞り込める（[未配信の Webhook イベントを処理する](https://docs.stripe.com/webhooks/process-undelivered-events)）。

## 4. Webhook エンドポイント

### 4.1 登録

本家の v1 の API（`/v1/webhook_endpoints`）の形に合わせる（[Webhook Endpoint object](https://docs.stripe.com/api/webhook_endpoints/object)）。本家の新しい `/v2/core/event_destinations` は、thin events と EventBridge への送信を含むので、MVP では作らない（ADR-0026）。

| 項目 | 意味 |
| --- | --- |
| `url` | 送信先。4.2 節の制約を満たすもの |
| `enabled_events` | 受け取る種類の配列。`["*"]` はすべて（明示の選択が要る種類を除く。本家と同じ） |
| `api_version` | Event を描画する版。null ならアカウントの既定の版（作成の時点の版で固定された Event の版） |
| `status` | `enabled` / `disabled` |
| `secret` | 署名の秘密。作成の応答でだけ返す（本家と同じ）。ダッシュボードでは権限のある人が再表示できる（7.3 節） |
| `description`、`metadata` | 任意 |

- 上限は、アカウント・環境ごとに 16 個。アカウントの既定と違う版を指定したエンドポイントは、異なる版で 3 種類まで（本家と同じ。[イベント送信先の制限](https://docs.stripe.com/event-destinations#event-destination-limits)）。
- 作成・変更・削除・秘密の入れ替えは、監査ログに残す（[security.md](security.md)）。
- テスト環境のエンドポイントは、テスト環境の Event だけを受ける。本番のエンドポイントは本番の Event だけを受ける。署名の秘密も別にする（本家と同じ）。

### 4.2 URL の制約

- `https` のみ。ポートは 443 だけにする。本家が 443 以外のポートを受け付けるかは未検証。受け付けるとしても、宛先の検査を単純に保つために 443 に限る（加盟店の要望が続けば見直す）。
- ホストは公開の DNS 名。IP アドレスの直書き、`localhost`、本システムのドメイン（`*.<domain>`）は拒否する。
- 登録・変更の時点で名前解決し、10 節の拒否リストに当たれば 400 を返す。送信の時点でも毎回検査する（DNS の再バインドに備える）。
- TLS 1.2 以上、証明書の検証を必須にする（本家は TLS 1.2・1.3 のみ。[HTTPS サーバーでイベントを受信する](https://docs.stripe.com/webhooks#receive-events-with-an-https-server)）。
- 開発の手元での受信は、本家の `stripe listen` に相当する道具を MVP では作らない。トンネル（ngrok など）を案内する。

## 5. 配信と再試行

### 5.1 成功と失敗

| 応答 | 扱い |
| --- | --- |
| 2xx | 成功 |
| 3xx | 失敗。リダイレクトを追わない（本家と同じ） |
| 4xx・5xx | 失敗。再試行する（本家は 4xx も失敗として再試行の対象にしている） |
| 接続の失敗、TLS のエラー、タイムアウト | 失敗。再試行する |

- タイムアウトは接続 5 秒、全体 15 秒にする（初期値）。本家の値は公開の文書にない（未検証）。
- 応答の本文は先頭 4 KB だけを保存する（配信ログの表示用。8 節）。バイナリは保存しない。

### 5.2 再試行の間隔

- **本番環境：3 日間、指数的に再試行する**（本家と同じ。[自動での再試行](https://docs.stripe.com/webhooks#automatic-retries)）。本家の正確な間隔は公開されていないので、次の値にする（初期値）。

  | 試行 | 前回からの間隔 | 最初の試行からの経過（目安） |
  | --- | --- | --- |
  | 1 | — | 0 |
  | 2 | 1 分 | 1 分 |
  | 3 | 5 分 | 6 分 |
  | 4 | 30 分 | 36 分 |
  | 5 | 2 時間 | 2.6 時間 |
  | 6 | 5 時間 | 7.6 時間 |
  | 7〜9 | 10 時間ずつ | 17.6〜37.6 時間 |
  | 10〜11 | 12 時間ずつ | 49.6〜61.6 時間 |
  | 12 | 72 時間の時点 | 72 時間 |

  間隔には ±10% のジッターを入れる。12 回目で失敗したら `failed` とし、自動の再試行を終える。
- **テスト環境：数時間のうちに 3 回再試行する**（本家と同じ）。間隔は 10 分、1 時間、3 時間にする。
- 再試行ごとに、署名とタイムスタンプを作り直す（本家と同じ。[リプレイ攻撃を防止する](https://docs.stripe.com/webhooks#replay-attacks)）。
- 再試行の時点でエンドポイントが無効・削除済みなら、その配信の自動の再試行を止める（`abandoned`）。無効にしても、次の再試行の時刻までに有効に戻せば、再試行を続ける（本家と同じ）。

### 5.3 公平さと背圧

- エンドポイントごとの同時に送る数に上限（初期値 10）を置き、webhook-sender が Valkey で数える。上限に当たったら、SQS の可視性タイムアウトを延ばして後で取り直す。1 つの遅いエンドポイントが、egress の同時実行を使い切らないため。
- アカウントごとの 1 秒あたりの送信数にも上限（初期値 100 件/秒）を置く。月初の一斉の処理などで、1 つのアカウントの大量の Event が全体を詰まらせないため。上限の値は [rate-limiting.md](rate-limiting.md) と [capacity.md](capacity.md) で決める。
- 配信の順序は、エンドポイントごとにも保証しない。前の Event の失敗を待たずに、次の Event を送る（先頭の詰まりを作らない）。

### 5.4 エンドポイントの無効化

- **失敗の通知**：あるエンドポイントで、成功のないまま 1 時間失敗が続いたら、アカウントの Administrator と Developer のロールの人（ロールの定義は [auth-and-keys.md](auth-and-keys.md)）にメールで知らせる。同じエンドポイントについて、通知は 24 時間に 1 回まで。本家も「失敗している」ことをメールで知らせる（[Stripe サポート](https://support.stripe.com/topics/webhooks) の記述。文書の本文での確認は未検証）。
- **自動の無効化**：本番環境で、成功のないまま 3 日間失敗が続いたエンドポイントを `disabled` にし、同じ人たちにメールで知らせる。本家が自動で無効にする条件は、公開の文書では確認できなかった（未検証）。3 日としたのは、再試行の期間と合わせ、「すべての Event が失敗で終わる状態」を続けないため。
- テスト環境では自動の無効化をしない（通知だけ）。
- 無効の間に作られた Event は、そのエンドポイントの配信を作らない。有効に戻しても、無効の間の Event は自動では送らない。加盟店は `delivery_success=false` の一覧（3.4 節）と手動の再送（8.2 節）で取り戻す。

## 6. API の版と描画

- Event の `api_version` は、作成の時点のアカウントの既定の版にする。アカウントの版を後で上げても、既存の Event は変わらない（本家と同じ）。
- エンドポイントに `api_version` があれば、その版で描画して送る。なければ Event の `api_version` で描画する（本家と同じ）。
- 描画は、正規形に [api.md](api.md) の版ごとの変換を順に当てて行う。変換は、公開した後は書き換えない（直すときは新しい版にする）。これで、同じ Event を同じ版で描画すれば、いつでも同じ本文になる（ADR-0026）。
- 本家の thin events（v2）は、MVP では作らない。版に依存しない通知の需要が出たら、エンドポイントに `event_payload`（`snapshot` / `thin`）を足す（ADR-0026）。

## 7. 署名

### 7.1 形式（本家の `Stripe-Signature` の形式に合わせる）

```
<Brand>-Signature: t=1790400000,v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd
```

- `t` は送った時刻（UNIX 秒）、`v1` は `HMAC-SHA256(署名の秘密, "{t}.{本文}")` の 16 進（[署名の検証](https://docs.stripe.com/webhooks#verify-signature)）。
- 秘密の入れ替え中は、有効な秘密ごとに `v1=` を 1 つずつ並べる（本家と同じ）。
- 本家はテスト環境の Event に偽の `v0` の署名を足す。これは検証の練習用なので、本システムでは出さない。
- ヘッダー名は本家の名前ではなく `<Brand>-Signature` にする（リポジトリ共通の [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。形式は同じにし、本家の SDK の検証の実装と同じ手順で検証できるようにする。名前は [api.md](api.md) のヘッダーの命名に合わせる。

### 7.2 加盟店に求める検証

文書と SDK で示す（本家の案内と同じ）。

- 生の本文で検証する（フレームワークに JSON を解釈させた後の本文では一致しない）。
- `v1` 以外の方式は無視する（ダウングレード攻撃を防ぐ）。
- 定数時間で比べる。
- `t` と現在時刻の差の許容幅は、SDK の既定で 5 分にする。0 にしない（本家の SDK と同じ）。
- 送信元の IP の許可リストを使ってよい（10.3 節）。

### 7.3 秘密の保管と入れ替え

- 秘密は `<brand>_whsec_` に続く 32 バイトの乱数（本家の `whsec_` と重ならない接頭辞にする）。エンドポイントごとに 1 つ。
- `webhook_endpoint_secrets` に、KMS の `webhook-secrets` 鍵で暗号化して置く。復号できるのは webhook-sender のタスクロールと、ダッシュボードの再表示の処理だけ。egress の Lambda には渡さない。
- **再表示**：ダッシュボードで、Administrator と Developer のロールの人が、再認証（[auth-and-keys.md](auth-and-keys.md) のステップアップ）の後に表示できる。本家もダッシュボードで「シークレットを表示」できる。表示は監査ログに残す。
- **入れ替え**：ダッシュボードと API で行う。旧い秘密を「すぐに失効」か「最大 24 時間後に失効」から選ぶ（本家と同じ。[署名シークレットを取り消す](https://docs.stripe.com/webhooks#roll-endpoint-secrets)）。重なりの間は、両方の秘密で署名する。
- 漏洩が疑われるときは、すぐに失効させる。

## 8. 配信ログと手動の再送

### 8.1 ダッシュボードで見せるもの

エンドポイントの画面の「イベントの配信」タブ（本家の Workbench の Webhook タブに相当。[イベント配信を表示する](https://docs.stripe.com/webhooks#view-event-deliveries)）。

| 表示 | 中身 |
| --- | --- |
| 一覧 | Event の種類・ID、状態（`delivered` / `pending` / `failed`）、最後の試行の時刻と HTTP ステータス、次の再試行の時刻 |
| 試行ごと | 時刻、HTTP ステータスまたはエラーの種類（接続・TLS・タイムアウト）、所要時間、応答の本文の先頭 4 KB、送った本文 |
| 集計 | 直近 24 時間・7 日の成功率、応答時間の p50・p95 |

- 表示できるのは 15 日以内の試行（3.4 節）。
- 見られるのは、Events と Logs を見る権限のあるロール（本家では Administrator、Developer、Analyst、View Only など。表は [auth-and-keys.md](auth-and-keys.md)）。

### 8.2 手動の再送

- ダッシュボードで、Event を選んで「再送」する。作成から 15 日以内の Event に限る（本家と同じ）。本家の CLI の `stripe events resend`（30 日以内）に相当する道具は MVP では作らない。
- 再送は新しい試行として `webhook_delivery_attempts` に書く（`manual: true`）。署名は新しく作る。
- **手動の再送が成功しても、自動の再試行は止めない**（本家と同じ）。加盟店は、処理済みの Event を受けたら 2xx を返して再試行を止める。
- 再送は、1 エンドポイントあたり 1 分に 60 件までにする（誤操作の連打を抑える）。

## 9. 加盟店への案内（文書と SDK）

本家の「ベストプラクティス」に合わせて、次を文書にする。

- **重複**：同じ Event を複数回受けることがある。処理した `event.id` を記録し、2 回目は処理せずに 2xx を返す。
- **順序**：到着の順序に頼らない。`created` で並べない。必要なら、`data.object.id` で API から最新のリソースを取り直す。
- **すばやく 2xx を返す**：重い処理の前に 2xx を返し、処理はキューで非同期に行う。
- **必要な種類だけを購読する**：`["*"]` は負荷が増えるので勧めない。
- **CSRF の除外**：フレームワークの CSRF 保護から Webhook の経路を除外する。
- **お金の判断**：`payment_intent.succeeded` などを受けたら、フルフィルメントの前に、必要に応じて API で状態を確かめる。Event は作成時点のスナップショットで、処理の時点では古いことがある。
- **取りこぼしの回復**：エンドポイントが止まっていた間の Event は、`GET /v1/events?delivery_success=false` で 30 日以内のものを取り直せる。

## 10. 外向きの通信（egress）

### 10.1 構成

- webhook-egress は Lambda にし、**本体の VPC と別の、専用の egress VPC** に置く（ADR-0025）。
  - egress VPC には、本体の VPC・CDE とのピアリング、Transit Gateway、VPC エンドポイントを置かない。外へ出る経路は NAT ゲートウェイだけ。
  - NAT ゲートウェイには Elastic IP を付け、**送信元の IP を固定して公開する**。本家は Webhook の送信元の IP を公開し、許可リストを勧めている（[IP アドレス](https://docs.stripe.com/ips)）。Slack の ADR-0016 の「VPC に接続しない Lambda」では送信元の IP が固定できないので、Slack の ADR-0016 の選択肢 3（専用の VPC と固定の NAT）を採る。
- 実行ロールはログの書き込みだけ。webhook-sender（本体の VPC）だけが `lambda:InvokeFunction` を持つ。
- Lambda は署名済みの要求（URL・ヘッダー・本文）を受け取って送り、ステータス・所要時間・応答の本文の先頭 4 KB だけを返す。

### 10.2 宛先の検査

Slack の ADR-0016 の「アプリの検査」をそのまま使い、Webhook 向けに絞る。

| 対象 | 規則 |
| --- | --- |
| スキーム・ポート | `https`、443 だけ。URL 中の認証情報は拒否 |
| 宛先の IP | 名前解決したすべてのアドレスを検査し、ループバック、RFC 1918、リンクローカル、CGNAT、`0.0.0.0/8`、マルチキャスト、予約済み、IPv6 の `::1`・`fc00::/7`・`fe80::/10`・IPv4 射影・NAT64 を拒否する |
| DNS の再バインド | 検査したアドレスに直接接続する。SNI と `Host` は元の名前 |
| リダイレクト | 追わない（失敗として扱う） |
| 自分たちのドメイン | `*.<domain>` には送らない |
| 時間 | 接続 5 秒、全体 15 秒 |
| 応答 | 本文は先頭 4 KB だけ読む |
| 要求 | Cookie は送らない。専用の `User-Agent`（例：`<Brand>/1.0 (+https://<domain>/docs/webhooks)`）を名乗る |

- egress VPC に内部への経路がないので、検査に漏れがあっても内部には届かない。検査は、外部の第三者への不正な送信（SSRF の踏み台）を防ぐためのもの。

### 10.3 送信元の IP の公開

- 使う Elastic IP の一覧を、文書と機械で読める JSON（`https://<domain>/ips/webhooks.json`）で公開する。S1 は東京 3 個・大阪 3 個の計 6 個を最初から載せる（[infrastructure.md](infrastructure.md) の 2.1 節）。
- IP を足すときは、使い始める 30 日前に公開して加盟店に知らせる。本家の告知の期間は未検証。

## 11. 規模の段階

| 段階 | 構成 |
| --- | --- |
| S1 | 本体の Aurora に `events`・`webhook_*` を置く。webhook-router・sender・scheduler は本体の ECS のサービス。egress の Lambda の予約済み同時実行数は 500（初期値） |
| S2 | **Webhook の配信を独立したクラスタにする**（[README](README.md) の規模の段階）。`events` 以外の配信の表（`webhook_deliveries`、`webhook_delivery_attempts`）を、配信専用の Aurora のクラスタに移す。router・sender・scheduler も専用の ECS のクラスタにし、決済の API と CPU・接続を奪い合わないようにする。`events` は状態の遷移と同じトランザクションで書くので、本体に残す |
| S3 | セルごとに配信のクラスタを持つ。egress VPC と Elastic IP はリージョンごとに持ち、公開の IP の一覧に両リージョン分を載せる |

- 量の見積もり（S1、初期値）：決済の確定 500 件/秒のピークで、決済 1 件あたり Event 4〜6 件、エンドポイントへの配信 1 Event あたり平均 1.5 件とすると、配信は最大 4,500 件/秒。詳しい数は [capacity.md](capacity.md) で決める。
- `events` の大きさ：1 行 2〜4 KB で、31 日分を持つ。S1 の平均の量で数 TB になりうる。本文は `jsonb` の lz4 圧縮で持ち、容量は [capacity.md](capacity.md) で見積もる。

## 12. 観測と運用

| 指標 | 目標・アラート |
| --- | --- |
| 最初の試行までの遅延（コミット → egress の送信開始） | p95 10 秒以内（NFR-006）。p95 30 秒を 5 分超えたらページ |
| 未配信の数と最古の未配信の経過時間（最初の試行） | 最古が 5 分を超えたらページ |
| SQS `webhook-delivery` の滞留 | 増え続けたら警告 |
| エンドポイント全体の成功率 | 急な低下は、egress の障害の兆し。自分たちの側の原因（NAT、Lambda の同時実行の枯渇）を先に疑う |
| egress の Lambda のスロットリング・同時実行数 | 予約の 80% で警告 |
| 自動で無効にしたエンドポイントの数 | 1 時間に通常の 3 倍を超えたら、自分たちの側の障害を疑う |

- 手順は runbooks に置く：`webhook-delivery-backlog.md`（配信の滞留）、`endpoint-mass-disable.md`（エンドポイントの一斉の無効化）。どちらも E5 で作る（[runbooks/README.md](../runbooks/README.md)）。自分たちの側の障害で失敗が続いたときは、自動の無効化を止める `ops.webhook_auto_disable_enabled` のキルスイッチ（フラグの運用は [delivery.md](delivery.md)）を使い、復旧後に失敗した配信を再度予定に入れる。
- ログとトレースは Event の `id` と配信の ID で相関させる（[observability.md](observability.md)）。本文はログに出さない。

## 13. データモデル

| テーブル | 主な列 | 備考 |
| --- | --- | --- |
| `events` | `account_id`、`id`、`type`、`api_version`、`created_at`、`object_id`、`object_type`、`data`（正規形）、`previous_attributes`、`request_id`、`idempotency_key`、`idempotency_source` | 日ごとのパーティション、31 日で `DROP`。RLS |
| `event_summaries` | `account_id`、`id`、`type`、`created_at`、`object_id`、`request_id` | 月ごと、13 か月 |
| `webhook_endpoints` | `account_id`、`id`、`url`、`enabled_events`、`api_version`、`status`、`disabled_reason`、`description`、`metadata` | RLS |
| `webhook_endpoint_secrets` | `endpoint_id`、`ciphertext`、`created_at`、`expires_at` | 入れ替え中は 2 行 |
| `webhook_deliveries` | `account_id`、`endpoint_id`、`event_id`、`status`、`attempt_count`、`next_attempt_at`、`last_status_code` | 一意キー `(endpoint_id, event_id)` |
| `webhook_delivery_attempts` | `delivery_id`、`attempted_at`、`status_code`、`error_kind`、`duration_ms`、`response_excerpt`、`manual` | 日ごと、15 日 |

環境（テスト・本番）は DB のクラスタで分かれるので、`livemode` の列は持たない（API の応答では付ける）。索引は [data-model.md](data-model.md) に載せる。

## 14. テスト

| レベル | 確かめること |
| --- | --- |
| 性質ベース | 任意の状態の遷移の列で、コミットした遷移 1 つにつき Event がちょうど 1 つある。任意の配信の結果の列（失敗・タイムアウト・重複の配送）で、各 `(endpoint, event)` の成功の記録は多くとも 1 つで、失敗の再試行は 72 時間を超えない |
| 署名 | 本家の公開の SDK（`stripe-node` の `webhooks.constructEvent`）の検証の手順で、本システムの署名を検証できる（ヘッダー名だけ差し替える）。入れ替え中の 2 つの署名のどちらでも通る |
| SSRF | 10.2 節の拒否すべきアドレス、内部を指すリダイレクト、DNS の再バインドで送信されない |
| 版 | 同じ Event を同じ版で描画すると、いつでも同じ本文になる（描画のスナップショットテスト） |
| 障害 | egress の Lambda の失敗・NAT の停止・加盟店の遅延で、他のエンドポイントの配信の遅延が NFR-006 に収まる |

## 15. 未検証の事項と確かめ方

| 事項 | 確かめ方 |
| --- | --- |
| 本家がエンドポイントを自動で無効にする条件と時期 | テスト用の本番アカウントで、常に 500 を返すエンドポイントを 4 日間置き、状態とメールを記録する。Stripe のサポートに問い合わせる |
| 本家の応答のタイムアウトの秒数 | 応答を 5・10・20・30 秒遅らせるエンドポイントで、ダッシュボードの結果を見る |
| 本家の再試行の正確な間隔 | 常に失敗するエンドポイントで、ダッシュボードの試行の時刻を 3 日分記録する |
| 本家が 443 以外のポートを受け付けるか | テスト環境でエンドポイントを登録してみる |
| 送信元の IP を変えるときの告知の期間 | [IP アドレス](https://docs.stripe.com/ips) の文書と変更履歴を確認する |

## 16. 決定と持ち越し（2026-09-26、既定案）

- **thin events・`/v2/core/event_destinations`・EventBridge への送信**：MVP の後の候補にする（[roadmap.md](../roadmap.md) の「後回しにしたもの」。ADR-0026）。
- **手元への転送の道具**（本家の `stripe listen` に相当）：MVP では作らない。トンネル（ngrok など）を案内する。CLI を作るときに合わせて検討する。
- **公開する送信元の IP**：東京 3 個・大阪 3 個の計 6 個（10.3 節）。
- 持ち越し：15 節の未検証の事項（本家の自動の無効化の条件、タイムアウト、再試行の間隔）は、E5 の `webhook-retry-and-disable` の Story で本家の環境を観察して、必要なら値を直す。
