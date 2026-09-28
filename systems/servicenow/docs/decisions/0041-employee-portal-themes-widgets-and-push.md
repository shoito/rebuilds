---
status: accepted
date: 2026-09-28
---

# ADR-0041: 従業員のポータルは同じホスト名の別の画面の束にし、見た目はテーマのトークンと決まった部品だけで変える。プッシュは Web Push で送り、ネイティブのアプリは MVP で作らない

詳細は [portal-and-ui.md](../architecture/portal-and-ui.md) の 6 節。

## Context

社員は IT に詳しくない人を前提にし、スマートフォンからも申請・承認・報告をする（[intent.md](../intent.md)）。承認はスマートフォンで 1 回の操作で答えられるようにする（[ADR-0016](0016-approvals.md)）。当番の呼び出しの通知は MVP でメールとアプリのプッシュに限り、受け付けは本人のログインを要る（[ADR-0027](0027-on-call-rotations-and-escalation.md)）。テナントに HTML・JavaScript を差し込ませない（[intent.md](../intent.md) の Non-goals）。

本家のポータルは、部品（widget）とテーマで作り、部品の中身（HTML・スクリプト）を顧客が書ける（[Employee Center widgets](https://www.servicenow.com/docs/r/employee-service-management/employee-experience-foundation/employee-center-widgets-list.html)、2026-09-28 に検索の結果の抜粋で確認。本文は未検証。本家の振る舞いで、この決定の前提ではない。本システムは部品の中身を顧客に書かせない）。

iOS・iPadOS は 16.4 から、ホーム画面に置いた Web アプリで Web Push を受けられる。Safari のタブの中では受けられない（[Web Push for Web Apps on iOS and iPadOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)、2026-09-28 に確認）。

## Options

### ポータルの置き場所

1. **同じホスト名の `/portal` に、作業の画面と別の画面の束**
2. 作業の画面の束の中に、依頼者向けの画面として入れる
3. 別のホスト名（`portal.<tenant>...`）

### 見た目の変え方

- a. **テーマのトークンと、決まった部品の配置**
- b. テナントの CSS を受ける
- c. 本家と同じく部品の中身を書かせる

### プッシュ

- x. **Web Push（PWA）**
- y. ネイティブのアプリ（APNs・FCM）

## Decision

1、a、x を採用する。

- ポータルは `/portal`（子会社ごとに `/portal/{portal_key}`、5 つまで）。画面の束は作業の画面と分け、最初の表示を軽くする。
- 読み書きは Record Service の出口を通し、ポータル用の権限の判定を作らない（DT-ACL-003 の 16 行）。
- テーマのトークン：色、ロゴ、角の丸み、文字の大きさの段。色の組のコントラストが WCAG 2.2 の AA に届かなければ保存させない。
- 部品は決まった 9 種。文章の部品は制限付きの Markdown だけ。SVG の画像は受けない。
- Web Push の本文にレコードの値を入れない。当番の受け付けは、プッシュから開いた画面で、当番の利用者の端末のセッション（長さは security の領域）と利用者の確認で行う。

2 を採らない理由：依頼者の端末に、担当者の画面の大きな束を配ることになる。依頼者向けの軽さ（スマートフォン、遅い回線）を作れない。

3 を採らない理由：Cookie・SSO・CSP の設定がホスト名ごとに 2 つになる。ルーター（[ADR-0002](0002-tenancy-and-isolation.md)）の対応表も増える。

b・c を採らない理由：テナントの CSS はクリックジャッキングや偽の画面（入力欄を隠す、別の文言を重ねる）に使え、JavaScript は XSS になる。部品の中身を書かせると、版の更新で壊れる部品を顧客ごとに持つことになる（[ADR-0002](0002-tenancy-and-isolation.md) の同じ版の方針）。

y を採らない理由：アプリの配布・審査・更新の運用が増える。MVP の当番の受け付けは、Android とデスクトップの Web Push、iOS のホーム画面の Web アプリ、メールの経路で足りる見込み。受け付けの時間の実測で足りなければ見直す。

## Consequences

- 良くなること：
  - ポータルの見た目の自由を減らす代わりに、全テナントで同じ部品を保守・検査できる。
  - アプリの配布の運用がない。
- 引き受けるコスト：
  - 本家のポータルを作り込んだ顧客は、見た目を再現できない。移行の資料で示す。
  - iOS の利用者は、ホーム画面に置かないとプッシュを受けられない。当番の利用者の導入の手順に入れる。

## Confirmation

- lint：ポータルの束が、制限付きの Markdown の部品の外で HTML を描かないこと。
- テーマの保存のテスト：コントラストの比が AA に届かない組を拒否する。
- 漏れの試験のポータルの出口（[access-control.md](../architecture/access-control.md) の 12.3 節）。
- 計測（E8）：ポータルの LCP の p75 2.5 秒、当番の受け付けの時間（経路別）。
