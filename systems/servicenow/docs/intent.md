# Intent: ServiceNow を AI エージェント主体で再構築する

- Author: shoito
- Status: accepted
- Date: 2026-09-28

## Problem

企業の IT 部門は、毎日多くの依頼と障害を受ける。その多くは、メール・電話・チャット・表計算ソフトに散らばっている。

- 誰が、いつまでに、何を対応するかが見えない。約束した応答の時間（SLA）を守れたかを、後から数えられない。
- 同じ障害が何度も起きても、根本の原因（問題）に結び付かない。
- 本番の環境の変更が、誰の承認で、どのリスクの評価で行われたかの証跡が残らない。内部統制（J-SOX）の監査で、変更の記録を集めるのに手間がかかる。
- サーバー・アプリ・ネットワークの構成（CMDB）が、取り込み元ごとに食い違う。障害の影響の範囲が分からない。
- 社員は、PC の申請やパスワードの再設定のために、どこへ何を頼めばよいか分からない。

本家 ServiceNow は、これを「共通の記録の基盤（テーブル・フォーム・リスト・権限・ワークフロー）」の上の ITSM のアプリ（インシデント、問題、変更、サービスカタログ、CMDB、ナレッジ、SLA、ポータル）として提供している。その中身を、小さなチームと AI エージェントでどこまで作り直せるかを確かめる。

## Proposed outcome

日本の企業の IT 部門が、テナントを作り、組織・担当のグループ・サービスを登録するだけで、ITSM の主な業務を 1 つの記録の上で回せる基盤を作り直す。次の 3 つの価値を満たす。

1. **すぐに使える ITSM**：インシデント・問題・変更・要求・ナレッジ・CMDB・SLA が、既定の設定のまま動く。日本語の画面と、日本の祝日・年末年始を扱う業務カレンダーを最初から持つ。
2. **コードなしで合わせられる**：フィールド・テーブル・フォーム・ワークフロー・承認・通知・SLA を、管理者が画面で設定できる。テナントに任意のコードを書かせない。
3. **数え間違えない、止まらない**：SLA の期限、承認、状態の遷移、構成の突き合わせは、障害や並行の処理があっても、ちょうど 1 回、正しく行われる。監査に耐える履歴が残る。

### MVP（S1）に含める

- **インシデント**：受け付け（ポータル・メール・API・担当者の入力）、影響度と緊急度からの優先度、担当の割り当て、エスカレーション、解決と完了、メジャーインシデントの扱い
- **問題**：インシデントとの関連付け、根本原因、既知のエラー、回避策のナレッジへの公開
- **変更**：標準・通常・緊急の種類、リスクの評価（質問票と規則）、CAB の承認、変更の予定表と衝突の検知、凍結期間、実施と振り返り
- **サービスカタログと要求**：カタログの品目、入力の項目（変数）、承認、実行のタスク、要求の状態の追跡
- **ナレッジ**：記事、バージョン、レビューと公開の流れ、公開の範囲、評価、ポータルでの自己解決
- **CMDB**：CI のクラスの階層、関係、複数の取り込み元（手入力、CSV、API、外部の資産管理）からの識別と調整、影響の範囲の表示。サービスのモデルは本家の CSDM の考え方に寄せる
- **SLA**：SLA・OLA の定義、開始・一時停止・停止の条件、業務カレンダー（営業時間、タイムゾーン、日本の祝日、会社の休日）、期限の前の警告と違反の通知
- **割り当てとオンコール**：割り当ての規則（カテゴリ・CI・場所など）、担当のグループ、当番表（ローテーション）、エスカレーション。オンコールの通知は MVP ではメールとアプリのプッシュに限る
- **メールからのチケット**：受信したメールからのインシデント・要求の作成、返信のスレッドへの紐付け、差出人と社員の照合、自動の返信のループの防止
- **従業員のセルフサービスのポータル**：カタログからの申請、インシデントの報告、自分のチケットの状況、ナレッジの検索、承認の依頼への回答
- **ノーコードのワークフローと承認のエンジン**：レコードの作成・更新・時刻をきっかけに、条件・承認・タスクの作成・通知・待ち・外部の呼び出しを組み合わせる。多段の承認、代理の承認、期限切れの扱い
- **レポートとダッシュボード**：一覧・集計・推移のグラフ、ダッシュボード、定期の配信。SLA の達成率、滞留、担当ごとの件数
- **REST API とイベント**：レコードの CRUD、取り込みの API、Webhook とイベントの購読
- **監査の履歴**：レコードのフィールドごとの変更の履歴（誰が、いつ、何を何に）、作業メモとコメント、承認の記録
- **アクセス制御**：ユーザー・グループ・ロール、テーブル・レコード・フィールドの単位の ACL、テナントの SSO（SAML・OIDC）

### MVP の後の Epic で扱う

| 機能 | 理由 |
| --- | --- |
| ディスカバリーのエージェント（ネットワークの走査、エージェントでの収集） | 顧客の網の中で動く部品の配布・更新・セキュリティの設計が重い。MVP では取り込みの API と外部の資産管理から CMDB を埋める |
| サービスマッピング（アプリの構成の自動の発見） | ディスカバリーの上に作る |
| イベント管理と AIOps（監視のアラートの集約、相関、自動のインシデント化） | 大量のイベントの取り込みと相関の基盤が別に要る |
| HR・顧客サービス（CSM）などの他の業務のアプリ | 同じテーブルの基盤の上に足せる。まず ITSM を完成させる |
| 仮想エージェント（チャットでの受け付け・自己解決） | 対話の設計と、生成 AI の利用の方針（別の intent）が要る |
| テナントのカスタムアプリの開発（任意のコード、スクリプト） | 任意のコードの実行の隔離が重い。ADR-0007 の方針とも合わせて、別の ADR で扱う |
| SMS・音声でのオンコールの呼び出し | 通信の事業者との契約と法令の確認（L8）が要る |
| 資産管理（ハードウェア・ソフトウェアのライセンス）、ベンダーの管理 | CMDB の上に足す |
| 海外のリージョン | S3 以降 |

### 守るべき振る舞い

- テナントは、他のテナントのレコード・設定・添付ファイル・履歴を一切見られない。
- ACL で読めないレコードとフィールドは、フォーム・リスト・API・レポート・検索・エクスポート・通知のどこからも、値も件数も漏れない。
- 1 つの承認の回答は、1 回だけ反映される。承認の後に、同じ承認で状態が 2 回進むことはない。
- 受け付けた SLA の計時は、プロセスや AZ の障害で失われない。期限はカレンダーから一意に決まり、同じ入力に対して同じ期限になる。
- 同じ CI を指す取り込みが並行に届いても、CI は 1 つだけになる。より信頼の低い取り込み元が、より信頼の高い取り込み元の値を上書きしない。
- 監査の対象のテーブルの変更は、変更と同じトランザクションで履歴に残る。履歴を利用者が消したり書き換えたりできない。
- 変更の記録は、承認のないまま「実施」の状態に進まない（緊急の変更は、事後の承認の記録を必須にする）。

### 成功の基準

| # | 基準 | 目標 | 測り方 |
| --- | --- | --- | --- |
| K1 | 画面の速さ | フォームを開くまで p95 1 秒以内、リストの 1 ページ p95 1 秒以内（NFR-001） | 実ユーザーの計測（RUM）とサーバーの計測 |
| K2 | SLA の正しさ | 期限の計算が、参照の実装と 1 秒の差もなく一致する。違反の通知が期限から 60 秒以内（NFR-003） | 性質ベーステスト、本番での期限と発火の時刻の差の計測 |
| K3 | ワークフローの耐久性 | 障害の注入で、遷移の欠落と二重の反映が 0 件（NFR-004） | 障害注入の試験（E4・E12）、本番の突き合わせのジョブ |
| K4 | CMDB の正しさ | 取り込みで作られた重複の CI が 0 件（NFR-005） | 性質ベーステスト、本番の重複の検出のジョブ |
| K5 | 可用性 | 本番のテナントで月間 99.95%（NFR-006） | 合成監視とサーバーの 5xx・タイムアウトの割合 |
| K6 | 権限の漏れ | ACL で読めない値が出口から漏れた件数 0 件（NFR-010） | 決定表の表駆動テスト、出口ごとの漏れの試験、本番の監査 |
| K7 | 導入の速さ | テナントの作成から、最初のインシデントがメールで起票され SLA が動くまで、中央値 1 日以内 | オンボーディングのイベントの計測 |
| K8 | 自己解決 | ポータルでナレッジを見て申請をやめた割合（自己解決の率）を計測できる | ポータルのイベントの計測。目標の値は E9 で決める |

## Affected users and systems

- **IT のサービスデスク**（主な利用者）：インシデントと要求を受け付け、分類し、割り当て、解決する担当者。日本の企業の情報システム部門と、その委託先（運用の外部の事業者）。
- **IT の運用・開発のチーム**：問題の調査、変更の計画と実施、CMDB の維持、オンコールの対応をする人。
- **変更の承認者と CAB**：変更のリスクを見て承認する人。
- **社員（依頼者）**：ポータルとメールで依頼・報告し、承認の依頼に答える人。IT に詳しくない人を前提にする。
- **テナントの管理者**：テーブル・フォーム・ワークフロー・SLA・権限を設定する人。
- **監査の担当**：変更と権限の証跡を確かめる内部監査・外部の監査人。
- **外部のシステム**：メール（社内のメールサーバーからの転送、SES）、IdP（Microsoft Entra ID など、SAML・OIDC）、人事のシステム（社員と組織の取り込み）、資産管理・監視・CI/CD のツール（API での連携）。
- 最初の対象は、日本の中堅から大企業（社員 1,000〜50,000 人）とする。

## Constraints

- 本家の実装（プラットフォームのコード、スクリプトの API、アプリの定義）を使わない。本家のスクリプトの API（サーバーのレコードの操作の API、クライアントのフォームの API）との互換は目標にしない（[リポジトリ共通の ADR-0007](../../../docs/decisions/0007-no-reuse-of-original-implementation.md)）。
- 本家の名前は識別子に使わない。ドメインは `<tenant>.<brand>.<domain>`、ヘッダーは `<Brand>-Tenant` の形で書く（[リポジトリ共通の ADR-0006](../../../docs/decisions/0006-brand-neutral-identifiers.md)）。
- 業務の流れは ITIL 4 のプラクティス（インシデント管理、問題管理、変更の実現、サービス要求管理、サービス構成管理、サービスレベル管理、ナレッジ管理）に沿う。ITIL 4 は 34 のプラクティスを持つ（[ITIL 4 Management Practices 2023](https://www.peoplecert.org/news-and-announcements/2023/itil-4-management-practices-2023)、PeopleCert、2026-09-28 に確認）。うち 17 がサービス管理のプラクティスとする分け方は二次の資料（[ITIL 4 Management Practices Explained](https://itsm.tools/34-itil-4-management-practices/)）による（PeopleCert の原典では未検証）。PeopleCert は 2026 年に ITIL（Version 5）の認定を始めた（[ITIL Foundation (Version 5)](https://www.peoplecert.org/browse-certifications/it-governance-and-service-management/ITIL-1/itil-5-foundation-version-50-4154)、2026-09-28 に確認）。この題材は S1 で ITIL 4 の用語を使う（下の「選定・計測で決めるもの」。PM が決めた）。
- 実行基盤と技術は、rebuilds の他の題材の決定（AWS 東京・大阪、TypeScript、Terraform、OpenTelemetry）を引き継ぐ（[ADR-0001](decisions/0001-platform-and-stack.md)）。
- テナントの分離は、共有の基盤を既定にし、大口の企業には専用のセルを出す（[ADR-0002](decisions/0002-tenancy-and-isolation.md)）。
- 日本の法令（個人情報保護法、電気通信事業法）と、顧客の内部統制（J-SOX）の要件への対応は、法務の確認を前提に設計する。
- 規模は段階的に広げる（[architecture/](architecture/README.md) の「規模の段階」）。

## Non-goals

| 機能 | 理由 |
| --- | --- |
| 本家のスクリプトの API・スクリプトの言語との互換 | ADR-0007。拡張はノーコードの設定と、後の別の ADR で扱う |
| 本家のアプリの定義（更新のセット、スコープのアプリ）の読み込み | 同上。本家からの移行は、データ（レコード）の取り込みに限る |
| 顧客ごとにバージョンを選んで止められる単一テナントのインスタンス | バージョンの数が増え、エージェントが保守する範囲が広がる。全テナントを同じバージョンで動かし、振る舞いの変更はフラグで段階的に出す（ADR-0002） |
| 顧客の網の中で動くディスカバリーの MVP での提供 | MVP の後（上の表） |
| テナントが画面の任意の HTML・JavaScript を差し込むこと | XSS と保守の問題。ポータルの見た目はテーマと部品の組み合わせに限る |
| FedRAMP・米国の政府向けの認定 | 日本の市場を先にする |

## Open questions

### 法務の確認待ち

設計はどの結論にも対応できる形にするが、結論は出さない。**下の表の「承認を止める spec」は、確認が済むまで PM・QA が承認しない。**

| # | 問い | 関係する設計 | 承認を止める spec |
| --- | --- | --- | --- |
| L1 | 個人情報保護法：テナントの社員の個人データ（氏名、連絡先、端末、チケットの本文）を、委託として扱うか、本システムが自ら取得するか（いわゆるクラウドの例外に当たるか）。漏えい等の報告の義務を負う者と手順（確報の期限を含む）。個人の削除の請求と監査の履歴の自由記述の関係、ポータルの事象と検索の語の集計の扱い（領域から足した論点） | security、data-model、knowledge、search | E2 の監査の履歴、E3 のユーザーの取り込み、E12 の GA の判定 |
| L2 | 電気通信事業法：メールの受信と自動の処理（本文の保存・解析）、通知のメールの送信の代行が「他人の通信の媒介」に当たり、届出が要るか。通信の秘密との関係 | notifications-and-email-ingest | E6 のメールからのチケット |
| L3 | データの所在：「日本のリージョンのデータを国外に出さない」をどこまで約束するか。バックアップ、DR（大阪は国内）、サポートでの参照、サブプロセッサーの扱い。CloudFront・WAF・GuardDuty などのグローバルなサービスの処理の場所、Web Push の配信の事業者（国外の可能性。本文に値は入れない）（領域から足した論点） | infrastructure、security、portal-and-ui、[ADR-0002](decisions/0002-tenancy-and-isolation.md) | E1 のリージョンの構成、E12 の契約の文書 |
| L4 | 監査の履歴と記録の保持：変更の記録・承認・権限の変更の履歴を何年持つか（既定案 7 年）。J-SOX の証跡として顧客が求める期間と出力の形式（CSV・PDF）を、契約でどこまで約束するか。削除の請求との関係、テナントの削除のときの監査の履歴の扱い（領域から足した論点） | data-dictionary-and-tables、security、itsm-processes | E2 の監査の履歴、E7 の変更の承認 |
| L5 | テナントとの契約：委託の契約（DPA）の雛形、サブプロセッサーの一覧と変更の通知（Web Push の配信の事業者、ステータスのページの事業者を含む）、専用のセルの契約の条件、運用者のテナントのデータの参照の例外（インシデントで許可を待てないとき）の書き方、バックアップの 35 日の説明（領域から足した論点） | security、infrastructure、[ADR-0002](decisions/0002-tenancy-and-isolation.md) | E12 の GA の判定 |
| L6 | 商標：「ITIL」は AXELOS Limited の登録商標である（[PeopleCert の Acknowledgements](https://www.peoplecert.org/acknowledgements)、2026-09-28 に確認）。製品の名前・画面・資料で ITIL の名前やプラクティスの名前をどこまで使えるか | portal-and-ui、knowledge | E6 の画面の文言の確定 |
| L7 | 本家からの移行：本家のインスタンスから、顧客の許可の下で API でデータを取り出す移行の道具を提供してよいか（本家の利用規約との関係） | api-and-integrations | MVP の後の移行の Epic |
| L8 | SMS・音声でのオンコールの呼び出し：国内の通信の事業者との契約、関係する法令 | assignment-and-on-call | MVP の後の SMS・音声の Epic（E13） |
| L9 | 公的なデータの利用の条件：内閣府の祝日の CSV を取り込み、全テナントの SLA の計算に使い、原本を保存してよいか（内閣府のサイトの利用規約は、権利の表記のないコンテンツに公共データ利用規約（第 1.0 版）を当てるとする。[内閣府ホームページ利用規約](https://www.cao.go.jp/notice/rule.html)、2026-09-28 に確認。当てはまるか、出典の表示の仕方）。取得の元の変更の知らせの受け方（2026-09-28 に sla-and-calendars の領域から足した） | sla-and-calendars、[ADR-0020](decisions/0020-japanese-holiday-data.md) | E5 の祝日の取り込み（`jp-holiday-import`） |

### 選定・計測で決めるもの（法務以外）

- 専用のセルを出す条件（社員の数、料金、契約の最低の期間）：E12 の前に PM が決める（[ADR-0002](decisions/0002-tenancy-and-isolation.md)）。
- 日本語の全文検索の解析器：search の領域で Sudachi を既定にした（[ADR-0043](decisions/0043-japanese-analyzer-and-index-layout.md)）。E9 の評価で kuromoji に負ければ置き換える。
- 祝日のデータの取り込み：内閣府の CSV（1955 年から 2027 年までを収録。[国民の祝日について](https://www8.cao.go.jp/chosei/shukujitsu/gaiyou.html)、2026-09-28 に確認）を正本にする。翌々年の分は前年の 2 月に掲載される（sla-and-calendars の領域で確かめた）。CSV の利用の条件の当てはめは法務の確認待ち（L9）。
- 変更のリスクの評価に機械学習を使うか：MVP は質問票と規則だけにする。本家は規則・質問票・機械学習の予測を組み合わせている（[Change Management data sheet](https://www.servicenow.com/content/dam/servicenow-assets/public/en-us/doc-type/resource-center/data-sheet/change-management-data-sheet.pdf)、2026-09-28 に検索の結果の抜粋で確認。本文は取得できず（403）未検証。規則の条件と質問票の組み合わせは [Risk assessment](https://www.servicenow.com/docs/r/it-service-management/change-management/c_RskAsmtCalc.html) で確認）。
- 本家の既定の値（SLA の再計算の間隔、ACL の既定の規則、識別の規則の既定）で、公式の文書で確かめられないもの：各領域の文書で、本家の資料で確かめるか、未検証と書く（2026-09-28 の検証の工程で、SLA の更新の間隔と ACL の探す順は確かめた）。
- 業務の用語の ITIL のバージョン：**決定（PM、2026-09-28）**。S1 は ITIL 4 の用語のままにする。ITIL（Version 5）は、刊行物と認定が安定した後、S2 の前に見直す（L6 の商標の確認はこれと別に続ける）。

## 出典（2026-09-28 に確認）

- ServiceNow, [Advanced High Availability Architecture](https://www.servicenow.com/lpwhp/high-availability-whitepaper.html)（本文は取得できず、検索の結果の抜粋で確認）
- ServiceNow Docs, [Table extension and classes](https://www.servicenow.com/docs/r/platform-administration/table-administration-and-data-management/table-extension-and-classes.html)
- ServiceNow Docs, [Access control list rules](https://www.servicenow.com/docs/bundle/zurich-platform-security/page/administer/contextual-security/concept/exploring-access-control-list.html)
- ServiceNow Docs, [Create an SLA definition](https://www.servicenow.com/docs/bundle/zurich-it-service-management/page/product/service-level-management/task/t_CreateAnSLADefinition.html)
- ServiceNow Docs, [Identification and Reconciliation engine (IRE)](https://www.servicenow.com/docs/r/zurich/servicenow-platform/configuration-management-database-cmdb/ire.html)
- ServiceNow Docs, [Inbound email action processing](https://www.servicenow.com/docs/r/platform-administration/inbound-action-processing.html)
- ServiceNow Docs, [Flows, subflows, and actions reference](https://www.servicenow.com/docs/bundle/yokohama-build-workflows/page/administer/flow-designer/reference/flow-designer-reference.html)
