---
status: accepted
date: 2026-10-04
---

# ADR-0033: 公開のメディアは推測できないキーの URL で 1 年キャッシュして配り、鍵アカウントと DM のメディアは署名付きの URL で配る。措置では CloudFront KeyValueStore の拒否の一覧で数秒で止め、元を隔離して無効にする

詳細は [media.md](../architecture/media.md) の 8 節。

## Context

[ADR-0004](0004-single-tenant-and-visibility.md) は、メディアを公開の CDN で配り、鍵アカウントのメディアは推測できない URL と短い期限の署名で配り、措置・削除のときは元の公開を止めて CDN を無効にすると決め、具体を media の領域に任せた。

- 措置・削除から 60 秒で配信を止める（NFR-009）。CloudFront の無効化だけでは、完了までの時間が公式に書かれていない（**未検証**）。利用者の端末や途中のキャッシュには古いものが残りうる（[Invalidate files](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/Invalidation.html)、2026-10-04 に確認）。
- 配信のヒットの率 95%（NFR-013）を求めるので、公開のメディアは長くキャッシュしたい。長いキャッシュは停止を難しくする。
- 全ての要求で DB を引くと（エッジから元へ毎回確かめると）、キャッシュが効かない。
- CloudFront KeyValueStore は、CloudFront Functions から読めるエッジのキーと値の保存で、更新は数秒で全エッジに広がる。1 つの保存は 5 MB まで、値は 1 KB まで（[KeyValueStore](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/kvs-with-functions.html)、[AWS のブログ](https://aws.amazon.com/blogs/aws/introducing-amazon-cloudfront-keyvaluestore-a-low-latency-datastore-for-cloudfront-functions/)、同日に確認）。

## Options

1. **公開は推測できないキーで 1 年キャッシュ。鍵・DM は別の道で署名付きの URL（15 分）。措置は KeyValueStore の拒否の一覧 → 元の隔離 → 無効化**
2. 全てのメディアを署名付きの URL で配る
3. 公開は短いキャッシュ（例：5 分）にして、措置は元の削除だけで止める
4. Lambda@Edge で要求ごとに DB（か写し）を引いて判定する

## Decision

1 を採用する。

- 公開のメディアは `/m/{media_key}/{variant}`。`media_key` は 128 ビットの乱数で、`tid` と別にする。`public, max-age=31536000, immutable`。Origin Shield を東京に置く。
- 鍵アカウントと DM のメディアは `/p/{media_key}/…` に置き、CloudFront の署名付きの URL（15 分）でだけ読める。App API が `visible()`（DM は参加者の確認）を通した閲覧者にだけ発行する。
- 措置・削除の停止は、Media Takedown worker が次の順で行う：(1) KeyValueStore に `m:{media_key}` を書く（ビューアーの要求の CloudFront Function が 404・451 を返す）、(2) 元を隔離の置き場へ移す、(3) `/m/{media_key}/*` を無効にする、(4) `media.state = withheld`、(5) 24 時間後に拒否を外す。60 秒は (1) で守る。
- 公開と鍵の切り替えは、`/m/` と `/p/` の間でキーを移す仕事にし、仕事の間は拒否の一覧で `/m/` を止める。
- 2 を採らない理由：URL が閲覧者ごと・期限ごとに変わり、公開の投稿のキャッシュが効かない。NFR-013 のヒットの率と費用が合わない。埋め込みや共有の URL が切れる。
- 3 を採らない理由：ヒットの率が下がり、元への要求が増える。5 分のキャッシュでは 60 秒を守れない。
- 4 を採らない理由：全ての要求にエッジから東京への往復が乗り、遅れと費用が大きい。判定の元が落ちると配信が止まる。

## Consequences

- 良くなること：
  - 公開のメディアは長くキャッシュでき、措置は数秒で止まる。
  - 鍵アカウントと DM のメディアは、渡った URL も 15 分で切れる。
  - 隔離した元で、異議の申立てと保全に応えられる。
- 引き受けるコスト：
  - KeyValueStore の容量（5 MB）に上限がある。拒否は 24 時間で外し、容量を監視する。鍵の切り替えの多い作者で足りなくなれば、作者ごとの前置きの形に替える（別の ADR）。
  - 利用者の端末に残ったキャッシュは消せない。アプリは `withheld` を受けたら端末から消す。
  - 署名の鍵の管理（[security.md](../architecture/security.md)）が要る。

## Confirmation

- 性質ベーステスト：PROP-MEDIA-003（`withheld` のメディアは拒否されているか隔離されている）、PROP-MEDIA-004（鍵・DM のメディアの応答に `/m/` の URL がない）。
- 合成監視：措置から CDN が 404・451 を返すまでの時間（NFR-009 の 60 秒）。
- 本番：KeyValueStore の使用量（80% でアラート）、無効化の完了までの時間、CDN のヒットの率。
