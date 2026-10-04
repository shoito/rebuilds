# Intent: Salesforce を AI エージェント主体で再構築する

- Author: shoito
- Status: draft
- Date: 2026-09-28

## Problem

B2B の営業チームは、顧客（取引先・取引先責任者）、見込み客（リード）、商談、活動を記録し、チームで共有して、売上の見込みを管理する。これを表計算やメールで回すと、次のことで困る。

- 情報が人ごとに散らばり、担当が替わると履歴が消える。
- 見せてよい相手が会社ごとに違う。上司は部下の商談を見たいが、他の支店の商談は見せたくない。
- 業務は会社ごとに違う。項目、画面、承認の流れ、自動の処理を、会社ごとに変えたい。しかし、会社ごとにシステムを作るのは高い。
- 業務の変更を本番で直接試すと、営業の仕事が止まる。

本家 Salesforce は、これを「1 つの共有の基盤の上で、会社ごとの違いをメタデータとして持ち、実行時に解釈する」形で提供している。オブジェクト・項目・画面・自動化は DB の構造ではなくメタデータとして持ち、全テナントのデータを少数の共有の表に入れる（[Platform Multitenant Architecture](https://architect.salesforce.com/docs/architect/fundamentals/guide/platform-multitenant-architecture.html)、2026-09-28 に確認）。見せてよい相手は、設定が変わった時に事前計算して保存し、読む時の計算を小さくしている（[Record-Level Access: Under the Hood](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_record_access_under_the_hood.pdf)、Winter '27 版、2026-09-28 に確認）。

その中身を、本家の実装に頼らず（[リポジトリ共通の ADR-0007](../../../docs/decisions/0007-no-reuse-of-original-implementation.md)）、小さなチームと AI エージェントでどこまで作り直せるかを確かめる。

## Proposed outcome

日本の B2B の営業チームと管理者が、コードを書かずに、自社の営業の業務に合わせた CRM を使える基盤を作り直す。次の 4 つの価値を満たす。

1. **業務に合わせて変えられる**：管理者が、オブジェクト・項目・画面・リストビュー・自動化・承認を、画面の操作（宣言的な設定）で変えられる。変更は即時に反映され、他の組織に影響しない。
2. **見せてよい人にだけ見せる**：組織の共有設定、ロール階層、共有ルール、手動の共有、権限セット、項目レベルのセキュリティで、誰が何を見て変えられるかを決められる。画面・API・レポート・検索・エクスポートのどこからでも、同じ判定が効く。
3. **安全に変える**：Sandbox の組織で作って試し、検証してから本番へメタデータをデプロイできる。デプロイは全部か無しかで、失敗しても本番は元のまま動く。
4. **公平で止まらない**：ある組織の重い処理が、他の組織を遅くしない。トランザクションごとの上限（ガバナ制限）と組織ごとの割り当てで守る。

### MVP（S1）に含める

- **組織（org）をテナントにする**：組織の作成、エディションとライセンス、利用者、ログイン（SSO を含む）、組織の設定の画面（Setup に相当）
- **標準オブジェクト**：取引先、取引先責任者、リード（取引先・取引先責任者・商談への変換を含む）、商談（フェーズ、金額、完了予定日）、活動（ToDo と行動）
- **カスタムオブジェクトとカスタム項目**：メタデータとして定義する。型（テキスト、数値、通貨、日付、日時、チェックボックス、選択リスト、参照、主従、数式、積み上げ集計）、必須、一意、外部 ID、入力規則
- **画面**：ページレイアウト（項目の配置、関連リスト）、レコードタイプ、リストビューのビルダー（列、条件、並べ替え、共有）
- **レコードのアクセスのモデル**：
  - 組織の共有設定（OWD：非公開、公開・参照のみ、公開・参照・更新、親に連動）
  - ロール階層
  - 共有ルール（所有者の条件と、レコードの条件）
  - 手動の共有
  - プロファイルと権限セット（オブジェクトの権限、「すべて参照」「すべて変更」、システムの権限）
  - 項目レベルのセキュリティ
- **レポートとダッシュボード**：表形式・サマリー・マトリックス、グラフ、ダッシュボードの部品、見る人の権限で集計する
- **宣言的な自動化**：レコードの変更で動くフロー（保存の前・後）、スケジュールで動くフロー、画面のフロー、承認のプロセス
- **API**：REST API（レコードの CRUD、問い合わせ、メタデータの記述）、一括の API（大量の登録・更新・削除・問い合わせのジョブ）
- **変更のイベントと Webhook**：レコードの変更を順序付きで配信し、再生できる。組織が定義するイベント、外向きの Webhook
- **インポート**：CSV の取り込みのウィザード、重複の照合、外部 ID での upsert
- **監査**：設定の変更の履歴、項目の変更の履歴、ログインの履歴
- **Sandbox**：開発・試験用の組織（メタデータだけの複製と、データを含む複製）。組織の間のメタデータのデプロイ（検証だけの実行、全部か無しか）

### MVP の後の Epic で扱う

| 機能 | 理由 |
| --- | --- |
| 利用者のコードによる拡張（トリガー、独自の API） | 任意のコードを共有の基盤で動かすため、隔離と上限の設計が重い。言語の方針は [ADR-0001](decisions/0001-platform-and-stack.md) で決めた（TypeScript を WASM の砂場で動かす）。MVP は宣言的な設定だけにする |
| パッケージ（AppExchange に相当）：配布、名前空間、バージョンの管理、インストール先での上書き | メタデータのデプロイ（E10）の上に作る。名前空間と上限の分け方が要る |
| CPQ（見積もりの構成と価格） | 商品と価格表のモデル、承認、見積書の出力が要る。商談の後に扱う |
| 売上予測（フォーキャスト） | 商談とロール階層の上に作る。集計の期間と調整の履歴の設計が要る |
| AI（本家の Einstein・Agentforce に相当）：スコアリング、要約、エージェント | 学習データの扱いと、法務の確認（L1、L2）が要る |
| テリトリー管理、商談チーム・取引先チームの細かな設定 | 共有のモデル（ADR-0004）の上に足せる。MVP は手動の共有とチームの基本だけ |
| 複数の通貨、日本語と英語以外の言語 | 日本の市場を先にする。MVP は JPY と、日本語・英語の画面 |
| モバイルのネイティブアプリ、オフライン | MVP はレスポンシブな Web |
| 外部のデータソースの参照（外部オブジェクト） | 他のシステムとつなぐ需要を見て扱う |

### 守るべき振る舞い

- 組織は、他の組織のメタデータ・レコード・ログを一切見られない。Sandbox も別の組織として扱い、本番の組織のデータに触れない。
- 利用者が見られないレコードは、画面・API・レポートの集計・検索・リストビューの件数・エクスポート・変更のイベントの購読のどこにも現れない。
- FLS で見えない項目の値は、どの経路でも返さない。数式やレポートの集計を通して値が漏れない。
- 共有の設定を変えた時、再計算の途中で、古い設定と新しい設定が混ざった判定をしない。どちらか一方で判定する。
- メタデータのデプロイは全部か無しかで行う。検証に失敗したデプロイは、本番の組織を一切変えない。
- 1 つのトランザクションは、上限を超えたら全体を巻き戻す。一部だけが保存された状態を残さない。
- 項目やオブジェクトを削除しても、一定の期間は復元できる。削除を確定するまで、データを消さない。
- 設定の変更、権限の変更、データの一括の削除は、監査のログに残る。

### 成功の基準

| # | 基準 | 目標 | 測り方 |
| --- | --- | --- | --- |
| K1 | 画面の速さ | レコードの詳細の表示に要る API の p95 300ms 以内（NFR-001） | サーバーの計測と RUM |
| K2 | 宣言的な変更の反映 | カスタム項目の追加から、画面と API で使えるまで p95 5 秒以内。他の組織の p95 の悪化なし | メタデータのバージョンの計測 |
| K3 | アクセス制御の正しさ | 参照の評価器と、本番の判定の食い違い 0 件 | 性質ベーステスト、本番での標本の照合（ADR-0004） |
| K4 | 公平 | 上限まで負荷をかけた組織があっても、他の組織の p95 の悪化が 10% 以内（NFR-003） | 騒がしい隣人の負荷試験（E12） |
| K5 | デプロイの安全 | デプロイの失敗で本番の組織が部分的に変わった件数 0 件。デプロイ中のデータの書き込みの止まりが p99 1 秒以内（NFR-004） | デプロイの結合テストと本番の計測 |
| K6 | 共有の再計算 | OWD の変更は行を書き直さない述語の切り替えで、反映が p95 5 秒以内。100 万件のレコード・1,000 人の組織で、レコードの条件の共有ルールの追加・変更の再計算が 15 分以内（NFR-005。2026-09-28 に改めた） | E4 の PoC と E12 の負荷試験 |
| K7 | テナントの分離 | 他の組織のデータが見える事象 0 件（NFR-009） | 性質ベーステストと本番の監査 |
| K8 | 導入の速さ | 新しい組織を作ってから、CSV で取引先 1 万件を取り込み、リストビューで見るまで、中央値 30 分以内 | オンボーディングのイベントの計測 |

## Affected users and systems

- **営業の担当者**（主な利用者）：日本の B2B の企業の営業。取引先・商談・活動を記録し、リストビューとレポートで自分の仕事を管理する。中堅の企業（利用者 20〜2,000 人）を最初の対象にする。
- **営業の管理職**：部下の商談とパイプラインをレポート・ダッシュボードで見る。ロール階層で部下のレコードを見る。
- **組織の管理者**：オブジェクト・項目・画面・自動化・権限・共有を設定する。Sandbox で試してデプロイする。情報システム部門か、営業企画の担当が多い。
- **連携の開発者**：REST API と一括の API、変更のイベント、Webhook で、基幹システム・名刺管理・MA（マーケティングの自動化）とつなぐ。
- **外部のシステム**：利用者の IdP（SAML・OIDC の SSO）、メールの送信事業者、Webhook の受け手、検索と分析の部品。
- **社内の運用**：サポート、セキュリティの監視、障害の対応、組織の移動（セルの間）。

## Constraints

- **本家の実装を核に使わない**（[リポジトリ共通の ADR-0007](../../../docs/decisions/0007-no-reuse-of-original-implementation.md)）。メタデータの実行基盤、保存の形、共有の計算、ガバナ制限は自分で設計する。本家が公開している設計の考え方（ユニバーサルなデータ辞書、ピボットの索引の表、共有の表）は参考にするが、コードや言語の互換は持たない。
- **Apex との互換は目標にしない。** 本家の言語（Apex、SOQL、SOSL）、画面の技術（Visualforce、Lightning Web Components）、メタデータの XML の形式は受け付けない。問い合わせの言語・数式の言語・メタデータの形式は、この題材で独自に定める（[ADR-0001](decisions/0001-platform-and-stack.md)、[ADR-0003](decisions/0003-metadata-driven-runtime.md)）。
- 実行基盤と技術は、rebuilds の他の題材の決定（AWS 東京・大阪、TypeScript、Aurora PostgreSQL、Terraform、OpenTelemetry）を引き継ぐ（[ADR-0001](decisions/0001-platform-and-stack.md)）。
- 本家の名前は識別子に使わない。組織のドメインは `<org>.my.<brand>.<domain>` の形、上限の情報のヘッダーは `<Brand>-Limit-Info` の形で書く（[リポジトリ共通の ADR-0006](../../../docs/decisions/0006-brand-neutral-identifiers.md)）。
- 日本の法令（個人情報保護法、電気通信事業法）への対応は、法務の確認を前提に設計する。
- 規模は段階的に広げる（[architecture/](architecture/README.md) の「規模の段階」）。

## Non-goals

| 機能 | 理由 |
| --- | --- |
| Apex・SOQL・SOSL・Visualforce・本家のメタデータの形式との互換 | [リポジトリ共通の ADR-0007](../../../docs/decisions/0007-no-reuse-of-original-implementation.md) と [ADR-0001](decisions/0001-platform-and-stack.md)。本家からの移行の道具が要れば、別の Epic で変換の道具として扱う |
| Service Cloud（ケース、コンタクトセンター）、Marketing Cloud、Commerce Cloud | Sales Cloud と基盤に絞る。基盤の上に後から足せる形にはする |
| Experience Cloud（顧客・パートナーのポータル） | 外部の利用者のライセンスと、共有のモデルの拡張（ポータルのロール）が要る。本家でも共有の計算が重くなる要因（[Record-Level Access: Under the Hood](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_record_access_under_the_hood.pdf)） |
| 専用の環境（シングルテナント）での提供 | 運用の形が別になる。S3 のセルで、大口の組織に専用のセルを用意して代替する |
| 海外のリージョン、海外の認定（FedRAMP など） | 日本の市場を先にする |
| 本家の SDK・API との完全な互換 | [リポジトリ共通の ADR-0006](../../../docs/decisions/0006-brand-neutral-identifiers.md)。独自の SDK を用意する |

## Open questions

### 法務の確認待ち

設計はどの結論にも対応できる形にするが、結論は出さない。**下の表の「承認を止める spec」は、確認が済むまで PM・QA が承認しない。**

| # | 問い | 関係する設計 | 承認を止める spec |
| --- | --- | --- | --- |
| L1 | 個人情報保護法：組織が登録する取引先責任者・リードの個人データを、本システムが委託を受けて扱うのか、いわゆるクラウドの例外に当たるのか。サポートでの参照、障害の調査、AI の機能での利用の扱い。BCC で取り込むメールの本文（第三者の個人データ）の扱い、利用者の匿名化と履歴の値の消去（本人の請求） | [security.md](architecture/security.md) の 6・11 節、[sales-objects.md](architecture/sales-objects.md) の 8 節、[orgs-users-and-auth.md](architecture/orgs-users-and-auth.md) の 5.2 節 | E2 の組織の作成の利用規約、E5 の取引先責任者とリード、メールの記録 |
| L2 | 外国にある第三者への提供：メールの送信事業者、Webhook の送信先、SSO の IdP が海外にある時の扱いと、本人への情報の提供 | [events-and-integrations.md](architecture/events-and-integrations.md) の 6.3 節、[orgs-users-and-auth.md](architecture/orgs-users-and-auth.md) の 6.4 節 | E8 の Webhook、E2 の SSO |
| L3 | Sandbox へのデータの複製：本番の個人データを、開発・試験の組織に複製してよい条件。安全管理措置として、項目のマスキングを必須にするか | [sandboxes-and-deploy.md](architecture/sandboxes-and-deploy.md) の 4.3 節 | E10 のデータを含む Sandbox |
| L4 | 電気通信事業法：Web-to-リードのフォームや、組織が埋め込む計測で、端末の情報を外部へ送る時の外部送信規律の公表の義務を負うのは誰か。メールの送信の代行・BCC の取り込みが「他人の通信の媒介」に当たるか | [events-and-integrations.md](architecture/events-and-integrations.md) の 7 節、[sales-objects.md](architecture/sales-objects.md) の 8 節 | E5 のメールの記録と送信、E8 の Webhook |
| L5 | 監査のログと削除：設定の変更の履歴、項目の変更の履歴、ログインの履歴を何日持つか。本人からの削除の請求と、監査の履歴の保持の関係。ごみ箱と、削除の確定までの期間 | [audit-and-field-history.md](architecture/audit-and-field-history.md)、[security.md](architecture/security.md) の 7 節 | E11 の監査の保持と削除 |
| L6 | データの所在：「日本のデータを国外に出さない」をどこまで約束するか。バックアップ、DR（大阪は国内）、サポートでの参照、サブプロセッサーの扱い | [infrastructure.md](architecture/infrastructure.md) の 1 節、[ADR-0005](decisions/0005-tenancy-and-governor-limits.md) | E1 のリージョンの構成、E12 の契約の文書 |
| L7 | 組織との契約：委託の契約（DPA）の雛形、サブプロセッサーの一覧と変更の通知、解約時のデータの返却と削除（30 日の猶予、7 日の消去、鍵の破棄、バックアップの 35 日） | [security.md](architecture/security.md) の 7・11 節、[orgs-users-and-auth.md](architecture/orgs-users-and-auth.md) の 3.3 節 | E12 の GA の判定 |
| L8 | 特定電子メール法：活動として送るメールや、一括のメールを MVP の後に扱う時の、同意の記録と送信者の表示 | [sales-objects.md](architecture/sales-objects.md) の 8.2 節 | MVP の後の一括のメールの Epic |
| L9 | 捜査機関・裁判所などからのデータの開示の要求：本システムが直接受けた時の応じ方、組織への通知（通知できない時の扱い）、運用者の break-glass で読む時の手続き（2026-09-28 に security の領域から足した） | [security.md](architecture/security.md) の 6 節 | E12 の GA の判定（運用の手順と DPA） |
| L10 | 個人データの漏えい等の報告：組織をまたぐ漏えい・見えないデータの漏えい・Sandbox のマスキングの事故が起きた時、個人情報保護委員会への報告（速報・確報）と本人への通知の主体（組織か本システムか）と期限（2026-09-28 に security の領域から足した） | [security.md](architecture/security.md) の 10 節、[runbooks/incident-response.md](runbooks/incident-response.md) | E12 の GA の判定（インシデントの手順） |
| L11 | 第三者のコードとパッケージ（E13・E14）：組織が入れた配布者のパッケージが組織のデータを読み書きする時の、本システム・配布者・組織の責任の分け方、配布者の審査と公開の一覧の条件（2026-09-28 に extensibility の領域から足した） | [extensibility.md](architecture/extensibility.md) の 8 節 | E14 のパッケージの配布 |

- **L1〜L11 は全て確認待ちのまま**にする（2026-09-28 の統合の工程で、結論を出さずに L9〜L11 を足した）。

### PM の確認済みの決定

- **ダッシュボードは見る人の権限だけで集計する。** 本家の「指定した実行ユーザー」（全員が特定の人の権限で見る形）は持たない。上司が部下の視点で見る時も、部下と見る人の権限の共通部分で集計する（[ADR-0030](decisions/0030-dashboards-viewer-intersection-and-subscriptions.md)）。「見られないレコードはレポートの集計に現れない」の約束を優先し、本家から移る組織の、全員が同じ数字を見る経営のダッシュボードは作れなくなることを受け入れる。全員に同じ数字を見せたい需要には、MVP の後に、集計の値を別のオブジェクトに保存するスケジュールのフローで応える案を検討する（値の共有は通常の共有で決まる）。PM が 2026-09-28 に確認した。

### 選定・計測で決めるもの（法務以外）

- 本家のエディションと価格：日本の価格のページでは、Free Suite 0 円、Starter Suite 3,000 円、Pro Suite 12,000 円、Core 23,400 円、Advanced 47,400 円、Max 66,000 円（ユーザーあたり月額、年間契約）と読めた（[Sales Cloud の価格](https://www.salesforce.com/jp/sales/pricing/)、2026-09-28 に確認）。各エディションの機能の差は、エディション（Enterprise・Unlimited など）ごとの表で確かめた：Enterprise はカスタムオブジェクト 200・1 オブジェクトのカスタム項目 500・有効な入力規則 100、Unlimited はカスタム項目 800（[Salesforce Enterprise Edition Allocations](https://help.salesforce.com/s/articleView?id=xcloud.overview_limits_enterprise.htm&type=5)、2026-09-28 に確認）。価格の段（Starter Suite など）とエディションの名前の対応は、価格のページだけでは読めない。本システムのエディションの分け方と上限の値は、E2 の着手前に PM が決める。
- 本家の API の割り当て：Enterprise では、24 時間で 100,000＋ライセンスの数×1,000 回。長く続く要求（20 秒以上）の同時実行は、本番の組織で 25（[Developer Limits and Allocations Quick Reference](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_app_limits_cheatsheet.pdf)、2026-09-11 更新版、2026-09-28 に確認）。本システムの初期値は [governor-limits.md](architecture/governor-limits.md) の 8 節に置いた。値は E2 の着手前に PM が決め、E12 の負荷試験で確かめる。
- 本家の Sandbox の種類（Developer、Developer Pro、Partial Copy、Full）と、再作成の間隔（1 日、1 日、5 日、29 日）、容量（データ 200MB、1GB、5GB、本番と同じ）：[Sandbox Licenses and Storage Limits by Type](https://help.salesforce.com/s/articleView?id=platform.data_sandbox_environments.htm&type=5)（2026-09-28 に確認）。数は Enterprise で Developer 25・Partial Copy 1、Unlimited で Developer 100・Developer Pro 5・Partial Copy 1・Full 1。本システムは同じ 4 種類で作る（[ADR-0038](decisions/0038-sandbox-types-and-masked-copy.md)）。
- 本家のプロファイルの権限の廃止の計画：Spring '26 からの廃止を取りやめた。既定値はプロファイルに、権限は権限セットに置くことを勧める（[Permissions in Profiles Retirement Cancelled](https://help.salesforce.com/s/articleView?id=003834041&type=1)、2026-09-28 に確認）。本システムは、権限セットを中心にし、プロファイルは既定値（レイアウトの割り当て、レコードタイプ、ログインの制限）の入れ物にする（[ADR-0013](decisions/0013-permission-sets-and-field-level-security.md) で決めた）。
- 利用者のログイン：自前の Better Auth にし、rebuilds の Auth0 の題材を本システムの IdP にしない（[ADR-0044](decisions/0044-authentication-better-auth-sso-and-mfa.md) で決めた）。組織の IdP の 1 つとしてなら、普通の OIDC でつなげる。
- 全文検索の部品（OpenSearch の既定の日本語の解析器で足りるか）：既定を kuromoji と CJK の 2-gram にし、E5 の着手前の PoC で Sudachi と比べて決める（[ADR-0031](decisions/0031-search-index-and-japanese-analysis.md)）。
