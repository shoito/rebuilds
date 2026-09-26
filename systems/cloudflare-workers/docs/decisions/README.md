# Decisions: Cloudflare Workers

Cloudflare Workers の再構築に関する決定。リポジトリ共通の決定は [docs/decisions/](../../../../docs/decisions/README.md) にある（本家の名前・接頭辞を使わない規則は、その ADR-0006）。領域ごとの設計と、各領域に割り当てた ADR の番号の範囲は [architecture/](../architecture/README.md) の 7 節を見る。

<!-- adr-index:start -->
| ADR | 決定 | 状態 |
| --- | --- | --- |
| [0001](0001-runtime-build-vs-reuse.md) | エッジのランタイムは workerd を元にし、多数のテナントの層は Rust で作る | proposed |
| [0002](0002-isolation-model.md) | 多数のテナントの V8 isolate を共有のプロセスで動かし、多層の防御を重ねる | proposed |
| [0003](0003-edge-locations.md) | S1・S2 は AWS のリージョンのエッジのノードを anycast の IP の後ろに置き、S3 で自前の PoP に移る | proposed |
| [0004](0004-config-and-code-distribution.md) | 設定とコードは、順序付きの変更のログを全ノードの読み込み用の写しへ押し出して配る | proposed |
| [0005](0005-storage-consistency.md) | ストレージの一貫性は製品ごとに決め、利用者に明示する | proposed |
<!-- adr-index:end -->

この一覧は、各 ADR の frontmatter と見出しから生成したもの。ADR を追加・更新したら生成し直す。
