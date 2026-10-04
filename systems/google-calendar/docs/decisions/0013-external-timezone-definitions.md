---
status: accepted
date: 2026-10-04
---

# ADR-0013: 外から来た TZID は、正規の名前、別名、製品の接頭辞、Windows のゾーン名、VTIMEZONE の遷移の照合の順で IANA のゾーンに解き、解けなければ近いものに寄せて印を付ける。知っている TZID の VTIMEZONE は使わず、書き出す VTIMEZONE は本システムの tzdb から作る

## Context

[ADR-0002](0002-time-representation.md) は、時刻つきの予定の TZID を IANA の tzdb のゾーンにし、オフセットを `packages/tzdata` からだけ求めると決めた。

ところが、外から来る TZID は IANA の名前とは限らない。RFC 5545 の 3.2.19 節は TZID の値の形を決めておらず、VTIMEZONE（3.6.5 節）で定義を一緒に送る形である。実際には次が来る（相互運用の試験で集める。種類の多さは未検証）。

- tzdb の別名（`Japan`、`US/Eastern`、`Asia/Calcutta`）
- 製品の接頭辞つきの名前（`/mozilla.org/20050126_1/Asia/Tokyo` など）
- Windows のゾーン名（`Tokyo Standard Time`）
- 独自の名前と VTIMEZONE の定義だけ

送り手の tzdb の版は、本システムと違いうる。

## Options

知らない TZID：

1. **段を決めて IANA のゾーンに解き、解けなければ近いものに寄せて印を付ける**
2. 送り手の VTIMEZONE の定義を、そのまま独自のゾーンとして保存して使う
3. 拒否する

知っている TZID の VTIMEZONE：

- a. **使わず、本システムの tzdb で解く**
- b. 送り手の定義を優先する

## Decision

1 と a を採用する。段の表は [time-zones-and-holidays.md](../architecture/time-zones-and-holidays.md) の 7.1 節。

- `packages/tz` の `normalizeTzid` が、正規の名前 → `backward` のリンク → 製品の接頭辞を外した末尾 → Unicode CLDR の `windowsZones`（地域 `001`）→ VTIMEZONE の遷移の照合（DTSTART の年の前年から 3 年後）の順に解く。
- 照合で複数のゾーンが当たれば、カレンダーのタイムゾーン、利用者のタイムゾーン、`zone1970.tab` の順で選ぶ。
- 当たらなければ、DTSTART の時点のオフセットが同じで、遷移の一致が最も多いゾーンに寄せる。それもなければ `Etc/GMT±N`（整数の時間）か `utc` の時刻にする。どちらも `tz_approximated` の印を付けて利用者に示す。
- 元の TZID は `X-<BRAND>-ORIGINAL-TZID` に残す。
- 知っている TZID の VTIMEZONE の定義は使わない。送り手と本システムでオフセットが違えば、`vtimezone_mismatch` を数え、壁時計の時刻を保つ。
- 書き出す VTIMEZONE は、本システムの tzdb の版から、予定の回の範囲に合わせて作る。`TZID` は IANA の正規の名前にする。
- 対応表（別名、`windowsZones`、遷移の指紋）は `packages/tzdata` の版に含め、tzdb の更新と同じ流れで更新する。

### 他の案を選ばなかった理由

- **2（独自のゾーンとして保存）**：オフセットの元が `packages/tzdata` の外に増え、tzdb の更新の計算し直しの対象にならない。同じ現地のゾーンの予定が、送り手ごとに別のゾーンになる。
- **3（拒否）**：Outlook・Exchange からの招待の多くを受けられなくなる見込み（Windows のゾーン名を使うため。未検証）。
- **b（送り手の定義を優先）**：送り手の tzdb が古いと、改正の後の時刻を誤る。同じ TZID の予定が、送り手ごとに違う UTC になり、[ADR-0002](0002-time-representation.md) の「すべての経路で同じ版の同じ規則」に反する。

## Consequences

- 良くなること：
  - すべての予定の TZID が IANA のゾーンになり、tzdb の更新の計算し直しの対象に入る。
  - 書き出しの VTIMEZONE が、本システムの中の時刻と常に一致する。
- 引き受けるコスト：
  - 照合の誤り（同じ遷移を持つ別の国のゾーンへ寄せる）が起きうる。将来の改正で、その 2 つのゾーンが分かれると、予定がずれる。印と元の TZID を残して、後から直せるようにする。
  - Windows のゾーン名の対応表の更新を追う必要がある。

## Confirmation

- 表駆動テスト：DT-TZ-001（7 段）を、合成の TZID と VTIMEZONE の集まりで確かめる。
- 性質ベーステスト：PROP-TZ-005（書き出した VTIMEZONE を照合すると元のゾーンに解ける）。
- 相互運用の試験：対象のクライアントと外部のカレンダーの招待で、TZID の形を記録し、すべてが段 1〜5 で解けることを確かめる。
- 本番：`tz_approximated`・`vtimezone_mismatch` の件数を監視する。
