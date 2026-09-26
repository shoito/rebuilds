# AGENTS.md — Kafka

Kafka（マネージドのストリーミング基盤）の再構築の設計。リポジトリ共通のルールはルートの [AGENTS.md](../../AGENTS.md) にある。このリポジトリには設計だけを置き、実装は Kafka の題材の開発リポジトリで行う（[リポジトリ共通の ADR-0005](../../docs/decisions/0005-design-record-repository.md)）。

## 最初に読むもの

- [docs/intent.md](docs/intent.md) — 何を、なぜ作るか
- [docs/architecture/](docs/architecture/README.md) — 全体像、規模の段階、非機能要件、領域ごとの設計
- [docs/decisions/](docs/decisions/README.md) — ADR。特に 0001（本家のブローカーを使う）、0002（保存の方式）、0005（互換性の方針）

## この題材に固有の規則（開発リポジトリで守る）

- **受け付けた書き込みを失わない。** 複製・ログ・階層型の保存・トランザクション・グループのコーディネーター・リーダーの選出に触れる変更は、障害注入の耐久性テスト（Jepsen の形。ノードの停止、ネットワークの分断、時計のずれ、ディスクの遅延、AZ の喪失）を通す。`acks=all` で成功を返した書き込みが消える、読めない、順序が変わる事象が 1 件でも出たら、マージしない（ADR-0002、ADR-0003）。
- **耐久性の既定値をテナントに変えさせない。** マルチ AZ のトピックの `replication.factor=3`、`min.insync.replicas=2`、`unclean.leader.election.enable=false` は、テナントの設定の API で変えられないようにする。変えるときは ADR を先に書く（ADR-0002、ADR-0004）。
- **プロトコルの振る舞いを変える変更には、互換性のテストを通す。** 要求の処理、API の版、エラーコード、許可・拒否する API の一覧に触れる PR は、クライアントの行列（Java のクライアント、librdkafka、franz-go、Sarama、KafkaJS）と、本家のブローカーとの差分テストを通す。動いていたクライアントの版を壊す変更は、[ADR-0005](docs/decisions/0005-compatibility-policy.md) の廃止の手順を踏むまで入れない。
- **本家のブローカーへの手の入れ方を最小にする。** まず本家の差し込み口（Authorizer、RemoteStorageManager、ClientQuotaCallback、KafkaPrincipalBuilder、CreateTopicPolicy・AlterConfigPolicy）で作る。本家のコードへのパッチは、テナントの名前空間など差し込み口で作れないものに限る。パッチを足すときは ADR を書き、パッチごとに理由と関連する KIP を記録する（ADR-0001、ADR-0004）。
- **テナントの分離をアプリのコードの注意だけに頼らない。** ブローカーに届くすべての要求は、テナントの解決（論理クラスタの ID の付与）を通る。新しい API の版・要求の種類を通すときは、他のテナントの資源が見えないことの性質ベーステストを付ける（ADR-0004）。
- **利用者のデータをログに出さない。** レコードの値・キー・ヘッダー、API キーの秘密、SASL の資格情報を、ログ・エラーの本文・トレースの属性・メトリクスのラベル・テストのスナップショットに書かない。
- **耐久性・テナントの分離・認証に関わる変更は、追加のレビューを受ける。** 該当する PR には `durability:sensitive` または `security:sensitive` のラベルを付け、Dev のテックリードの承認を必須にする。エージェントは承認しない。
- **本家の名前を識別子に使わない。** 製品名、ドメイン、ブートストラップのホスト名、API のパス、HTTP のヘッダー、API キーの接頭辞、CLI のコマンド名、Terraform のプロバイダー名は `<Brand>`・`<brand>` で書く（[リポジトリ共通の ADR-0006](../../docs/decisions/0006-brand-neutral-identifiers.md)）。本家のプロトコルの振る舞い（API の名前、エラーコード、`__consumer_offsets` などの内部トピックの名前、クライアントの設定のキー）は、互換性のためにそのまま使う。

## このリポジトリでの規則

- ADR を追加・更新したら、`docs/decisions/README.md` の一覧を生成し直す。
- 領域の文書で ADR を起票するときは、[architecture/README.md](docs/architecture/README.md) の 7 節で領域に割り当てた番号の範囲の中で採番する。
- 本家（Apache Kafka、Confluent Cloud）と他の実装（MSK、WarpStream、Redpanda、AutoMQ）の振る舞い・数値を書くときは、出典と確認日を付ける。確かめられないものは「未検証」と書く。
