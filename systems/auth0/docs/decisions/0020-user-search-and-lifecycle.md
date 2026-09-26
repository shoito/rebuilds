---
status: accepted
date: 2026-09-27
---

# ADR-0020: ユーザーの検索は Aurora の reader の上の限られた言語で行う。ブロックと削除は状態機械で扱い、削除した ID を墓標で守る

## Context

テナントの管理者は、ダッシュボードと Management API でユーザーを探し、ブロックし、削除する。大きなテナントは数百万のユーザーを持つ。

本家 Auth0 の検索は、Lucene の問い合わせの文字列を受け、結果は最大 1,000 件、結果整合で、2 秒で時限切れ（503）になる。認証の処理やリンクに検索を使わないよう求めている（[User Search Best Practices](https://auth0.com/docs/manage-users/user-search/user-search-best-practices)、2026-09-27 に確認）。

本システムの S1 の構成は Aurora だけで、専用の検索の基盤を持たない（[architecture/README.md](../architecture/README.md) の 2 節）。管理の経路の負荷を、ログインに及ぼさない（[ADR-0005](0005-authentication-path-availability.md)）。

## Options

検索：

1. **Aurora の reader の上で、索引で答えられる限られた問い合わせの言語（AND・完全一致・前方一致・範囲）を提供する**
2. OpenSearch などの専用の検索の基盤に outbox から写し、Lucene の構文を提供する
3. 任意の SQL に近い絞り込み（OR、否定、中間一致）を reader の上で許す

削除：

- a. **[ADR-0055](0055-data-retention-and-deletion.md) の削除（資格情報を即時に物理削除し、ユーザーの行は 30 日の墓石の後に消す）に加え、`user_id` の HMAC を別の表に残し続け、再利用を拒む**
- b. ADR-0055 の削除だけにする（墓石が消えた後は、同じ `user_id` をインポートで再び使える）

## Decision

1 と a を採用する。

- 検索は、管理の経路の DB の接続プールで reader に問い合わせる。1 ページ最大 100 件、総数 1,000 件、2 秒の時限。
- メタデータの検索はスカラーの完全一致だけ。並べ替えはしない。
- ユーザーの `status` は `active`・`blocked`・`deleted`（墓石）。ブロックはすべての接続のログイン・SSO・リフレッシュを止め、セッションとリフレッシュトークンを失効させる。
- 削除は 1 つのトランザクションで資格情報・ID・セッションを物理削除し、ユーザーの行を墓石にし、`user_tombstones` に HMAC を入れ、outbox から `user.deleted` を出す。墓石は 30 日で消す（ADR-0055）。`user_tombstones` は消さない。
- 2 は S1 で基盤と同期の遅れの運用が増える。S2 で検索の負荷を測って再評価する。
- 3 は、大きなテナントの問い合わせが reader を占有し、ログインの読み込みを遅らせる。
- b は、インポートで `user_id` を指定できる（[ADR-0018](0018-user-identifier-and-profile-store.md)）ため、30 日の後に同じ `sub` が別の人に割り当てられうる。OIDC Core の再割り当ての禁止に反する。

## Consequences

- 良くなること：
  - 検索の費用の上限が読める。認証の経路に影響しない。
  - 資格情報が即時に消え、個人データは 30 日（バックアップは 35 日）で消える。`sub` の再利用が起きない。
- 引き受けるコスト：
  - 本家の Lucene の問い合わせを使っていた管理のスクリプトは、書き直しが要る。
  - OR や中間一致の検索が要る管理者は、エクスポートを使う必要がある。
  - 認証のログには、削除の後も `user_id` と IP が保持の期間まで残る（法務の L7 で確かめる）。

## Confirmation

- 性質ベーステスト：構文解析に成功した任意の問い合わせが、索引を使う SQL になる。失敗したものは SQL に届かない。
- 負荷試験（E12）：100 万ユーザーのテナントで、代表の問い合わせの p99 が 2 秒以内。
- 結合テスト：削除の後、その `user_id` での作成とインポートが失敗する。ブロックの直後にリフレッシュが `invalid_grant` になる。

## References

- 設計の詳細：[users-and-profiles.md](../architecture/users-and-profiles.md) の 6・7 節
