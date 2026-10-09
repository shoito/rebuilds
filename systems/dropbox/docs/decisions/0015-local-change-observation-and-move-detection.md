---
status: accepted
date: 2026-10-09
---

# ADR-0015: 手元の変化は、Windows では ReadDirectoryChangesW を手がかりにして File ID で Local を直し、macOS では File Provider の呼び出しを手がかりにする。イベントが溢れたら、その部分を走査し直す。移動は File ID・項目の ID で結び、結べない削除は 3 秒待ってから削除とする。「一時のファイルに書いて置き換える」保存は、元のノードの中身の変更として扱う

## Context

3 つの木の Local は、手元のファイルシステムの観測から作る（[ADR-0006](0006-sync-conflict-model.md)）。観測の誤りは、そのまま同期の誤りになる。

- イベントは溢れる。Windows の ReadDirectoryChangesW は、溜めが溢れると中身を捨て、0 バイトを返す。記録できなかったときは `ERROR_NOTIFY_ENUM_DIR` で失敗し、列挙して求めるよう求める（[ReadDirectoryChangesW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-readdirectorychangesw)、2026-10-09 に確認）。
- 移動は「消えた」と「現れた」に分かれて届くことがある。取り違えると、大きなフォルダーを送り直し、バージョン履歴と共有リンクが切れる（[architecture/README.md](../architecture/README.md) の 6 節）。
- 多くのアプリは、一時のファイルに書いて元の名前へ置き換える。File ID が変わる。
- macOS は File Provider（replicated の拡張）を使うと決めた（[architecture/README.md](../architecture/README.md) の 6 節）。File Provider の領域では、OS が変化を拡張に知らせる。呼び出しの詳細は Apple の文書の本文で確かめられなかった（**未検証**）。

## Options

1. **イベントは手がかりにだけ使い、パスを stat して File ID・項目の ID で Local を直す。溢れたら走査し直す。結べない削除は待つ**
2. イベントの中身（操作の種類と名前）をそのまま当てる
3. 周期的に全体を走査する（イベントを使わない）
4. Windows の USN の変更ジャーナルを読む

## Decision

1 を採用する。詳細は [file-system-integration.md](../architecture/file-system-integration.md) の 4・5 節。

- Windows：同期のルートの全体に ReadDirectoryChangesW（溜め 1 MiB、非同期）。イベントを 200ms まとめ、パスを stat し、128 ビットの File ID で `local_nodes` を引いて直す。
- macOS：File Provider の拡張の呼び出し（作成・変更・削除）を手がかりにし、項目の ID で Local を直す。同期のルートの中で FSEvents は使わない。
- 0 バイトの返り・`ERROR_NOTIFY_ENUM_DIR`・5 秒以上の遅れ・スリープからの復帰・起動・拡張の起動し直しで、全体を走査し直す（1 秒 5,000 項目まで）。走査し直しは Synced を変えない。
- 消えたパスのノードは 3 秒待つ。その間に同じ File ID が別のパスに現れたら移動にする。現れなければ削除にする。
- 2 秒の窓の中で、パス P のノードの File ID が消え（か無視の名前へ移り）、P に新しい File ID が現れたら、P のノードの中身の変更にする。

### 他の案を選ばなかった理由

- **2（中身をそのまま）**：溢れ・順序の入れ替わり・移動の分かれで、Local が実際と食い違う。食い違いが削除の誤りになる。
- **3（周期の走査）**：100 万ファイルで、静かなときの CPU 1% 未満（NFR-008）に収まらない。保存から送信の開始まで p95 3 秒にも収まらない。
- **4（USN）**：ボリューム全体の変化を読むので、同期のルートの外の変化も処理する。管理者の権限の要る操作がある。ReadDirectoryChangesW と走査し直しで足りる。溢れの多い環境で足すかは、計測で決める。

## Consequences

- 良くなること：
  - 溢れても走査し直しで正しい Local に戻り、Synced と比べるので削除を誤らない。
  - 移動と置き換えの保存で、ノードの ID とバージョン履歴が続く。
- 引き受けるコスト：
  - 同期のルートの中の移動の確定が、最大 3 秒遅れる。
  - 走査し直しは、100 万ファイルで約 3.5 分の I/O を使う。
  - macOS の振る舞いは `placeholder-platform-survey` の結果に依る。

## Confirmation

- 性質ベーステスト：PROP-FS-001（走査し直しの一致）、PROP-FS-002（移動の保存）、PROP-FS-003（置き換えの保存）。
- 表駆動テスト：DT-FS-002（保存のしかた）、DT-FS-003（走査し直しのきっかけ）。
- 実機の試験：イベントの溢れ（大量の作成）、スリープと復帰、大量の移動、Office の保存（[quality.md](../quality.md) の 2.2.1 節 B）。
- 本番：走査し直しの率を端末の匿名の計測で見る（[quality.md](../quality.md) の 4.1 節）。
