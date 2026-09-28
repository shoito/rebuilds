---
status: accepted
date: 2026-09-28
---

# ADR-0042: 画面の決まった文言はコードの版の ICU MessageFormat の辞書に、テナントの文言は安定したキーの翻訳の表に持つ。言語は利用者 → テナント → 日本語の順に決め、日時は UTC で保存し見る人のタイムゾーンで出す

詳細は [portal-and-ui.md](../architecture/portal-and-ui.md) の 7 節。

## Context

[intent.md](../intent.md) は、日本語の画面を最初から持つことを求める。日本の企業の中にも、英語を使う社員と海外の拠点がある。テナントは、テーブル・フィールド・選択肢・カタログの品目・通知のテンプレートを自分の言葉で作る。メタデータは `stable_key` を持ち、パッケージで移送する（[ADR-0010](0010-metadata-versions-and-config-packages.md)）。

本家は、国際化のプラグインと言語ごとの翻訳のプラグインを持ち、翻訳した値をフィールドの種類ごとに別の表に持つ（コミュニティの記事 [ServiceNow Localization and Language Translation](https://www.servicenow.com/community/itsm-forum/servicenow-localization-and-language-translation/m-p/3455929)、2026-09-28 に確認。公式の本文は未検証。本家の振る舞いで、この決定の前提ではない）。

## Options

### テナントの文言の翻訳の置き場所

1. **1 つの翻訳の表 `(stable_key, attribute, locale)`**
2. 各メタデータの行に、言語ごとの列（`label_ja`、`label_en`）
3. 各メタデータの行の JSONB の `labels: {ja, en}`

### 言語の数

- a. **MVP は `ja`・`en`。足すのは辞書と表の行だけ**
- b. 最初から多くの言語

## Decision

1 と a を採用する。

- 組み込みの文言は `ja.json`・`en.json`（ICU MessageFormat）にし、CI で 2 つのキーの集合が等しいことを確かめる。
- テナントの文言は `translation(tenant_id, stable_key, attribute, locale, text)` に持ち、`meta_version` の対象にする。訳がなければ作成の時の言語の文言を出す。
- 表示の言語は `user.language` → `tenant.default_language` → `ja`。ログインの前は `Accept-Language` とテナントの既定。
- 日時は UTC で保存し、見る人の `time_zone` で表示する。SLA の期限は見る人のタイムゾーンで出し、計時のタイムゾーンを添える。
- 和暦と読みでの並べ替えは MVP で持たない。

2 を採らない理由：言語を足すたびに、すべてのメタデータの表の列を足すことになる。

3 を採らない理由：メタデータの行の内容のハッシュ（[ADR-0010](0010-metadata-versions-and-config-packages.md) の `content_hash`）が、訳の追加だけで変わる。開発のテナントで訳を足すと、本番の同じオブジェクトとの衝突になり、パッケージの衝突の判定が多くなる。1 なら、訳は別のオブジェクトとして移送できる。

b を採らない理由：訳の品質を確かめる人がいない言語を出すと、画面の誤訳が業務の誤りになる。

## Consequences

- 良くなること：
  - 言語を足すのが、辞書と表の行の追加だけで済む。
  - 訳の移送が、メタデータの本体と独立する。
- 引き受けるコスト：
  - 画面のモデルを作るとき、翻訳の表を読む（`(tenant_id, meta_version, 言語)` でキャッシュする）。
  - テナントの文言の訳の抜けは、管理者が埋める。一覧の画面で示す。

## Confirmation

- CI：`ja`・`en` のキーの集合が等しい。
- E2E：主な流れを `ja` と `en` で通す。
- lint：画面の束に、日本語・英語の文言のリテラルを書かない（辞書のキーを使う）。
