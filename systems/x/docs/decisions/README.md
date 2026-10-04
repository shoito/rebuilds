# Decisions: X

X の再構築に関する決定。リポジトリ共通の決定は [docs/decisions/](../../../../docs/decisions/README.md) にある（本家の名前・接頭辞を使わない規則は、その ADR-0006。本家の実装を核に使わない規則は、その ADR-0007）。領域ごとの設計と、領域ごとの ADR の番号の範囲は [architecture/](../architecture/README.md) の 7 節を見る。

<!-- adr-index:start -->
| ADR | 決定 | 状態 |
| --- | --- | --- |
| [0001](0001-platform-and-stack.md) | 共通の基盤を引き継ぎ、タイムライン・推薦・カウンター・検索の核を自前で作る。アプリは React Native、学習だけ Python | accepted |
| [0002](0002-post-ids-and-ordering.md) | 投稿・利用者・DM のメッセージに、時刻の順に並ぶ 64 ビットの `tid` を振る | accepted |
| [0003](0003-timeline-fanout-hybrid.md) | ホームのタイムラインは、フォロワーの少ない作者はプッシュ、多い作者はプルで作る | accepted |
| [0004](0004-single-tenant-and-visibility.md) | テナントは 1 つ。本人だけの表に FORCE RLS をかけ、公開の表の見える範囲は 1 つの関数 `visible()` で読み出しの時に決める | accepted |
| [0005](0005-event-log-and-outbox.md) | 確定した変更は outbox から Kinesis Data Streams の出来事のログへ流す。閲覧の数だけは Aurora を通さない | accepted |
| [0006](0006-ranking-boundary.md) | おすすめは自前の段のパイプラインにし、ML はスコアと取り出しだけに使う。安全と法令の判定を上書きしない | accepted |
| [0007](0007-follow-graph-storage.md) | フォローの関係は、向きの違う 2 つの隣接の表を正本にし、同じトランザクションで書く。グラフ DB を使わない | accepted |
<!-- adr-index:end -->

この一覧は、各 ADR の frontmatter と見出しから生成したもの。ADR を追加・更新したら生成し直す。
