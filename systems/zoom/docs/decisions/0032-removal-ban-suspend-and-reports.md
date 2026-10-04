---
status: accepted
date: 2026-09-27
---

# ADR-0032: 退出させたゲストは端末の鍵で ban し、同じ回線は待合室に回す。活動の一時停止は 1 回の操作で行い、報告は会議の中から送る

## Context

intent.md は「主催者が退出させた参加者は、同じ会議に再び入れない（主催者が許すまで）」を守るべき振る舞いにし、K6 で「第三者の入り込みの報告に、主催者が 1 回の操作で対処できる」を求める。

退出させる操作の判定と強制は [ADR-0009](0009-host-controls-enforcement.md) と [signaling-and-meetings.md](../architecture/signaling-and-meetings.md) の 9 節にあり、ban の鍵は「`user_id`（ゲストは端末の鍵。meeting-security.md）」とされている。

ゲストはアカウントを持たないので、同じ人を確実に見分ける方法がない。ブラウザの保存領域は消せる。IP は、同じ会社や携帯の回線で多くの人が共有する。

本家には、「Suspend participant activities」（全員の映像・音声・Zoom Apps・画面共有を止め、会議をロックする。[Changing security settings in a Zoom meeting](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0061231)、2026-09-27 に確認）と、参加者の報告（主催者・共同主催者が、理由と添付を付けて Trust and Safety に送る）がある（後者は [3 New Ways We're Combatting Meeting Disruptions](https://www.zoom.com/en/blog/new-ways-to-combat-zoom-meeting-disruptions/)、2026-09-27 に確認）。

## Options

ゲストの ban の鍵：

1. **端末の鍵（ブラウザに置く乱数）で ban し、同じ回線からの参加は待合室に回して印を付ける**
2. **IP で ban する**
3. **ブラウザの指紋（端末の情報の組み合わせ）で ban する**

一時停止：

4. **1 回の操作で、主催者・共同主催者以外のマイク・カメラ・共有・チャット・名前の変更を止め、ロックし、待合室を有効にし、録画を一時停止する**
5. **本家のように、録画も止める**

## Decision

1 と 4 を採用する。詳細は [meeting-security.md](../architecture/meeting-security.md) の 6 節。

- **ban**：アカウントは `user_id`、ゲストは端末の鍵（初回の起動で作る 128 ビットの乱数を IndexedDB に置き、サーバーは HMAC だけを持つ）。効く範囲は同じ `meeting_id`（繰り返しの会議と PMI の別の回を含む）。最後の開催から 30 日で消す。主催者は `host.readmit` で許せる。
- **同じ回線**：退出させたゲストと同じ回線（IPv4 の /32、IPv6 の /64）からのゲストは、拒否せず待合室に回し、主催者に印を見せる。
  - > 2026-09-27 の注記：同じ回線の判定に使う `ip_prefix_hash` の pepper は 30 日ごとに替える（[meeting-security.md](../architecture/meeting-security.md) の 10 節）。替えた後も前の pepper を 30 日残し、照合では今と前の両方で計算して比べる。`meeting_removals` には、計算に使った pepper のバージョンを残す。これで、同じ回線の印は退出させてから少なくとも 30 日効く。ban の本体（`user_id`・端末の鍵）は pepper に依らず、最後の開催から 30 日まで効く。
- **一時停止（`host.suspend`）**：1 つの `seq` の差分で、主催者・共同主催者以外のマイク・カメラ・共有を Media Node で止め、チャットと名前の変更を止め、ロックし、待合室を有効にし、録画を一時停止にする。解除は項目ごとに行い、一括の解除は作らない。
- **報告**：会議の参加者の全員が、会議の中から送れる。サーバーは、報告された人の表示の名前、`user_id` か端末の鍵、参加の時刻、回線のハッシュ、ASN を自動で添える。会議の音声・映像・チャットの本文は自動で添えない。報告した人が自分の端末の画面の画像を付けられる（扱いは L2 に従う）。運営の Trust & Safety が、アカウントの停止と、全体の端末の ban（90 日）で対処する。
- 2 を採らない理由：同じ会社や携帯の回線の、関係のない人まで締め出す。IP を変えれば逃れられる。
- 3 を採らない理由：端末の情報を集めることは、外部送信規律（L5）とプライバシーの整理が重い。精度も保証できない。
- 5 を採らない理由：止めた録画を再開し忘れると、会議の残りが録られない。荒らしの証拠の録画も途切れる。一時停止なら、主催者が再開するまで録らず、区間は 1 つの録画に残る（[ADR-0025](0025-recording-per-track-capture-and-offline-compose.md)）。

## Consequences

- 良くなること：
  - 荒らしに対して、主催者が 1 回の操作で会議を静められる。
  - 関係のない人を拒否せずに、主催者の判断に委ねられる。
  - 報告に、運営が対処に要る身元の情報が自動で揃う。
- 引き受けるコスト：
  - ブラウザの保存領域を消し、別の回線から入り直すゲストは防げない。待合室とロックで補う。
  - 報告と IP の保持、開示の請求の扱いが、法務の確認待ち（L4・L8）になる。
  - Trust & Safety の運用（人の確認）が要る。

## Confirmation

- 性質ベーステスト：`host.remove` の後、`host.readmit` なしに同じ `user_id`・端末の鍵の人が入れない。繰り返しの会議の別の回でも同じ（PROP-SEC-002）。
- 性質ベーステスト：`meeting.suspended` の後、主催者・共同主催者以外の producer が再開しない（PROP-SEC-004）。
- 結合試験：ゲストを退出させ、IndexedDB を消して同じ回線から入り直すと、待合室に回り、主催者に印が見える。
- レビュー：報告の API が、会議の音声・映像・チャットの本文を自動で添えていない。
