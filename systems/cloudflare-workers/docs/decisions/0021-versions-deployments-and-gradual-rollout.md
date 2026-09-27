---
status: accepted
date: 2026-09-27
---

# ADR-0021: 版は変えられないものにし、デプロイは 1〜2 の版と万分率の割合で、版の鍵により決定的に振り分ける

詳細は [deployment-and-config-distribution.md](../architecture/deployment-and-config-distribution.md) の 4 節と 8.3 節。

## Context

intent の MVP は「版を残し、2 つの版の間で割合を決めて流し、1 回の操作で前の版に戻す」を含む。[ADR-0004](0004-config-and-code-distribution.md) は、版を変えられないもの（コードのハッシュ、設定、互換の日付、バインディング）とし、ルートが「版 A に x%、版 B に 100−x%」を指すと決めた。その具体を決める。

本家の振る舞い（2026-09-27 に確認）：

- 版はコード・アセット・バインディング・互換の設定を含む。ストレージの中身は含まない。デプロイは 1 つか 2 つの版を指す。一覧は直近 100（[Versions & deployments](https://developers.cloudflare.com/workers/versions-and-deployments/)）。
- 段階的なデプロイは、要求ごとに割合で独立に選ぶ。直近 100 の版から作れる（[Gradual deployments](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/)）。
- 版の鍵のヘッダーをハッシュして決定的に選ぶ。割合を上げても、新しい版に割り当てた鍵は残る（[Version affinity](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/version-affinity/)）。
- 版の上書きのヘッダー（RFC 8941 の辞書）は、いまのデプロイの版（0% を含む）だけに効く（[Version overrides](https://developers.cloudflare.com/workers/versions-and-deployments/version-overrides/)）。
- ロールバックは、選んだ版を 100% にする新しいデプロイ。バインディングの先が消えた場合などは戻せない（[Rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)）。
- `secret put` は新しい版を作ってすぐデプロイする（[Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)）。

## Options

1. **版は、コード・互換の設定・解決したバインディング・シークレットの値の参照を含む変えられないもの。デプロイは 1〜2 の版と万分率。版の鍵は `script_id` と鍵のハッシュで決め、新しい版を小さい側に置く**
2. シークレットを版に含めず、関数ごとの最新の値を常に使う
3. 割合を、要求ごとの乱数だけで決める（版の鍵を持たない）
4. 3 つ以上の版を同時に流せるようにする

## Decision

1 を採用する。

- 版は `script_versions` の行で、`bundle_sha256`、互換の日付とフラグ、解決した `bindings`（資源の名前でなく ID）、`secret_refs`（値そのものではなく、変えられない値の行の ID）、`limits` を持つ。作った後に変えない。
- デプロイは `deployments` の行で、1 つか 2 つの `(version_id, basis_points)`。割合は万分率（合計 10000）。いまのデプロイは関数ごとに最新の行。
- 版の選び方（入口のプロキシ）：
  1. `<Brand>-Version-Overrides` に、この関数の名前の鍵があり、値がいまのデプロイの版なら、その版。
  2. `<Brand>-Version-Key` があれば `bucket = SipHash-2-4(k_platform, script_id ‖ 0x00 ‖ key) mod 10000`。`bucket < 新しい版の割合` なら新しい版。
  3. なければ乱数の `bucket` で同じ判定。
- ハッシュにデプロイの ID を入れない。割合を上げても、新しい版に割り当てた鍵は動かない。
- ロールバックは、選んだ版を 100% にする新しいデプロイ（`reason = rollback`）。選んだ版が `purged`、バインディングの資源が消えた、Durable Objects のクラスの変更を挟む、シークレットの値が明示の削除で消えた場合は戻せない。
- シークレットの変更は、新しい値の行と、`secret_refs` を差し替えた新しい版を作る。既定の操作はすぐ 100% にする。
- 版は関数ごとに直近 100 と、いまのデプロイが指す版を残す。ノードには、いまのデプロイが指す版だけを配る。
- 2 を採らない理由：段階的なデプロイの間に、シークレットの変更が両方の版に同時に効き、「版を戻せば元に戻る」が成り立たない。本家とも違う。
- 3 を採らない理由：同じ利用者の要求が版の間を行き来し、アセットのハッシュの名前の食い違いなどの「版のずれ」の障害になる（本家もこのために版の鍵を持つ）。
- 4 を採らない理由：本家も 2 つまで。3 つ以上は、利用者が版のずれを考える組み合わせを増やす。

## Consequences

- 良くなること：
  - どの要求をどの版が処理したかが、記録の `version_id` で分かる。
  - 版を戻せば、コード・設定・シークレットが一緒に戻る。
  - 割合の変更は設定の変更（p99 10 秒）だけで、コードの再配布が要らない。
- 引き受けるコスト：
  - ロールバックで古いシークレットの値に戻る。漏れた鍵を無効にするには、利用者が値を明示に削除する必要がある。戻す前に画面で示す。
  - 版の上書きは誰でも送れるので、0% の版も外から呼べる。
  - ストレージの中身は戻らない（本家と同じ）。

## Confirmation

- 性質ベーステスト：任意の鍵と、新しい版の割合の増える列で、一度新しい版に割り当てた鍵は古い版に戻らない。割合 p のとき、鍵の分布の新しい版の割合が p に近い。
- 表駆動テスト：上書き（正しい・壊れた・デプロイにない版）、鍵あり・なし、1 版・2 版。ロールバックの可否の各条件。
- 結合テスト：シークレットの変更が新しい版を作り、古い版に戻すと古い値が見える。削除した値を参照する版へのロールバックが拒まれる。
