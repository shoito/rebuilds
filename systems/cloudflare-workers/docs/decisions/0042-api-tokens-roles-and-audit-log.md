---
status: accepted
date: 2026-09-27
---

# ADR-0042: API トークンは接頭辞とチェックサムの形でシークレットスキャンに載せ、ロールは 5 つに固定し、監査ログは変更と同じトランザクションで書く

詳細は [dashboard-and-api.md](../architecture/dashboard-and-api.md) の 5〜7 節。

## Context

CI からのデプロイは、長く生きる API トークンを使う。トークンは、公開のリポジトリや npm のパッケージに誤って載ることがある。リポジトリ共通の [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md) は、トークンの接頭辞を他のサービスと重ならない独自の形にし、GitHub のシークレットスキャンのパートナープログラムに登録すると決めた。

本家（2026-09-27 に確認）：

- トークンは種類ごとの接頭辞＋40 文字＋チェックサム。GitHub のシークレットスキャンで公開のリポジトリに見つかったら、自動で失効してメールで知らせる（[Token formats](https://developers.cloudflare.com/fundamentals/api/get-started/token-formats/)）。
- トークンは権限の群・資源・IP・有効期間で絞れ、利用者のトークンとアカウントのトークンがある（[Create API token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)）。ロールは 100 以上（[Roles](https://developers.cloudflare.com/fundamentals/manage-members/roles/)）。
- 監査ログは 18 か月持つ（[Audit logs](https://developers.cloudflare.com/fundamentals/account/account-security/review-audit-logs/)）。

GitHub のパートナーは、固有の接頭辞、高いエントロピー、32 ビットのチェックサムを勧められる。知らせは ECDSA P-256 / SHA-256 で署名される（[Secret scanning partner program](https://docs.github.com/en/code-security/secret-scanning/secret-scanning-partnership-program/secret-scanning-partner-program)）。

## Options

1. **`<brand>_<kind>_`＋40 文字の base62＋CRC32 の 6 文字。SHA-256 で持つ。効く権限はトークン・資源・いまのロールの積。ロールは 5 つに固定。監査ログは変更と同じトランザクション**
2. 接頭辞のない乱数のトークン（JWT などの自己完結の形を含む）
3. 本家に近い細かいロール（製品ごとの管理者・閲覧者）

## Decision

1 を採用する。

- 形：`<brand>_(ut|at|oa|or)_` ＋ 40 文字の base62（約 238 ビット）＋ CRC32 を base62 にした 6 文字。正規表現を GitHub に登録し、知らせの受け口で署名を確かめ、有効なトークンを即時に失効し、持ち主に知らせ、`true_positive`・`false_positive` を返す。
- 保存は SHA-256 だけ（高いエントロピーの乱数なので、遅いハッシュは要らない）。秘密は作成の時に 1 回だけ見せる。失効は 2 秒以内に全ての API のタスクに効かせる。
- スコープは権限の一覧（`scripts:write`・`logs:tail` など）と資源（アカウント全体か個別の資源）、任意の送り元の CIDR と有効期限。効く権限は、トークンの権限 ∩ 資源の範囲 ∩（利用者のトークンなら）いまのロール。
- ロールは `owner`・`admin`・`developer`・`viewer`・`billing` の 5 つ。`viewer` はログとストレージの中身を見られない（関数の利用者のデータを含むため）。利用者が作るロールは S2。
- 重要な操作（トークンの作成、ロールの変更、請求、削除）は、直近 10 分のステップアップの MFA を求める。
- 監査ログは、全ての変更の API と、ログイン、機微な閲覧（ログの検索、tail、KV の値の読み出し）、基盤の側の操作（停止、サポートの閲覧、シークレットスキャンの失効）を記録する。変更と同じトランザクションで書き、監査の行が書けなければ変更も失敗する。18 か月持つ。改ざんの検知と長期の保存は security の領域で決める。
- 2 を採らない理由：スキャンの道具が高い確度で見つけられず、漏れが放置される。自己完結の形は失効が効かない。
- 3 を採らない理由：S1 の製品の数と、小さなチームの利用者に対して、ロールの組み合わせが多すぎる。細かい絞り込みはトークンのスコープで足りる。

## Consequences

- 良くなること：
  - 公開の場所に漏れたトークンが、人の手を待たずに失効する。
  - メンバーを外すと、その人の利用者のトークンの権限も次の要求から消える。
  - 誰が何をしたかが、変更と必ず対になって残る。
- 引き受けるコスト：
  - `<brand>` の実際の値を決めたときに、接頭辞の衝突の確認と GitHub への登録の手続きが要る。
  - 誤った失効（公開の例に本物のトークンを貼った場合を含む）は元に戻さない。利用者が作り直す。
  - 監査の書き込みが変更のトランザクションに乗るので、監査の表の障害が変更を止める。

## Confirmation

- 性質ベーステスト：生成したトークンが正規表現とチェックサムに合い、1 文字の変更でチェックサムが合わない。任意のロール・スコープ・資源で、許可の判定が権限の積の定義と同じ。
- 結合テスト：正しい署名・誤った署名の知らせ、1 回に 1,000 件の知らせ、失効が 2 秒以内に効く。
- CI の検査：OpenAPI の全ての変更の API が監査の行を作る。全てのテナントの表に RLS がある。
