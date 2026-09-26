---
status: accepted
date: 2026-09-27
---

# ADR-0048: 拡張のトリガーは同期 3 つと非同期 2 つから始め、同期は全体 10 秒、基盤の障害はテナントが拒否か飛ばすかを選ぶ

詳細は [extensibility.md](../architecture/extensibility.md) の 4・7 節。MVP の後（E13）。

## Context

テナントは、ログインの後にクレームを足す、条件でアクセスを拒否する、M2M のトークンにクレームを足す、サインアップを拒否する、といった拡張を求める。本家は Actions で、`post-login`・`credentials-exchange`・`pre-user-registration` などのトリガーを持ち、1 回のトリガーの実行を 20 秒に限る（[Explore Triggers](https://auth0.com/docs/customize/actions/explore-triggers)、[Actions Limitations](https://auth0.com/docs/customize/actions/limitations)、2026-09-27 に確認）。

テナントのコードを認証の経路で同期に動かすことは、認証の経路に同期の依存を足すことである。AGENTS.md は、足すときに [ADR-0005](0005-authentication-path-availability.md) の縮退の表を先に更新することを求める。

## Options

1. **同期の `post-login`・`credentials-exchange`・`pre-user-registration` と、非同期の登録の後・パスワードの変更の後から始める。同期は全体 10 秒。テナントのコードの失敗は拒否。基盤の障害は、トリガーごとにテナントが `deny`・`skip` を選ぶ**
2. 本家のトリガーをすべて、本家と同じ 20 秒で
3. 非同期（Webhook の通知）だけにし、認証の経路で同期にテナントのコードを動かさない

## Decision

1 を採用する。

- トリガーの全体（並んだ Action のすべて）を 1 回の呼び出しにする。
- 同期の時限は全体で 10 秒（本家 20 秒）。非同期は 20 秒、再試行 3 回。
- テナントのコードの例外と時間切れは、その要求を失敗にする（本家と同じ）。
- 基盤の障害（スロットリング、5xx、到達不能）は、トリガーの設定 `on_platform_error`（既定 `deny`）に従う。
- テナントのコードは変更の指示（`commands`）を返し、Auth が検証して適用する。予約のクレームを変えられない。
- **E13 の spec の承認の前に、ADR-0005 の縮退の表に「Actions の実行の基盤」の行を足す**（行の案は extensibility.md の 7 節。2026-09-27 に足した。E13 の PoC の結果でレビューを受ける）。
- Action の時間は NFR-002 の計測から除き、別に計る。
- 2 は、ログインの画面で 20 秒待たせることと、使われ方が見えないトリガーの保守を、最初から抱える。
- 3 は、クレームの付け足しとアクセスの拒否ができず、Actions を使う本家の利用者の主な需要を満たさない。

## Consequences

- 良くなること：
  - 主な需要（クレーム、拒否、サインアップの検査）を満たしつつ、トリガーの数を絞って保守の面を小さくする。
  - 基盤の障害のときの振る舞いを、テナントが自分のリスクで選べる。
- 引き受けるコスト：
  - 本家の 20 秒に頼る Action は、移行で時間切れになりうる。
  - `skip` を選んだテナントは、障害の間、Action の判定なしでログインが通る。ダッシュボードで警告する。
  - Action を使うテナントの可用性は、実行の基盤の可用性に依る。

## Confirmation

- 表駆動テスト：失敗の種類 × 同期・非同期 × `on_platform_error` の結果。
- 結合テスト：10 秒の時間切れでログインがエラーの画面になり、`actions_execution_failed` が出る。
- 障害の注入：実行の基盤を遮断し、`deny`・`skip`・Action なしのテナントの振る舞いを確かめる。
- レビュー：E13 の spec の承認の前に、ADR-0005 の表の更新がレビューを通っている。
