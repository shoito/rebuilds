---
status: accepted
date: 2026-09-27
---

# ADR-0040: スキーマレジストリは、Confluent の REST API と互換の自前の実装にする

## Context

intent.md は、スキーマレジストリを Later とし、Confluent の Schema Registry は Confluent Community License で SaaS として提供できない前提で進めるとした（L3）。S2 で提供する。

事実（いずれも 2026-09-27 に確認）：

- Confluent Community License は、Confluent の製品と競合する SaaS として提供することを除外する。Schema Registry を競合するオンラインのサービスとして提供することはできないと FAQ が書く（[FAQ](https://www.confluent.io/confluent-community-license-faq/)）。一方、`client`・`avro-serializer`・`protobuf-serializer`・`json-schema-serializer` などのクライアント側のモジュールは Apache License 2.0（[schema-registry の README](https://github.com/confluentinc/schema-registry)）。
- Apicurio Registry は Apache License 2.0（最新 3.3.3、2026-09-08）で、Confluent の互換の API（`/apis/ccompat/v7`）を持つ。ただし ID が 2 種類ある、グループのスキーマが見えないことがある、一部の状態コードが違う、参照で Confluent のライブラリが失敗する報告がある（[互換の API の文書](https://www.apicur.io/registry/docs/apicurio-registry/3.3.x/getting-started/assembly-confluent-schema-registry-compatibility.html)、GitHub の issue #5133・#7295）。3.x のマルチテナントは、テナントごとに別のインスタンスを立てる形で、1 つのインスタンスの中で ID の空間を分ける機能はない（[Implementing multitenancy](https://www.apicur.io/registry/docs/apicurio-registry/3.3.x/getting-started/assembly-implementing-multitenancy.html)、2026-09-27 に確認）。
- Karapace は Apache License 2.0 の Python の互換の実装で、スキーマを Kafka のトピックに保存する（[karapace](https://github.com/Aiven-Open/karapace)）。

## Options

1. **自前で実装する（Java 21、Aurora PostgreSQL）。互換の API の、シリアライザーと管理の道具が使う部分を持つ**
2. Apicurio Registry を動かす（組織ごとのインスタンスか、グループでの分離）
3. Karapace を動かす（組織ごとのインスタンス）
4. Confluent Schema Registry を動かす

## Decision

1 を採用する。詳細は [connectors-and-schema.md](../architecture/connectors-and-schema.md) の 3 節にある。

- API：スキーマの ID の取得、サブジェクトと版、登録と検索（`normalize` を含む）、削除（軽い・完全）、互換性の判定、`config`、`mode`（`IMPORT` を含む）、参照。コンテキスト、エクスポーター、データの契約、DEK は持たない。
- レジストリは組織×リージョンに 1 つ（`sr-<id>`）。ID はレジストリごと。認証は、レジストリに絞った API キー。
- 互換性の判定は、Apache Avro、protobuf-java、JSON Schema のライブラリ（Apache 2.0 か MIT）で行う。Confluent のサーバーのコードは写さない。
- 互換は、Confluent の Apache 2.0 のクライアント・シリアライザーを相手にした差分テストで確かめる。
- 見直しの条件：S2 の開始の PoC で、Apicurio が同じ差分テストを通し、マルチテナントを持つなら、2 に切り替えるかを判断する。

2 を選ばない理由：互換の API の違い（ID の対応、状態コード、参照）が、既存のシリアライザーの「URL と資格情報の変更だけで移れる」を崩す。組織ごとのインスタンスは、組織の数（S2 で 1 万）に費用が合わない。

3 を選ばない理由：組織ごとに Kafka のトピックとプロセスを持つ作りで、費用が合わない。Python のサービスを 1 つ増やす。

4 を選ばない理由：Confluent Community License で SaaS として提供できない（法務の確認待ちだが、FAQ の文言から前提とする）。

## Consequences

- 良くなること：
  - 状態コード・ID・正規化を、本家のクライアントの期待に合わせて作れる。
  - マルチテナントと課金を最初から持てる。
- 引き受けるコスト：
  - 3 つの形式の互換性の判定と正規化を、自前で保つ。本家の振る舞いの変化に、差分テストで追従する。
  - Java のサービスを 1 つ増やす。
  - 互換の API を提供してよいか、どの表示が要るかは、法務の確認待ち（L3 の追加の問い）。確認が済むまで、S2 のスキーマの Epic の spec を承認しない。

## Confirmation

- 差分テスト：Confluent の Apache 2.0 のクライアントとシリアライザーで、登録・検索・互換性の判定・参照・削除の応答が、本家の期待と同じ。違いは「許された違い」の表にあるものだけ。
- 表駆動テスト：形式×互換性の水準×変更の種類。
- 性質ベーステスト：同じ正規化の内容は同じ ID。一方のレジストリのキーで他方のスキーマが読めない。
