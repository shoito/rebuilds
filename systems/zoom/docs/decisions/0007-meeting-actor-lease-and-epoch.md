---
status: accepted
date: 2026-09-27
---

# ADR-0007: Meeting Actor の持ち主は Valkey のリース（TTL 6 秒）で決め、取るたびに epoch を上げる。失ってはならない変更は配る前に Aurora に書く

## Context

[ADR-0005](0005-meeting-state-and-signaling.md) は、会議ごとに 1 つの Meeting Actor が状態の正本になり、持ち主をリースで決め、フェンシングの番号（`epoch`）で二重化を防ぐと決めた。数値と、どこで `epoch` を検査するかは、この領域に残された。

条件は次のとおり。

- Actor の障害で、制御は 10 秒以内に戻る（NFR-004）。
- 分断や GC の長い停止で、古い持ち主が「まだ自分が持ち主だ」と思い込むことがある。リースだけでは防げず、受け手の側での `epoch` の検査が要る（Martin Kleppmann「[How to do distributed locking](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html)」、2016、2026-09-27 に確認）。
- Valkey は失われても会議が続く前提（[architecture/README.md](../architecture/README.md) の 1 節）。一方で、「退出させた人は再び入れない」（intent.md の守るべき振る舞い）は、Valkey を失っても守る必要がある。

## Options

リースの長さ：

1. **TTL 6 秒、2 秒ごとに更新、4.5 秒で自分で止まる**
2. **TTL 15 秒（切り替えは遅いが、Valkey の短い停止に強い）**
3. **TTL 3 秒（切り替えは速いが、誤った切り替えが増える）**

失ってはならない変更：

- a. **退出させる・ロック・役割の変更・待合室の設定は、配る前に Aurora に書く**
- b. **すべて Valkey のスナップショットに頼る**

## Decision

1 と a を採用する。詳細は [signaling-and-meetings.md](../architecture/signaling-and-meetings.md) の 5.3・5.4・10 節。

- リースは `mtg:{m}:lease = {host_id, epoch}`、TTL 6,000ms。取るときに `mtg:{m}:epoch` を `INCR` する（Lua のスクリプトで 1 回に行う）。
  - > 2026-09-28 の注記：Valkey を失うと `mtg:{m}:epoch` が 1 から数え直しになり、Aurora と Media Node と Gateway が新しい持ち主を拒む。そこで、取るときに下限（Aurora の `meeting_instances.actor_epoch` と、取得を頼む Gateway が見た最大の `epoch` の大きい方＋ 1）を渡し、`epoch = max(INCR, 下限)` にする。Media Node の `409 stale_epoch` は見た最大の `epoch` を返し、Actor はその値＋ 1 を下限にして取り直す（[data-model.md](../architecture/data-model.md) の 11.2 節の 16）。`epoch` が減らないという決定の中身は変えない。
- 持ち主は 2 秒ごとに更新する。最後に更新できた時から 4.5 秒で、新しい操作の受け付けと外への指示を止める。
- `epoch` を、Media Node・Signaling Gateway・Aurora の書き込みの 3 か所で検査する。Media Node と Gateway は会議ごとに見た最大の `epoch` を覚え、小さい指示を拒否する。Aurora は `actor_epoch <= :epoch` を条件にした更新にする。
- 退出させる・ロック・役割の変更・待合室の設定は、Aurora に書けてから `seq` を振って配る。その他（ミュート、挙手など）は Valkey のスナップショット（500ms ごと）だけに置く。
- 回復は、スナップショット・Aurora・Media Node の一覧・クライアントの申告を突き合わせて行う。最悪の回復の見積もりは約 8 秒。
- 2 を採らない理由：最悪の回復が 15 秒を超え、NFR-004 の 10 秒に入らない。
- 3 を採らない理由：ElastiCache の primary の切り替えや、Node.js の GC の停止で、誤った切り替えが増える。切り替えのたびにスナップショットの再送が全員に走る。
- b を採らない理由：Valkey を失うと、退出させた人が再び入れてしまう。

## Consequences

- 良くなること：
  - 二重の持ち主が生じても、古い指示はメディアと記録に届かない。
  - 退出させた記録が、Valkey の喪失を越えて残る。
- 引き受けるコスト：
  - Valkey の primary の切り替えが 4.5 秒を超えると、その間のすべての会議で Actor が止まり、切り替えの後に取り直しが集中する。取り直しを乱数で散らす。
  - 退出させる操作などは、Aurora の書き込みの分（p99 数十 ms の見込み。**未検証**。E3 の `removal-ban-durable` で測る）遅れる。
  - Media Node と Gateway は、会議ごとの最大の `epoch` を持つ必要がある。

## Confirmation

- 障害の注入の試験：Actor Host の `SIGKILL` から、主催者の操作が効くまで 10 秒以内。メディアの途切れはない。
- 障害の注入の試験：Actor Host と Valkey の分断で、古い Actor が 4.5 秒以内に止まり、その後の古い `epoch` の指示が Media Node で拒否される。
- 性質ベーステスト：PROP-SIG-003（退出させた人は、持ち主の交代をはさんでも入れない）、PROP-SIG-004（古い `epoch` の指示で Media Node が変わらない）。
