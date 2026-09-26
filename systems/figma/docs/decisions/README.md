# Decisions: Figma

Figma の再構築に関する決定。リポジトリ共通の決定は [docs/decisions/](../../../../docs/decisions/README.md) にある。

<!-- adr-index:start -->
| ADR | 決定 | 状態 |
| --- | --- | --- |
| [0001](0001-platform-and-stack.md) | 基盤は他の題材を引き継ぎ、エンジンとマルチプレイヤーのサーバーは Rust で書く | proposed |
| [0002](0002-central-authoritative-multiplayer.md) | 同時編集は、ファイルごとの中央のサーバーが順序を決める。プロパティ単位の LWW、分数インデックス、循環の拒否 | proposed |
| [0003](0003-journal-and-checkpoints.md) | ファイルはメモリに持ち、確定の前にジャーナルへ書き、定期的に S3 へチェックポイントを書く | proposed |
| [0004](0004-gpu-rendering-in-wasm.md) | 描画は WASM の中の自前のエンジンで、WebGL2 を必須、WebGPU を使えるときに使う | proposed |
| [0005](0005-tenancy-and-document-routing.md) | メタデータは共有スキーマと FORCE RLS で組織を分け、ファイルは Router のリースで Document Server へ振り分ける | proposed |
<!-- adr-index:end -->

この一覧は、各 ADR の frontmatter と見出しから生成したもの。ADR を追加・更新したら生成し直す。
