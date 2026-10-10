---
status: accepted
date: 2026-10-10
---

# ADR-0068: QoE の出来事は本システムの受け口にだけ送り、題・URL・IP・端末の固有の識別子を入れず、切り口は決めた種類の値だけにする。CDN のリアルタイムのログは IP・cookie・見出しの欄を選ばずパスのトークンを落とし、標準のログは 7 日で IP を落とす。自己監視は大阪の `selfmon` に置く

## Context

- プレイヤーとアプリが利用者の端末から情報を送らせることは、電気通信事業法の外部送信規律に関わる（**法務の確認待ち：L6**）。視聴の履歴と端末の識別子の扱いは L5。
- QoE の集計は、端末・ISP・CDN・地域の単位の数があれば足り、個人を特定する値は要らない。
- CloudFront のログは視聴者の IP、cookie、見出し、問い合わせの文字列、パスを含みうる。パスの頭にはエッジのトークン（[ADR-0025](0025-edge-token-signing-and-cache-keys.md)）が入る。リアルタイムのログは欄を選べる（[Use real-time access logs](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/real-time-logs.html)、2026-10-10 に確認）。
- 開示の請求の対象は投稿者で、視聴者の CDN のログの IP は要らないと見込む（判断は L10）。
- 自己監視は本番に依存せず、東京のリージョンの障害の間も動く必要がある（[runbooks/](../runbooks/README.md) の 5 節）。

## Options

1. **送り先を自社の受け口に限り、入れる項目と切り口を決めた一覧にする。CDN のログは欄を選び、IP を短く持つ。自己監視は大阪**
2. 第三者の解析の道具（RUM の SaaS）を使う
3. CDN のログを全欄で長く持つ（調べのため）

## Decision

1 を採用する。詳細は [observability.md](../architecture/observability.md) の 3・6・7 節。

- QoE の出来事の送り先は `event-collector` だけ。第三者の解析のタグを置かない。
- 入れない：題、説明、URL の全体（参照元を含む）、検索の語、IP、広告の識別子、端末の固有の識別子。入れてよい：再生のトークン（端末の識別子のハッシュを含む）、決めた切り口（`device_class`、`player_version`、`cdn`、`asn`、`pref`、`mode`、`codec`）、QoE の数。QoE の集計に端末の識別子を入れない。QoE のための追加の送信を作らず、心拍に載せる。
- CDN のリアルタイムのログは、`c-ip`・`x-forwarded-for`・`cs-cookie`・`cs-headers`・`cs-user-agent`・`cs-referer`・`cs-uri-query` を選ばない。`cs-uri-stem` のトークンは、読んだ直後に `sig` の先頭 16 文字と `kid` だけにする。Kinesis の保持は 24 時間。
- 標準のログは全数を log-archive に置き、7 日の後に IP を落とした形に書き換える（13 か月）。
- 自己監視（AMP、CloudWatch、Grafana、`canary` の制御）は大阪の `selfmon` のアカウント。本番からは自己の計測（ID と数と理由のコード）だけが入る。見張りは、東京・大阪の EC2 と、固定回線 3・携帯 3 の拠点の見張りの端末。
- 計測の送信を止める設定を持つか、外部送信の通知・公表の文言は L6・L5 の結論で決める。どちらでも再生は止めない。

### 他の案を選ばなかった理由

- **2（第三者の RUM）**：視聴の行動が第三者へ渡り、外部送信と第三者への提供の論点が増える。ABR とおすすめの判断に使う値を自社で持てない。
- **3（全欄を長く）**：視聴者の IP を長く持つ理由がなく、漏れたときの被害が大きい。

## Consequences

- 良くなること：
  - 法務の結論がどちらでも、送る項目の一覧の差し替えで対応できる。
  - 漏れても個人を特定しにくい形で計測を持つ。
  - 東京の障害の間も警報が動く。
- 引き受けるコスト：
  - IP のない CDN のログでは、個別の視聴者の不具合を追えない（ASN と国までで調べる）。
  - 見張りの端末を拠点に置いて保守する。

## Confirmation

- PROP-OBS-002（`cdn-log-aggregator` の出力にトークンの全体・IP・問い合わせの文字列がない）。
- 出来事の封筒の欄の一覧の試験（決めた欄の外を受け口が捨てる）。
- 東京の本番を止めた staging で、大阪の自己監視が警報を出す（[observability.md](../architecture/observability.md) の 12 節）。
