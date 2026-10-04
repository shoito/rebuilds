---
status: accepted
date: 2026-10-04
---

# ADR-0062: アプリは週 1 回の列車でストアに出し、iOS は 7 日の段階的リリース、Android は段階的公開で広げる。JS だけの修正は自前の Expo Updates の形のサーバーから署名した束で配る。最低のバージョンは `426` で強制し、支えるバージョンは 12 週

## Context

- iOS・Android のアプリは React Native（Expo）（[ADR-0001](0001-platform-and-stack.md)）。ストアの審査、段階の配布、最低のバージョンの運用が要る。
- runbooks は、アプリを 1% → 10% → 50% → 100% で広げ、クラッシュの率・投稿の失敗の率が前のバージョンの 2 倍で止め、最低のバージョンの強制はセキュリティと API の互換の理由に限るとした（[runbooks/README.md](../runbooks/README.md) の 3 節）。
- App Store の段階的リリースは 7 日で 1% → 2% → 5% → 10% → 20% → 50% → 100% と自動で広がり、止めるのは合計 30 日まで（[Release a version update in phases](https://developer.apple.com/help/app-store-connect/update-your-app/release-a-version-update-in-phases/)、2026-10-04 に確認）。割合は選べない。
- Expo Updates の仕様（v1）は公開の取り決めで、自前の更新のサーバーを持てる。マニフェストのコード署名と `runtimeVersion` を持つ（[Expo Updates v1](https://docs.expo.dev/technical-specs/expo-updates-1/)、2026-10-04 に確認）。

## Options

更新の配り方：

1. **ストアの列車と、自前の更新のサーバー（署名あり）での JS の修正**
2. ストアの列車だけ
3. 外部の更新の配信のサービス

## Decision

1 を採用する。詳細は [delivery.md](../architecture/delivery.md) の 4〜6 節。

- 列車：月に切り、火に出し、審査が通ったら段階の配布。iOS は App Store の 7 日の段階的リリース、Android は 1% → 10% → 50% → 100%。runbooks の「1% → 10% → 50% → 100%」は Android に当て、iOS は 7 日の形にする（runbooks の書き換えを提案する）。
- 止める条件：クラッシュのないセッションが前のバージョンより 0.5 ポイント下がる、または投稿の失敗の率が 2 倍。
- OTA：更新のサーバーを `updates.<brand>.<domain>` に置き、束を S3 に置く。署名の鍵は shared のアカウントの KMS。OTA で出すのは JS だけの不具合の修正に限り、1% → 10% → 100%。`runtimeVersion` は列車ごとのネイティブの組に固定する。
- 最低のバージョン：App API は `min_supported_build` より古いバージョンに `426`（`client_too_old`）を返す。上げるのはセキュリティと互換の理由だけ。支えるバージョンは 12 週で、画面の API はそのバージョンが読めなくなる変更をしない。
- 2 を採らない理由：JS の小さな不具合でも審査と 7 日の段階を待つことになる。
- 3 を採らない理由：署名の鍵と段階の配布の制御が外に出る。サーバーのフラグと同じ仕組みで止められない。

## Consequences

- 良くなること：
  - JS の不具合を数時間で直せ、署名で差し替えを防げる。
  - 古いバージョンの数が 12 週に限られ、画面の API の互換の範囲が決まる。
- 引き受けるコスト：
  - 更新のサーバーの運用と署名の鍵の管理。
  - OTA をストアの規約の範囲で使う運用の確かめ（新しい機能を OTA で出さない）。
  - 12 週前のバージョンとの互換の夜間の E2E。

## Confirmation

- 夜間の E2E：12 週前のバージョンのアプリと今のサーバー。
- 署名のない・鍵の違う束をアプリが拒む結合テスト。
- 本番：古いバージョンの利用者の割合（12 週を超えたバージョンが 2% 以下）。
