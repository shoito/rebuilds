# Runbook: デプロイとロールバック（サーバー、Web のクライアント、Electron）

- Owner: Ops
- 対応するアラート: デプロイ中の自動ロールバック、拒否の率の急な上がり、クライアントのバージョンの後の移行の失敗、Web・Electron の段階の止める条件（[delivery.md](../architecture/delivery.md) の 5.1 節）、定期作業（リリース）
- 最終確認日: 2026-09-28

方針は [delivery.md](../architecture/delivery.md)、[ADR-0056](../decisions/0056-flags-client-distribution-and-min-build.md)、[ADR-0057](../decisions/0057-schema-change-ordering.md) にある。

## 症状

| 場面 | 見え方 |
| --- | --- |
| A. サーバーのリリース | 定期作業。または、デプロイ中に 5xx・拒否の率・送信から ack の p99・Relay の遅れのアラーム |
| B. Web のクライアントの段階の悪化 | 新しいバージョンの端末で、遅延・起動・拒否・エラー・`migration`・`corrupt` のやり直しが、古いバージョンより悪い |
| C. Electron の殻の問題 | 新しい殻のバージョンのクラッシュの率、起動の失敗の報告 |
| D. 収束の不一致・outbox の喪失が新しいバージョンで出た | 収束の監査の `unexplained`、`lost_local` 以外の喪失の報告 |

## 影響

- サーバーの障害は、書き込みの経路の SLO（99.9%）を消費する。ただし、クライアントは手元で読み書きを続け、outbox に貯める（NFR-006）。
- クライアントの不具合は、そのバージョンの端末だけに出る。段階の割合が小さいうちに止めれば、影響は小さい。
- 手元の DB のバージョン（`schema_version`）を上げた Web のバージョンは、戻せない（前のコードは新しい DB を開けない）。

## 確認

1. どの成果物の問題か：サーバー（ECS のデプロイの履歴）、Web（KeyValueStore のバージョンごとの割合と、RUM の `build` の別）、Electron（更新の案内の割合と、殻のバージョンの別）。
2. 直前の変更に、マイグレーション（広げる段か、消す段か）が含まれるか。含まれる消す段の後は、その前のバージョンへ戻さない（4.2 節）。
3. Web のバージョンが手元の DB のバージョンを上げたか（リリースのノートと `schema_version`）。
4. 拒否のコードの内訳（`invalid`・`forbidden`・`invalid_reference`）。クライアントとサーバーの規則のバージョンのずれを疑う。

## 対処

### A. サーバーのリリースとロールバック

1. 順序（[delivery.md](../architecture/delivery.md) の 4.1 節）：マイグレーション（広げる段だけ）→ writer → relay → gateway・sync-api → public-api・auth・worker → Web の資産を S3 に置く。
2. Gateway は 1 タスクずつ `kick: server_shutdown` で 10 分かけて逃がす。**全 Gateway を同時に入れ替えない**（再接続の殺到。[capacity.md](../architecture/capacity.md) の 3.3 節）。
3. 自動のロールバックが動いた・アラームが続く場合：
   1. ECS のサービスを 1 つ前のタスク定義に戻す（逆の順：worker → public-api → gateway・sync-api → relay → writer）。マイグレーションは戻さない（広げる段は前のバージョンで動く）。
   2. 拒否の率が戻るか、送信から ack の p99 が戻るかを 15 分見る。
   3. 戻らないなら、インシデントを宣言する（[incident-response.md](incident-response.md)）。
4. 書き込みを止める必要がある時の最後の手段は `ops.writes_enabled = false`。Writer は `retry` を返し、クライアントは outbox に貯める。**止めている間の時間を記録し、開いた後の送り直しの集中を見る**。

### B. Web のクライアント

1. KeyValueStore の割合を、前のバージョンに 100% 戻す。KeyValueStore の変更は数秒でエッジに届き（[delivery.md](../architecture/delivery.md) の 5 節）、その後の新しい起動に効く。
2. 新しいバージョンが手元の DB のバージョンを上げていた場合は、戻しても、そのバージョンを開いた端末は前のコードで DB を開けない。この場合は戻さずに、**修正のバージョンを前へ出す**。割合を止める（新しい端末に広げない）ことだけは行う。
3. 移行の失敗が出ている場合（`migration` のやり直し）：失敗しても outbox は残る（ADR-0005）。やり直しのブートストラップの負荷を Sync API で見る。
4. `min_build` を上げて古いバージョンを止めるのは、プロトコル・互換・セキュリティの理由の時だけ。上げても手元の読み書きは止まらない。

### C. Electron

1. 更新の案内の割合を 0 にする（まだ取っていない端末は取らない）。
2. 取った端末はバージョンを下げられないので、前のコードでバージョンの番号を上げたバージョンを作り、署名して、1% から出し直す（Chromium の修正を含む場合は 24 時間で 100%）。
3. 殻が起動しない場合は、利用者に Web の利用と、配布物の手動の入れ直しを案内する。outbox は Electron のデータの場所に残る。

### D. 収束・outbox に関わる不具合

1. [incident-response.md](incident-response.md) の「収束の不一致」に従う。
2. 原因のクライアントのバージョンの割合を止め、サーバーの規則のバージョンのずれなら、サーバーを戻す（A）。
3. 修正の前に、シミュレーターで再現した種を `sim/regressions/` に足す。

## エスカレーション

- 自動のロールバックの後も 15 分戻らない：SEV2 を宣言し、Dev のテックリードを呼ぶ。
- 手元の DB のバージョンを上げた Web のバージョンで、移行の失敗が 1% を超える：SEV2。
- Electron の殻が起動しない報告が複数：SEV2。
- 収束の不一致・outbox の喪失：SEV2 から（[incident-response.md](incident-response.md)）。

## 事後

- 調査結果を `changes/` の新しい `intent.md` として起票する（Maintain 段）。
- 関門（[delivery.md](../architecture/delivery.md) の 2 節）で見つけられなかった理由を書き、CI に足す。
- この手順で足りなかったことを、ここに反映する。
