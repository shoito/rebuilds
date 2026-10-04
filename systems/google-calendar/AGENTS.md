# AGENTS.md — Google Calendar

Google Calendar の再構築の設計。リポジトリ共通のルールはルートの [AGENTS.md](../../AGENTS.md) にある。このリポジトリには設計だけを置き、実装は Google Calendar の開発リポジトリで行う（[リポジトリ共通の ADR-0005](../../docs/decisions/0005-design-record-repository.md)）。

## 最初に読むもの

- [docs/intent.md](docs/intent.md) — 何を、なぜ作るか
- [docs/architecture/](docs/architecture/README.md) — 全体像、規模の段階、非機能要件、領域ごとの設計
- [docs/decisions/](docs/decisions/README.md) — ADR。特に 0002（時刻の表し方）、0003（繰り返しの保存と展開）、0005（変更のログと同期のトークン）、0006（主催者の写しと参加者の写し）
- [docs/quality.md](docs/quality.md)・[docs/roadmap.md](docs/roadmap.md)・[docs/runbooks/](docs/runbooks/README.md) — 品質の戦略、Epic と Story、SLO と運用

## この題材に固有の規則（開発リポジトリで守る）

- **繰り返しの展開とタイムゾーンの計算を自前で作る。** 展開器（RRULE・RDATE・EXDATE と例外）と、tzdb の遷移の表からの時刻の変換は、`packages/recurrence` と `packages/tz` に自前で書く。第三者の iCalendar のライブラリ（libical など）は、性質ベーステストの参照（答え合わせの相手）にだけ使い、本番のコードから import しない（[リポジトリ共通の ADR-0007](../../docs/decisions/0007-no-reuse-of-original-implementation.md)、ADR-0001、ADR-0003）。
- **時刻は「壁時計の時刻＋TZID」を正にする。** 時刻つきの予定は、現地の時刻と IANA の TZID を正本に持ち、UTC の瞬間は派生の値として `tzdata_version` と一緒に持つ。UTC の瞬間だけを保存しない。終日の予定は日付（終わりを含まない）で持ち、UTC に変換しない。浮動の時刻（TZID なし）は浮動のまま往復させる（ADR-0002）。
- **オフセットの計算に `Intl`・OS・DB のタイムゾーンの機能を使わない。** オフセットは、版を固定した `packages/tzdata` からだけ求める。PostgreSQL の `AT TIME ZONE`、`Date` の現地時刻、`Intl.DateTimeFormat` の `timeZone` を、保存・展開・通知の時刻の計算に使わない。`Intl` は月や曜日の名前の表示にだけ使う（ADR-0002）。
- **tzdb の更新は、データのリリースとして扱う。** `packages/tzdata` の版を上げる PR には、未来の遷移が変わるゾーンの一覧（差分の報告）と、影響する予定の件数の見積もりを付ける。版を上げた後の再計算のジョブ（展開の索引、リマインダー、変更のログ）を省かない（ADR-0002）。
- **繰り返しの変更は 3 つの形に限る。** 系列の全体の変更、1 回分の例外（`RECURRENCE-ID` で特定する上書き）、「これ以降」の分割（元の系列を `UNTIL` で切り、新しい UID の系列を作る）。例外を 1 回ずつ大量に作って「これ以降」を表さない（ADR-0003）。
- **展開は、展開の索引と同じ関数で行う。** 画面・API・CalDAV・空き時間・会議室・リマインダーのどれでも、`packages/recurrence` の `expand()` を通す。別の場所で RRULE を解釈しない。
- **展開の正しさは参照と比べる性質ベーステストで確かめる。** 繰り返し・例外・タイムゾーンに触れる変更には、任意の RRULE・EXDATE・RDATE・TZID・期間を生成し、参照の実装と展開の結果を比べるテストを付ける。食い違いは、参照の誤りと判断した場合だけ、理由を書いた許可リストに入れる。失敗したシードは回帰テストとして残す（[quality.md](docs/quality.md) の 2.2.1 節）。
- **書き込みは、同じトランザクションで変更のログに載せる。** 予定・カレンダー・ACL を変える書き込みは、カレンダーごとの `change_seq` を振り、`calendar_changes` と outbox を、変更と同じ DB のトランザクションで書く。ログを通らない書き込み（直接の `UPDATE` の一括の修正を含む）を作らない（ADR-0005）。
- **参加者の写しは、主催者の写しから iTIP の意味で作る。** 共有の項目（時刻、場所、参加者、繰り返し）は主催者の写しだけが正で、参加者の写しは内部の iTIP のメッセージ（`REQUEST`・`CANCEL`・`REPLY`）でだけ変える。参加者の写しから共有の項目を直接書き換えない（ADR-0006）。
- **会議室の二重予約を DB の制約で防ぐ。** 会議室・設備の予約と予約ページの予約は、アプリの事前の確認だけに頼らず、DB の排他の制約で重なりを拒む（ADR-0019、ADR-0033）。
- **権限は 1 つの関数で判定する。** カレンダーの ACL、予定の公開範囲（`default`・`public`・`private`・`confidential`）、組織の共有の方針は、`packages/policy` の `can()` と `redact()` だけで判定する。API・CalDAV・ICS の公開・空き時間・検索・通知・Webhook で、別に条件を書かない。空き時間だけを見られる人には、予定の中身を一切返さない（ADR-0004）。
- **テナントのテーブルには `tenant_id` と RLS を付ける。** `FORCE ROW LEVEL SECURITY` を外さない。テナントをまたぐのは、ADR-0004 の許可リストの経路（X1〜X9：内部の iTIP の配送、空き時間の照会、共有のカレンダーの読み出しと書き込み、リマインダーの時計、入口の解決、tzdb の影響の探し、個人から組織への移り、SLI の集計）だけで、専用の DB のロールと関数を通す。RLS の外の表も ADR-0004 の一覧の表だけにし、予定の中身の列を持たせない。一覧にない経路・表を足すときは、先に ADR-0004 を直す（CI が一覧と照らす）。
- **リマインダーは「少なくとも 1 回送り、重なりは鍵で消す」。** 送信の前に（利用者, 予定オブジェクト, `recurrence_id`, 方法, 分, 回の開始）の鍵を送信の記録に挿入し、挿入できたものだけを送る。版は鍵に入れない。予定が動いたら計画の行を作り直し、送る時に回の開始が今と同じかを確かめて、古い時刻の送信を捨てる（ADR-0029、ADR-0030）。
- **外から来るデータを信用しない。** iMIP の受信のメール、ICS の購読の URL、CalDAV の `PUT` の本文は、大きさ・件数・展開の回数の上限を先に確かめる。ICS の購読の取得は egress の専用の経路を通し、内部のアドレスへの要求（SSRF）を拒む。
- **展開・時刻・権限の規則をフラグにしない。** `expand()`・`resolve()`・`can()`・`redact()` の変更はコードの版として出し、戻すときは前のイメージへ戻す。`release.*` のフラグで規則を経路ごとに切り替えない。tzdb の版は AppConfig の `tzdata.active_version` で全サービスを一度に切り替える（ADR-0049）。
- **フラグの名前**：`release.*` は kebab-case（`release.cross-tenant-shared-writes`）、`ops.*` は snake_case（`ops.writes_enabled`）。`release.*` は 100% の後 30 日で消す。例外は [runbooks/README.md](docs/runbooks/README.md) の 3 節の一覧だけ。
- **IME を壊さない。** 予定のタイトルの入力・クイック作成で、日本語の変換の途中（`isComposing`）の `Enter` で保存しない。
- **本家の名前を識別子に使わない。** ドメイン、HTTP ヘッダー（Webhook の `<Brand>-Channel-Id` など）、`PRODID`、iMIP の送信元のアドレス、OAuth のスコープ、ICS の秘密のアドレスは `<Brand>`・`<brand>` で書く（[リポジトリ共通の ADR-0006](../../docs/decisions/0006-brand-neutral-identifiers.md)）。
- **テストに本物のデータを使わない。** 実在の人のメールアドレス・予定、本物の会議室の名前、本家のカレンダーから書き出した ICS を、テスト・フィクスチャー・シードに書かない。ICS の試験のデータは合成する。

## このリポジトリでの規則

- ADR を追加・更新したら、`docs/decisions/README.md` の一覧を生成し直す。
- 領域の文書で ADR を起票するときは、[architecture/README.md](docs/architecture/README.md) の 7 節で領域に割り当てた番号の範囲の中で採番する。
- 本家の振る舞い・数値を書くときは、出典と確認日を付ける。確かめられないものは「未検証」と書く。
- RFC の要求と本家の振る舞いが違うときは、両方を書き、本システムがどちらに寄せるかを明記する。本システムが RFC と違う振る舞いを選んだら、[ADR-0007](docs/decisions/0007-interop-standards-scope.md) の「RFC との意図した違い」の表に行を足す。本家と違う振る舞いを選んだら、[architecture/README.md](docs/architecture/README.md) の 1.4 節の「本家との意図した違い」に行を足す。
- 数値の正本：SLO とアラートは [runbooks/README.md](docs/runbooks/README.md)、上限は各 ADR と [runbooks/README.md](docs/runbooks/README.md) の 2 節、保持の期間は ADR-0042、負荷のモデルは [capacity.md](docs/architecture/capacity.md)、表と置き場所は [data-model.md](docs/architecture/data-model.md)。値を変えるときは正本から直し、引いている文書を同じ PR で揃える。
