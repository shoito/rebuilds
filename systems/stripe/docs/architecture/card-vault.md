# Card Vault: Stripe

カード情報を扱う領域（CDE）の境界、カード番号の流れ、トークン化と保管、鍵の管理、CDE へのアクセス、PCI DSS の要件との対応。

| 関連 | 決定 |
| --- | --- |
| [ADR-0005](../decisions/0005-pci-scope-segmentation.md) | カード情報は CDE（別の AWS アカウント）に閉じ込め、本体はトークンだけを扱う |
| [ADR-0019](../decisions/0019-vault-encryption-and-key-hierarchy.md) | カード番号は CDE 専用の KMS の鍵でエンベロープ暗号化する。役割ごとに鍵の操作を分ける |
| [ADR-0020](../decisions/0020-cde-access-model.md) | CDE へのアクセスは、人は期限つきの承認（JIT）だけ。エージェントは持たない |
| [ADR-0023](../decisions/0023-audit-log.md) | 監査ログ。CDE の復号の記録は別の系統で残す |
| [ADR-0024](../decisions/0024-data-retention-and-deletion.md) | カード番号の保持と消去 |

## 1. 目標と前提

- **カード番号（PAN）は CDE の外に、平文で一度も出ない**（intent.md の守るべき振る舞い）。本体・加盟店のサーバー・ログ・テスト用のデータのどこにも出さない。
- **セキュリティコード（CVC）は、オーソリの後に一切残さない。** PCI DSS はオーソリ後の機密認証データ（SAD）の保存を禁じ、オーソリ前に一時的に持つ場合は強い暗号で守ることを求める（要件 3.3.1・3.3.2）。
- 目標は PCI DSS v4.0.1 のサービスプロバイダー レベル 1（NFR-010）。v4.0.1 は 2024 年 6 月の限定改訂で、要件の追加・削除はない（[PCI SSC のブログ](https://blog.pcisecuritystandards.org/just-published-pci-dss-v4-0-1)）。
- 本家も同じ形をとる。カード番号を保存・復号・送信する基盤（Card Data Vault）は、API や Web サイトとは別のホスティング環境で動き、認証情報を共有しない。保存時は AES-256 で暗号化し、復号の鍵は別のマシンに置く。内部のサーバーはカード番号の平文を取得できず、許可リストにある送信先へ送るよう依頼できるだけ。アクセスできるのは少数の訓練を受けたエンジニアで、四半期ごとに見直す（[Stripe のセキュリティ](https://docs.stripe.com/security)、2026-09-26 に確認）。

## 2. CDE の境界

アカウントと接続の正本は [ADR-0029](../decisions/0029-multi-account-and-cde-layout.md) と [infrastructure.md](infrastructure.md) の 1・2 節。ここでは Vault の中の部品を書く。

```
加盟店の顧客のブラウザ
  │  加盟店のページ（CDE の外）
  │   └─ iframe：elements.<domain>（CDE が配る入力部品。カード番号はここにだけ入る）
  │  Checkout のページ checkout.<domain>（本体が配る。カード欄は同じ iframe）
  │
  │ TLS 1.2 以上。live は vault.<domain>、テスト環境は vault-test.<domain>
  ▼
┌──── CDE アカウント cde-live（テスト環境は同じ構成の cde-test。東京。大阪に DR）────┐
│ CloudFront＋WAF → ALB                                                          │
│   ▼                                                                            │
│ vault-ingest ──▶ Vault DB（Aurora、cde-pan で暗号化した PAN）                    │
│ （暗号化だけ）       ▲        ▲                                                  │
│                vault-core   │ 復号できるのは connector-gateway だけ               │
│          （紐づけ・照会・消去。  connector-gateway ──▶ Egress（許可リスト）──▶ アクワイアラ・3DS Server
│            鍵を使わない）                                                        │
│ CVC の一時保管（ElastiCache、cde-sad で暗号化、TTL 30 分）                        │
└──────▲─────────────────────────────────────────────┬──────────────────────────┘
       │ PrivateLink＋mTLS（本体 → CDE）              │ SQS connector-results（CDE → 本体）
┌──────┴──────────── 本体アカウント prod（CDE の外）───▼──────────────────────────┐
│ api（PaymentMethod の作成、Payments）      workers（コネクタの結果・通知の反映）   │
└────────────────────────────────────────────────────────────────────────────────┘
      ログ・CloudTrail・監査 ──▶ log-archive アカウント（Object Lock）
```

| 構成要素（サービス名） | 置き場所 | 役割 |
| --- | --- | --- |
| Elements の iframe | CDE（S3＋CloudFront、`elements.<domain>`） | カード番号・有効期限・CVC を受け取り、vault-ingest へ直接送る。加盟店のページのスクリプトから読めない（[ADR-0027](../decisions/0027-checkout-and-elements-isolation.md)） |
| Vault Ingress（`vault-ingest`） | CDE（ECS Fargate） | インターネットからの入口。入力の検証、BIN の照合、暗号化と保存、使い捨ての `card_input` の発行 |
| Vault Core（`vault-core`） | CDE（ECS Fargate） | 本体からの内部の要求（`card_input` と `pm_` の紐づけ、表示用の情報の照会、消去）。鍵を使わない。インターネットからの入口と分ける |
| Vault DB | CDE（Aurora PostgreSQL、専用のクラスタ） | 暗号化した PAN、表示用の情報、指紋（fingerprint）、`pm_` との対応 |
| CVC の一時保管 | CDE（ElastiCache） | 最初のオーソリまでだけ CVC を持つ |
| Connector Gateway（`connector-gateway`） | CDE（ECS Fargate） | PAN を復号し、アクワイアラ・3DS Server への要求を組み立てて送る。結果を `connector-results` へ送る |
| Egress | CDE（NAT → Network Firewall） | 送信先をアクワイアラ・3DS Server の宛先の許可リストに限る |

- **CDE は live と test で別のアカウント**（cde-live・cde-test）にする（ADR-0029）。テスト環境（`<brand>_pk_test_`）のカードの入力は cde-test の Vault が受ける。staging 用には cde-nonprod、CDE のイメージ・CI・Terraform の状態は cde-shared に置く。
- **CDE は専用の AWS アカウントにする**（ADR-0005）。AWS のアカウントは既定で互いにアクセスを許さない、強い境界になる。AWS も PCI のスコープの分割にアカウントの分離を勧めている（[Architecting for PCI DSS Scoping and Segmentation on AWS](https://d1.awsstatic.com/whitepapers/compliance/architecting-pci-dss-segmentation-scoping-aws.pdf)、[PCI DSS v4.0 on AWS Compliance Guide](https://d1.awsstatic.com/whitepapers/compliance/pci-dss-compliance-on-aws-v4-102023.pdf)）。
- **本体と CDE をつなぐ経路は 2 本だけ**にする（ADR-0029。要件 1.3.1・1.3.2）。

  | 向き | 方式 | API・運ぶもの |
  | --- | --- | --- |
  | 本体 → CDE | PrivateLink（CDE の NLB のエンドポイントサービス）＋mTLS（AWS Private CA の証明書）。許可するのは prod のアカウントだけ | vault-core の `bind_card_input`・`get_card`・`set_card_attached`・`delete_card`・`sync_publishable_key`、connector-gateway の `authorize` / `capture` / `refund` / `void` / `inquire` / `authenticate_*`。渡すのは `pm_`、`account_id`、金額、参照番号（紐づけのときだけ使い捨ての `card_input`）。応答は表示用の情報と結果だけで、カード番号を含めない |
  | CDE → 本体 | prod の SQS キュー `connector-results`（キューのポリシーで cde-live・cde-test のロールだけを許す） | コネクタの結果と、カード番号を除いたアクワイアラの通知（[ADR-0014](../decisions/0014-connector-inbox.md)）。CDE から本体へ HTTP で呼ぶ経路は作らない |

- **境界を越える識別子は `pm_` だけ。唯一の例外が `card_input`** で、PaymentMethod の紐づけ（3.1 節の手順 8）の 1 回だけ本体を通る。Vault の内部の `card_ref` は CDE の外に出さない。
  - この例外は 2026-09-28 に確定した（[README.md](README.md) の 6 節の「決定（2026-09-28、推奨案で確定）」）。根拠（2026-09-27 に確かめた）：PAN・有効期限・CVC は、ブラウザの iframe から CDE の vault-ingest へ直接送られ、本体を通らない。本体が受け取るのは `card_input`（`ci_` ＋ 128 bit のランダムな値。PAN から導かない）だけで、カード会員データを含まず、PAN を復元する手がかりにもならない。使い捨てで、30 分で失効し、同じ公開キーからの紐づけにしか使えない。
  - 紐づけの応答で本体が受け取るのは、表示用の情報（ブランド、BIN、下 4 桁、有効期限、funding、発行国）と、加盟店向けの指紋と内部向けの指紋だけ。内部向けの指紋はプラットフォームの不正検知だけが使い、加盟店に出さない（2026-09-28 の決定。[ADR-0019](../decisions/0019-vault-encryption-and-key-hierarchy.md) の注記）。BIN と下 4 桁と指紋を本体に置く扱いは、QSA に確認する（4 節）。
  - 公開可能キーの ID と `account_id` の対応は、本体が `sync_publishable_key` で CDE に写す（`vault_publishable_keys`）。vault-ingest はこれで受け取りの時点の加盟店を決め、加盟店向けの指紋を計算する。公開してよい値で、向きは本体 → CDE なので、境界の規則を変えない（2026-09-28 の決定）。
  - これ以外の値を境界に通すときは、ADR を起票する（[ADR-0029](../decisions/0029-multi-account-and-cde-layout.md) の 2026-09-27 の注記）。
- **Checkout のページ（本体）と、Elements を埋め込む加盟店のページは CDE ではない。** ただし Checkout のページは、改ざんされるとカード欄を偽装できるため、CDE のセキュリティに影響する系（connected-to / security-impacting）として扱い、スクリプトの管理（要件 6.4.3）と改ざんの検知（要件 11.6.1）の対象に含める。
- CDE のデプロイの経路（CI/CD のロール、Terraform の状態、ECR）も CDE と同じ統制に置く（[ADR-0033](../decisions/0033-cde-pipeline-and-change-control.md)、[security.md](security.md) の 8 節）。
- 大阪リージョン（DR）にも同じ構成を置く。Vault DB は Aurora Global Database、鍵は KMS のマルチリージョンキーにする（ADR-0019）。

## 3. カード番号の流れ

### 3.1 受け取りとトークン化

CDE から本体を呼ばない（2 節）ので、`pm_` の作成は「ブラウザ → 本体 → CDE」の向きで行う。

```
ブラウザ（elements iframe）
  └─▶ POST vault.<domain>/v1/card_inputs   （公開キー、PAN、有効期限、CVC）
        vault-ingest
          1. 形式の検証（桁数、Luhn）。BIN 表でブランド・funding・発行国を引く
          2. cde-test なら、ブランドのテスト用の番号以外を拒否する（保存もログもしない）
          3. PAN を暗号化（DEK で AES-256-GCM）。DEK は cde-pan の CMK で包む
          4. 指紋を計算（cde-fp の HMAC 鍵。4 節）
          5. Vault DB に INSERT：card_ref（ランダム）、暗号文、表示用の情報、指紋、公開キーの ID と、それから決めた account_id（vault_publishable_keys）。pm_ は未設定
          6. CVC を cde-sad で暗号化し、ElastiCache に TTL 30 分で置く
  ◀── { card_input: "ci_..." }              使い捨て。30 分で失効
  └─▶ POST api.<domain>/v1/payment_methods  （公開キー、type=card、card_input）
        api（本体）
          7. 公開キーを検証し、account_id を決め、pm_ を採番する
          8. PrivateLink で vault-core.bind_card_input(card_input, account_id, pm_, 公開キーの ID)
             vault-core：card_input が未使用・期限内・同じ公開キー・同じ account_id のものかを確かめ、行に pm_ を書く
             → 表示用の情報（ブランド、BIN、下 4 桁、有効期限、funding、発行国）と加盟店向け・内部向けの指紋を返す
          9. payment_methods に INSERT
  ◀── { id: "pm_..." }                      iframe → 加盟店の JS → 加盟店のサーバー
```

- **`card_ref` は PAN から導かないランダムな値**（`vc_` ＋ 128 bit）で、CDE の外に出さない。`card_input`（`ci_` ＋ 128 bit）は、紐づけの 1 回だけ使える別の値で、紐づけの後は無効になる。
- `pm_` は本体が採番する。`pm_` と `card_ref` の対応は Vault の側にだけ持ち、本体から CDE への要求は `pm_` と `account_id` で行う（[payment-methods.md](payment-methods.md) の 2 節）。
- 手順 8 が済まなかった行（`pm_` が未設定）は、1 時間後に消去の Worker が消す（6 節）。ブラウザには失敗を返し、入力し直させる。手順 8 は `card_input` について冪等にし、api が再送しても同じ `pm_` を返す。
- 公開キーを使うので、カードテスティング（盗んだ番号の有効性の確認）の入口になる。IP・公開キーごとのレート制限と、急増時の WAF の Challenge を掛ける（[fraud.md](fraud.md) の 7 節、[rate-limiting.md](rate-limiting.md) の 4 節）。
- 本家は、テスト環境で本物のカードを使うと拒否する。これに合わせる。本物の番号を受け取った時点で CDE の統制が要るので、テスト環境の入力は cde-test の Vault が受け、保存もログもせずに拒否する（ADR-0029）。cde-test の connector-gateway は模擬のアクワイアラにだけつなぐ。

### 3.2 オーソリ（detokenization）

```
Payments（本体）──▶ Connector Gateway.authorize(account_id, pm_, amount, currency, 3DS の結果, connector, ref)
  Connector Gateway
    1. Vault DB から pm_ の行を読む。account_id が一致しなければ拒否（別の加盟店のカードを使わせない）
    2. DEK を KMS で復号（キャッシュ 5 分）→ PAN を復号（プロセスのメモリの中だけ）
    3. その card_ref の CVC が ElastiCache にあれば取り出し、同時に消す（GETDEL）
    4. コネクタごとの形式で要求を組み立て、Egress 経由でアクワイアラへ送る
    5. 応答（承認番号、結果コード、CVC・住所の照合結果）から、カード番号を含まない値だけを返す
    6. 復号の記録を CDE の監査の系統に書く（ADR-0023）
```

- PAN の平文は Connector Gateway のプロセスの中だけに現れる。`Buffer` に置き、使い終わったら `fill(0)` で消す。JavaScript の文字列は消せないので、PAN を文字列にしない（lint で検査する）。コアダンプとヒープのスナップショットは無効にする。
- 冪等：Connector Gateway は Payments が渡す参照番号（ADR-0004 のコネクタの層）をそのままアクワイアラへ送る。再送で PAN を再び復号しても、取引は 1 回になる。
- **3D セキュアの認証要求（AReq）は PAN を含む。** したがって 3DS Server への送信も Connector Gateway から行う。3DS Server は外部の提供者（またはアクワイアラの 3DS の機能）を使い、TPSP として管理する（要件 12.8）。3DS を行うかどうかの判断は本体の Fraud と Payments が行う（[fraud.md](fraud.md) の 5 節）。
- 返金・キャプチャ・取り消しは、アクワイアラの取引の参照で行えるので、PAN を復号しない（コネクタが求める場合だけ復号する）。

### 3.3 CVC

| 場面 | 扱い |
| --- | --- |
| 入力から最初のオーソリまで | `cde-sad` で暗号化して ElastiCache に置く（要件 3.3.2）。TTL 30 分 |
| 最初のオーソリ | 取り出すと同時に消す。オーソリの成否にかかわらず残さない（要件 3.3.1.2） |
| 保存したカードで再び CVC を求める | iframe から vault-ingest へ CVC だけを送り（`pm_` を添える）、その `pm_` のカードに紐づけて同じく一時保管する（本家の CVC の再収集に相当） |
| ログ・監査・エラー | CVC の値も長さも出さない。出してよいのは照合の結果（`pass` / `fail` / `unavailable` / `unchecked`。本家の `cvc_check` と同じ値、[Card object](https://docs.stripe.com/api/cards/object)） |

- ElastiCache は永続化（スナップショット・AOF）を無効にする。フェイルオーバーで消えた CVC は、決済を「CVC なし」で続けるか、入力し直させる（Payments が決める）。

## 4. 保管と暗号化

方式の比較と決定は ADR-0019 にある。要点は次のとおり。

| 鍵 | 種類 | 使える役割 | 用途 |
| --- | --- | --- | --- |
| `cde-pan` | KMS 対称 CMK（マルチリージョン） | Vault Ingress：`GenerateDataKey` だけ。Connector Gateway：`Decrypt` だけ。消去の Worker：なし | DEK を包む（KEK） |
| DEK | AES-256（KMS が生成） | 上に同じ | PAN を AES-256-GCM で暗号化 |
| `cde-fp` | KMS の HMAC 鍵（HMAC_SHA_256） | Vault Ingress：`GenerateMac` だけ | 指紋の計算 |
| `cde-sad` | KMS 対称 CMK | Vault Ingress：暗号化。Connector Gateway：復号 | CVC の一時保管 |
| `cde-db` など | KMS 対称 CMK | サービス | Aurora・ElastiCache・S3・ログの保存時の暗号化（Slack ADR-0017 と同じ分け方を CDE で繰り返す） |

- **Vault Ingress は暗号化できるが復号できない。** 入口の脆弱性で、保存済みの PAN を読み出せないようにする。
- DEK は 1 時間ごと、または 100 万件ごとに新しくし、以後は復号だけに使う。GCM の nonce は 96 bit のランダムで、1 つの DEK での件数を上限で抑える。
- KMS の HSM は FIPS 140-3 Security Level 3 の認定を受けており、平文の鍵を誰も取り出せない（[AWS のブログ](https://aws.amazon.com/blogs/security/aws-kms-now-fips-140-2-level-3-what-does-this-mean-for-you/)）。
- 指紋：本家の `fingerprint` は、同じカード番号かを見分ける値（[Card object](https://docs.stripe.com/api/cards/object)）。本システムでは次の 2 つを出す。
  - 加盟店向け：`HMAC(cde-fp, account_id ‖ PAN)` を切り詰めた値。加盟店をまたいで同じカードを突き合わせられない。本家の指紋もアカウントごとに一意である（[重複したカードの検出](https://support.stripe.com/questions/how-can-i-detect-duplicate-cards-or-bank-accounts)、2026-09-27 に確認）。
  - 内部向け（Fraud のリストと速度の集計）：`HMAC(cde-fp, PAN)`。加盟店に出さない。
- 本体に置くのは、ブランド、BIN（先頭 6 桁）、下 4 桁、有効期限、funding、発行国、指紋。切り詰めた PAN と鍵つきハッシュが同じ場所にあっても、鍵が CDE の外にないので突き合わせられない。**この扱いが要件 3.5.1（同じ PAN の切り詰めた値とハッシュが同じ環境にあるときの追加の統制）と 3.5.1.1（鍵つきの暗号学的ハッシュ）を満たすかは QSA に確認する**（QSA の見解は未検証）。2026-09-27 の訂正：以前は「3.4・3.5.1.1」と書いていたが、3.4 は PAN の表示とコピーの制限で、この話題の要件は 3.5.1 である（PCI DSS v4.0.1 の原文（PCI SSC の文書庫からは取得できず、第三者が掲載した公式の PDF の写し [PCI-DSS-v4_0_1.pdf](https://www.middlebury.edu/sites/default/files/2025-01/PCI-DSS-v4_0_1.pdf) で照合。2026-09-27））。

### データモデル（CDE）

列・制約・索引の正本は [data-model/card-vault.md](data-model/card-vault.md)。要点は次のとおり。

```sql
vault_cards (card_ref PK,                 -- vc_ + 128 bit のランダム。CDE の外に出さない
             account_id,                  -- 受け取りの時点で公開キーから決める（vault_publishable_keys）
             payment_method_id NULL UNIQUE,                -- 3.1 節の手順 8 で設定
             card_input_hash, card_input_expires_at,        -- 使い捨ての card_input（紐づけで無効にする）
             publishable_key_id,                           -- 受け取ったときの公開キー
             pan_ciphertext,               -- AWS Encryption SDK のメッセージ（包んだ DEK を含む）
             edk_hash, cmk_key_id,         -- DEK・CMK の漏洩の疑いで対象の行を探す
             fp_merchant, fp_internal, bin6, last4, exp_month, exp_year,
             network_txn_id,               -- MIT 用（payments.md の 11 節）
             created_at, bound_at, last_used_at, attached,  -- attached：Customer に保存済み
             purge_after)                  -- 6 節
vault_publishable_keys (publishable_key_id PK, account_id, status, expires_at)
vault_bin_ranges       (version, range_start, range_end, brand, funding, country, ...)
vault_test_cards       (pan_hmac PK, brand, last4, scenario, origin)
```

- Vault DB は本体の DB と別のクラスタで、本体のロールは接続できない。RLS は使わず、`account_id` と `payment_method_id` の組の一致を Vault Core と Connector Gateway が確かめる（3.2 節）。
- cde-live と cde-test は別のクラスタなので、`livemode` の列は持たない。
- DEK は AWS Encryption SDK の caching CMM が作り、暗号文のメッセージに包んだ形で入る（ADR-0019 の 2026-09-28 の注記）。DEK の表（旧 `vault_deks`）は持たない（2026-09-28 の決定）。

## 5. 鍵の管理とローテーション

| 対象 | 周期 | 方式 |
| --- | --- | --- |
| `cde-pan`・`cde-sad` の鍵素材 | 365 日（KMS の自動ローテーション。90〜2,560 日で設定できる） | 旧い鍵素材は KMS が保持し、復号に自動で使う。アプリの変更は要らない（[Rotate AWS KMS keys](https://docs.aws.amazon.com/kms/latest/developerguide/rotate-keys.html)、2026-09-26 に確認） |
| DEK | 1 時間または 100 万件 | 新しい DEK を作る。旧い DEK は復号だけ |
| `cde-fp`（HMAC） | 2 年 | KMS の HMAC 鍵は自動ローテーションできない（同上）。新しい鍵を作り、Vault DB の全件の指紋を CDE の中で計算し直してから切り替える。本体の指紋は、本体が Vault Core から取り直して更新する |
| mTLS の証明書 | 90 日 | AWS Private CA。新旧を重ねて入れ替える |

- **漏洩の疑いがあるとき**：
  - KEK（CMK）：KMS の `ReEncrypt` で DEK を新しい CMK で包み直す。平文の DEK は KMS の外に出ない。その後、旧い CMK を無効にする。
  - DEK：該当の DEK で暗号化した PAN を、CDE の中のバッチで新しい DEK へ暗号化し直す。
  - 手順は runbook の `key-rotation.md`（E10 で作る。[runbooks/README.md](../runbooks/README.md)）に書く。
- 鍵の削除の待機期間は 30 日。削除の予約・鍵の無効化・キーポリシーの変更はアラートにする。
- 鍵の管理の手順（生成、配布、保管、暗号期間、廃棄、知識の分割）を文書にする（要件 3.6・3.7）。KMS を使うので、鍵の素材の手作業での扱いはない。

## 6. 保持と消去

方針は ADR-0024。カード番号に関わる部分をここに書く。

| 状態 | 消去の時期 |
| --- | --- |
| 本体への登録が済まなかった行（`pm_` が未設定） | 1 時間後 |
| Customer に保存していない PaymentMethod | 最後の使用から 30 日後（再試行・追加のオーソリ・キャプチャの余裕） |
| Customer に保存した PaymentMethod | 加盟店が外した（detach）とき、または Customer を消したとき。24 時間以内 |
| 有効期限を過ぎ、13 か月使われていないカード | 月次の消去 |
| 加盟店のアカウントの終了 | 終了の手続きが済んでから 30 日後（[merchant-onboarding.md](merchant-onboarding.md) の 8 節） |

- Vault は長期のスナップショットを取らず、35 日の PITR だけにする（[infrastructure.md](infrastructure.md)）。消去がバックアップにも期限内に及ぶ。

- 消去は行の物理削除で行う。消去の Worker は `DELETE` の権限だけを持ち、鍵を使えない。本体での detach・Customer の削除は、Vault Core の `delete_card` で伝える。
- PCI は、定義した保持期間を過ぎた保存データを少なくとも四半期ごとに見つけて消すことを求める（要件 3.2.1）。月次の消去のジョブと、四半期ごとの消し残しの確認で満たす。

## 7. CDE へのアクセス

方針は ADR-0020。

- **常設の人の権限はない。** 人は、申請 → 承認（申請者以外の 2 人目）→ 期限つきの権限（最長 4 時間）で入る。
- 入るのは SSM Session Manager だけ。SSH の鍵、踏み台、コンソールでの手作業は使わない。セッションの入出力を log-archive に記録する。
- MFA を必須にする（要件 8.4.2）。
- **AI エージェント（コーディング・運用）は CDE にアクセスしない。** JIT の対象にもしない。
- PAN を平文で見る手段は、人にも用意しない。調査は `card_ref`・指紋・下 4 桁で行う。
- アクセスの権限は 6 か月ごとに見直す（要件 7.2.4）。本家は四半期ごとに見直しているので、これに合わせて四半期にする。

## 8. ネットワークトークン（後で）

S2 以降で扱う。ネットワークトークンは、ブランドのトークンサービス（Visa Token Service、Mastercard MDES など）が PAN の代わりに発行するトークンで、カードの再発行に追従し、取引ごとの暗号文（cryptogram）を使う（[Stripe の解説](https://stripe.com/guides/understanding-benefits-of-network-tokens)）。

- 発行と暗号文の取得は Connector Gateway から、アクワイアラまたはトークンリクエスタの機能を通して行う。
- ネットワークトークンも Vault DB に `card_ref` に紐づけて、PAN と同じ鍵の階層で保管する。これは本システムの選択で、トークンリクエスタがトークンをどう保管すべきかを定めた公開の規則は見つからなかった（未検証）。ブランドの規則で確かめられたのは、Visa の暗号文（TAVV・DTVV）はオーソリの後に保存してはならず、1 回限りであること（[Visa のトークンの要件](https://usa.visa.com/content/dam/VCOM/global/support-legal/documents/avoid-authorization-declines-by-following-the-requirements-for-token.pdf)、2026-09-27 に確認）。暗号文は保存しない。
- PAN は、ネットワークトークンが使えないときのために残す。
- カードの情報の更新（Card Account Updater）も同じ時期に検討する。

## 9. ログとマスキング

- **構造化ログのフィールドは許可リストにする。** CDE のサービスは、許可したフィールドだけを出すロガーを使い、要求の本文をそのままログに出さない。
- CloudWatch Logs のデータ保護ポリシーで、カード番号・セキュリティコードの形をマスクし、検出をメトリクスにする（検出が 1 件でもあればアラート）。マネージドなデータ識別子は `CreditCardNumber`・`CreditCardExpiration`・`CreditCardSecurityCode` を使う（[金融のデータ識別子](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/protect-sensitive-log-data-types-financial.html)、2026-09-27 に確認）。
  - この 3 つは、近くに「card」「cvv」などのキーワードがあることを検出の条件にしている。キーワードのない生の PAN は検出されないことがあり、テスト用のカード番号も報告されない。**この仕組みを唯一の防御にしない。** 許可リストのロガー（上）と、正規表現と Luhn による独自のデータ識別子を併せて使う。
- 本体では、ADR-0005 の Confirmation のとおり、ログ・DB・メッセージに PAN の形（Luhn を満たす 13〜19 桁）が出ないことを CI と本番の走査で確かめる。S3 は Macie で走査する。
- 画面に出すカード番号は、BIN と下 4 桁までにする（要件 3.4.1）。本体の画面は下 4 桁だけを出す。
- CDE のログ・CloudTrail・VPC フローログは、log-archive アカウントへ送る（ADR-0023）。

## 10. PCI DSS の要件との対応（概要）

要件番号は PCI DSS v4.0.1 の原文（PCI SSC の文書庫からは取得できず、第三者が掲載した公式の PDF の写し [PCI-DSS-v4_0_1.pdf](https://www.middlebury.edu/sites/default/files/2025-01/PCI-DSS-v4_0_1.pdf) で照合。2026-09-27）と照合した。この文書・[security.md](security.md)・[observability.md](observability.md) の番号（1.3.1・1.3.2、3.2.1、3.3.1・3.3.1.2・3.3.2、3.4.1、3.5.1・3.5.1.1、3.6・3.7、6.2.3、6.3.3、6.4.3、6.5.1、7.2.4、8.4.2、10.2.1・10.2.2、10.4.1・10.4.1.1、10.5.1、10.6、10.7.2、11.3.1・11.3.2、11.4.1〜11.4.3、11.4.6、11.6.1、12.5.2・12.5.2.1、12.8、12.9、12.10・12.10.2）は、表題と内容が合っている。QSA との最初の打ち合わせで、PCI SSC から正式に取得した原本で改めて確かめる。AWS の責任範囲（物理、ハイパーバイザー）は、AWS Artifact の AOC と責任分担の表で引き継ぐ。

| 要件 | 内容 | 本システムでの対応 |
| --- | --- | --- |
| 1 | ネットワークのセキュリティ統制 | 別アカウント、private・isolated subnet、本体との 2 経路（本体 → CDE の PrivateLink、CDE → 本体の SQS）、Egress の許可リスト、Network Firewall |
| 2 | 安全な設定 | IaC（Terraform）だけで構成し、AWS Config で逸脱を検知。既定の認証情報を持たない（Fargate） |
| 3 | 保存データの保護 | 4〜6 節。CVC を残さない、PAN の暗号化、鍵の管理、保持と消去 |
| 4 | 送信時の暗号化 | 外部は TLS 1.2 以上と HSTS、内部は mTLS。アクワイアラへの経路も TLS |
| 5 | マルウェア対策 | コンテナは読み取り専用のファイルシステム。GuardDuty（ECS Runtime Monitoring）。イメージのスキャン |
| 6 | 安全な開発 | CDE のコードは CODEOWNERS（Security）の承認が必須、SAST、依存の管理。決済ページのスクリプトの管理（6.4.3） |
| 7 | 必要最小限のアクセス | 役割ごとの KMS の操作の分離（4 節）、JIT（7 節） |
| 8 | 識別と認証 | SSO＋MFA、共有アカウントなし、サービスは IAM ロール |
| 9 | 物理的なアクセス | AWS から引き継ぐ。社内に CDE の物理的な資産を持たない |
| 10 | ログと監視 | CloudTrail、アプリの監査、復号の記録、12 か月以上の保持（直近 3 か月はすぐ見られる）（ADR-0023） |
| 11 | テスト | ASV スキャン（四半期）、内部の脆弱性スキャン、ペネトレーションテスト（年 1 回と大きな変更後）、分割の検証（サービスプロバイダーは 6 か月ごと）、決済ページの改ざんの検知（11.6.1）（[security.md](security.md) の 10 節） |
| 12 | 方針と体制 | スコープの確認、TPSP の管理（3DS Server、アクワイアラ）、インシデント対応、加盟店への責任分担の提示（12.9） |

- サービスプロバイダーとして、加盟店に AOC と責任分担の表を出す（要件 12.9）。本家も、統合の方法に応じた自己評価の書式（SAQ）の案内を提供している（[Stripe のセキュリティ](https://docs.stripe.com/security)）。
- 附属書 A1（Additional PCI DSS Requirements for Multi-Tenant Service Providers。A1.1 顧客の環境の分離、A1.2 顧客ごとのログとインシデント対応）が当てはまるかは QSA に確認する（番号と表題は原文で確認。当てはまるかは QSA の判断で未検証）。

## 11. Epic との対応

| Epic | この文書から切り出す Story の候補 |
| --- | --- |
| E1 | CDE アカウント（cde-test から）と本体との 2 経路、テスト用の番号だけを受け付ける Vault の骨格 |
| E3 | Connector Gateway の `authorize` と detokenization、CVC の一時保管 |
| E6 | Elements の iframe と vault-ingest・`card_input` の紐づけ、Checkout のカード欄 |
| E10 | 鍵のローテーションの自動化、消去のジョブ、ログのマスキング、PCI の証跡の収集、DR（大阪） |
| E11 | ネットワークトークン、Card Account Updater（S2） |

## 12. 持ち越し

計測・接続先の選定・QSA の見解で決めるもの。

| 項目 | いつ・どう決めるか |
| --- | --- |
| 最初のアクワイアラが PAN の送信に独自の暗号化（TR-31 の鍵交換など）を求めるか。求めるなら AWS Payment Cryptography を connector-gateway で使う（ADR-0019） | E3 の接続先の選定 |
| コネクタが 3DS Server を提供するか。提供しなければ ADR-0012 の選択肢 3（3DS の専業の事業者）にする | E3 の接続先の選定（ADR-0012） |
| 指紋と BIN・下 4 桁を本体に置く扱い、附属書 A1 の適用、PrivateLink の扱いについての QSA の見解 | E10 の QSA の事前相談 |
