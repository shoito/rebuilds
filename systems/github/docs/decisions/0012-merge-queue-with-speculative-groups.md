---
status: accepted
date: 2026-09-26
---

# ADR-0012: merge queue は、投機的なグループの ref を作り、検査を通った SHA を早送りで取り込む

> 識別子（ヘッダー・接頭辞・ドメイン・環境変数・パスの名前）は、リポジトリ共通の [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md) に合わせて `<Brand>`・`<brand>`・`<BRAND>` の置き換え用の名前にした（2026-09-26）。本家の名前は、出典の説明としてだけ書く。

## Context

変更の多いブランチで「必須のチェックが通った PR だけを取り込む」を保証するには、次の 2 つの方法がある。

- 最新の base を必須にする（strict）：base が動くたびに、すべての PR で「ブランチの更新」と CI をやり直す必要がある。
- 最新の base を必須にしない：個々の PR は通っていても、組み合わせで base が壊れうる。

本家の merge queue は、キューに入れた PR を、base の最新とキューの前の PR と合わせた一時的なブランチで検査し、通ったものを取り込む（[Managing a merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)）。

- 一時的なブランチは `<brand>-readonly-queue/{base}/...` の名前を持つ。
- CI には `merge_group` の Event が届く（[Events that trigger workflows](https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows)）。

## Options

1. **投機的なグループの ref を作り、そのコミットで検査し、通ったらその SHA へ base を早送りする（本家と同じ）**
2. PR を 1 つずつ、base の最新の上で順に検査して取り込む（直列）
3. 検査の後に、取り込むときにマージのコミットを作り直す

## Decision

1 を採用する。詳細は [pull-requests.md](../architecture/pull-requests.md) の 8 節にある。

- **キューに入れる条件は、PR の規則を満たすこと。** 承認・コードオーナー・会話の解決・head のチェックを満たす必要がある。最新の base は要求しない。
- **グループのコミットは、「取り込んだ後の base の姿」そのものにする。**
  - base の最新の上に、キューの前の PR から順に、キューの設定の方式（merge・squash・rebase）でコミットを積む（[ADR-0010](0010-server-side-merge-and-diff.md) の RPC）。
  - 各 PR の位置に ref `<brand>-readonly-queue/{base}/pr-{number}-{head_sha}` を作る。名前の形は本家（`gh-readonly-queue/`）に揃え、接頭辞だけを ADR-0006 で置き換える。外部の CI の設定は、接頭辞の置き換えで流用できる。
- **必須のチェックは、グループのコミットの SHA で判定する。** CI には `merge_group.checks_requested` を送る。
- **取り込みは、検査した SHA への base の早送り（比較交換）にする。** 作り直さないので、検査したものと取り込むものが一致する。取り込みの前に ruleset の push の規則を再評価する（[ADR-0011](0011-rulesets-as-single-protection-model.md)）。
- **失敗した PR は外し、その後ろのグループを作り直す。** base が他の経路（バイパスの push）で動いたら、比較交換が失敗するので、すべてのグループを作り直す。
- **キューの状態は DB を正本とし、base のブランチごとに 1 つの単一ライターの Worker が進める。**
  - グループの ref は Git に作り、捨てたら消す（`merge_group.destroyed`）。
  - Worker の排他は、base のブランチのキーのリースで行う。
- **設定は本家に揃える。**
  - 同時に作るグループの数：1–100
  - 1 回に取り込む PR の数の最小・最大：1–100
  - 最小に満たないときの待ち時間
  - 失敗していないものだけ取り込むか
  - チェックの待ち時間の上限
- 2 は、CI の時間 × PR の数だけ取り込みが遅れ、変更の多いブランチで詰まる。
- 3 は、検査していないコミットを base に入れることになる。コミットの日時や署名が変われば SHA も変わり、「通った SHA」と「入った SHA」が一致しない。

## Consequences

- 良くなること：
  - base は常に、必須のチェックを通った SHA だけを指す。
  - strict のときのような「ブランチの更新」の繰り返しがない。
  - 本家の `merge_group` の Event と ref の名前に合わせるので、既存の CI の設定を流用できる。
- 引き受けるコスト：
  - 投機的に作るグループの分だけ、CI の実行が増える。前のグループが失敗すると、後ろの検査は捨てられる。
  - キューの状態遷移（入れる・外す・作り直す・タイムアウト・base の変化）が複雑で、ステートマシンのテストが要る。
  - `merge_group` を契機に持たない CI は、キューで検査されず、取り込みが止まる。設定の画面と、チェックの待ちの状態で案内する。

## Confirmation

- 性質ベーステスト：任意の PR の列・チェックの成否・base への割り込みの push で、次が成り立つ。
  - base が指す SHA は、必須のチェックが成功した SHA か、バイパスの push の SHA に限られる。
  - キューから外された PR の変更が base に入らない。
- ステートマシンのテスト：すべての状態と Event の組み合わせで、未定義の遷移がない。
- 監視：キューの長さ、PR がキューに入ってから取り込まれるまでの時間、作り直しの回数。
