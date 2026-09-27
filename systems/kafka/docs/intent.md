# Intent: Kafka をマネージドのストリーミング基盤として AI エージェント主体で再構築する

- Author: shoito
- Status: accepted
- Date: 2026-09-27

## Problem

イベントを順序どおりに、失わずに、大量に流す仕組み（分散ログ）は、決済の記録、注文の状態の変化、IoT の計測、行動ログ、データ基盤への取り込みなど、多くのシステムの背骨になっている。その事実上の標準が Apache Kafka のプロトコルである。

ただし、Kafka のクラスタを自前で運用するのは重い。

- パーティションの配置、複製、ブローカーの入れ替え、版の更新を、止めずに行う必要がある。
- ディスクの容量を先に見積もって買う必要があり、負荷の山に合わせると、谷の時間は無駄になる。
- AWS では、AZ をまたぐ複製の転送料金が、費用の大きな部分を占める（1 GB あたり送信と受信で各 $0.01。[AWS Architecture Blog](https://aws.amazon.com/blogs/architecture/exploring-data-transfer-costs-for-aws-managed-databases/)、2026-09-27 に確認。東京の単価も同じ値であることを AWS Price List API で確かめた）。
- 受け付けた書き込みを失わないこと、トランザクション（exactly-once）が正しく動くことを、自分で確かめる手段が乏しい。本家の実装でも、Jepsen の検証でトランザクションの問題が見つかっている（[Jepsen: Bufstream 0.1.0](https://jepsen.io/analyses/bufstream-0.1.0)。Kafka 本体の論点を含む。2026-09-27 に確認）。

本家に近いサービスとして、Confluent Cloud（Kora という自社のエンジンの上で、多数のテナントが物理クラスタを共有する。[Kora の論文、VLDB 2023](https://vldb.org/pvldb/vol16/p3822-povzner.pdf)）と Amazon MSK がある。一方で、オブジェクトストレージを正本にしてディスクを持たない実装（WarpStream、AutoMQ、Redpanda の Cloud Topics）が増え、本家の Apache Kafka でも Diskless Topics（KIP-1150）が 2026-03 に採択された（[Aiven の解説](https://aiven.io/blog/kip-1150-accepted-and-the-road-ahead)、2026-09-27 に確認）。

これを、小さなチームと AI エージェントで、どこまで作り直せるかを確かめる。

## Proposed outcome

アプリの開発者とデータのチームが、クラスタの運用を意識せずにトピックを作り、既存のクライアントのままイベントを読み書きできる基盤を、次の 3 つの価値を満たすように作り直す。

1. **既存のクライアントがそのまま動く**：Apache Kafka のワイヤープロトコルに互換。アプリのコードは変えず、ブートストラップのサーバーと資格情報を変えるだけで移れる。
2. **受け付けた書き込みを失わない**：`acks=all` で成功を返した書き込みは、1 つのリージョンの中で失わない（RPO 0）。トランザクションと冪等なプロデューサーが、本家と同じ意味で動く。
3. **使った分だけ払い、容量を考えない**：共有の物理クラスタの上の論理クラスタとして提供し、スループットに合わせて容量が伸び縮みする。古いデータはオブジェクトストレージ（S3）へ移し、保存の費用を下げる。

### プロトコル互換について

- Apache Kafka のワイヤープロトコルへの互換は、**振る舞いとして** 提供する。API の名前、版、エラーコード、内部トピックの名前、クライアントの設定のキーは本家のものを使う。互換の範囲は [ADR-0005](decisions/0005-compatibility-policy.md) で決める。
- 製品名、ドメイン、ブートストラップのホスト名、HTTP の API のパスとヘッダー、API キーの接頭辞、CLI、Terraform のプロバイダーには、「Kafka」「Confluent」を自社のブランドとして使わない。設計の文書では `<Brand>`・`<brand>` で書く（[リポジトリ共通の ADR-0006](../../../docs/decisions/0006-brand-neutral-identifiers.md)）。
  - 例：ブートストラップ `<lc-id>.<region>.<brand>.<domain>:9092`、API キーの接頭辞 `<brand>_key_...`、CLI `<brand> cluster create`、Terraform のプロバイダー `<brand>/<brand>`、管理 API `api.<brand>.<domain>/v1/...`
- 「Apache Kafka 互換」と説明の中で書いてよいか、どう書くかは、法務の確認待ち（下の「法務の確認待ち」の L1）。

### 利用者

- **アプリの開発者**：マイクロサービスの間のイベント、非同期の処理、注文・決済の状態の変化。Java・Go・Python・Node.js・.NET のクライアントを使う。
- **データのチーム**：行動ログ・CDC（データベースの変更）の取り込み、データ基盤（DWH・データレイク）への連携、ストリーム処理。
- **運用の担当**：クラスタの作成、権限、API キー、監視、費用の管理。コンソール、CLI、Terraform を使う。
- **市場**：日本を最初にする。東京リージョンで提供し、大阪を災害復旧に使う。日本語のコンソールと文書、円建ての請求を用意する。

### MVP に含める

- **マネージドのクラスタ**：共有の物理クラスタの上の論理クラスタ（サーバーレス。容量は自動で伸び縮みする）。層は Basic（開発向け）と Standard（本番向け、マルチ AZ）の 2 つ（[ADR-0004](decisions/0004-logical-clusters-on-shared-physical-clusters.md)）
- **トピックとパーティション**：作成、削除、パーティションの追加、許可した範囲のトピックの設定
- **プロデューサーとコンシューマー**：Apache Kafka のワイヤープロトコルに互換。クライアントは変更なしで動く
- **冪等なプロデューサーとトランザクション（exactly-once）**：Kafka Streams の exactly-once を含む
- **コンシューマーグループ**：従来のリバランスのプロトコルと、新しいプロトコル（KIP-848）の両方。オフセットの管理
- **保持と圧縮**：時間・サイズによる保持（retention）と、キーによる圧縮（log compaction）
- **階層型の保存**：古いセグメントを S3 へ移す（KIP-405）。利用者からは 1 本のログに見える
- **ACL と API キー**：サービスアカウント、API キー（SASL/PLAIN を TLS の上で）、トピック・グループ・トランザクションの ID の単位の ACL
- **メトリクスの API**：スループット、リクエスト数、パーティションの数、コンシューマーの遅れ（lag）を、テナントが取得できる
- **コンソール**：Web の管理画面（日本語）
- **Terraform のプロバイダー** と CLI

### MVP の後（Later）

| 機能 | 理由・前提 |
| --- | --- |
| スキーマレジストリ | Confluent の Schema Registry は Confluent Community License で、SaaS として提供できない（L3）。Apache License の実装を使うか自前で作るかを connectors-and-schema の領域で決める |
| マネージドのコネクター（Kafka Connect に相当） | 利用者のコードとプラグインを動かすので、隔離と責任の範囲が大きい |
| ストリーム処理（Flink に相当する SQL） | 別の実行基盤が要る |
| クラスタの間の複製（Cluster Linking に相当） | リージョンをまたぐ災害復旧と移行の道具。S2 で大阪への複製に使う |
| プライベートの接続（AWS PrivateLink） | S2。MVP は TLS と IP の許可リストで守る |
| BYOC（利用者の AWS アカウントでデータ面を動かす） | S3。運用の境界と責任の分け方が別の設計になる |
| 専用の物理クラスタ（Dedicated） | S2。論理クラスタの仕組みのまま、1 テナントだけの物理クラスタとして作る（ADR-0004） |
| ディスクレスのトピック（オブジェクトストレージが正本） | S2。本家の KIP-1150 の実装（KIP-1163・1164）の進み具合で決める（ADR-0002） |
| 共有のグループ（Share Groups、KIP-932） | 本家の 4.2 で本番向けになった（[4.2.0 の発表](https://kafka.apache.org/blog/2026/02/17/apache-kafka-4.2.0-release-announcement/)、2026-09-27 に確認）。MVP の直後に、クォータとテストを足して有効にする |

### 守るべき振る舞い

- `acks=all` で成功を返した書き込みは、1 つのリージョンの中のどの 1 つの AZ が落ちても失わない。
- 1 つのパーティションの中で、書き込みの順序とオフセットは変わらない。
- 冪等なプロデューサーの再送は、重複を生まない。コミットしたトランザクションの書き込みはすべて見え、中止したトランザクションの書き込みは `read_committed` のコンシューマーに見えない。
- テナントは、他のテナントのトピック・グループ・ACL・メトリクスを一切見られない。
- 他のテナントの負荷の急増で、自分のクォータの中のスループットが削られない。
- 動いていたクライアントの版は、事前の告知と移行の期間なしに動かなくならない（[ADR-0005](decisions/0005-compatibility-policy.md)）。

## Success criteria

測れる形の成功の基準。非機能要件の詳細は [architecture/](architecture/README.md) の 3 節にある。

| ID | 基準 | 目標 |
| --- | --- | --- |
| SC-1 | 既存のアプリの移行 | 互換性のテストの対象のクライアント（Java、librdkafka、franz-go、Sarama、confluent-kafka-javascript。[ADR-0008](decisions/0008-client-matrix-differential-tests-and-version-tracking.md)）の選んだテストの全件が通る。移行はブートストラップと資格情報の変更だけで済む |
| SC-2 | 受け付けた書き込みの喪失 | 障害注入のテストと本番の耐久性の監査で 0 件 |
| SC-3 | 最初のメッセージまでの時間 | 登録から、クラスタの作成、トピックの作成、最初の produce と consume まで 5 分以内（コンソールか CLI） |
| SC-4 | 可用性 | Standard の層で月間 99.95%（S1）、99.99%（S2） |
| SC-5 | 費用 | 1 GB の書き込みあたりの原価が、[architecture/](architecture/README.md) の NFR-010 の目標以下 |
| SC-6 | 採用 | GA から 6 か月で、日本の有償のテナント 50（本番の利用） |

## Affected users and systems

- テナントのアプリ（プロデューサー・コンシューマー・Kafka Streams）と、その運用の担当
- データ基盤（DWH、データレイク）への取り込みの道具（テナントの側で動かすもの）
- 社内の運用（オンコール、サポート、経理・請求）
- AWS（EC2・EBS・S3・EKS・Aurora・NLB）

## Constraints

- 実行基盤と技術は、rebuilds の他の題材の決定を引き継ぐ。制御面（コントロールプレーン）は、AWS の東京（災害復旧は大阪）、TypeScript（Hono）、Aurora PostgreSQL 18、Terraform、OpenTelemetry。データ面（ブローカー）は、本家の Apache Kafka を使い、Java で拡張する（[ADR-0001](decisions/0001-upstream-brokers-and-stack.md)）。
- 本家の Apache Kafka は Apache License 2.0。本家のコードに当てたパッチの扱いと、配る成果物（CLI、Terraform のプロバイダー）の表示は、ライセンスに従う。
- 規模は段階的に広げる（[architecture/](architecture/README.md) の「規模の段階」）。

## Non-goals

| 機能 | 理由 |
| --- | --- |
| Kafka 以外のプロトコル（AMQP、MQTT、Pulsar） | 互換の対象を 1 つに絞る。MQTT の取り込みは、必要ならコネクターで扱う |
| ZooKeeper を使う構成 | 本家の 4.0 で ZooKeeper は取り除かれた（[4.0.0 の発表](https://kafka.apache.org/blog/2025/03/18/apache-kafka-4.0.0-release-announcement/)、2026-09-27 に確認）。KRaft だけで作る |
| 2.1 より古いクライアントのプロトコルの版 | 本家の 4.0 で取り除かれた（KIP-896）。本家に合わせる（[ADR-0005](decisions/0005-compatibility-policy.md)） |
| テナントが自分でブローカーの設定を変えること | 耐久性と分離の前提が崩れる。許可したトピックの設定だけを変えられる |
| GCP・Azure での提供 | 日本の市場で AWS を先にする。他のクラウドは S3 の後で考える |
| オンプレミスでの提供（ソフトウェアの販売） | マネージドのサービスに絞る。BYOC は Later |

## 法務の確認待ち

設計はこの前提で進めるが、確認が済むまで、該当する Epic の spec を承認しない。

| ID | 問い | 影響する範囲 |
| --- | --- | --- |
| L1 | 商標：「Kafka」は ASF の登録商標である。本家の商標の方針は、第三者の Java 以外のクライアントとコネクターの名前に使うことを条件付きで認め、免責の表示を求めている（[Apache Kafka の Trademark](https://kafka.apache.org/community/trademark/)、2026-09-27 に確認）。マネージドのサービスの説明で「Apache Kafka 互換」「Apache Kafka のプロトコルに対応」と書けるか、どの表示と免責が要るか | 製品の説明、コンソール、文書、マーケティング |
| L2 | 本家の Apache Kafka に当てたパッチを、SaaS として動かすときと、配る成果物（CLI、Terraform のプロバイダー、サンプル）の、Apache License 2.0 の上の義務（NOTICE、変更の表示） | ADR-0001、delivery |
| L3 | 周辺の OSS のライセンス：Confluent Community License の部品（Schema Registry など）は SaaS として提供できない前提で進める。この理解が正しいか。Apache License の代替（Apicurio Registry、Karapace など）を使うときの義務 | connectors-and-schema |
| L4 | テナントのトピックの中身（個人データを含みうる）について、当社は委託先（処理者）として扱われるか。個人情報保護法の上の安全管理措置と、越境（大阪以外の海外に置かないこと）の約束をどう書くか | security-and-acls、infrastructure、利用規約 |
| L5 | 他人の通信を媒介するとみなされ、電気通信事業法の届出が要るか | 提供の開始の前 |
| L6 | SLA の返金（サービスクレジット）の条件と、リージョンの障害で失いうるデータの説明。S1 では、大阪から戻せるのは写しを有効にした論理クラスタの S3 に上がった部分だけ（[ADR-0045](decisions/0045-osaka-disaster-recovery-scope.md)、NFR-009） | 利用規約、SLA |
| L7 | 経理・税務：適格請求書の登録番号と訂正の手続き、値引き（クレジット・SLA の返金）の課税の扱い、海外の法人の利用者への消費税（電気通信利用役務の提供の区分）、使用量の生の記録の保存の期間（10 年の案） | metrics-and-billing、ADR-0039（E11） |
| L8 | 利用規約：未払いの停止と削除の条件、停止の間の課金、BYOK のキーの取り消しを SLA の対象外にすること、監査ログ（個人データを含む）を 1 年を超えて持つか | metrics-and-billing、security-and-acls |

- L3 に次の問いを足す：Confluent の Schema Registry の REST API と互換の API を自前で提供してよいか、どの表示が要るか。差分テストのために本家の Schema Registry を社内で動かしてよいか（[ADR-0040](decisions/0040-own-schema-registry.md)）。
- L7・L8 は法務・経理の確認待ちとして扱い、確認が済むまで該当する E11 の Story の spec を承認しない。

## Open questions

統合の工程（2026-09-27）で次のとおり決めた。

- データ面のオペレーター：Strimzi を使い、自前では作らない（[ADR-0032](decisions/0032-strimzi-for-physical-clusters.md)）。
- テナントの名前空間：ブローカーのパッチで作る（[ADR-0025](decisions/0025-tenant-namespace-patch.md)）。E1 の PoC で、パッチの量と本家の版の更新の手間を測り、多すぎればプロキシの案を見直す。
- ディスクレスのトピック：本家が冪等とトランザクションに対応してから出す（[ADR-0020](decisions/0020-diskless-topics-adoption.md)）。
- CU の定義：[ADR-0037](decisions/0037-capacity-unit-definition.md)。値段の形は [ADR-0039](decisions/0039-jpy-billing-and-free-tier.md)（パーティション-時の課金を含む。PM・Dev の確認待ち）。単価の値は PM が E11 で決める。

残る問い：

- NFR-009 の約束の書き方（大阪から戻せる範囲。[architecture/README.md](architecture/README.md) の 3 節）を、PM が SLA と利用規約（L6）と合わせて確定する。
- パーティション-時の課金と、NFR-010 の目標の改定（同じく 3 節）を、PM と Dev が確定する。
