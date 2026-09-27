---
status: accepted
date: 2026-09-27
---

# ADR-0025: 名前空間は `<lc-id>_` の接頭辞を、要求の出入口の表駆動のパッチで付け外しし、テナントは SNI と API キーの一致で決める

詳細は [multi-tenancy-and-quotas.md](../architecture/multi-tenancy-and-quotas.md) の 4 節。

## Context

- [ADR-0004](0004-logical-clusters-on-shared-physical-clusters.md) で、テナントを共有の物理クラスタの上の論理クラスタにし、名前空間をブローカーの小さなパッチで作ると決めた。この ADR は、パッチの中身を決める。
- Kora は、資源に論理クラスタの ID を付け、認証のときに接続に結び付けた ID で、ブローカーの割り込みの処理が要求を書き換える（[Kora](https://vldb.org/pvldb/vol16/p3822-povzner.pdf) の 5.1 節、2026-09-27 に確認）。
- 本家のトピックの名前の上限は 249 文字。トピックの ID（UUID）は物理クラスタで一意で、Fetch などの新しい版は ID で指す。
- consumer のグループの正規表現（KIP-848）はサーバーで評価される（[Consumer Rebalance Protocol](https://kafka.apache.org/43/operations/consumer-rebalance-protocol/)、2026-09-27 に確認）。
- クライアントはブローカーの TLS に SNI を付けて繋ぐ。SNI のプロキシは TLS を終端しない（[architecture/README.md](../architecture/README.md) の 1 節）ので、ブローカーが SNI を受け取れる。
- [ADR-0003](0003-kraft-metadata-and-cluster-placement.md) は、論理クラスタの ID を `lc-<ランダムな英数字>` とした。

## Options

名前の形：

1. **`<lc-id>_<名前>`（接頭辞と区切り）**
2. 名前のハッシュなど、元の名前を含まない内部の名前と、対応の表

テナントの決め方：

- A. **SNI と API キーの両方で決め、一致を求める**
- B. API キーだけで決める

他のテナントの資源に触れたとき：

- X. **存在しないときと同じエラーを返す**
- Y. 権限のエラーを返す

## Decision

1、A、X を採用する。

- lc-id は `lc-` ＋ 小文字の英数字 6 文字。区切りは `_`。テナントのトピックの名前の上限は 239 文字。
- 対象：トピック、グループ（全種類）、`transactional.id`、ACL の資源の名前、`ConfigResource`（TOPIC・GROUP）の名前。
- 要求の出入口の 1 か所に、API のキー × 版ごとの資源の名前の場所の表を持ち、要求で付け、応答で外し、一覧から他のテナントの要素を取り除く。表は本家のメッセージの定義から生成し、CI で本家の ApiVersions と照合する。
- トピックの ID で指す要求は、ID の持ち主を確かめ、違えば `UNKNOWN_TOPIC_ID`。
- ACL の LITERAL の `*` は PREFIXED の `<lc-id>_` に置き換える。
- Metadata・DescribeCluster の `cluster_id` は lc-id。S1 のブローカーの一覧は物理クラスタの全体で、ホスト名はテナントの形。
- consumer のグループの正規表現は、コーディネーターの中のパッチで、テナントのトピックだけを相手に、接頭辞を外した名前で評価する（[ADR-0023](0023-consumer-group-protocols-and-limits.md)）。
- パッチの場所は P1〜P7 の一覧で管理する（[multi-tenancy-and-quotas.md](../architecture/multi-tenancy-and-quotas.md) の 4.5 節）。P1・P2 は 1 つのクラス、P3〜P7 は本家のコードの 1 か所に呼び出しを足すだけにする。
- 2 を選ばない理由：S3 のキー、運用のログ、障害の調査で、元の名前が分からなくなる。対応の表の一貫性が新しい正しさの問題になる。
- B を選ばない理由：他のテナントのホスト名に自分の API キーで繋げてしまい、テナントのホスト名とブローカーの一覧の対応が崩れる。
- Y を選ばない理由：権限のエラーは、その名前の資源が存在することを漏らす。

## Consequences

- 良くなること：
  - 名前が人に読める形で残り、S3 のキー（[ADR-0018](0018-s3-remote-storage-manager.md)）や費用の按分に前方一致で使える。
  - 名前空間の抜けを、表と CI で機械的に防げる。
- 引き受けるコスト：
  - テナントのトピックの名前の上限が 10 文字短い（本家との違い）。
  - パッチが要求の出入口に加えて、コーディネーターの中にも入る。
  - SNI の取り出しが差し込み口で済まなければ、パッチが 1 つ増える（E1 で確かめる）。

## Confirmation

- 性質ベーステスト：任意の 2 つのテナント、任意の API のキー × 版、任意の名前の列で、一方の応答に他方の資源が出ない。接頭辞の付け外しで名前が戻る。ACL が他のテナントの資源に当たらない。
- CI：本家が広告するすべての API のキー × 版が、表にあるか明示的に拒否されている。
- 本番：合成監視の 2 つの論理クラスタで、互いの資源が見えないことを 1 分ごとに確かめる。
