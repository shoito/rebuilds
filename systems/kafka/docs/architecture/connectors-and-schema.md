# Connectors and schema: Kafka

スキーマレジストリと、マネージドのコネクター（Kafka Connect に相当）の設計。どちらも MVP の後（Later）で、スキーマレジストリは S2、マネージドのコネクターは S3（テナントのコードを動かすものは S3 の後半）に入れる（[architecture/README.md](README.md) の 2 節）。この文書で決めたことは [ADR-0040](../decisions/0040-own-schema-registry.md)（スキーマレジストリ）、[ADR-0041](../decisions/0041-managed-connectors-curated-plugins.md)（コネクターの範囲とプラグイン）、[ADR-0042](../decisions/0042-connector-runtime-isolation.md)（テナントのコードの隔離）にある。

本家（Confluent）と他の実装の振る舞い・ライセンスは、2026-09-27 に公式の文書と GitHub で確かめた。確かめられなかったものは「未検証」と書く。ライセンスの解釈は法務の確認待ち（intent.md の L3）。要件 ID は、S2・S3 の Epic の各変更の `spec.md` に移すときに振る。

## 1. 目的と範囲

- スキーマレジストリ：プロデューサーとコンシューマーが、Avro・Protobuf・JSON Schema のスキーマを共有し、互換性の規則で進化させる。既存のシリアライザー（Confluent のシリアライザー、librdkafka の上のクライアントのシリアライザー）を、URL と資格情報の変更だけで使えるようにする。
- マネージドのコネクター：データベースの変更（CDC）の取り込み、S3 などへの書き出しを、利用者がコネクターの設定だけで動かせるようにする。

範囲に入れないもの：

- ストリーム処理（Flink に相当）。intent.md の Later の別の行。
- REST Proxy（HTTP での produce・consume）。需要があれば別の ADR。

## 2. ライセンスの状況（確かめたこと）

| もの | ライセンス | SaaS として提供できるか | 出典 |
| --- | --- | --- | --- |
| Confluent Schema Registry（サーバー） | Confluent Community License | できない。「Confluent の製品と競合する SaaS として提供すること」を除外している | [Confluent Community License FAQ](https://www.confluent.io/confluent-community-license-faq/)、[schema-registry の README](https://github.com/confluentinc/schema-registry) |
| Confluent のシリアライザー・クライアント（`client`、`avro-serializer`、`protobuf-serializer`、`json-schema-serializer` など） | Apache License 2.0 | 利用者のアプリの中で使う。本システムはサーバーを提供するだけ | 同 README（Apache 2.0 のモジュールの一覧） |
| Confluent の JDBC・S3 などのコネクター（`kafka-connect-jdbc`、`kafka-connect-storage-cloud`） | Confluent Community License | できない（同上） | 各リポジトリの README・GitHub のライセンスの表示 |
| Apicurio Registry | Apache License 2.0。CNCF の Sandbox。最新 3.3.3（2026-09-08） | できる（義務は法務の確認待ち） | [apicurio-registry](https://github.com/Apicurio/apicurio-registry) |
| Karapace（Aiven） | Apache License 2.0。Python。Schema Registry と REST Proxy の互換の実装 | 同上 | [karapace](https://github.com/Aiven-Open/karapace) |
| Apache Kafka Connect | Apache License 2.0（本家の一部） | 同上 | 本家 |
| Debezium | Apache License 2.0 | 同上 | [debezium](https://github.com/debezium/debezium) |
| Aiven の S3 などのコネクター、JDBC のコネクター | Apache License 2.0 | 同上 | [cloud-storage-connectors](https://github.com/Aiven-Open/cloud-storage-connectors-for-apache-kafka)、[jdbc-connector](https://github.com/Aiven-Open/jdbc-connector-for-apache-kafka) |

- Confluent Schema Registry の REST API と互換の API を、自前の実装で提供すること自体が、ライセンスや他の権利（API の形の著作権など）に触れないかは、法務の確認待ち（L3 に追加の問いとして出す）。Apicurio・Karapace も同じ互換の API を公開している。
- Confluent のコードを、自前の実装に写さない。互換の確かめは、Apache 2.0 のクライアント・シリアライザーを相手にしたテストで行う。

## 3. スキーマレジストリ

### 3.1 本家の形と他の実装の違い

- 本家の Schema Registry の REST API（`/subjects`、`/subjects/{subject}/versions`、`/schemas/ids/{id}`、`/config`、`/compatibility/...`、`/mode`）を、シリアライザーが使う。
- 本家のワイヤー形式：レコードの値の先頭に、マジックバイト（0）と 4 バイトのスキーマの ID を置く。ID はレジストリの中で一意。Protobuf は、その後にメッセージの索引を置く（[Formats, Serializers, and Deserializers](https://docs.confluent.io/platform/current/schema-registry/fundamentals/serdes-develop/index.html)、2026-09-27 に確認）。E16 の `sr-differential-tests` で、本家のシリアライザーの出力と突き合わせる。
- Apicurio Registry は、Confluent の互換の API（`/apis/ccompat/v7`）を持つが、次の違いがある（[Confluent Schema Registry compatibility API](https://www.apicur.io/registry/docs/apicurio-registry/3.3.x/getting-started/assembly-confluent-schema-registry-compatibility.html)、[Apicurio の ADR-0001](https://github.com/Apicurio/apicurio-registry/blob/main/adr/0001-confluent-schema-registry-compatibility.md)、2026-09-27 に確認）：
  - ID が 2 種類（`globalId`・`contentId`）あり、Confluent の 1 つの ID との対応を設定で選ぶ。
  - スキーマのグループに入れたスキーマは、互換の API から見えないことがある（独自の見出しでグループを選ぶ）。
  - 一部のエラーの状態コードが違う（例：本家の 405 に対し 404）。
  - スキーマの参照（references）で、Confluent のライブラリが失敗する報告がある（GitHub の issue #5133）。
  - ccompat の v8 は issue #7295 で検討中。
- Karapace は「既存の Schema Registry のクライアント・サーバーの置き換え」を掲げるが、Python で、スキーマを Kafka のトピック（`_schemas`）に保存する作り（README）。

### 3.2 決定の要点

**自前で実装する**（[ADR-0040](../decisions/0040-own-schema-registry.md)）。

- 互換の API のうち、シリアライザーと管理の道具が使う部分を実装し、本家の振る舞い（状態コード、エラーコード、ID の割り当て、正規化）を、本家の Apache 2.0 のクライアントを相手にした差分テストで確かめる。
- マルチテナント（レジストリごとの ID の空間）を最初から持つ。Apicurio の 3.x のマルチテナントは、テナントごとに別のインスタンス（オペレーターの `ApicurioRegistry3` の CR）を立てる形で、1 つのインスタンスの中で ID の空間を分ける機能はない（[Implementing multitenancy](https://www.apicur.io/registry/docs/apicurio-registry/3.3.x/getting-started/assembly-implementing-multitenancy.html)、2026-09-27 に確認）。1,000 以上の論理クラスタには向かない。
- 実装の言語は Java 21。スキーマの解析と互換性の判定を、Apache Avro（`SchemaCompatibility`）、protobuf-java、JSON Schema のライブラリ（Apache 2.0 か MIT のものを選ぶ）で行う。TypeScript では、3 つの形式の互換性の判定のライブラリが揃わない見込み（未検証。E16 の `sr-compatibility` の着手の前に確かめる。Java を選ぶ理由は、本家の判定と同じ Avro の `SchemaCompatibility` を使えることで足りる）。
- 保存は Aurora PostgreSQL（制御面と別のクラスタ）。

### 3.3 資源と URL

| 項目 | 形 |
| --- | --- |
| レジストリ | 組織×リージョンに 1 つ。`sr-<ランダム>` |
| エンドポイント | `https://sr-<id>.<region>.<brand>.<domain>` |
| 認証 | HTTP の Basic 認証。スキーマレジストリのキー（`scope = schema_registry:<sr-id>`。[security-and-acls.md](security-and-acls.md) の 3.3 節） |
| 認可 | ロール：ClusterAdmin 相当の SchemaAdmin（すべて）、SchemaWriter（登録）、SchemaReader（読み取り）を、サブジェクトの接頭辞で付ける |

### 3.4 API の範囲

| API | 扱い |
| --- | --- |
| `GET /schemas/ids/{id}`、`GET /schemas/ids/{id}/versions`、`GET /schemas/types` | 持つ |
| `GET /subjects`、`GET /subjects/{s}/versions`、`GET /subjects/{s}/versions/{v}`、`.../schema` | 持つ |
| `POST /subjects/{s}/versions`（登録）、`POST /subjects/{s}`（検索） | 持つ。`normalize` を含む |
| `DELETE /subjects/{s}`、`DELETE /subjects/{s}/versions/{v}`（軽い削除と `permanent=true`） | 持つ |
| `POST /compatibility/subjects/{s}/versions/{v}` | 持つ |
| `GET/PUT/DELETE /config`、`/config/{s}` | 持つ。互換性の水準（BACKWARD、BACKWARD_TRANSITIVE、FORWARD、FORWARD_TRANSITIVE、FULL、FULL_TRANSITIVE、NONE）。既定は BACKWARD（本家と同じ。[Schema Evolution](https://docs.confluent.io/platform/current/schema-registry/fundamentals/schema-evolution.html)、2026-09-27 に確認） |
| `GET/PUT /mode`（READWRITE、READONLY、IMPORT） | 持つ。IMPORT は移行のため（ID を指定した登録） |
| スキーマの参照（references） | 持つ |
| コンテキスト、エクスポーター、データの契約（ルール、メタデータ）、フィールドの暗号化の鍵（DEK） | 持たない（S2 の後に需要で決める） |

### 3.5 ID の割り当て

- ID はレジストリごとに 1 から増える整数。同じ正規化の内容は、サブジェクトが違っても同じ ID（本家の文書は「スキーマが同じなら、複数のサブジェクトが同じ ID を持ちうる」とする。[Formats, Serializers, and Deserializers](https://docs.confluent.io/platform/current/schema-registry/fundamentals/serdes-develop/index.html)、2026-09-27 に確認）。
- 移行：本家や他のレジストリから、ID を保ったまま取り込む（`IMPORT` のモード）。これで、既に書かれたレコードのスキーマの ID が、そのまま引ける。

### 3.6 上限

| 項目 | 値（初期値） |
| --- | --- |
| スキーマの数（レジストリごと） | 1,000（Standard の組織は 20,000 まで引き上げ可） |
| スキーマ 1 つの大きさ | 1 MiB |
| 要求 | レジストリごとに 100 回/秒 |

- 値は本システムの初期値。Confluent Cloud は、Essentials で 100、Advanced で 20,000 のスキーマを含み（版と論理削除したものを数える）、要求は読み取り 75 回/秒・書き込み 25 回/秒（[Stream Governance packages](https://docs.confluent.io/cloud/current/stream-governance/packages.html)、2026-09-27 に確認）。

### 3.7 性能と可用性

- シリアライザーはスキーマの ID を手元にキャッシュするので、読み取りの多くは起動のときだけ。ID の取得（`GET /schemas/ids/{id}`）は、CloudFront を通さず、サービスのメモリーのキャッシュ（ID は変わらない）で返す。
- 目標：可用性 99.95%、ID の取得の p99 50 ms。スキーマレジストリの停止は、新しいスキーマの登録と、キャッシュのないクライアントの起動を止める。produce・fetch そのものは止めない（シリアライザーのキャッシュ）。

### 3.8 スキーマの検証（ブローカー側、Later）

- Confluent の「ブローカー側のスキーマの検証」に当たる機能（produce のレコードの ID が、登録されたものかを確かめる）は持たない。ブローカーのパッチが増えるため。需要が出たら別の ADR にする。

## 4. マネージドのコネクター

### 4.1 本家の形（確かめたこと）

- Confluent Cloud のカスタムのコネクターは、Java の Kafka Connect のプラグイン（.zip か .jar、250 MB まで）を利用者が上げて動かす。外への接続は FQDN で指定し、検証する。Confluent は上げたプラグインを走査し、悪意のある動きを見つけたら消す（[Custom connector quick start](https://docs.confluent.io/cloud/current/connectors/bring-your-connector/custom-connector-qs.html)）。
- 上限：組織あたり 30 のカスタムのコネクターと 100 のプラグイン、コネクターあたり 250 のタスク。コネクターのメモリーは 2 GB をタスクで分け合う。ローカルのファイルシステムに書けない。固定の送信元の IP はない（[Custom connector limitations](https://docs.confluent.io/cloud/current/connectors/bring-your-connector/custom-connector-fands.html)）。
- Confluent は基盤だけを支え、上げたプラグインの問題は利用者の責任とする（[Custom connectors overview](https://docs.confluent.io/cloud/current/connectors/bring-your-connector/overview.html)）。

### 4.2 段階

| 段階 | 中身 |
| --- | --- |
| S3 前半 | 当社が選んだ Apache 2.0 のコネクターだけ（Debezium の MySQL・PostgreSQL、S3 への書き出し、JDBC）。利用者は設定だけを渡す |
| S3 後半 | 利用者のプラグイン（カスタムのコネクター）。4.4 節の隔離を必須にする |

- Confluent Community License のコネクターは使わない（2 節）。
- 当社が選んだコネクターでも、第三者のコード（JDBC のドライバーなど）を動かす。隔離は、選んだコネクターにも同じく掛ける（4.4 節）。

### 4.3 構成

```
制御面：コネクターの設定（秘密は Secrets Manager）、状態
   └─▶ コネクターの実行基盤（専用の EKS のクラスタ。ブローカーの EKS と分ける）
         ├─ コネクターごとの Kafka Connect のワーカー（分散モード、1 つのコネクター専用）
         │    ├─ EKS Fargate の Pod（Pod ごとに VM）
         │    ├─ 専用の API キー（そのコネクターが使うトピックだけの ACL）
         │    └─ 外への通信：出口のプロキシ（FQDN の許可リスト）だけ
         └─ 出口のプロキシ（Envoy、許可リストは組織ごと）
```

- ワーカーは、コネクターごとに専用にする（複数のテナントのコネクターを 1 つのワーカーに載せない）。Kafka Connect のワーカーは、1 つの JVM に複数のプラグインを載せる作りなので、テナントの境界をプロセスの中で守れない。
- ワーカーの内部のトピック（`config`・`offset`・`status`）は、テナントの論理クラスタの中に置く（接頭辞付き、テナントに見える）。コネクターの専用の API キーで読み書きする。
- 秘密（データベースのパスワード）は、Secrets Manager に置き、Kafka Connect の設定の提供者（ConfigProvider）で読む。コネクターの設定の API の応答では伏せる。

### 4.4 テナントのコードの隔離

[ADR-0042](../decisions/0042-connector-runtime-isolation.md)。脅威と対策：

| 脅威 | 対策 |
| --- | --- |
| コンテナからの脱出で、他のテナントのワーカーに届く | EKS Fargate：Pod ごとに VM の境界があり、カーネル・CPU・メモリー・ネットワークのインターフェースを他の Pod と分け合わない（[AWS Fargate on EKS](https://docs.aws.amazon.com/eks/latest/userguide/fargate.html)、2026-09-27 に確認）。特権のコンテナ、`HostNetwork` は Fargate で使えない（同上） |
| 基盤（ブローカー、制御面）への侵入 | コネクターの EKS を、ブローカーの EKS・制御面と別のクラスタ・別の VPC（別の AWS アカウント）に置く。AWS も「最も安全な隔離は別のクラスタ」とする（同上）。ブローカーへは、公開のブートストラップ（SNI のプロキシ）経由で、テナントと同じ道でつなぐ |
| SSRF（内部の IP、メタデータのサービス） | Fargate では IMDS を使えない（同上）。外への通信は出口のプロキシの FQDN の許可リストだけ。RFC 1918 の宛先、リンクローカル、当社のドメインを拒否する。DNS の再束縛を防ぐため、プロキシで名前を引き、引いた IP を検査する |
| Kubernetes の API の悪用 | Pod にサービスアカウントのトークンを載せない。名前空間はテナントごと。NetworkPolicy で Pod の間の通信を禁止する |
| AWS の資格情報の悪用 | Pod に IAM の役割を付けない（S3 への書き出しは、利用者の役割を引き受ける形で、利用者のアカウントの外部 ID 付きの AssumeRole） |
| 資源の独占（暗号通貨の採掘など） | Pod の CPU・メモリーの上限（コネクターあたり 2 vCPU・4 GiB から）。CPU の使用の異常の検知。課金（コネクターのタスク-時） |
| 悪意のあるプラグイン | 上げるときに、既知のマルウェアの走査と、依存の脆弱性の走査。大きさの上限（250 MB）。動いている間の外への通信を記録する |
| 他のテナントのデータへのアクセス | コネクターの API キーは、そのテナントの論理クラスタの、指定したトピックだけ（ACL） |

- Fargate の制約：EBS を付けられない（同上）。コネクターはローカルのファイルに書かない前提（Confluent と同じ）。
- Fargate の Pod の OS の更新で、Pod が消されることがある（同上）。Kafka Connect のタスクは再起動に耐える（オフセットをコミット済みの位置から再開）。

### 4.5 課金

- 行：コネクターのタスク-時と、コネクターが書き込み・読み取りした GB（論理クラスタの書き込み・読み取りとは別に数えない。論理クラスタの側で数える）。価格は PM が決める（[metrics-and-billing.md](metrics-and-billing.md) の 13 節）。

## 5. 障害と振る舞い

| 事象 | 起きること | 検知 | 対応 |
| --- | --- | --- | --- |
| スキーマレジストリの停止 | 新しいスキーマの登録と、キャッシュのないクライアントの起動が失敗 | 合成監視 | 復旧。produce・fetch はシリアライザーのキャッシュで続く |
| スキーマの保存の破損・誤った削除 | ID が引けず、デシリアライズの失敗 | ID の取得の 404 の率 | Aurora の時点復元。軽い削除は戻せる（`permanent` でない限り） |
| コネクターのワーカーの停止 | その 1 つのコネクターが止まる | タスクの状態 | 自動の再起動。利用者にタスクのエラーを見せる |
| 出口のプロキシの停止 | そのリージョンのコネクターが外につながらない | プロキシの健全性 | 複数の AZ に置く |
| プラグインの悪意の検知 | — | 走査、外への通信の異常 | コネクターを止め、組織に知らせる（runbook） |

## 6. セキュリティ

- スキーマは、利用者のデータ構造（個人データの項目名を含みうる）を表す。スキーマの本文をログに出さない。
- スキーマレジストリのキーは、レジストリに絞る（Kafka の接続には使えない）。
- コネクターの隔離は 4.4 節。コネクターの設定の秘密は、応答・ログ・監査ログに出さない。

## 7. テスト

- 差分テスト（スキーマレジストリ）：Confluent の Apache 2.0 のクライアントとシリアライザー（Java）、librdkafka の上のクライアントのシリアライザーで、登録・検索・互換性の判定・参照・削除を流し、応答を本家の Schema Registry（社内の試験の環境で、ライセンスの範囲で動かす。法務の確認待ち）と比べる。本家を動かせない場合は、本家の文書とクライアントのテストの期待値で比べる。
- 互換性の判定の表駆動テスト：形式（Avro・Protobuf・JSON Schema）×水準（7 つ）×変更の種類（項目の追加・削除・既定値・型の変更）。
- 性質ベーステスト：任意の登録の列で、同じ正規化の内容は同じ ID。任意の 2 つのレジストリで、一方のキーで他方のスキーマが読めない。
- コネクターの隔離：侵入テストの項目（IMDS、内部の IP、Kubernetes の API、他の Pod への接続、DNS の再束縛）を自動のテストにし、ワーカーの基盤の変更ごとに流す。
- コネクター：選んだコネクターごとの結合テスト（MySQL・PostgreSQL の CDC、S3 への書き出し）。

## 8. ADR

| ADR | 決定 |
| --- | --- |
| [0040](../decisions/0040-own-schema-registry.md) | スキーマレジストリは、Confluent の REST API と互換の自前の実装（Java、Aurora）にする。Confluent のサーバーのコードは使わない。Apicurio・Karapace は採らない |
| [0041](../decisions/0041-managed-connectors-curated-plugins.md) | マネージドのコネクターは、当社が選んだ Apache 2.0 のコネクターから始め、利用者のプラグインは隔離を整えてから足す。コネクターごとに専用のワーカーにする |
| [0042](../decisions/0042-connector-runtime-isolation.md) | コネクターは、ブローカーと別の EKS・VPC・アカウントの、Fargate の Pod で動かし、外への通信を FQDN の許可リストの出口のプロキシに限る |

## 9. Story の候補

MVP の Epic（E1〜E12）には入れない。roadmap で S2・S3 の Epic を足すときに、次を Story の候補にする。MVP の間に E8・E12 で先に行うものも挙げる。

| Epic | Story | 中身 |
| --- | --- | --- |
| E8 | `schema-registry-key-scope` | API キーの `scope` に `schema_registry` を足せる形にしておく（[security-and-acls.md](security-and-acls.md) の 3.3 節） |
| S2（スキーマ） | `sr-core-api` | 3.4 節の API、ID の割り当て、Aurora の保存 |
| S2（スキーマ） | `sr-compatibility` | 3 つの形式の互換性の判定 |
| S2（スキーマ） | `sr-differential-tests` | 7 節の差分テスト |
| S2（スキーマ） | `sr-import-mode` | 移行（`IMPORT`） |
| S2（スキーマ） | `sr-console-and-terraform` | コンソールの画面、Terraform の `<brand>_schema` |
| S3（コネクター） | `connector-runtime` | 4.3・4.4 節の基盤（別の EKS、Fargate、出口のプロキシ） |
| S3（コネクター） | `curated-connectors` | Debezium（MySQL・PostgreSQL）、S3 への書き出し、JDBC |
| S3（コネクター） | `connector-isolation-tests` | 7 節の侵入テストの自動化 |
| S3（コネクター） | `custom-connector-upload` | 利用者のプラグインの受け付け、走査 |

## 10. 段階ごとの変化

| 項目 | S1 | S2 | S3 |
| --- | --- | --- | --- |
| スキーマレジストリ | なし（利用者が自分で動かす。Apicurio・Karapace を案内する） | 自前の実装 | 同じ |
| コネクター | なし | なし | 選んだコネクター → 利用者のプラグイン |

## 11. 未解決の問い

- スキーマレジストリを自前で作るか、Apicurio を使うか。
- スキーマの ID を組織ごとにするか、論理クラスタごとにするか。
- コネクターの隔離に Fargate を使うか、gVisor・Kata などのサンドボックスを EC2 のノードで使うか。
- 利用者のプラグインを受け付けるか。

### 決定（2026-09-27、既定案）

- **スキーマレジストリ**：自前（ADR-0040）。ただし S2 の開始の時点で、Apicurio の ccompat の差（3.1 節）が本家に揃っていれば、ADR-0040 を見直す（PoC で、7 節の差分テストを Apicurio に流して比べる）。
- **ID の範囲**：組織×リージョン。1 つのレジストリを、組織の複数の論理クラスタで共有できる（Confluent の環境ごとのレジストリに近い）。
- **隔離**：Fargate（ADR-0042）。サンドボックスのランタイムを自前で運用しない。
- **利用者のプラグイン**：S3 の後半。選んだコネクターの運用で、隔離と走査の仕組みが本番で 6 か月問題なく動いてから。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| Confluent Schema Registry の API と互換の API を提供してよいか、どの表示が要るか | 法務の確認待ち（L3 の追加の問い） |
| 差分テストで本家の Schema Registry を社内で動かしてよいか | 法務の確認待ち（L3） |
| Apicurio 3.x のマルチテナントの有無 | S2 の開始の PoC |
| JSON Schema の互換性の判定のライブラリの選定 | S2 の PoC |
| コネクターの課金の単価 | PM（S3） |

## 12. quality.md・runbooks・data-model への項目

### quality.md

- スキーマレジストリの差分テストの合格率と、「許された違い」の表の行数。
- コネクターの隔離の侵入テストの自動化を、コネクターの基盤の変更の必須のテストにする。

### runbooks

- `runbooks/schema-registry-restore.md`：誤った削除・破損からの戻し（時点復元、ID の保存）。
- `runbooks/connector-malicious-plugin.md`：悪意のあるプラグインの検知の後の停止、組織への連絡、証拠の保存。
- `runbooks/connector-egress-proxy.md`：出口のプロキシの障害と許可リストの誤り。

### data-model（索引への追加の提案）

| テーブル | 中身 |
| --- | --- |
| `schema_registries` | `id`（`sr-`）、`organization_id`、リージョン、既定の互換性の水準、モード |
| `schemas` | `registry_id`、`schema_id`（整数）、形式、正規化した本文、本文のハッシュ、参照 |
| `subject_versions` | `registry_id`、サブジェクト、版、`schema_id`、削除の印（軽い・完全） |
| `subject_configs` | `registry_id`、サブジェクト、互換性の水準、モード |
| `connectors` | `id`、`organization_id`、`logical_cluster_id`、プラグイン、設定（秘密は参照だけ）、状態、タスクの数、専用の API キー |
| `connector_plugins` | `id`、組織（当社のものは空）、名前、版、ハッシュ、走査の結果、大きさ |
| `egress_allowlists` | `organization_id`、FQDN の一覧 |
