---
status: accepted
date: 2026-09-28
---

# ADR-0038: Sandbox は 4 種類にし、ID をそのまま新しい org_id へ写し、個人データは複製の経路の中で Sandbox ごとの鍵の偽の値に置き換える

詳細は [sandboxes-and-deploy.md](../architecture/sandboxes-and-deploy.md) の 3 節と 4 節。

## Context

intent は、Sandbox（メタデータだけの複製と、データを含む複製）を MVP に含め、「Sandbox も別の組織として扱い、本番の組織のデータに触れない」ことを守るべき振る舞いにする。法務の L3 は、本番の個人データを開発・試験の組織に複製してよい条件と、項目のマスキングを必須にするかを問い、E10 のデータを含む Sandbox の spec を止めている。

[ADR-0005](0005-tenancy-and-governor-limits.md) は、Sandbox を別の `org_id` の組織にし、データの複製は組織をまたぐ管理の処理として Worker が行うとした。[ADR-0006](0006-data-dictionary-and-field-lifecycle.md) は、`field_id` を全組織で一意の UUIDv7 とした。レコードの値（JSONB）は親の ID を持ち、フロー・リストビュー・レポートの定義は `field_id` で項目を指す。

本家の Sandbox は、Developer（データ 200MB、メタデータだけ、1 日）、Developer Pro（1GB、メタデータだけ、1 日）、Partial Copy（データ 5GB、テンプレートで選んだ標本、5 日）、Full（本番と同じ、全てのデータ、29 日）。エディションごとの数は、Enterprise で Developer 25・Partial Copy 1、Unlimited で Developer 100・Developer Pro 5・Partial Copy 1・Full 1（[Sandbox Licenses and Storage Limits by Type](https://help.salesforce.com/s/articleView?id=platform.data_sandbox_environments.htm&type=5)、2026-09-28 に確認）。Partial Copy のオブジェクトごとの件数の上限（1 万件と広く紹介されている）、Sandbox のレコードの ID が本番と同じか、マスキングの既定は、読めた資料に書かれていない（未検証。E10 の `sandbox-data-copy` で確かめる）。

## Options

ID：

1. **ID をそのまま使う（主キーの先頭の `org_id` で分かれる）**
2. 全ての ID を付け替え、参照・定義の中の ID を書き換える

マスキング：

- a. **複製の経路の中で、分類が `personal` の項目を Sandbox ごとの鍵で決まる偽の値に、`sensitive` を空に置き換えてから書く。L3 の結論まで外せない**
- b. そのまま写し、管理者が後で伏せる
- c. データを含む Sandbox を MVP で持たない

## Decision

1 と a を採用する。

- 種類は `developer`・`developer_pro`（メタデータだけ）、`partial`（テンプレートの標本、オブジェクトごとに 1 万件、写したレコードの親を 1 段）、`full`（全て）。容量と再作成の間隔は本家に寄せ（200MB・1GB・5GB・本番と同じ、1・1・5・29 日）、数はエディションで決める。
- 複製は、組織をまたぐ管理の DB のロールを持つ Worker が、ID の範囲ごとに読み、伏せ、新しい `org_id` で書く。写しの表（ピボット、一意、関係、照合の鍵、共有の行、閉包）は写した値から作り直す。組織の全体の一貫した時点は取らず、写さなかった親を指す参照は空にし、数を知らせる。
- ID は付け替えない。ADR-0006 の `field_id` の一意は「組織の中で一意。Sandbox と元の組織は同じ ID を共有する」に読み替える。
- 項目にデータの分類（`none`・`personal`・`sensitive`）を持つ。標準の個人データの項目は種から `personal`。カスタム項目は作成の画面で必ず選ばせる。
- 偽の値は `HMAC(Sandbox ごとの鍵, 元の値)` で決め、同じ元の値は同じ偽の値になる。鍵は作成の後に捨てる。氏名は生成した偽の辞書から選び、形（メール、電話の桁、都道府県）を保つ。長いテキスト・添付は写さないか空にする。
- 作った人以外の利用者は無効にし、メールを伏せる。Webhook・外向きの呼び出しは `disabled` で秘密なし、スケジュールは止め、メールは外へ送らず、OAuth のクライアントは写さない。
- 2 は、JSONB の参照の値、フロー・リストビュー・レポートの定義の中の ID を全て書き換えることになり、書き換えの漏れが壊れた Sandbox を作る。
- b は、伏せる前の個人データが Sandbox の DB に一度は入る。L3 の安全管理の論点をそのまま残す。
- c は、intent の MVP の範囲を外れ、本番に近いデータでの試験ができない。

## Consequences

- 良くなること：
  - 複製が行の写しと写しの表の作り直しだけで済み、定義の書き換えがない。
  - 伏せる前の個人データが Sandbox に入らない。
  - 伏せた後も、重複の照合・参照・集計の形が保たれ、試験に使える。
- 引き受けるコスト：
  - 同じ ID が複数の組織にある。ID だけで組織を決める経路（ログの検索、サポートの調査）は、必ず組織と組で扱う。
  - 分類の漏れたカスタム項目は伏せられない。複製の前の検出と警告で補う。
  - 組織の全体の一貫した時点ではないので、複製の途中の変更で参照が食い違いうる。
  - L3 の結論によっては、伏せ方や外し方を変える ADR が要る。

## Confirmation

- 性質ベーステスト：任意の本番のデータで、Sandbox の DB のどの行にも `personal`・`sensitive` の元の値が現れない。同じ元の値は同じ偽の値になる。
- 性質ベーステスト：Sandbox の組織のコンテキストで、元の本番の組織の行が読めない。
- 結合テスト：Sandbox の Webhook・外向きの呼び出しが送らない、メールが外へ出ない、スケジュールが動かない。
- レビュー：複製の Worker のコードの変更は `security:sensitive`。
