---
status: accepted
date: 2026-09-27
---

# ADR-0036: ローカル開発は同梱の下流の workerd で動かし、ストレージは同じ workerd の中の模擬で模す

詳細は [developer-tooling.md](../architecture/developer-tooling.md) の 6 節。

## Context

intent は「手元でも本番と同じランタイムで動かせる」ことを価値の 1 つにする。一方、本番には手元にないもの（CPU・メモリの強制、外向きのプロキシの宛先の制限、KV の古さ、Durable Objects の配置）がある。

本家の振る舞い（2026-09-27 に確認）：Miniflare が workerd で利用者のコードを動かし、バインディングは既定で手元で模擬する。`remote: true` でバインディングごとに本物の資源につなげる。Durable Objects・環境変数・シークレットなどは遠隔にできない（[Development & testing](https://developers.cloudflare.com/workers/development-testing/)）。本家の `dev --remote` は、コードごと本家の網で動かす（[Workers commands](https://developers.cloudflare.com/workers/wrangler/commands/workers/)）。

上流の公開版の workerd は制限を強制しない（`NullIsolateLimitEnforcer`。[runtime-and-isolates.md](../architecture/runtime-and-isolates.md) の 2 節）。下流のビルドには、制限の強制のパッチがある（[ADR-0009](0009-cpu-and-memory-metering.md)）。

## Options

1. **同梱の下流の workerd で動かし、模擬のストレージを同じ workerd の中の Worker として動かす。本物の資源はバインディングごとの `remote: true` だけ**
2. 上流の公開版の workerd と、本家の Miniflare をそのまま使う
3. コードを本番の網で動かす遠隔の開発（本家の `dev --remote` に当たる）を MVP で持つ

## Decision

1 を採用する。

- CLI が固定した下流の workerd のビルドで利用者のコードを動かす。本番と同じパッチ（`brand` の置き換え、`request.<brand>`）が効く。
- 模擬の KV・オブジェクトストレージ・キューは TypeScript の Worker として同じ workerd の中で動かし、手元の SQLite とファイルに置く。Durable Objects は workerd の手元の保存で動かす。
- `remote: true` は KV・オブジェクトストレージ・キューの producer・サービスだけ。管理 API の資源の口を、ログインのトークンで呼ぶ。Durable Objects・変数・シークレット・版のメタデータは遠隔にしない。
- CPU 時間・メモリ・サブリクエストの上限は、既定で測って警告する。`--enforce-limits` で強制する。外向きの宛先が本番の拒否の範囲に当たれば警告する。
- 本番との差は表にして文書と起動時の表示で示す。
- 2 を採らない理由：`request.<brand>` などの名前の置き換えと、バインディングの API の差（オブジェクトストレージの制限など）が手元に出ない。Miniflare の模擬は本家の製品の振る舞いに合わせてあり、この基盤の振る舞い（KV の書き込みの 1 秒に 1 回の判定など）と違いうる。
- 3 を採らない理由：本番のノードで開発中のコードを動かすには、制限・課金・隔離の別の扱いが要る。本物の資源が要る場面は、バインディングのつなぎ込みで大半を賄える。

## Consequences

- 良くなること：
  - ランタイムの振る舞いの差が、ランタイムの版の差だけになる。
  - 模擬と本番のバインディングに同じ契約テストを回せる。
- 引き受けるコスト：
  - 模擬のサービスを自前で作り、本番のストレージの振る舞いの変更に追従させる。
  - KV の古さ、Durable Objects の配置と障害は手元で試せない。
  - 手元の機械の速さで CPU 時間が変わるので、強制は既定にできない。

## Confirmation

- 契約テスト：同じテストの集まりを模擬とステージングの本番のバインディングに回し、KV の古さを除いて結果が同じ。
- 結合テスト：拒否の範囲の宛先で警告が出る。`--enforce-limits` で CPU の上限で止まる。`remote: true` の Durable Objects の指定が誤りになる。
