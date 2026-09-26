---
status: accepted
date: 2026-09-27
---

# ADR-0028: ログアウトは RP-Initiated と Back-Channel を出し、Back-Channel は Worker が再試行ごとにトークンを作り直して送る

詳細は [sessions-and-sso.md](../architecture/sessions-and-sso.md) の 6 節。

## Context

[intent.md](../intent.md) は、RP-Initiated Logout と Back-Channel Logout を MVP に含め、OpenID Certification の両方のプロファイルに合格することを求める（K2）。

- OIDC のログアウトの仕様は 4 つある。RP-Initiated Logout、Back-Channel Logout、Front-Channel Logout、Session Management。後の 2 つは、別サイトの iframe とサードパーティの Cookie に頼る。
- 本家 Auth0 は、`/oidc/logout` で `id_token_hint`・`logout_hint`・`post_logout_redirect_uri`・`client_id`・`state`・`ui_locales`・`federated` を受け、ヒントがないときに確認の画面を出す（止める設定がある）。ログアウトの URL にワイルドカードを許す（[Log Users Out of Auth0](https://auth0.com/docs/authenticate/login/logout/log-users-out-of-auth0)、2026-09-27 に確認）。
- 本家の Back-Channel Logout は非同期の待ち行列から送る。受け手の例は、トークンの古さの上限を 2 分にしている。再試行の回数は資料にない（[OIDC Back-Channel Logout](https://auth0.com/docs/authenticate/login/logout/back-channel-logout)、2026-09-27 に確認）。
- Signer は Auth のタスクからの要求だけを受ける（[ADR-0059](0059-signer-isolation.md)）。
- Back-Channel Logout の送り先はテナントが登録する URL で、SSRF の入口になりうる。

## Options

送る仕組み：

1. **ログアウトの操作で outbox に事象を入れ、Worker が送る。トークンは送るたびに、Auth の内部の API を通して Signer で作る**
2. ログアウトの要求の中で、Auth が同期で送る
3. ログアウトの時に作ったトークンを outbox に入れ、Worker がそのまま送り直す

出す仕様：

- a. **RP-Initiated と Back-Channel だけ**
- b. 4 つすべて

## Decision

1 と a を採用する。

- `/oidc/logout`：GET と POST。`post_logout_redirect_uri` は、`id_token_hint` か `client_id` でアプリを決められたときだけ、登録と完全一致で使う（ワイルドカードなし）。ヒントがない・合わないときは確認の画面を出し、止める設定は持たない（RP-Initiated Logout 1.0 は、`id_token_hint` がないか不正なときの確認を MUST にしている。[RP-Initiated Logout 1.0](https://openid.net/specs/openid-connect-rpinitiated-1_0.html)、2026-09-27 に確認）。ヒントの `sid` のセッションが別のブラウザにあっても終えない。`federated` は MVP では無視する。
- ログアウトの処理は、セッションの終了、結び付いたリフレッシュトークンの系列の失効、outbox への `session.ended` を 1 つのトランザクションで行う。書けなければ Cookie を消さずに再試行を促す。
- ログアウトトークン：`typ: logout+jwt`、`iss`・`aud`・`iat`・`exp`（`iat` の 120 秒後）・`jti`・`sub`・`sid`・`events`。`nonce` なし。
- Worker は、Auth の内部の API（相互 TLS）にトークンを求める。内部の API は、セッションが `ended` で、そのアプリが `session_clients` にあるときだけ作る。再試行のたびに新しいトークンにする。
- 送り方：接続 2 秒・全体 5 秒。2xx で成功。400 などの 4xx は再試行しない。接続の失敗・429・5xx は 10 秒、60 秒、5 分、30 分で再試行し、その後は諦めてログに残す。リダイレクトを追わない。テナントごとの並行は 50 件まで。
- `backchannel_logout_uri` は `https` だけ。送るときに解決したアドレスが私的なアドレスなら送らない。外への送信は専用の出口を通す。
- 期限の経過では送らない。ログアウト、取り消し、ユーザーのブロック・削除、別の利用者のログイン、結び付いた系列の再利用の検知で送る。
- 2 は、RP の遅さや障害がログアウトの応答を遅くし、多くのアプリへの送信で時間の予算を超える。
- 3 は、再試行のトークンが受け手の古さの上限（2 分）で拒否される。
- b は、主要なブラウザのサードパーティの Cookie の制限で動かない場合が多く、iframe を許すための CSP の緩和も要る。

## Consequences

- 良くなること：
  - ログアウトの応答が、RP の数と状態に左右されない。
  - Worker が乗っ取られても、生きたセッションのログアウトトークンは作れない。
- 引き受けるコスト：
  - Worker から Auth の内部の API への依存が増える。
  - 本家で確認の画面を止めていたテナントは、`id_token_hint` を送るようアプリを変える必要がある。
  - RP が 36 分より長く落ちると、そのアプリにはログアウトが届かない。

## Confirmation

- 適合試験：RP-Initiated Logout OP と Back-Channel Logout OP のプロファイル。
- 表駆動テスト：[sessions-and-sso.md](../architecture/sessions-and-sso.md) の 6.1 節・6.2 節・6.3 節の各行。
- 性質ベーステスト：任意のログアウトで、対象のアプリに少なくとも 1 回の送信の試行がある。任意のログアウトトークンが `nonce` を持たず、`sub`・`sid`・`events` を持つ。
- 結合テスト：私的なアドレスに解決される URL に送らない。`active` のセッションについて内部の API がトークンを作らない。
