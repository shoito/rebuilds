---
status: accepted
date: 2026-09-27
---

# ADR-0018: ユーザーの ID は接続から独立した不透明な値にし、再利用しない。メタデータに固い上限を置く

## Context

ユーザーの ID は、ID トークンとアクセストークンの `sub` になる。テナントのアプリは、この値を自分の DB の外部キーにする。後から変えると、すべてのアプリのデータの付け替えが要る。

本家 Auth0 の振る舞い（2026-09-27 に確認）：

- `user_id` は、最初の ID の接続の種類と ID を `|` でつないだ形。リンクしても主の `user_id` のまま（[User Account Linking](https://auth0.com/docs/manage-users/user-accounts/user-account-linking)）。
- プロファイルは 10 KB まで。超える書き込みも今は成功するが、将来失敗しうる。`app_metadata` と `user_metadata` を合わせて 16 MB まで。検索で扱えるのは 1 ユーザー 1 MB まで（[Metadata Field Names and Data Types](https://auth0.com/docs/manage-users/user-accounts/metadata/metadata-fields-data)、[Support の記事](https://support.auth0.com/center/s/article/What-is-the-maximum-size-of-user-metadata-and-app-metadata-profiles)）。

OpenID Connect Core 1.0 は、`sub` を 255 文字以下の ASCII とし、発行者の中で再割り当てしないことを求めている（2 節）。

他の IdP から移る事業者は、既存の `sub` を保ちたい。

## Options

ID の形：

1. **接続から独立した不透明な値（`usr_` ＋ 128 ビットの乱数）。インポートでは指定を許す**
2. 本家と同じく、接続の種類と ID をつないだ値
3. 内部の主キー（UUIDv7）をそのまま出す

メタデータの上限：

- a. **それぞれ 16 KiB の固い上限。超えたら拒否する**
- b. 本家と同じく、緩い上限（10 KB）と大きな固い上限（16 MB）

## Decision

1 と a を採用する。

- `user_id` の既定は `usr_` と 22 文字の base62（128 ビットの乱数）。`sub` はこの値。
- 作成とインポートで `user_id` を指定できる。形は `^[A-Za-z0-9_\-|.:@]{1,255}$`。
- 削除した `user_id` は、テナントごとの鍵の HMAC を墓標（`user_tombstones`）に残し、同じ値での作成を拒否する。
- 内部の結合には UUIDv7 の主キーを使い、外に出さない。
- プロファイル（ルートの属性）、外部の ID（`user_identities`）、メタデータ（`user_metadata`・`app_metadata`）を分けて持つ。ルートの属性は主の ID から作る。
- `user_metadata`・`app_metadata` は、それぞれ直列化して 16 KiB まで。名前に `.`・`$` を使えない。入れ子は 10 段まで。`app_metadata` の予約の名前を拒否する。
- 2 は、接続の名前や種類の変更と `sub` が結び付き、本家の名前の形（接続の種類の名前）を識別子に持ち込む（リポジトリ共通の ADR-0006）。
- 3 は、作成の時刻が外に漏れ、移行で `sub` を保てない。
- b は、行の大きさと、検索の索引・トークンへの展開の費用が読めない。

## Consequences

- 良くなること：
  - 接続の変更・リンクで `sub` が変わらない。移行で既存の `sub` を保てる。
  - `sub` が別の人に再び割り当てられる事故がない。
  - 行の大きさの上限が決まり、検索と負荷の見積もりができる。
- 引き受けるコスト：
  - 本家からの移行では、アプリの側で本家の `user_id` を指定してインポートするか、対応表を持つ必要がある（指定すれば同じ値を使える）。
  - 大きなメタデータを使っていたテナントは、外部の保存先へ移す必要がある。
  - 墓標の表は削除とともに増え続ける（1 行 70 バイト程度）。

## Confirmation

- 性質ベーステスト：任意の作成・削除・インポートの列で、同じ `user_id` が 2 人に割り当てられない。
- 性質ベーステスト：任意のリンク・解除の列で、主のユーザーの `user_id` が変わらない。
- 結合テスト：16 KiB を 1 バイト超えるメタデータの書き込みが 400 になり、何も保存されない。
- レビュー：ID トークンの `sub` を作るコードが `users.user_id` 以外を読まないこと。

## References

- 設計の詳細：[users-and-profiles.md](../architecture/users-and-profiles.md) の 3・4 節
