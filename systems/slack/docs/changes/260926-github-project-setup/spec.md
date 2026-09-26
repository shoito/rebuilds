---
capability: delivery
change: 260926-github-project-setup
issue:
epic: E1
status: draft
---

# Spec: GitHub の Issue・Projects・App の設定と同期

## 概要

[project-management.md](../../../../../docs/project-management.md) の運用を動かすための設定と自動化を作る。対象は次のとおり。

- エージェント用の GitHub App（[ADR-0004](../../../../../docs/decisions/0004-agent-prs-via-github-app.md)）
- Issue types、ラベル、Issue Forms
- Project の項目とビュー
- 同期のワークフロー（`project-fields-sync`・`change-link`・`stage-sync`）
- 既存の変更フォルダへの Issue の割り当て

リポジトリと Project は Organization に置く前提である（[ADR-0003](../../../../../docs/decisions/0003-github-projects-for-planning.md)）。

範囲の外：

| 対象 | 置き場所 |
| --- | --- |
| `rollout-sync`（AppConfig からの連携）、`intent-from-incident` | E7（AppConfig・監視の基盤ができてから） |
| `weekly-report` と `agent-dispatch` | `agent-skills-foundation`（`pmo-weekly.yml`） |

## ADDED Requirements

### REQ-DLV-016: GitHub App の権限

システムは、エージェント用の GitHub App に、次の権限だけを与えなければならない。

- リポジトリの `contents: write`、`pull_requests: write`、`issues: write`
- Organization の Projects の `read and write`

レビューの承認・マージ・ruleset や `CODEOWNERS` の変更は、App の権限で行えてはならない。

#### Scenario: App でマージを試みる

- Given App のインストールのトークン
- When App が、承認済みの PR のマージの API を呼ぶ
- Then 失敗する（ruleset がバイパスを許すのは管理者のロールだけで、App はマージの必須の条件を満たせない）

#### Scenario: App で PR を承認しようとする

- Given App のトークン
- When App が PR にレビューの承認を送る
- Then `CODEOWNERS` の承認として数えられない（App は `CODEOWNERS` に含まれない）

### REQ-DLV-017: Issue types とラベルの定義

システムは、Organization の Issue types（Intent・Epic・Story・Bug・Task・Spike）と、`.github/labels.yml` のラベルを、定義どおりに保たなければならない。`labels.yml` が変わったら、ラベルを同期する。定義にないラベルがリポジトリにあれば、警告の Issue を起票する。

#### Scenario: ラベルを追加する

- Given `labels.yml` に `area:mcp` を加えた PR がマージされた
- When `labels-sync` が走る
- Then リポジトリに `area:mcp` が作られる

#### Scenario: 手で作ったラベル

- Given 誰かが画面から `urgent` のラベルを作った
- When `labels-sync` が走る
- Then `urgent` は消されず、定義にないラベルとして警告の Issue が 1 件起票される

### REQ-DLV-018: Issue Forms

システムは、Intent・Story・Bug・Spike の Issue Forms を提供しなければならない。どのフォームで起票しても、対応する Issue type と、選んだ題材の `system:*` のラベルが設定される。

#### Scenario: Story のフォーム

- When Story のフォームで、題材に `slack` を選んで起票する
- Then Issue type が Story、ラベルに `system:slack` が付く

### REQ-DLV-019: Project への追加と項目の同期

リポジトリに Issue か PR が作られたとき、システムはそれを Project に加え、Status を `Inbox` にし、`system:*` のラベルから System の項目を設定しなければならない。Story で Size が空なら、`needs:pm` のラベルを付けなければならない。

#### Scenario: Size のない Story

- When Size を決めずに Story を起票する
- Then Project に加わり、Status は `Inbox`、System は `slack`、ラベルに `needs:pm` が付く

### REQ-DLV-020: 変更フォルダと Issue のつなぎ

`systems/*/docs/changes/*/spec.md` を追加・変更する PR に対して、システムは DT-DLV-006 に従って検査しなければならない。通ったら、PR と Issue をつなぎ、Issue の Change と Flag の項目を設定しなければならない。

#### Scenario: 正しくつながった

- Given `spec.md` の frontmatter が `issue: 42` で、#42 の Issue type が Story
- When PR を作る
- Then 検査が通り、#42 の Change に `YYMMDD-<slug>` が入り、PR の本文から #42 が参照される

#### Scenario: Story でない Issue を指している

- Given `issue: 43` で、#43 の Issue type が Bug
- When PR を作る
- Then 検査が失敗し、理由が PR に出る

### REQ-DLV-021: Stage の同期

`main` への push、PR の状態の変化、Issue の Type の変化があったとき、システムは DT-DLV-007 に従って Stage の項目を設定しなければならない。人が Stage を手で変えても、次の同期で決まりどおりの値に戻さなければならない。

#### Scenario: spec が承認された

- Given #42 の Stage が `Design`
- When `spec.md` の `status` を `approved` にした PR がマージされる
- Then #42 の Stage が `Build` になる

#### Scenario: 手で書き換えた

- Given #42 の Stage を、人が `Release` に変えた
- When 次の同期が走る
- Then #42 の Stage は `Build` に戻る

### REQ-DLV-022: `agent:ready` を付けられる人

`agent:ready` のラベルが付いたとき、付けた人が PM か Dev のチーム（Organization のチーム `pm`・`dev`）に属していなければ、システムはラベルを外し、理由をコメントしなければならない。

#### Scenario: QA のメンバーが付けた

- Given チーム `qa` だけに属する人
- When その人が `agent:ready` を付ける
- Then ラベルが外れ、「`agent:ready` は PM か Dev が付ける」とコメントが付く

### REQ-DLV-023: 既存の変更への Issue の割り当て

この変更を適用したとき、システムは、`issue` が空の変更フォルダのそれぞれについて、Story の Issue を作り（親は frontmatter の `epic` の Epic）、`spec.md` の `issue` を埋める PR を作らなければならない。Epic の Issue がなければ、`roadmap.md` の Epic の一覧から作る。

#### Scenario: E1 の 11 件

- Given `issue` が空の、E1 の変更フォルダが 11 件ある
- When 割り当てのスクリプトを実行する
- Then Epic E1 の Issue の下に、Story の Issue が 11 件でき、11 件の `spec.md` の `issue` を埋める PR が 1 件できる

## Decision Tables

### DT-DLV-006: 変更フォルダと Issue のつなぎの検査

上から順に評価し、最初に一致した行を採用する。

| # | `issue` の値 | Issue の存在 | Issue type | Issue の状態 | → 結果 |
| --- | --- | --- | --- | --- | --- |
| 1 | 空 | - | - | - | 失敗（REQ-DLV-023 の割り当ての前は、警告にとどめる） |
| 2 | 番号 | なし | - | - | 失敗 |
| 3 | 番号 | あり | Story 以外 | - | 失敗 |
| 4 | 番号 | あり | Story | 閉じている | 失敗（閉じた Story に変更を足さない） |
| 5 | 番号 | あり | Story | 開いている | 成功。PR と Issue をつなぎ、Change・Flag を設定する |

### DT-DLV-007: Stage の決め方

[project-management.md](../../../../../docs/project-management.md) の 6.2 節のうち、この変更で扱うもの。Test・Deploy・Release は E7 で足す。

| # | Issue type | 変更フォルダ | `spec.md` の `status` | → Stage |
| --- | --- | --- | --- | --- |
| 1 | Intent | - | - | `Plan` |
| 2 | Story | なし | - | `Design` |
| 3 | Story | あり | `draft` | `Design` |
| 4 | Story | あり | `approved`・`in-progress` | `Build` |
| 5 | Story | あり（archive 済み） | `done` | `Maintain` |
| 6 | Bug・Task・Spike・Epic | - | - | 空（Stage を使わない） |

## Correctness Properties

### PROP-DLV-005: Stage は成果物だけで決まる

任意の成果物の状態と、任意の手での書き換えの列について、同期を 1 回走らせた後の Stage は、DT-DLV-007 が成果物から決める値と等しい。同期を何回走らせても、結果は変わらない（冪等）。

## Design

- **設定のうち、コードで持てるもの。**
  - `.github/labels.yml`
  - `.github/ISSUE_TEMPLATE/*.yml`
  - ワークフロー
  - `tools/project/setup.ts`：Project の項目とビューを、GraphQL で冪等に作る。
- **画面でしか設定できないもの。** Issue types の作成、Project の組み込みのワークフロー（Auto-add、Item closed など）、App の作成。これらは、`tools/project/README.md` に手順を書き、`tools/project/verify.ts` で設定を読み出して検査する。
- **ワークフローの認証。** App のインストールのトークンを、`actions/create-github-app-token` で、ジョブごとに発行する。秘密鍵は、リポジトリの Secrets に置く。
- **既存の運用との関係。** DT-DLV-006 の 1 行目は、REQ-DLV-023 の割り当てがマージされるまで警告にとどめ、その後に失敗に切り替える。切り替えは、この変更の最後の PR で行う。

## Open questions

- Organization のチーム（`pm`・`dev`・`qa`・`ops`）と `CODEOWNERS` をどう対応させるか（1 人の間は、全チームに `@shoito` だけが入る）。
- App の秘密鍵の入れ替えの頻度（ADR-0017 の署名鍵に合わせて 90 日とする案）。
