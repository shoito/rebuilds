# Decisions: Mercari

Mercari の再構築に関する決定。リポジトリ共通の決定は [docs/decisions/](../../../../docs/decisions/README.md) にある（本家の名前・接頭辞を使わない規則は、その ADR-0006。本家の実装を核に使わない規則は、その ADR-0007）。領域ごとの設計と、領域ごとの ADR の番号の範囲は [architecture/](../architecture/README.md) の 7 節を見る。

<!-- adr-index:start -->
| ADR | 決定 | 状態 |
| --- | --- | --- |
| [0001](0001-platform-and-stack.md) | 共通の基盤を引き継ぎ、ドメインごとのパッケージを持つ 1 つのコードベースを入口・Worker ごとのサービスで出す。Aurora は core・ledger・content の 3 クラスタにする。ML だけ Python で書く。検索は OpenSearch を汎用の部品として使う | accepted |
| [0002](0002-transaction-state-machine-and-single-purchase.md) | 取引を明示の状態の機械にし、購入を `purchaseListing` の 1 つの関数と 1 つのトランザクション（出品の条件つきの更新と、部分一意の索引）に集める。期限は DB の列と 1 分ごとの処理で動かし、紛争で止める | accepted |
| [0003](0003-escrow-and-double-entry-ledger.md) | お金の正本を、取引ごとの預かりの口座を持つ追記だけの複式簿記の台帳にする。release と refund を冪等キーと一意の制約で 1 回に限り、取引と台帳を 5 分ごと、台帳と提供者・銀行を日次で照合する | accepted |
| [0004](0004-proceeds-model-under-payment-services-act.md) | 売上金・残高・ポイントを別の口座の種類にし、期限・使い道・本人確認の要否・保全を `legal.*` の設定で決める。収納代行・資金移動業・前払式支払手段のどれに整理されても切り替えられる形にし、法務の L1 の結論まで本番の値を有効にしない | accepted |
| [0005](0005-payments-via-providers-and-capture-at-purchase.md) | 決済は外部の提供者に任せ、本システムはカード番号に触れない。カードは購入の時に売上を確定し、預かりは本システムの台帳で持つ。冪等キー、Webhook の inbox、照会で結果を確かめる。Stripe の題材は提供者の 1 つとして使い、設計し直さない | accepted |
| [0006](0006-shipping-orchestration-via-carriers.md) | 配送は運送会社の API を包むアダプターで扱い、匿名の配送の受け付け・QR・追跡・状態の Webhook を自前で指揮する。住所は `shipping` の金庫に封筒の暗号化で置き、相手に出さない。運送会社の事象は順位で前にだけ進める | accepted |
| [0007](0007-single-tenant-and-party-visibility.md) | テナントは 1 つ。本人だけの表は FORCE RLS、取引の表は買い手と売り手の 2 者の RLS にする。出品の見える範囲は `listingVisible(viewer, listing)` の 1 つの関数で決める。運用者は監査つきの JIT の権限で見る | accepted |
| [0008](0008-search-engine-and-index.md) | 検索は Amazon OpenSearch Service に、販売中と売れた品の出品を入れ、Sudachi の形態素と 2-gram の欄で日本語を引く。順位付けは自前の決めた式。索引は出品のバージョンを外部のバージョンにして順序を守る。保存した検索の照合は OpenSearch でなく自前の逆索引で行う | accepted |
| [0009](0009-trust-and-safety-pipeline-boundary.md) | T&S は、同期の検査・非同期の分類器・規則のエンジン・人の審査・措置の記録の段に分ける。分類器は点と理由のコードだけを出し、措置は規則と人が `moderation_actions` に書いてから効かせる。分類器は自前で学習し、評価の集まりで出す前に確かめる | accepted |
| [0010](0010-ml-boundary-for-pricing-and-recommendations.md) | 価格の提案とおすすめの ML は助言と順位だけにする。MVP の価格の提案は売れた品の統計、おすすめは規則にする。ML のモデルは MVP の後に、影の評価を通してから出す。出品の価格・手数料・見える範囲を ML で変えない | accepted |
<!-- adr-index:end -->

この一覧は、各 ADR の frontmatter と見出しから生成したもの。ADR を追加・更新したら生成し直す。
