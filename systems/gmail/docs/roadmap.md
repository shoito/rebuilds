# Roadmap: Gmail

## 進め方の原則

- **最初に walking skeleton を通す。** E1・E2・E4・E5・E8 の最小の部分で、外部の MTA → `mx-edge` → スプール → `inbound-pipeline` → `mailstore` → change log → JMAP → Web の受信箱を端から端まで貫き、検証の環境で外部の MTA から送ったメールが Web に出て、返信が外部に届くところまで作ってから、機能を広げる。確定の後の 250、配送の冪等、`mailstore` だけの書き込みと change log、FORCE RLS、見張りのメールは、最初から本物の形で作る。後から足すと直せないため。
- **PoC を先に済ませる。** 次の PoC は、それぞれの Epic の Story の spec を承認する前に結果を記録する。
  - E2 の前：受信と送信の 1 台あたりの量、BYOIP の手続きの時間（`mx-throughput-poc`）。
  - E4 の前：MIME の解析のライブラリの選定（`mime-parser-poc`）、blob のパックと圧縮と費用（`blob-pack-poc`）、メールボックスのシャードの大きさ（`mailbox-shard-poc`）。
  - E6 の前：内容の分類器の形と推論の遅れ（`spam-classifier-poc`）。
  - E10 の前：日本語の索引の 2-gram と形態素（`search-index-poc`）。
- **送信の IP を早く温める。** 外部への送信の到達は、IP の評判が育つまで時間がかかる。E7 の前でも、E1 で IP を取得し、見張りのメールの少ない量から送り始める。
- **規則は 1 つのコードに。** SMTP の時点の判定は `crates/smtp-server`、認証は `crates/mailauth`、選別の合わせは `crates/filter`、メールボックスの状態は `crates/mailstore`、スレッドは `crates/threading`、検索とフィルターの条件は `crates/search-lang` にだけ書く。
- **契約を先に固定する。** SMTP の時点の判定の決定表、blob とフレームの形式、change log の形、JMAP の拡張、IMAP の箱の対応と UID の規則、スレッドの合わせの規則と件名の正規化、ラベルの排他の規則、データの区分（C1〜C3）は、人間がレビューして確定する。エージェントは勝手に変えない。
- **法務の確認待ちの Story は、spec を承認しない。** 設計と、法務に依らない Story は進めてよい（[intent.md](intent.md) の「法務の確認待ち」L1〜L10）。下の表で「法務：L*」と書いた Story が当たる。
- **選別は影から出す。** 規則とモデルは、評価の集まりの合否を通した後、本番で影の判定を経てから、段階的に判定に使う。

## Epic

PM が持つ。変更の一覧はここに書かず、各変更の `spec.md` の frontmatter（`epic`）から集計する（[process.md](../../../docs/process.md) の「粒度」）。各 Epic の品質の重点と合否基準は [quality.md](quality.md) の 5 節にある。

| Epic | 目的 | 状態 |
| --- | --- | --- |
| E1 基盤 | AWS・Terraform・CI（Rust と TypeScript、ファジングと模型の枠）、BYOIP とネットワーク、Aurora（directory とシャード）と RLS、S3・SQS、ECS（Fargate と EC2）、フラグ、観測と見張りのメール、監査ログ、大阪の骨格 | 設計中 |
| E2 受信の SMTP | `mx-edge`、接続の評判と速さ、宛先の確認、SMTP の時点の判定、スプールと待ち行列、STARTTLS・MTA-STS・TLS-RPT、大阪の副 MX | 未着手（前に MX の PoC） |
| E3 送信者の認証 | SPF・DKIM・DMARC・ARC の検査、`Authentication-Results`、DKIM の署名と鍵、ARC の封印、DMARC の集計の報告 | 未着手 |
| E4 メールの保存 | MIME の解析と上限、日本の文字コード、blob とパック、圧縮と暗号化、`mailstore` の配送、参照と GC、容量、消去 | 未着手（前に MIME・blob・シャードの PoC。消去の期限は法務：L6） |
| E5 ラベルとスレッド | システムと利用者のラベル、排他、アーカイブ、ミュート、スヌーズ、スレッド化 | 未着手 |
| E6 迷惑メールの選別 | 規則、評判、分類器、添付と URL の検査、利用者の報告、隔離、評価の枠、影の判定 | 未着手（前に分類器の PoC。既定の有効化は法務：L1、共有は法務：L10） |
| E7 送信の SMTP と評判 | `outbound-gate`、`mta-out`、IP プールとウォームアップ、速さの調整、再試行、DSN、フィードバックループ、送信の上限、乗っ取りの検知 | 未着手（送信の選別は法務：L1、停止の範囲は法務：L2） |
| E8 同期の API とプッシュ | change log、JMAP（Core・Mail・Submission）と拡張、EventSource・WebSocket、モバイルのプッシュの経路 | 未着手 |
| E9 Web のクライアント | 受信箱、スレッド、作成、元に戻す送信、予約の送信、ラベル、設定、HTML メールの安全な描画、外部の画像の代理、配信停止のボタン | 未着手（画面の寄せ方は法務：L9、配信停止は法務：L2、画面の計測は法務：L8） |
| E10 検索 | 検索の文法と IR、索引、`search-node`、状態のビットマップ、候補 | 未着手（前に索引の PoC。演算子の確定は法務：L9、索引は法務：L1） |
| E11 IMAP と submission | IMAP4rev2、CONDSTORE・QRESYNC、IDLE、OBJECTID、SMTP の submission、OAuth の SASL | 未着手 |
| E12 フィルター・転送・自動化 | フィルター、確認つきの転送（SRS・ARC）、不在の返信、スヌーズ | 未着手 |
| E13 アカウントと安全 | 作成、サインイン（パスキー、2 段階）、セッション、回復、乗っ取りの検知と対応、第三者のアプリの OAuth | 未着手（回復の SMS は法務：L3） |
| E14 組織 | 組織と組織の単位、独自のドメイン、別名とグループ、配送の規則、管理の役割と監査、SSO | 未着手（契約は法務：L7） |
| E15 保持と eDiscovery | 保持の規則、保留、横断の検索と書き出し、捜査機関への対応の枠 | 未着手（法務：L4・L6） |
| E16 モバイルのアプリ | iOS・Android、オフラインの読み書き、プッシュ、通知 | 未着手（プッシュの本文は法務：L3・L5、計測は法務：L8） |
| E17 本番の準備と GA の判定 | 負荷試験、到達性の試験、DR の訓練、外部のペンテスト、GA の判定 | 未着手（GA の判定は法務：L1〜L7） |
| E18 POP3 と取り込み（MVP の後） | POP3、他社のアカウントからのメールの取り込み | 未着手（MVP の後） |
| E19 S/MIME（MVP の後） | 組織向けの S/MIME の署名の検証と表示、署名と暗号化 | 未着手（MVP の後） |
| E20 添付の動的な解析（MVP の後） | サンドボックスでの実行、添付の中身の文字の抽出と検索 | 未着手（MVP の後。法務：L1） |
| E21 BIMI と送信の DANE（MVP の後） | BIMI のロゴの表示、送信の DANE | 未着手（MVP の後） |
| E22 受信箱の分類と重要の自動の判定（MVP の後） | 受信箱のタブ、重要の自動の判定 | 未着手（MVP の後。法務：L1） |
| E23 誤送信の対策（MVP の後） | 外部の宛先の確認、送信の保留、組織の SMTP のリレー | 未着手（MVP の後） |
| E24 公開の REST API と送信者向けの画面（MVP の後） | 第三者向けの REST API、外部の送信者向けの評判の画面 | 未着手（MVP の後） |
| E25 海外のリージョン（MVP の後） | アカウントをリージョンに固定する、リージョンごとのセル | 未着手（MVP の後。法務：L5） |

E1〜E17 が MVP（S1）。領域の文書の「Story の候補」は、この番号で書く。

## Story

各 Story は、着手するときに `changes/YYMMDD-<slug>/` として起票する。ここは計画で、進み具合は各変更の `spec.md` の frontmatter で見る。順序は Epic の中での目安で、依存があるものを先に置いた。領域の文書（[architecture/README.md](architecture/README.md) の 7 節）を書くときに、各領域の「Story の候補」で直す。

### E1 基盤

| Story | 内容 |
| --- | --- |
| `dev-repo-bootstrap` | Gmail の再構築の開発リポジトリを作り、`changes/`・`specs/`・開発向けの `AGENTS.md`、CODEOWNERS（`crates/smtp-server`・`mailauth`・`filter`・`mailstore`・`threading` はテックリード）を置く（リポジトリ共通の ADR-0005） |
| `aws-accounts-and-network` | アカウント（本番、検証、報告のサンプルと学習の別のアカウント、見張りの別のアカウント）、SCP、VPC。データの所在の約束は法務：L5 |
| `ip-ranges-and-byoip` | IP の範囲の取得、BYOIP、逆引き、ポート 25 の送信の制限の解除の申請、IP の温めの開始（ADR-0001） |
| `edge-and-endpoints` | NLB（25・465・587・993）、CloudFront・WAF、ドメイン（`mx`・`smtp`・`imap`・`jmap`・`app.<brand>.<domain>`、`<brand>usercontent.<domain>`）、TLS |
| `ecs-fargate-and-ec2-capacity` | Fargate のサービスと、EC2（固定の IP、NVMe）のキャパシティープロバイダー |
| `terraform-root-modules` | ルートモジュールとポリシーの検査 |
| `aurora-directory-and-rls` | directory のクラスタ、RLS、`SET LOCAL app.tenant_id`、RLS の外の表と、テナントをまたぐ経路の許可リスト（ADR-0007） |
| `mailbox-shards-baseline` | メールボックスのシャードの作成の自動化、シャードの割り当て、RLS（`app.account_id`）（ADR-0007） |
| `s3-sqs-baseline` | スプール・blob・索引のバケット、SSE-KMS、ライフサイクル、大阪への CRR と RTC、SQS の配送の待ち行列 |
| `ci-pipeline-baseline` | PR の関門、Rust と TypeScript、ファジングの夜間、模型の枠、テストの緩和の検出、依存の禁止の一覧（ADR-0001） |
| `flags-appconfig` | `release.*`・`ops.*` のフラグ |
| `observability-and-mail-canary` | 観測の経路、外部の見張りのアカウントとの送受の骨格（quality.md の 2.2.1 節 K） |
| `audit-log-table-and-archive` | 監査ログの表と、S3 の Object Lock への写し |
| `osaka-warm-standby` | 大阪の骨格、Aurora Global Database、CRR の遅れの監視 |

### E2 受信の SMTP

| Story | 内容 |
| --- | --- |
| `mx-throughput-poc` | PoC：`mx-edge`・`mta-out` の 1 台あたりの接続とメッセージの数、BYOIP の手続きの時間 |
| `smtp-server-core` | SMTP の状態の機械、EHLO・STARTTLS・PIPELINING・SIZE・8BITMIME・SMTPUTF8・CHUNKING、上限 |
| `connection-reputation-and-limits` | 接続の評判、IP・/24・ASN ごとの速さ、一時の絞り（ADR-0002） |
| `recipient-validation` | 宛先の解決のキャッシュ、宛先がない・停止・容量の超過の応答 |
| `end-of-data-checks` | DATA の終わりの同期の検査と予算、決定表（ADR-0002） |
| `spool-and-delivery-queue` | スプールと SQS の確定の後の 250、掃除の役、重複の抑え（ADR-0002） |
| `mta-sts-and-tls-rpt-inbound` | 本システムのドメインの MTA-STS の公開、TLS-RPT の受け取り |
| `osaka-secondary-mx` | 大阪の副 MX（受け付けて溜め、東京の再開の後に配る） |
| `smtp-peer-sim` | SMTP の相手の模型と、受信の全場面（quality.md の 2.2.1 節 B） |

### E3 送信者の認証

| Story | 内容 |
| --- | --- |
| `spf-evaluation` | SPF の評価（RFC 7208）、照会の上限、マクロ |
| `dkim-verify` | DKIM の検証（RSA、Ed25519）、正規化、`Authentication-Results` |
| `dmarc-evaluation` | DMARC の評価、組織のドメインの決め方、方針の当て方 |
| `arc-verify-and-seal` | ARC の検査と封印 |
| `dkim-signing-and-key-rotation` | 本システムのドメインと組織のドメインの DKIM の署名、鍵の作成と交換、セレクター |
| `dmarc-reports` | DMARC の集計の報告の送信（受信の側）と受け取り（本システムと組織のドメイン） |
| `auth-test-vectors-and-interop` | 試験のベクトルと、外部の実装との相互の検証（quality.md の 2.2.1 節 C） |

### E4 メールの保存

| Story | 内容 |
| --- | --- |
| `mime-parser-poc` | PoC：MIME の解析のライブラリの選定（壊れた日本語のメール、入れ子、ファジングの耐性） |
| `blob-pack-poc` | PoC：パックの大きさ、zstd の水準と辞書、S3 の要求の費用 |
| `mailbox-shard-poc` | PoC：1 つのシャードあたりのアカウントの数、配送と同期の書き込みの量 |
| `mime-parsing-and-limits` | MIME の解析と上限の層、パートの木の索引、文字コードの変換（日本の旧来の文字コード、機種依存の文字） |
| `blob-format-v1` | blob とフレームの形式、圧縮、blob ごとの鍵、試験のベクトル（ADR-0003） |
| `mailstore-deliver` | 配送（blob の共有、前置き、メタデータ、冪等）、`modseq` と change log と outbox |
| `blob-catalog-and-refcount` | blob の目録のシャード、参照の数え、鍵の破棄、GC（ADR-0003）。物理の消去の期限は法務：L6 |
| `blob-packer` | 小さな blob の詰め直し、生きている割合の低いパックの詰め直し |
| `quota` | 容量の数え、超過の応答、利用者への知らせ |
| `mime-fuzzing` | MIME と文字コードのファジングと差分のファジング（quality.md の 2.2.1 節 A） |

### E5 ラベルとスレッド

| Story | 内容 |
| --- | --- |
| `labels-and-exclusivity` | システムと利用者のラベル、排他の決定表、アーカイブ（ADR-0004） |
| `thread-ops-mute-snooze` | スレッドへの操作、ミュート、スヌーズ |
| `threading-v1` | スレッド化の規則、件名の正規化、仮の節、合わせ（ADR-0005） |
| `threading-property-tests` | スレッド化の性質ベーステスト（quality.md の 2.2.1 節 D） |
| `trash-and-spam-expiry` | ゴミ箱と迷惑メールの箱の 30 日の期限 |

### E6 迷惑メールの選別

| Story | 内容 |
| --- | --- |
| `spam-classifier-poc` | PoC：分類器の形（勾配ブースティングと小さな言語モデル）、推論の遅れ、評価の集まりでの質 |
| `filter-pipeline-and-verdicts` | 層のパイプライン、判定と理由のコード、データの区分の型（ADR-0008） |
| `rules-engine` | 規則のエンジンと最初の規則の集まり |
| `reputation-service` | IP・ドメイン・URL・ハッシュの評判、外部のブロックリストの入力 |
| `content-classifier` | 分類器の推論（ONNX Runtime）、モデルのバージョン |
| `attachment-static-scan` | 添付の静的な検査（隔離したタスク）、既知のマルウェアの止め |
| `url-extraction-and-reputation` | URL の取り出しと評判、開くときの確かめの API |
| `user-reports-and-consented-samples` | 迷惑メールの報告・迷惑メールではない、同意のある報告のサンプルの置き場所。範囲は法務：L1 |
| `filtering-consent-settings` | 選別の範囲の設定と示し方。既定の有効化は法務：L1 |
| `org-quarantine` | 組織の隔離と、管理者の確かめと解除 |
| `filter-eval-and-shadow` | 評価の枠と影の判定（quality.md の 2.2.1 節 H） |
| `threat-intel-sharing` | 外部との脅威の情報の共有。法務：L10 |

### E7 送信の SMTP と評判

| Story | 内容 |
| --- | --- |
| `outbound-gate` | 送信の依頼の解放、アカウントの送信の上限、DKIM の署名、IP プールの選択 |
| `mta-out-queues-and-throttling` | 宛先のドメインごとの待ち行列と接続、速さの調整、MTA-STS の尊重、TLS-RPT の送信 |
| `retries-and-dsn` | 再試行と後退、DSN の生成（RFC 3464） |
| `ip-pools-and-warmup` | プールの分け方とウォームアップの計画 |
| `feedback-loops-and-blocklist-monitoring` | 外部の事業者のフィードバックループの登録と受け取り、ブロックリストの監視 |
| `outbound-content-filtering` | 送信の内容の選別。範囲は法務：L1 |
| `compromised-account-detection` | 送信の異常の検知、保留、本人への確かめ。停止の範囲は法務：L2 |
| `srs-for-forwarding` | 転送の SRS と、転送のプール |

### E8 同期の API とプッシュ

| Story | 内容 |
| --- | --- |
| `change-log-and-modseq` | change log の形と保持、`modseq`（ADR-0006） |
| `jmap-core-and-mail` | JMAP の Core と Mail（`Email`・`Thread`・`Mailbox`・`*/changes`・`*/query`） |
| `jmap-submission` | `EmailSubmission`、`sendAt`、取り消し |
| `jmap-extensions` | 本システムの拡張（スレッドへの操作、スヌーズ、ミュート、検索の文字列、配信停止） |
| `push-gateway` | EventSource・WebSocket のプッシュ、IMAP の IDLE への合図 |
| `mobile-push-pipeline` | APNs・FCM への送信の経路。本文の中身は法務：L3・L5 |
| `sync-convergence-sim` | 同期の収束の模型（quality.md の 2.2.1 節 E） |

### E9 Web のクライアント

| Story | 内容 |
| --- | --- |
| `web-shell-and-inbox` | 画面の骨格、受信箱、オフラインと楽観の更新。画面の寄せ方は法務：L9 |
| `thread-view-and-safe-html` | スレッドの表示、HTML メールの安全な描画（サンドボックスの iframe、CSS の制限） |
| `remote-image-proxy` | 外部の画像の代理の取得（`<brand>usercontent.<domain>`） |
| `compose-and-drafts` | 作成、返信、転送、署名、下書きの自動保存、添付 |
| `undo-and-scheduled-send` | 元に戻す送信、予約の送信 |
| `one-click-unsubscribe-button` | 配信停止のボタン。法務：L2 |
| `labels-and-settings-ui` | ラベル、設定、フォルダーの表示 |
| `ui-analytics` | 画面の計測。法務：L8 |

### E10 検索

| Story | 内容 |
| --- | --- |
| `search-index-poc` | PoC：2-gram と形態素、索引の大きさ、順位の質 |
| `search-language-and-ir` | 検索の文法と IR、WASM、演算子の決定表。演算子の確定は法務：L9 |
| `search-indexer-and-segments` | 索引の作成、セグメント、合わせ（ADR-0009）。索引の作成は法務：L1 |
| `search-node-and-placement` | `search-node` の受け持ちと写し、NVMe のキャッシュ |
| `state-bitmaps` | 状態のビットマップと change log の追いつき |
| `search-reference-compare` | 参照の実装との一致（quality.md の 2.2.1 節 I） |

### E11 IMAP と submission

| Story | 内容 |
| --- | --- |
| `imap-core` | IMAP4rev2、箱の対応、UID の数え、`SPECIAL-USE`、`MOVE` |
| `imap-condstore-qresync` | CONDSTORE・QRESYNC、`VANISHED`、OBJECTID |
| `imap-idle` | IDLE と `push-gateway` |
| `smtp-submission` | 465・587 の submission、送信の依頼への変換 |
| `oauth-sasl` | `OAUTHBEARER`・`XOAUTH2` |
| `imap-interop` | 主な IMAP のアプリとの相互運用の試験 |

### E12 フィルター・転送・自動化

| Story | 内容 |
| --- | --- |
| `user-filters` | フィルターの条件（検索の IR）と動作、既存のメールへの適用 |
| `verified-forwarding` | 転送の先の確かめのメール、転送の規則、SRS と ARC |
| `vacation-responder` | 不在の返信（4 日、RFC 3834） |
| `snooze-and-schedule-workers` | スヌーズの戻し、予約の送信の解放の仕組み |

### E13 アカウントと安全

| Story | 内容 |
| --- | --- |
| `account-signup` | アカウントの作成、アドレスの規則、迷惑な作成の抑え |
| `sign-in-passkeys-and-2sv` | パスキー、パスワードと 2 段階の確認、セッション |
| `risk-based-challenges` | 危険度での確かめ |
| `account-recovery` | 回復の手段。SMS は法務：L3 |
| `ato-detection-and-response` | 乗っ取りの検知、転送・フィルターの変更の通知、全セッションの失効 |
| `oauth-authorization-server` | 第三者のアプリの OAuth、スコープ、同意、アプリの確かめ |
| `account-activity` | 活動の表示（サインイン、接続中のアプリ） |

### E14 組織

| Story | 内容 |
| --- | --- |
| `orgs-and-org-units` | 組織、組織の単位、管理の役割 |
| `custom-domains` | ドメインの確かめ、MX・SPF・DKIM・DMARC・MTA-STS の案内 |
| `aliases-and-groups` | 別名、グループ（配布）、送信の許可 |
| `routing-rules` | 分けた配送、送信のゲートウェイ、全受け |
| `admin-audit-log` | 管理の操作の監査ログ |
| `sso-saml-oidc` | SAML・OIDC の SSO |
| `org-contracts` | 契約の文書、サブプロセッサーの一覧。法務：L7 |

### E15 保持と eDiscovery

| Story | 内容 |
| --- | --- |
| `retention-rules` | 保持の規則と期限の処理。期限は法務：L6 |
| `legal-holds` | 保留と、保留の中の消去の止め |
| `ediscovery-search-and-export` | 横断の検索と書き出し、担当の役割、監査 |
| `lawful-access-framework` | 捜査機関への対応の枠。法務：L4 |

### E16 モバイルのアプリ

| Story | 内容 |
| --- | --- |
| `mobile-sync-core` | オフラインの DB と JMAP の同期の層（iOS・Android） |
| `mobile-inbox-and-compose` | 受信箱、スレッド、作成 |
| `mobile-notifications` | プッシュの受け取りと通知。本文は法務：L3 |
| `mobile-release-pipeline` | 配布、段階のリリース |
| `mobile-analytics` | アプリの計測。法務：L8 |

### E17 本番の準備と GA の判定

| Story | 内容 |
| --- | --- |
| `load-tests` | 受信・送信・同期・検索の負荷試験（S1 のピークの 2 倍） |
| `deliverability-tests` | 外部の主な事業者への到達の試験 |
| `dr-failover-drill` | 大阪の副 MX と、大阪への切り替えの訓練 |
| `pentest-external` | 外部のペンテスト（SMTP、IMAP、JMAP、Web、OAuth、HTML の描画） |
| `slo-dashboards-alerts` | SLO とアラート（[runbooks/README.md](runbooks/README.md)） |
| `runbooks-e17` | 個別の手順の作成と確認 |
| `ga-readiness` | GA の判定。法務：L1〜L7 |

## エージェントに任せないこと

- **契約（SMTP の時点の判定の決定表、blob の形式、change log の形、JMAP の拡張、IMAP の箱と UID の規則、スレッドとラベルの規則、データの区分）の確定**：利用者のデータとクライアントに出した後に変えるコストが最も高い。
- **選別のモデルと規則の本番での有効化、評価の集まりの合否の基準の変更**：QA と Dev の判断。
- **送信の上限・評判の閾値の変更、IP プールの割り当ての変更、アカウントの送信の停止の解除**：Ops と到達性の担当が判断する。
- **ブロックリストの解除の申請、外部の事業者との連絡**：Ops が行う。
- **報告のサンプルの置き場所の中身を見ること**：権限を持つ人だけが、監査の下で行う。
- **大阪への切り替えの判断**：IC と Ops の責任者。
- **開示の請求・捜査機関からの照会への応答、eDiscovery の書き出しの実行**：法務と Ops、組織の担当。
- **法務の判断**（L1〜L10）。
- **負荷試験・PoC・評価の結果の解釈**：数字は出せるが、採否は Dev と PM の判断。

## 延期の一覧

MVP の後に検討する。E18〜E25 に入れなかったもの。着手するときに `intent.md` から起票する。

- **機密モード**（[architecture/README.md](architecture/README.md) の 1.4 節。誤った安心と、法務の L3）。
- **委任（他の人のメールボックスを読み書きする許可）と組織の共有の受信箱の画面**（ADR-0007 の `app.account_ids` の形だけを用意する）。
- **利用者が手でスレッドから外す操作**（ADR-0005）。
- **組織ごとの暗号化の鍵（BYOK）と、保存を分ける組織**（ADR-0003）。
- **アプリのパスワード**（作らない方針。要望が強ければ別の ADR）。
- **Sieve のフィルターの読み込みと書き出し**（filters-forwarding-and-automation の領域）。
- **S2 以降のセルの構成**（infrastructure の領域）。
