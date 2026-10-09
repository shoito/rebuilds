---
status: accepted
date: 2026-10-09
---

# ADR-0049: 段階を上げる基準を Aurora の writer・容量・表の大きさ・commit のピーク・接続の数で決め、上限の 70% で次の段階の準備を始める。S2 は名前空間の持ち主のテナントを単位に Aurora のクラスタへ分け、ディレクトリを小さなクラスタに置く。S3 はセルとリージョン

## Context

- 規模の段階は S1（25 億ノード、commit のピーク 5,000 件/秒）、S2（250 億、50,000 件/秒）、S3（1,250 億、250,000 件/秒）（[architecture/README.md](../architecture/README.md) の 2 節）。S2 は名前空間の持ち主のテナントを単位に複数のクラスタへ分けると書いた。段階を上げる基準は infrastructure の領域で決める。
- Aurora PostgreSQL 17.5 以降のクラスタの容量の上限は 256 TiB、PostgreSQL の表の上限は 32 TiB（[Quotas and constraints for Amazon Aurora](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/CHAP_Limits.html)、2026-10-09 に確認）。
- 名前空間の表は `tenant_id`・`ns_id` を持ち、ブロックの索引と参照はテナントの中で閉じる（[ADR-0003](0003-dedupe-scope-and-privacy.md)、[ADR-0004](0004-tenancy-namespaces-and-rls.md)）。共有フォルダーは持ち主のテナントの名前空間で、他のテナントのメンバーが載せる。カーソルは名前空間ごとの位置の組である（[ADR-0005](0005-namespace-journal-and-cursors.md)）。
- 他の題材（Google Calendar の ADR-0045）は、テナントの単位のクラスタとディレクトリのクラスタ、S3 のセルを決めた。

## Options

S2 の分け方：

1. **名前空間の持ち主のテナントを単位にクラスタへ分ける**
2. 名前空間を単位にクラスタへ分ける（同じテナントの名前空間が別のクラスタにありうる）
3. Aurora Limitless Database などの分散の DB に移す

## Decision

1 を採用する。

### 段階を上げる基準

| 指標 | S1 の上限（想定） | 準備を始める |
| --- | --- | --- |
| Aurora の writer の CPU（ピークの p95） | 70% | 50% が 4 週続く |
| commit のピーク | 5,000 件/秒 | 3,500 件/秒 |
| クラスタの容量 | 256 TiB | 100 TiB |
| 最大の表（分割の 1 つ） | 32 TiB | 10 TiB |
| ノード | 25 億 | 17.5 億 |
| `notify` の同時の接続 | 40 万 | 28 万 |

- 月次のキャパシティのレビューで見る。移行に四半期かかる前提で、上限の 70% で準備を始める。

### S2

- テナントのすべての名前空間・ブロックの索引・参照・`logical_bytes` を同じクラスタに置く。commit はクラスタをまたがない。
- ディレクトリのクラスタ（Global Database）に、RLS の外の表（アカウント、`auth`、`ns_directory`、`ns_access`、`link_tokens`、`tenant_directory`）を置く。
- `list/continue` は名前空間をクラスタごとにまとめて読む。カーソルの形は変えない。名前空間をまたぐ移動とコピーは、既にあるバッチの非同期の操作で、クラスタをまたいでも動く。
- Relay・GC・照合・`quota` はクラスタごとに動かす。テナントの移し方は S2 の着手の前に別の ADR で決める。

### S3

- スタック一式をセルとして複製し、テナントをセルとリージョンに固定する。ディレクトリだけを全体で持つ。入口のエッジでトークンからセルを引いて振り分ける。別のセルの共有フォルダーは、持ち主のセルへ内部の経路で送る。

### 他の案を選ばなかった理由

- **2（名前空間の単位）**：重複排除の答えとブロックの索引（テナントの単位）が、クラスタをまたぐ。1 回の commit の参照の更新が複数のクラスタに分かれる。
- **3（分散の DB）**：`SET LOCAL` の RLS、`FORCE ROW LEVEL SECURITY`、行のロックでの直列（[ADR-0005](0005-namespace-journal-and-cursors.md)）の振る舞いを確かめ直す必要があり、S1 の設計の前提が変わる。S2 の前に、他の選択肢と比べる余地は残す。

## Consequences

- 良くなること：
  - commit・重複排除・GC がクラスタの中で閉じる。
  - カーソルとクライアントの契約を変えずに分けられる。
- 引き受けるコスト：
  - 最大のチーム（S2 で 10 万席）が 1 つのクラスタに収まる必要がある。収まらないテナントは、S2 の前に別に扱う。
  - ディレクトリのクラスタが、すべての要求の名前空間の解決の経路に入る。Valkey にキャッシュする。
  - クラスタをまたぐ `list/continue` の遅れ。

## Confirmation

- 月次のキャパシティのレビューで、上の表の値をダッシュボードから見る。基準を超えたら Intent を起票する。
- S2 の前の PoC：2 つのクラスタにテナントを分けた staging で、共有フォルダーをまたぐ `list/continue` の p99 が NFR-010 を満たす。
