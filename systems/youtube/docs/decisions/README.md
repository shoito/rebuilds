# Decisions: YouTube

YouTube の再構築に関する決定。リポジトリ共通の決定は [docs/decisions/](../../../../docs/decisions/README.md) にある（本家の名前・接頭辞を使わない規則は、その ADR-0006。本家の実装を核に使わない規則は、その ADR-0007）。領域ごとの設計と、領域ごとの ADR の番号の範囲は [architecture/](../architecture/README.md) の 7 節を見る。

<!-- adr-index:start -->
| ADR | 決定 | 状態 |
| --- | --- | --- |
| [0001](0001-platform-and-stack.md) | 管理の面は共通の基盤を引き継ぎ、メディアの面と視聴の計測は Rust で書く。メディアの面は ECS の EC2（CPU の Spot、GPU、NVMe）で動かし、視聴の出来事は MSK に流す | accepted |
| [0002](0002-upload-and-pipeline-orchestration.md) | アップロードは S3 のマルチパートの上の自前の再開できるセッションにし、全体のハッシュが合ってから完了を返す。パイプラインは自前の段の状態の機械で、段は冪等にし、元のファイルを保持する | accepted |
| [0003](0003-codecs-and-per-title-ladder.md) | H.264 を全動画に、AV1 を人気の動画にだけ作り、VP9 は作らない。ラダーは試しの符号化と VMAF で動画ごとに決める。VOD は CPU の Spot、ライブは GPU で符号化し、MediaConvert は使わない | accepted |
| [0004](0004-cmaf-packaging-and-drm-scope.md) | CMAF の fMP4 で 1 回だけ保存し、HLS と DASH のマニフェストを要求の時に作る。VOD のセグメントは 4 秒。DRM はメンバー限定の動画だけにし、CENC の `cbcs` で暗号化する | accepted |
| [0005](0005-cdn-and-origin-strategy.md) | S1 は CloudFront と Origin Shield と自前の中間のキャッシュで配り、S2 から複数の CDN と計測による振り分けを足す。セグメントは署名つきの URL で、措置は拒否の一覧で 60 秒以内に止める | accepted |
| [0006](0006-live-ingest-and-latency.md) | ライブの取り込みは RTMPS と SRT にし、GPU で H.264 のラダーに変換する。低遅延は LL-HLS（部分 0.5 秒、p95 6 秒）、通常は 2 秒のセグメント。DVR は 12 時間で、同じセグメントから VOD を作る | accepted |
| [0007](0007-two-phase-view-counting.md) | 視聴回数は、流れの中の仮の数と、Parquet のバッチで確かめる確定の数の 2 段で出す。検証の規則は 1 つのクレートに置く。公開の数は再生の開始で数え、収益はエンゲージ ビュー（30 秒）で数える | accepted |
| [0008](0008-fingerprinting-and-match-engine.md) | 指紋は自前で作る。音声は対数周波数の山の組のハッシュ、映像は 1 秒 2 枚のフレームの知覚ハッシュにし、転置の索引と時刻のずれの投票で照合する。照合の結果が出るまで動画を公開しない | accepted |
| [0009](0009-single-tenant-and-playable.md) | テナントは 1 つ。本人だけの表は FORCE RLS、チャンネル・権利者の管理の表は持ち主の RLS にする。動画の見える範囲は `playable(viewer, video, region)` の 1 つの関数で決める | accepted |
| [0010](0010-recommendation-boundary.md) | おすすめは自前の段のパイプラインにし、ML は候補の取り出しとスコアだけに使う。見える範囲・年齢・子ども向け・照合・措置の判定を上書きしない | accepted |
<!-- adr-index:end -->

この一覧は、各 ADR の frontmatter と見出しから生成したもの。ADR を追加・更新したら生成し直す。
