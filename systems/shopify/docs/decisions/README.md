# Decisions: Shopify

Shopify の再構築に関する決定。リポジトリ共通の決定は [docs/decisions/](../../../../docs/decisions/README.md) にある（本家の名前・接頭辞を使わない規則は、その ADR-0006。本家の実装を核に使わない規則は、その ADR-0007）。領域ごとの設計と、領域ごとの ADR の番号の範囲は [architecture/](../architecture/README.md) の 7 節を見る。

<!-- adr-index:start -->
| ADR | 決定 | 状態 |
| --- | --- | --- |
| [0001](0001-platform-and-stack.md) | 共通の基盤（TypeScript・Hono、Aurora、Fargate、Valkey、SQS・SNS）を引き継ぎ、ドメインごとのパッケージを持つ 1 つのコードベースを入口ごとのサービスで出す。関数の砂場のホストだけ Rust で書く。検索は OpenSearch、GraphQL の構文解析は graphql-js を汎用の部品として使う | accepted |
| [0002](0002-pods-and-shop-placement.md) | ショップを単位に、Aurora・Valkey・SQS・アプリのサービスを持つポッド（完全なセル）へ置く。エッジが KeyValueStore でショップ → ポッドを引く。ショップの移し替えは、コピー・論理デコードでの追いかけ・10 秒以内の書き込みの停止・ディレクトリの切り替えで行う | accepted |
| [0003](0003-tenancy-and-rls.md) | ショップをテナントにし、ポッドの DB の全表に `shop_id` と FORCE RLS を置く。`shop_id` はホスト名・トークン・セッションからだけ決める。ポッドの中で、ショップごとの同時実行と速さの上限を置く | accepted |
| [0004](0004-inventory-reservation-model.md) | 在庫は拠点ごとの行を Aurora の正本にし、支払いの開始で期限つきの引き当て、注文の作成で確定にする。「売り越さない」品目は CHECK 制約で守る。熱い品目は在庫を複数の枠の行に分ける | accepted |
| [0005](0005-checkout-state-machine-and-exactly-once-orders.md) | チェックアウトを明示の状態の機械にし、注文の作成を `completeCheckout` の 1 つの関数とトランザクションに集める。`orders.checkout_id` を一意にし、決済だけ済んだ状態を 1 分ごとの照合で解消する | accepted |
| [0006](0006-payments-via-providers.md) | 決済は外部の提供者に任せ、本システムはカード番号に触れない。提供者の差を吸収するアダプターの契約、冪等キー、Webhook の inbox を持つ。Stripe の題材は提供者の 1 つとして使い、設計し直さない | accepted |
| [0007](0007-theme-language-design.md) | テーマの言語を自前で設計する（`{{ }}`・`{% %}` の形、副作用なし、既定で HTML をエスケープ、歩数・出力・ループ・入れ子・データの読み出しの上限）。中間表現に翻訳し、インタープリターで動かす。Liquid の実装は使わない | accepted |
| [0008](0008-extension-sandbox-wasm.md) | アプリの関数は WebAssembly のモジュールにし、`checkout` の隣の Rust のプロセスの Wasmtime で、燃料・メモリー・入出力の上限を付けて動かす。WASI の機能を渡さない。失敗は種類ごとの「効果なし」 | accepted |
| [0009](0009-admin-api-graphql-and-cost-limits.md) | Admin API は GraphQL だけにし、日付のバージョン（`YYYY-MM`、四半期）を持つ。クエリの費用を実行の前に計算し、アプリとショップの組ごとのリーキーバケット（Valkey）で絞る。重い読み出しは一括の操作（S3 の JSONL） | accepted |
<!-- adr-index:end -->

この一覧は、各 ADR の frontmatter と見出しから生成したもの。ADR を追加・更新したら生成し直す。
