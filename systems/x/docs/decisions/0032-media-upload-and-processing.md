---
status: accepted
date: 2026-10-04
---

# ADR-0032: メディアはクライアントから S3 へ分割で直接上げ、検査とハッシュの照合を通るまで公開しない。画像は位置の情報を消して決まったバージョンに、動画は MediaConvert で HLS にする

詳細は [media.md](../architecture/media.md) の 4〜6 節。

## Context

- 投稿の API は p99 300ms（NFR-001）で、メディアの変換を待てない。画像は完了から投稿に使えるまで p95 3 秒、1 分の動画は p95 60 秒で変換する（NFR-013）。
- 動画は 1 本で数 GB になりうる。App API のタスクに本体を通すと、帯域と記憶を食い、瞬間のピークで投稿の経路を巻き込む。
- スマートフォンの写真は EXIF に撮影の位置（GPS）を持つ。そのまま配ると、利用者の住まいが分かる。
- 既知の違法なメディアを、一度でも公開の CDN に載せてはいけない（[ADR-0034](0034-media-hash-matching.md)）。
- 本家は INIT・APPEND・FINALIZE の分割のアップロードを持つ（[Media upload](https://docs.x.com/x-api/media/introduction)、2026-10-04 に確認）。

## Options

アップロード：

1. **S3 の署名付きの URL へ、クライアントが 8 MiB の分割で直接上げる。サーバーは開始と完了だけを受ける**
2. App API が本体を受けて S3 へ書く（本家の APPEND に近い形）

公開の条件：

- a. **形式の検査とハッシュの照合を通ってから変換し、`ready` にする**
- b. 先に公開し、後で検査する

## Decision

1 と a を採用する。

- 開始（`POST /media/uploads`）で `media_id`（`tid`）と、部分ごとの署名付きの URL（15 分）を返す。完了（`/complete`）で S3 の分割を閉じ、SQS の仕事を作る。
- 状態は `initiated → uploaded → scanning → processing → ready → attached`。`blocked`・`failed`・`expired`・`withheld`・`purged` を持つ。`ready` でないメディアは投稿・DM に付けられない。`state_version` を上げる規則は投稿と同じ（[ADR-0009](0009-post-state-tombstones-and-state-cache.md)）。
- 検査：先頭のバイトで形式を確かめる。画像は一辺 8,192・4,000 万ピクセルまで（展開の爆弾）。
- 画像：`sharp` で向きを当てた後、EXIF・XMP・IPTC を全部消す。`orig`（4,096）・`large`（2,048）・`medium`（1,200）・`small`（680）・`thumb`（150）の JPEG と WebP。GIF は繰り返しの MP4。BlurHash と PDQ を作る。
- 動画：MediaConvert で HLS（fMP4、6 秒の区切り）の 240p〜1080p の 5 段と、720p の MP4。照合のためのフレームを 2 秒ごとに書き出す。
- 1 つのメディアは 1 つの投稿か DM にだけ付ける。
- 2 を採らない理由：本体が App API を通り、投稿の経路と資源を取り合う。再開できる分割の扱いを自前で持つことになる。形（開始・部分・完了）は本家に寄せたまま、本体の道だけを変える。
- b を採らない理由：既知の違法なメディアが CDN に載り、端末と途中のキャッシュに残る。

## Consequences

- 良くなること：
  - App API が本体を通さず、大きな動画でも投稿の経路が影響を受けない。
  - 配る画像に位置の情報が残らない。
  - 照合を通らないメディアは公開されない。
- 引き受けるコスト：
  - クライアントが S3 と直接やりとりする。署名の期限、部分の取り直しをクライアントで扱う。
  - 照合の提供者の障害で、公開のメディアの処理が止まる。
  - バージョンの数だけ保存が増える（画像 1 枚で 10 ファイル）。

## Confirmation

- 性質ベーステスト：PROP-MEDIA-001（`ready` でないメディアは付かない、照合を通らないものは `ready` にならない）、PROP-MEDIA-002（位置の情報が残らない）。
- 結合テスト：展開の爆弾、偽の拡張子、壊れた動画を `failed` にする。
- 計測：画像 p95 3 秒、1 分の動画 p95 60 秒（NFR-013）。
