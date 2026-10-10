---
status: accepted
date: 2026-10-10
---

# ADR-0063: 名簿のための旅券の読み取りは、端末で MRZ を読み（検査の数字を確かめる）、読めれば IC の読み取りを足し、画像と項目を `identity` のアダプター経由で `compliance-jp` に直接渡す。`identity` は旅券の画像と番号を残さず、確かめた結果（方式、国籍の一致、有効期限の内か）だけを持つ。旅券の番号はログ・事象に出さない

詳細は [identity-verification.md](../architecture/identity-verification.md) の 6 節。

## Context

- 住宅宿泊事業の宿泊者名簿は、日本に住所のない外国人の国籍と旅券の番号を記録する（観光庁 [住宅宿泊事業者の義務](https://www.mlit.go.jp/kankocho/minpaku/business/host/index.html)、2026-10-10 に確認）。名簿と旅券の画像は vault と S3 の `registry` に、`compliance-jp` が（届出住宅、年度）の鍵で置く（[ADR-0067](0067-guest-registry-in-vault.md)、[ADR-0073](0073-key-layout-and-vault-envelope-encryption.md)）。
- 手で入れた旅券の番号は誤りやすい。
- 旅券の番号と画像が複数のサービスに残ると、漏れの経路と削除の対象が増える。
- 本人確認の方法（対面の代わりの ICT の方法）は法務の確認待ち（L3）。

## Options

1. **端末で MRZ と IC を読み、`compliance-jp` に直接渡す。`identity` は結果だけ**
2. `identity` が旅券の画像と番号を持ち、名簿から参照する
3. 手で入れる項目と画像だけ（読み取りなし）

## Decision

1 を採用する。

- 端末で MRZ を読み、旅券の番号・生年月日・有効期限・全体の検査の数字（7・3・1 の重みの和の 10 の剰余）を確かめる。読めなければ手で入れ、画像を上げて運用の確かめの印を付ける。
- 端末が IC を読めれば、IC の中の項目と MRZ の一致を確かめる。
- 画像と項目は `identity` のアダプターのメモリーを通って `compliance-jp` に渡り、名簿の行と S3 の `registry` に書かれる。`identity` は `passport_capture_results`（方式、検査の一致、IC の一致、宿泊の日に有効か）だけを残す。
- 求める方式（`mrz_only`・`mrz_nfc`・`mrz_nfc_face`）は `legal.registry_identity_method` で決め、本番の値は L3 の後。
- 試験には見本の旅券の値だけを使う。

### 他の案を選ばなかった理由

- **2**：旅券のデータが 2 つのサービスと 2 つの鍵に分かれ、削除と照会の手順が二重になる。
- **3**：番号の誤りが名簿の誤りになり、照会の時に困る。

## Consequences

- 良くなること：
  - 旅券のデータの置き場所が名簿の 1 か所になる。
  - 番号の入力の誤りを検査の数字で見つけられる。
- 引き受けるコスト：
  - 端末の MRZ と IC の読み取りの部品（提供者か OS の機能）の選定と試験が要る。
  - 顔の照合を求める結論になれば、提供者の顔の照合を足す。

## Confirmation

- PROP-KYC-003（`identity` に旅券の番号と画像が残らない）、PROP-KYC-004（検査の数字）。
- 試験のベクトル：[identity-verification.md](../architecture/identity-verification.md) の 6.2 節の見本の値。
