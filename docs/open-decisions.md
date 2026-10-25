# 保留中の判断と食い違い

人の判断を待っているものを 1 か所に集めた一覧。エージェントは草案を書くが承認はしない（[process.md](process.md) の 2 節）ので、判断の待ちは文書のあちこちに残る。この一覧はそれを見失わないためにある。

- 1 節と 2 節は自動で生成する（`npm run open-decisions`）。`npm run check` が、生成し直していなければ落とす。
- 3〜5 節は手で書く。見つけた人（エージェントを含む）が行を足し、判断した人が「状態」を直す。解いたら、行を消さずに状態を「解決」にし、直したコミットか PR を書く。月に 1 回、解決の行を消す。
- 判断するのはロールの持ち主である。確認先は [process.md](process.md) の「判断に迷ったときの確認先」に従う（要件 → PM、設計と ADR → Dev、テスト → QA、本番 → Ops）。

## 1. 承認を待つ ADR（自動）

`status: proposed` の ADR。持ち主（Dev、範囲に関わるものは PM も）が読み、`accepted` にするか、直すか、退ける。検証や規模の段階を待ってから承認するものは、`decide_after` を書いて「判断する時点を待つもの」に分ける。

<!-- proposed-adrs:start -->
**今判断が要るもの**

| 題材 | ADR | 決定 | 起票日 |
| --- | --- | --- | --- |

**判断する時点を待つもの**（frontmatter の `decide_after`）

| 題材 | ADR | 決定 | 判断する時点 |
| --- | --- | --- | --- |
| github | [ADR-0034](../systems/github/docs/decisions/0034-multi-region-repository-placement.md) | S3 では、リポジトリにホームのリージョンを割り当て、他のリージョンに非同期の読み取りの複製を置く | E11 の staging での検証（S3 の前） |
| notion | [ADR-0030](../systems/notion/docs/decisions/0030-cdc-data-lake.md) | S2 で、変更データの取り込み（CDC）によるデータレイクを S3 に作る | S2 への移行を始めるとき |
| slack | [ADR-0023](../systems/slack/docs/decisions/0023-cell-based-architecture.md) | S3 でセル構成に移る | S3 への移行を始めるとき |
<!-- proposed-adrs:end -->

## 2. 法務の確認待ち（自動）

各題材の intent.md の「法務の確認待ち」の L 番号の数。中身と、結論が出るまで止める spec は、各 intent.md にある。

<!-- legal-counts:start -->
| 題材 | 法務の確認待ち（L 番号の数） | 置き場所 |
| --- | --- | --- |
| airbnb | 14 | [intent.md](../systems/airbnb/docs/intent.md) |
| auth0 | 8 | [intent.md](../systems/auth0/docs/intent.md) |
| datadog | 10 | [intent.md](../systems/datadog/docs/intent.md) |
| dropbox | 10 | [intent.md](../systems/dropbox/docs/intent.md) |
| figma | 6 | [intent.md](../systems/figma/docs/intent.md) |
| github | 表の形でない（intent を見る） | [intent.md](../systems/github/docs/intent.md) |
| gmail | 10 | [intent.md](../systems/gmail/docs/intent.md) |
| google-calendar | 10 | [intent.md](../systems/google-calendar/docs/intent.md) |
| linear | 8 | [intent.md](../systems/linear/docs/intent.md) |
| mercari | 13 | [intent.md](../systems/mercari/docs/intent.md) |
| notion | 5 | [intent.md](../systems/notion/docs/intent.md) |
| salesforce | 13 | [intent.md](../systems/salesforce/docs/intent.md) |
| servicenow | 9 | [intent.md](../systems/servicenow/docs/intent.md) |
| shopify | 11 | [intent.md](../systems/shopify/docs/intent.md) |
| slack | 表の形でない（intent を見る） | [intent.md](../systems/slack/docs/intent.md) |
| stripe | 9 | [intent.md](../systems/stripe/docs/intent.md) |
| uber | 9 | [intent.md](../systems/uber/docs/intent.md) |
| workday | 58 | [intent.md](../systems/workday/docs/intent.md) |
| x | 12 | [intent.md](../systems/x/docs/intent.md) |
| youtube | 10 | [intent.md](../systems/youtube/docs/intent.md) |
| zoom | 8 | [intent.md](../systems/zoom/docs/intent.md) |
<!-- legal-counts:end -->

## 3. PM の判断待ち

範囲（MVP に入れるか）の判断。どれも、選択肢と推奨を対応する ADR と intent.md に書いてある。

| ID | 題材 | 判断すること | 推奨 | 置き場所 | 状態 |
| --- | --- | --- | --- | --- | --- |
| PM-001 | Slack | 他のチャットツールからの取り込み（移行）を提供するか、どの範囲か | 本家のエクスポートのパブリックチャンネルを MVP の後に取り込む | [intent.md](../systems/slack/docs/intent.md)、[ADR-0034](../systems/slack/docs/decisions/0034-workspace-import-from-other-tools.md) | 解決（2026-10-25：パブリックを MVP の後の E8 に） |
| PM-002 | Stripe | 他の決済事業者とのカード番号の移行を提供するか | 取り込みと書き出しの両方を、MVP の後に運用者の仲介で | [intent.md](../systems/stripe/docs/intent.md)、[ADR-0034](../systems/stripe/docs/decisions/0034-card-data-migration.md) | 解決（2026-10-25：両方を E10 の後に） |
| PM-003 | GitHub | 他のホスティングからのリポジトリと Issue の取り込みを提供するか | Git に加えて、決めた 1 つの形式のアーカイブから Issue と PR を MVP の後に | [intent.md](../systems/github/docs/intent.md)、[ADR-0037](../systems/github/docs/decisions/0037-import-from-other-hosts.md) | 解決（2026-10-25：Git と Issue・PR を MVP の後に） |
| PM-004 | Salesforce | Web からのリードのフォームを MVP に入れるか | E5 に入れる | [intent.md](../systems/salesforce/docs/intent.md)、[ADR-0064](../systems/salesforce/docs/decisions/0064-web-lead-form-public-intake.md) | 解決（2026-10-25：E5 に入れる） |
| PM-005 | Salesforce | 本家からの移行の支援の範囲 | MVP は手順と移行の文書だけ | [intent.md](../systems/salesforce/docs/intent.md)、[ADR-0065](../systems/salesforce/docs/decisions/0065-migration-path-from-original.md) | 解決（2026-10-25：文書と CSV の手順、変換の道具は MVP の後） |
| PM-006 | Datadog | 組織のデータの書き出しの範囲 | 設定とテレメトリーの両方を MVP に | [intent.md](../systems/datadog/docs/intent.md)、[ADR-0067](../systems/datadog/docs/decisions/0067-org-data-export.md) | 解決（2026-10-25：両方を MVP に。費用は GA では数えない） |
| PM-007 | Datadog | 他の監視の道具からの移行を MVP に入れるか | MVP は手順書だけ、変換器は E17 の後 | [intent.md](../systems/datadog/docs/intent.md)、[ADR-0068](../systems/datadog/docs/decisions/0068-migration-from-other-monitoring-tools.md) | 解決（2026-10-25：MVP は手順書だけ、変換器は E17 の後） |
| PM-008 | X | 本人のデータの書き出しを MVP に入れるか | E14 に入れる | [intent.md](../systems/x/docs/intent.md)、[ADR-0064](../systems/x/docs/decisions/0064-personal-data-export-scope-and-format.md) | 解決（2026-10-25：E14 に入れる） |
| PM-009 | Shopify | 他の EC の基盤からの移行を MVP に入れるか、最初にどの基盤を受けるか | 自前の CSV の形と元の型のデータで受ける | [intent.md](../systems/shopify/docs/intent.md)、[ADR-0077](../systems/shopify/docs/decisions/0077-migration-import-from-other-platforms.md) | 解決（2026-10-25：独自の CSV の 4 種類を MVP に、元の型は後） |
| PM-010 | Uber | 訪日の旅行者を MVP の対象にするか（アプリの言語） | 日本語と英語と、人が訳した定型文 | [intent.md](../systems/uber/docs/intent.md)、[ADR-0044](../systems/uber/docs/decisions/0044-app-languages-and-rider-driver-phrases.md) | 解決（2026-10-25：日本語と英語と定型文） |
| PM-011 | Figma | 英語の UI を利用者に出す時期 | MVP は日本語だけ、英語は後から（仕組みは最初から両方） | [intent.md](../systems/figma/docs/intent.md)、[editor-and-tools.md](../systems/figma/docs/architecture/editor-and-tools.md) | 解決（2026-10-25：MVP から日本語と英語。推奨と違う判断） |
| PM-013 | Notion | 1 ファイルの大きさの上限（`limit.file.bytes`）の値 | 価格の設計の中で決める。本家の値は未確認 | [ADR-0034](../systems/notion/docs/decisions/0034-plans-and-entitlements.md) | 待ち |
| PM-012 | YouTube | 音声解説を入れる時期 | MVP の後の候補 | [roadmap.md](../systems/youtube/docs/roadmap.md) | 解決（2026-10-25：MVP の後の候補のまま） |

## 4. 文書の食い違い

本文と表、文書と文書が違うことを言っているもの。2026-10-10〜11 の見直し（図の追加、README の整理）で見つけ、直さずに残した。図は表を正として描いてある。

| ID | 題材 | 場所 | 食い違い | 確認先 | 状態 |
| --- | --- | --- | --- | --- | --- |
| DOC-001 | Stripe | [payments.md](../systems/stripe/docs/architecture/payments.md) 4 節、[fraud.md](../systems/stripe/docs/architecture/fraud.md) 2 節 | 不正検知で拒否する時点が違う。payments.md は手順 3 で「許可・拒否・3DS を要求」を返し、fraud.md は段 2（block）を 3DS の後・オーソリの前に評価する | Dev | 解決（2026-10-25：fraud.md に揃え、payments.md の手順と図を 3 段にした） |
| DOC-002 | Stripe | [payments.md](../systems/stripe/docs/architecture/payments.md) 3.1 節・3.3 節 | 3.3 節の `requires_payment_method → requires_confirmation`（決済の手段を付ける）が、3.1 節の遷移の表にない | Dev | 解決（2026-10-25：3.3 節の 2 つの遷移を表と図に足し、不正検知の拒否の行を 3 段に合わせた） |
| DOC-003 | Stripe | [payments.md](../systems/stripe/docs/architecture/payments.md) 7.2〜7.3 節、10.2 節 | `failed_before_send` に入る元と、`captured → partially_refunded → refunded` の条件が書かれていない。コンビニ・銀行振込の返金で、口座情報がないことと残高不足のどちらを先に判定するかが書かれていない | Dev、QA | 解決（2026-10-25、推奨で決めた：failed_before_send の入口と返金の状態の条件を書き、返金の失敗で状態を戻す。コンビニ・銀行振込の返金は残高を先に確かめる） |
| DOC-004 | GitHub | [pull-requests.md](../systems/github/docs/architecture/pull-requests.md) 3.3 節 | `mergeable_state` の 7 つの値のうち、判定が書いてあるのは `behind` だけ。ほかの値の判定と順序がない。決定表にすることを勧める | Dev、QA | 解決（2026-10-25、推奨で決めた：DT-PR-001 を足した。draft → unknown → dirty → blocked → behind → unstable → clean。本家の順は未検証） |
| DOC-005 | GitHub | [actions.md](../systems/github/docs/architecture/actions.md) 4.2 節 | ジョブの遷移の表に `waiting → completed(failure)`（否認・期限切れ）と `created → skipped`（needs の失敗・if が偽）がない。図には残した | Dev | 解決（2026-10-25：2 つの遷移を表に足した） |
| DOC-006 | Linear | [sync-engine.md](../systems/linear/docs/architecture/sync-engine.md) 4.4 節、[client-store-and-offline.md](../systems/linear/docs/architecture/client-store-and-offline.md)、[ADR-0014](../systems/linear/docs/decisions/0014-indexeddb-layout-durability-and-migrations.md) | `done` で outbox の行を消す時点。sync-engine.md は同じトランザクションで消し、ほかの 2 つは 15 分残す | Dev | 解決（2026-10-25：ADR-0014 に合わせ、done で印を付けて 15 分後に消す） |
| DOC-007 | Notion | [collaboration.md](../systems/notion/docs/architecture/collaboration.md) 11.3〜11.4 節 | 再接続で、heads の照合と差分の取得と、待ち行列の送信の順序が決まっていない。図では並行として描いた | Dev | 解決（2026-10-25、推奨で決めた：差分に追いついてから FIFO で送る） |
| DOC-008 | Auth0 | [universal-login.md](../systems/auth0/docs/architecture/universal-login.md) 3.2 節 | ステートマシンの遷移が一意に読めない。表にあるソーシャル・パスキーの遷移の元、MFA の後に同意・完了へ直接進めるか。図にしていない | Dev | 解決（2026-10-25：表に前の状態を足し、図にした。順序は connections.md・users-and-profiles.md に合わせて link → MFA → 同意） |
| DOC-009 | Auth0 | [mfa-and-passkeys.md](../systems/auth0/docs/architecture/mfa-and-passkeys.md) 4.2 節 | `disabled` から抜ける遷移が書かれていない | Dev | 解決（2026-10-25：管理者の解除と再設定を出口にした。解除で failure_count を 0 に戻す） |
| DOC-010 | Figma | [multiplayer.md](../systems/figma/docs/architecture/multiplayer.md) 7.2 節 | `Disconnected → Live`（Welcome の resume）が、Connecting と Loading を通らない。意図どおりか確かめる | Dev | 解決（2026-10-25：必ず Backoff → Connecting を通し、Welcome で Live か Loading に分かれる） |
| DOC-011 | Dropbox | [sync-engine.md](../systems/dropbox/docs/architecture/sync-engine.md) 11.2 節 | 「自分の名前の変更は既に確定して Synced に入っている」なら `Lc` は none になり、`Lc = place` と矛盾する（5.2 節の表では commit の成功で Synced も進む）。図は決定表の 6 が成り立つ順で描いた | Dev | 解決（2026-10-25：本文を図の順に直した） |
| DOC-012 | X | [ranking-and-recommendation.md](../systems/x/docs/architecture/ranking-and-recommendation.md) 4.1 節・8 節 | 4.1 節の表では「特徴の付加」が「軽いランク」より前、8.1 節と 4.1 節の図では後。同じ節に「800ms の割り振り」と「全体の締め切り 700ms」がある | Dev | 解決（2026-10-25：表の順を直した。700ms は ADR-0006 の 800ms の中の Ranking の締め切り） |
| DOC-013 | Uber | [trips-lifecycle.md](../systems/uber/docs/architecture/trips-lifecycle.md) タイマーの表 | `dispatch_deadline` を「与信の成功から 3 分」としているが、車内払い（与信なし）は作成の時点でこのタイマーを置く | Dev | 解決（2026-10-25：車内払いは作成から 3 分） |
| DOC-014 | Uber | [primer](../systems/uber/docs/primer/index.html) の乗車の状態の節 | 本文は「ドライバーの取り消しは requested に戻す」とだけ書くが、DT-TRIP-001 では安全・迷惑行為なら `cancelled_by_driver`、期限の後なら `no_driver_found` もある | Dev | 解決（2026-10-25：primer に例外の 2 つを書いた） |
| DOC-015 | ServiceNow | [itsm-processes.md](../systems/servicenow/docs/architecture/itsm-processes.md) 8.1 節 DT-CHG-001 の #12 | 「後」の列は通常の変更なら `new`、効果の列は「承認を取り直す（通常は `assess` から）」 | Dev、PM | 解決（2026-10-25：通常の変更は assess からやり直す。図も直した） |
| DOC-016 | Airbnb | [availability-and-calendars.md](../systems/airbnb/docs/architecture/availability-and-calendars.md) 4.7 節の表 | 「6.3 節で切り取る」は同じ文書の 6.3 節（DT-AVL-001）でなく、calendar-sync.md の 6.3 節を指すはず。リンクがない | Dev | 解決（2026-10-25：calendar-sync.md へのリンクにした） |
| DOC-017 | Gmail | [client-sync-and-protocols.md](../systems/gmail/docs/architecture/client-sync-and-protocols.md) 5.1〜5.2 節 | 状態の文字列の `modseq` を 36 進で書くとしているが、例の `"1.1000"` などは 10 進に見える | Dev | 解決（2026-10-25：例を 36 進にした） |
| DOC-018 | Google Calendar | [time-zones-and-holidays.md](../systems/google-calendar/docs/architecture/time-zones-and-holidays.md)、[free-busy-and-scheduling.md](../systems/google-calendar/docs/architecture/free-busy-and-scheduling.md)、ADR-0017 | 「README の 6 節の持ち越しを閉じる」「持ち越していた」と書くが、指す項目が README にも design-log にもない | Dev | 解決（2026-10-25：持ち越しは design-log に移されていなかったので、経緯の説明と ADR-0017 の注記で示した） |
| DOC-019 | Workday | [payroll-engine.md](../systems/workday/docs/architecture/payroll-engine.md) 4.2 節 | 既定値（締日 20 日、支給日 25 日、3 営業日前）を 2026 年 12 月に当てると、締日から確定の期限までが実質 1 営業日になる。勤怠の締めと入力の固定の期限は値がない | PM、Ops | 解決（2026-10-25、推奨で決めた：期限を会社ごとの設定にし、営業日が 2 日より少ない月に警告。既定値は置かない） |
| DOC-020 | Salesforce | [orgs-users-and-auth.md](../systems/salesforce/docs/architecture/orgs-users-and-auth.md) 7.1 節 | 移行用の権限 `set_audit_fields_on_import` は既定でどの権限セットにもなく、自分の持たない権限は渡せない規則のため、誰も付けられなかった（FOL-005 の反映で見つかった） | Dev | 解決（2026-10-25、推奨で決めた：管理者の依頼で運用者が期限つき・2 人の承認で付ける） |

## 5. ADR が承認されたら直す文書

1 節の ADR が `accepted` になったら、合わせて直す箇所。ADR を退けたら、行を消す。

| ID | ADR | 直す箇所 | 状態 |
| --- | --- | --- | --- |
| FOL-001 | Slack ADR-0035（運用者のアクセス） | ADR-0009 のロールの表に `ops_read` を足す。infrastructure.md 1 節の「本番への書き込み権限は Ops のグループだけに与え」を JIT の形に | 解決（2026-10-25、ADR の承認と同時に直した） |
| FOL-002 | Stripe ADR-0035（CDE の外の運用者のアクセス。2026-10-25 に承認） | JIT の仕組みの選定（ADR-0020 の注記、E10 の PoC）と揃える | 待ち（E10 の PoC の後） |
| FOL-003 | GitHub ADR-0038（運用者のアクセス） | data-model.md 2.3 節（「運用者は break-glass」）、ADR-0028・0031 の書き方を JIT の形に | 解決（2026-10-25、ADR の承認と同時に直した） |
| FOL-004 | Notion ADR-0034（プランと権利） | data-model/global.md の権利の名前（`guest_limit` など）、api-and-integrations.md 5 節の 600 回の対象の書き方 | 解決（2026-10-25、ADR の承認と同時に直した。`workspace_entitlements` の表も定義した） |
| FOL-005 | Salesforce ADR-0064（Web からのリードのフォーム）と ADR-0065（本家からの移行）。どちらも 2026-10-25 に承認 | orgs-users-and-auth.md（ログインできないフォームの利用者、`set_audit_fields_on_import`）、governor-limits.md（`alloc.web_form_submissions`）、automation-flows.md（`$Origin` の `web_form`）、infrastructure.md（`forms.` のホスト） | 解決（2026-10-25：4 文書に反映した） |
| FOL-006 | Datadog ADR-0068（他の道具からの移行） | monitors-and-alerting.md に、取り込んだモニターと移行の待ちのダウンタイムを書く（変換器を作る E17 の後で足りる） | 待ち（ADR は 2026-10-25 に承認） |
| FOL-007 | X ADR-0064（本人のデータの書き出し。2026-10-25 に承認） | data-model/users-and-accounts.md の `data_export_requests` に目録のバージョンの列を足す | 解決（2026-10-25：catalog_version の列を足した） |
| FOL-008 | Gmail ADR-0044（安全な HTML の描画） | 浄化の許可の一覧に `lang`・`dir`・表の `role`・`scope`・`headers`・`abbr` を足す提案（web-client.md 17 節の持ち越し）。Dev とセキュリティの判断 | 解決（2026-10-25、推奨で決めた：lang・dir・scope・headers・abbr を許し、role は presentation と none だけ） |
| FOL-009 | 全題材 | primer の「読む順」に、今回足した文書（design-log.md、Dropbox の web-client.md など）が載っていない | 解決（2026-10-25：全題材の読む順に design-log.md、Dropbox に web-client.md を足した） |
| FOL-010 | 全題材 | architecture/README.md の 4 節（技術スタック）の多くに「エージェントにとっての理由」の列がない（[agents.md](agents.md) の 4 節） | 解決（2026-10-25：20 題材の 4 節に列を足した。GitHub・Notion・X は根拠がなく「—」。FOL-012 を参照） |
| FOL-011 | Workday payroll-engine.md 4.2 節（DOC-019） | 会社ごとの期限の設定（勤怠の締め、入力の固定、`released` の期限）を、data-model/payroll.md の `pay_groups` に列として足す。勤怠の締めと入力の固定に既定値を置くか（PM・Ops） | 待ち |
| FOL-012 | GitHub・Notion・X の ADR-0001 | 技術の選定に「エージェントにとっての理由」が書かれていない（README の 4 節の列が「—」）。書くなら ADR-0001 に注記で足す（Dev） | 待ち |
