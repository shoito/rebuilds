---
status: accepted
date: 2026-09-27
---

# ADR-0031: すべての会議に待合室かパスコードを必ず付け、待合室は身元でしか省けない。パスコードは既定 6 桁の数字で、暗号化と HMAC で持つ

## Context

会議の URL や ID が漏れると、知らない人が入り込む（[intent.md](../intent.md) の Problem）。intent.md は「待合室もパスコードもない会議は作れない」を守るべき振る舞いにしている。本家も 2020-09-27 から同じ規則である（[May 2020: Passcode and security settings](https://support.zoom.us/hc/en-us/articles/360042647952-May-2020-Passcode-and-security-settings)、2026-09-27 に確認）。

会議の ID は秘密ではなく、URL のフラグメントの参加の鍵はパスコードの入力だけを省く（[ADR-0006](0006-meeting-id-and-join-url.md)）。[signaling-and-meetings.md](../architecture/signaling-and-meetings.md) の 16 節は、「参加の鍵を持つ人に待合室も省かせるか」を、この領域の判断に委ねている。

本家は、待合室を省く条件として、同じアカウントのユーザー、許可したドメイン、会議の中から招待した人などを選ばせる（[Enabling and customizing the waiting room](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0059359)、2026-09-27 に確認）。パスコードは、組織の設定で要件を選べ、招待のリンクに埋め込める（[Managing Zoom Meetings passcodes](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0063160)、2026-09-27 に確認）。

主催者は招待のためにパスコードを見る必要があるので、ハッシュだけでは持てない。電話からの参加（MVP の後）では、押しボタンで入力できる数字が要る。

## Options

1. **待合室かパスコードを必ず付ける（既定は両方）。待合室は身元の条件でしか省けない。パスコードは既定 6 桁の数字**
2. **1 と同じ。ただし、参加の鍵かパスコードを持つ人は待合室を省ける**
3. **待合室を常に必須にし、パスコードは任意にする**

## Decision

1 を採用する。詳細は [meeting-security.md](../architecture/meeting-security.md) の 3〜5 節。

- **不変条件**：`waiting_room = false` かつ `passcode = null` の会議を作れない。すべての経路（API、組織の設定、カレンダー、公開 API、予定の更新）で、同じ検査関数 `assertJoinGuard` を通す。組織の設定で「両方を無効にする」ことはできない。
- **既定**：待合室とパスコードの両方を有効にする。待合室だけの会議は、参加の要求で存在が分かるため。
- **待合室を省く条件**：共同主催者の指名、同じ組織のログインした人（組織の設定、既定は省く）、許可したドメイン、招待したアカウント（会議の設定、既定は省かない）、会議の中からの招待（`host.invite`）。参加の鍵とパスコードでは省かない。
- **パスコード**：既定は 6 桁の数字。組織の設定で長さ 6〜10、英数字を選べる。英数字の会議は、電話用の数字のパスコードを別に持つ。同じ数字の繰り返し、連番、会議の番号の一部を禁止する。
- **保存**：KMS で守るデータの鍵で暗号化した値（主催者と管理者の表示用）と、`HMAC-SHA256(pepper, meeting_id || passcode)`（照合用、定数時間で比べる）を持つ。
- 2 を採らない理由：URL が漏れたときに、主催者が確かめる機会がなくなる。「URL を知っている」ことは身元ではない。
- 3 を採らない理由：主催者のいない会議（`join_before_host`）や、大勢の社内の定例で、主催者の負担が大きい。パスコードだけで守れる会議を残す。

## Consequences

- 良くなること：
  - URL が漏れても、待合室が有効な会議では主催者が確かめられる。
  - 待合室を省く判断が、ログインした身元（組織、確認済みのメール）に結び付く。
  - 電話からの参加に、同じ規則のまま対応できる。
- 引き受けるコスト：
  - 社外の人との会議では、主催者が待合室から入れる操作が増える。
  - 6 桁の数字は推測に弱いので、流量の制限（[ADR-0033](0033-join-rate-limits-and-enumeration-defense.md)）が欠かせない。
  - パスコードを復号できる形で持つので、KMS の鍵と復号の権限の管理が要る。

## Confirmation

- 性質ベーステスト：任意の設定の操作の列の後、待合室もパスコードもない会議が 0 件（PROP-SEC-001）。
- 性質ベーステスト：`bypass_waiting` が偽の人は、主催者の `admit` なしに入れない（PROP-SEC-003）。
- lint：会議の設定を書く関数が、`assertJoinGuard` を通らずに `meetings` を更新していない（書き込みの関数を 1 か所に集め、他からの `UPDATE meetings SET settings` を禁止する）。
- 本番：毎日の設定の監査で、待合室もパスコードもない会議を数え、0 でなければアラートにする（K6）。
