---
status: accepted
date: 2026-09-28
---

# ADR-0035: セッションは HttpOnly のクッキーで、使わないまま 30 日で切れ、絶対の期限は置かない。ワークスペースへの入り口は同期のチケットで、発行の時にメンバーシップ・状態・ログインの制限を確かめる。取り消しと停止は Valkey で Gateway に知らせて 5 秒以内に切り、5 分ごとに確かめ直す。Electron はシステムのブラウザでログインし、PKCE の形でコードを交換する

## Context

クライアントは WebSocket で Gateway につなぎ、最初のメッセージで 60 秒・1 回限りのチケットを送る（[ADR-0009](0009-sync-gateway-protocol.md)）。チケットの発行は認証の領域に任されていた（sync-engine.md の Story の `sync-ticket`）。

決めることは次のとおり。

- セッションの期限。本家は使わないセッションを 30 日で切る（[Security & Access](https://linear.app/docs/security-and-access)、2026-09-28 に確認）。この題材のクライアントは、7 日のオフラインの後も outbox を送れる必要がある（NFR-004）。
- ワークスペースの入り口で何を確かめるか。アカウントのログインは全体で 1 つだが、ワークスペースごとにログインの手段の制限がある（本家は Business 以上。[Login methods](https://linear.app/docs/login-methods)、2026-09-28 に確認）。
- 長く続く WebSocket の接続に、セッションの取り消しとメンバーの停止をどう効かせるか。本家の停止は「すぐに全部のアクセスを失う」（[Members and roles](https://linear.app/docs/members-roles)、2026-09-28 に確認）。
- Electron でのログイン。本家のデスクトップはパスキーを使えない（Security & Access）。Google は埋め込みの WebView からの OAuth を拒む（[Google Developers Blog](https://developers.googleblog.com/upcoming-security-changes-to-googles-oauth-20-authorization-endpoint-in-embedded-webviews/)、2026-09-28 に確認）。

## Options

入り口の確認：

1. **チケットの発行の時に、`users` の行（メンバーか、状態）とワークスペースのログインの制限を確かめる**
2. ログインの時に、全ワークスペースの制限を確かめる
3. Gateway が接続のたびに確かめる

取り消しの効かせ方：

- a. **Valkey の知らせで即座に切り、5 分ごとにまとめて確かめ直す**
- b. 次の再接続まで待つ
- c. 接続ごとに短い期限を持たせ、切れる前に取り直させる

Electron のログイン：

- x. **システムのブラウザでログインし、ディープリンクで返した 1 回限りのコードを PKCE の形で交換する**
- y. Electron の窓の中でログインの画面を開く

## Decision

1・a・x を採用する。詳細は [accounts-and-auth.md](../architecture/accounts-and-auth.md) の 6 節。

- セッションのクッキーは HttpOnly・Secure・`SameSite=Lax`。状態を変える API は `Origin` を確かめる。使わないまま 30 日で切れる（`expiresIn` 30 日、`updateAge` 1 日）。絶対の期限は MVP では置かない。重い操作には 1 日以内のログインを求める。
- セッションが切れても手元の DB と outbox は消さない。ログインし直せば続けられる。
- `POST /sync/ticket` は DT-AUTH-002 で決める：セッションがない → `401`。`User` がない → `404`。停止 → `403 forbidden`（手元の DB を消す）。ログインの手段が制限を満たさない → `403 login_method_required`。それ以外 → チケット。セッションに `amr`（ログインの手段）を持つ。
  > 2026-09-28 の注記：最初の行に「セッションに `wipe_requested` がある → `401 wipe_required`（手元の DB を未送信を確かめずに消す）」を足した（[ADR-0046](0046-device-data-no-app-encryption-and-remote-wipe.md) の遠隔の消去。[accounts-and-auth.md](../architecture/accounts-and-auth.md) の 6.3 節）。ワークスペースが `pending_deletion` のときも停止と同じ `403 forbidden` にする。
- 取り消し・停止は Valkey の `auth:revoked`・`auth:member_removed` で Gateway に知らせ、該当の接続に `kick: session_revoked`・`kick: forbidden` を送る。目標は p99 5 秒。Gateway は 5 分ごとに、接続のセッションの有効をまとめて確かめる。
- ログアウトの既定は「この端末だけ」。全部の端末からのログアウトを別に置く。本家は全部を切るが、他の端末の未送信の outbox を送れなくしないため。
- Electron は、システムのブラウザでログインし、`challenge = SHA-256(verifier)` に結んだ 60 秒・1 回限りの `code` をディープリンクで受け、`verifier` と一緒に交換してセッションを得る（RFC 7636 の考え方）。
- 2 を採らない理由：ログインの後にワークスペースの制限が変わっても効かない。ログインの画面でワークスペースの制限を示すと、ワークスペースの有無が分かる。
- 3 を採らない理由：再接続の殺到のたびに、認証のサービスと DB に確認が集まる。チケットの発行で 1 回確かめれば足りる。
- b を採らない理由：本家の「すぐに失う」を満たせない。WebSocket は何日もつながりうる。
- c を採らない理由：全接続の取り直しの負荷が常にかかる。オフラインの後の再接続の流れが複雑になる。
- y を採らない理由：Google の OAuth が拒まれうる。ログインの画面の中身を Electron の窓で扱うと、資格情報の扱いの範囲が広がる。

## Consequences

- 良くなること：
  - 停止・取り消しが、長い接続にも数秒で効く。
  - ワークスペースのログインの制限が、入り口の 1 か所で強制される。
  - Electron でも、Google とパスキーでログインできる。
  - 長いオフラインの後も、ログインし直せば outbox を送れる。
- 引き受けるコスト：
  - 絶対の期限がないので、盗まれたセッションは使われ続ける限り有効。本人のセッションの一覧と取り消し、新しい端末のログインの知らせで抑える。Enterprise の設定で絶対の期限を足す。
  - Valkey の知らせを取りこぼすと、最大 5 分、取り消したセッションの接続が残る。
  - Electron のログインが、ブラウザとアプリを行き来する手順になる。

## Confirmation

- 表駆動テスト：DT-AUTH-002 の全行。
- 性質ベーステスト：PROP-AUTH-001（チケットの 1 回限り）、PROP-AUTH-002（入り口の一致）。
- 結合テスト：取り消し・停止から切断まで 5 秒以内。Valkey の知らせを落としても 5 分で切れる。
- E2E：Electron のログインの経路。
- 本番：取り消し・停止から切断までの p99、5 分の確かめで切った数。
