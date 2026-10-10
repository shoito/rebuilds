# Decisions: Gmail

Gmail の再構築に関する決定。リポジトリ共通の決定は [docs/decisions/](../../../../docs/decisions/README.md) にある（本家の名前・接頭辞を使わない規則は、その ADR-0006。本家の実装を核に使わない規則は、その ADR-0007）。領域ごとの設計と、領域ごとの ADR の番号の範囲は [architecture/](../architecture/README.md) の 7 節を見る。

<!-- adr-index:start -->
| ADR | 決定 | 状態 |
| --- | --- | --- |
| [0001](0001-platform-and-stack.md) | 管理の面は共通の基盤（TypeScript・Hono、Aurora、Fargate）を引き継ぎ、MTA・選別・保存・検索・IMAP は Rust で書く。メールの送受信に SES を使わず、BYOIP の IP を持つ自前の MTA を EC2 で動かす。汎用の部品は一覧の範囲で使う | accepted |
| [0002](0002-accept-then-filter.md) | SMTP の時点では、接続の評判・宛先・容量・認証の失敗・既知のマルウェアのような安く確かなものだけを拒む。中身の選別は、スプールと待ち行列に確定して 250 を返した後に行い、迷惑メールの箱か隔離に入れる。受け付けた後に迷惑メールを送り返さない。グレーリストは使わない | accepted |
| [0003](0003-message-storage-layout-and-dedupe.md) | 生のメッセージを不変の blob として S3 に置き、状態はメタデータに置く。blob は同じ配送の受け手の間でだけ共有し、受け手ごとのヘッダーは別に持つ。zstd のフレームで圧縮し、blob ごとのデータの鍵で暗号化する。小さな blob は 1 日後にパックへ詰め直す。消去は鍵の破棄と参照の数え | accepted |
| [0004](0004-labels-as-primary-mailbox-model.md) | メールボックスのモデルはラベルを正とする。メッセージは複数のラベルを持ち、受信箱・送信済み・下書き・迷惑メール・ゴミ箱もシステムのラベルにする。迷惑メールとゴミ箱は他のラベルと排他にする。フォルダーは見せ方で、IMAP ではラベルを箱として見せる | accepted |
| [0005](0005-threading-algorithm.md) | スレッドはアカウントごとに作る。`References`・`In-Reply-To` の Message-ID のつながり（届いていない親を仮の節にした素集合）と、正規化した件名の一致で合わせる。参照のないメールは同じ差出人・同じ件名・7 日の中で合わせる。100 通で新しいスレッドにする。合わせはあるが、自動で分けない | accepted |
| [0006](0006-sync-protocol-jmap-imap-and-modseq.md) | Web・アプリ・第三者の API は JMAP（RFC 8620・8621）に本システムの拡張を足して使い、既存のアプリには IMAP4rev2（CONDSTORE・QRESYNC）を出す。独自の同期の API は作らない。両方を、アカウントごとの `modseq` と change log の上に作る | accepted |
| [0007](0007-tenancy-accounts-orgs-and-rls.md) | テナントは組織、個人のアカウントは 1 人の個人のテナントとする。メールボックスの表はアカウントの単位で Aurora のシャードに置き、`tenant_id`・`account_id` で FORCE RLS にする。配送は受け手の文脈で書く。テナントをまたぐ経路は一覧にして専用のロールを通す | accepted |
| [0008](0008-spam-pipeline-boundary-and-secrecy.md) | 選別のパイプラインは、接続の情報・中身から作った特徴・中身そのものを分け、中身そのものは選別の処理の中だけで機械が読む。人が中身を見るのは同意のある報告だけ。学習は特徴と同意のある報告で行う。選別は利用者の同意の仕組みの上で既定で有効にし、範囲と変え方を示す（法務の L1 の結論で調整する） | accepted |
| [0009](0009-search-index-design.md) | 検索の索引は自前で、アカウントごとの不変のセグメント（日本語は 2-gram、英語は語、NFKC と大文字小文字の畳み込み）を S3 に置き、`search-node` がアカウントの範囲を受け持って NVMe にキャッシュする。変わる状態（ラベル、既読）は索引に入れず、change log から追う状態のビットマップで当てる | accepted |
<!-- adr-index:end -->

この一覧は、各 ADR の frontmatter と見出しから生成したもの。ADR を追加・更新したら生成し直す。
