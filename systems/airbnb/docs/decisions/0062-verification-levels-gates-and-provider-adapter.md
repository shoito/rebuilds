---
status: accepted
date: 2026-10-10
---

# ADR-0062: 確認の水準は `none`・`contact_verified`・`id_verified`（書類と顔の照合、またはマイナンバーカードの IC の読み取り）と、事業者の印 `business_verified`。どの機能に何を求めるかは `kyc_gates`（バージョンの付いた表）に書き、各サービスは `identity` の `kycLevel()` と表で判定する。提供者は自前のアダプターの後ろに置き、結果は署名を確かめた Webhook と照会の両方で受け、本システムは結果と最小の項目だけを vault に残す

詳細は [identity-verification.md](../architecture/identity-verification.md) の 4・5 節。

## Context

- ホストは公開の前に本人確認が必須。ゲストは規則で求める（初めての予約、高額、危険の点）（[architecture/README.md](../architecture/README.md) の 6 節）。
- 自前の eKYC は作らない（[intent.md](../intent.md) の Non-goals）。方式の法令の扱いは法務の確認待ち（L3・L6）で、結論で方式と水準の対応が変わりうる。
- Mercari の題材は、水準と方式を分け、機能の条件を表にし、書類の画像を持たない形にした（[ADR-0056](../../../mercari/docs/decisions/0056-ekyc-provider-and-verification-levels.md)、[ADR-0057](../../../mercari/docs/decisions/0057-identity-data-minimization-and-retention.md)）。

## Options

1. **水準と方式を分け、機能の条件を `kyc_gates` の表にする。提供者は自前のアダプター、画像は持たない**
2. 機能ごとにコードで方式を確かめる
3. 書類の画像を本システムにも保存する

## Decision

1 を採用する。

- 水準：`none`、`contact_verified`、`id_verified`（`document_face`・`jp_ic_card`・`passport_nfc`）。印：`business_verified`（法人番号と担当者の `id_verified`）。
- `kyc_gates`：公開は `owner` の `id_verified`（事業者は `business_verified`）、送金の口座は `id_verified` と名義の一致、ゲストの予約は `contact_verified`、総額 300,000 円以上と T&S の `step_up` は `id_verified`。表はバージョンで出す。
- 判定は実行の場所で行い、`identity` は水準だけを返す。
- アダプター：セッションの作成、端末の部品、Webhook（署名の確かめ、inbox）と照会の一致で水準を変える。
- vault に残すのは結果と最小の項目（名義、読み、生年月日、書類の種類、発行の国、提供者の参照）。画像は提供者に残し、契約で削除を求める。

### 他の案を選ばなかった理由

- **2**：法務の結論で方式の扱いが変わるたびに、機能ごとのコードを直すことになる。
- **3**：漏れたときの被害が大きく、保持と削除の義務が増える。画像は名簿の旅券だけに限る（[ADR-0063](0063-passport-capture-for-guest-registry.md)）。

## Consequences

- 良くなること：
  - 法務の結論を表の変更で受けられる。
  - 本システムに書類の画像の山ができない。
- 引き受けるコスト：
  - 異議や調べで画像が要るときは、提供者の保存の期間の中でしか見られない。
  - 提供者の切り替えでアダプターの作り直しが要る。

## Confirmation

- PROP-KYC-001（Webhook と照会）、PROP-KYC-002（表の判定）、PROP-KYC-003（漏れ）。
