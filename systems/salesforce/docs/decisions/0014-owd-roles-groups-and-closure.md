---
status: accepted
date: 2026-09-28
---

# ADR-0014: OWD の変更は述語の切り替えだけにし、利用者本人とキューもグループとして、ロール階層を含む閉包を 1 つの表にまとめる

詳細は [sharing-and-record-access.md](../architecture/sharing-and-record-access.md) の 4 節、6.2 節、7.1 節。

## Context

[ADR-0004](0004-record-access-model.md) は、グループの閉包（`group_members_closure`）とロール階層の閉包（`role_subordinates_closure`）を事前計算し、所有者と所有者の条件の共有ルールは問い合わせの時に閉包と結ぶとした。OWD の変更は、影の世代の再計算の対象に挙げていた。

本家は、ロールごとに Role・RoleAndSubordinates のシステムのグループを作り、キュー・公開グループと同じ表で所属を展開して持つ（[Record-Level Access: Under the Hood](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_record_access_under_the_hood.pdf)、2026-09-28 に確認）。両方の OWD が公開・参照・更新のオブジェクトは、共有の表を持たない（同）。

決めること：

- 閉包を 2 つの表に分けるか。
- 公開グループの「上司にも与える」と、オブジェクトごとの「階層で与えない」設定をどう表すか。
- OWD の変更で、共有の行を書き直すか。

## Options

1. **利用者本人のグループ（ID は利用者の ID）とキュー（ID はキューの ID）を含む全てのグループの閉包を 1 つの表にし、階層だけで属する行に印（`via_hierarchy`）を付ける。`record_shares` を OWD に関わらず常に保ち、OWD の変更は問い合わせの条件の切り替えだけにする**
2. ADR-0004 のとおり 2 つの閉包の表を持ち、OWD の変更で影の世代を作る
3. 1 と同じ閉包にし、OWD が公開・参照・更新のオブジェクトでは `record_shares` を持たない（本家と同じ）

## Decision

1 を採用する。

- グループの種類は `user`、`queue`、`role`、`role_and_subordinates`、`public`。`user` のグループの ID を利用者の ID と同じにする。
- 閉包の 1 行は「利用者 U はグループ G のメンバーとして扱われる」。上司は部下の `user` のグループに `via_hierarchy = true` で属する。公開グループの `grant_via_hierarchy` が真なら、メンバーの上司も `via_hierarchy = true` で属する。
- 所有者から見える判定は、`records.owner_id` が利用者の属するグループ（閉包）にあるかで行う。本人・キュー・部下を 1 つの条件で表せる。`grant_via_hierarchy = false` のオブジェクトでは `via_hierarchy = false` の行だけを使う。
- ADR-0004 の `role_subordinates_closure` は、この表の `user` のグループの行の見方とし、別の表にしない。
- `record_shares` を OWD に関わらず保ち、OWD・`grant_via_hierarchy`・ロールの `child_access` の変更は、メタデータの版を上げて問い合わせの条件を変えるだけにする。
- 閉包は世代の番号を持ち、ロールの木の移動のような大きな変更は新しい世代を作って切り替える（[ADR-0016](0016-recalculation-rule-versions-and-skew.md)）。
- 利用者の所属は、要求ごとに閉包から読み、キャッシュしない。
- 2 は、同じ意味の所属を 2 つの表で保つことになる。OWD の変更のたびにオブジェクトの全ての行を作り直すのも重い。3 は、OWD を非公開に戻す時に、全ての行の再計算が要る。

## Consequences

- 良くなること：
  - 本人・キュー・部下・グループへの共有が、同じ閉包の結合で判定できる。
  - OWD の変更が即時で、再計算がない（NFR-005 の OWD の変更の目標を、版の切り替えだけで満たす）。
  - 所属の変更の直後に、古い所属で見せることがない。
- 引き受けるコスト：
  - 閉包の表が、上司の行の分だけ大きくなる（利用者の数 × 平均の深さ）。
  - 公開・参照・更新のオブジェクトでも、レコードの条件のルールの行を書き続ける。
  - 要求ごとに閉包の読みが 1 回入る。p99 を計測する。

## Confirmation

- 性質ベーステスト：任意のロールの木・グループの入れ子・所属の変更の列で、閉包から求めた所属が、定義からその場でたどった所属と一致する。
- 性質ベーステスト：OWD の変更の前後で、判定が参照の評価器と一致し、行の書き直しがない。
- 性能テスト（E4 の PoC）：所属の読みの p99 が 5ms 以内。
