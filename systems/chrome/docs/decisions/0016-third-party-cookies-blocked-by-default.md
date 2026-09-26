---
status: accepted
date: 2026-09-26
---

# ADR-0016: サードパーティ Cookie を既定で遮断し、CHIPS と Storage Access API で補う

## Context

サードパーティ Cookie は、サイトをまたいだ追跡の主な手段である。主要なブラウザの既定は分かれている。

- 本家 Chrome：2025 年 4 月に、サードパーティ Cookie を既定で許したままにし、新しい選択の確認も出さないと決めた（[Next steps for Privacy Sandbox and tracking protections in Chrome](https://privacysandbox.google.com/blog/privacy-sandbox-next-steps)）。シークレットでは既定で遮断する。2025 年 10 月には Privacy Sandbox の多くの技術を終了すると発表した。
- Firefox：Total Cookie Protection で、サードパーティ Cookie をトップレベルのサイトごとに分割する。
- Safari：サードパーティ Cookie を遮断する。

この題材は、Privacy Sandbox などの広告の API を作らない（intent の Non-goals）。[ADR-0005](0005-privacy-first-services.md) はプライバシーを優先する方針を決めている。Cookie の既定は、互換性とプライバシーのどちらを取るかの判断で、エージェントが本家に合わせて許可にしがちなので、ADR にする。

## Options

1. **本家と同じ：既定で許可し、設定で遮断できる**
2. **既定で遮断し、CHIPS（`Partitioned`）と Storage Access API で補う**
3. **Firefox と同じ：すべてのサードパーティ Cookie を、属性に関係なくトップレベルのサイトで分割する**

## Decision

2 を採用する。詳細は [networking.md](../architecture/networking.md) の 8 節にある。

- サードパーティの文脈では、`Partitioned` 属性のない Cookie を送らず、保存しない。
- `Partitioned` 属性のある Cookie（CHIPS）は、トップレベルのサイトで分割したジャーで扱う。上限は本家と同じ（分割ごとに 180 個、埋め込まれたサイトごとに 10 KB。[CHIPS](https://privacysandbox.google.com/3pcd/chips)）。
- `document.requestStorageAccess()`（Storage Access API）で、利用者の操作の後に、組（トップレベルのサイト、埋め込まれたサイト）ごとに許可する。
- ログインの流れ（OAuth のポップアップなど）には、期限付きの一時的な許可を入れる。規則は Firefox の実装を読んで決める（未検証）。
- 利用者はサイトごとに例外を作れる。企業はポリシー（本家の `CookiesAllowedForUrls` など）で例外を配れる。
- 1 は、ADR-0005 と合わない。本家は広告の事業と規制の事情で決めており、この題材はその前提を持たない。
- 3 は互換性が最もよいが、サイトが分割を意図していない Cookie を黙って分割するため、「動くが状態が保たれない」壊れ方をし、原因が分かりにくい。2 は、分割を望むサイトが `Partitioned` で明示する、本家の CHIPS の設計に揃う。

## Consequences

- 良くなること：
  - 既定の状態で、サードパーティ Cookie による追跡を防げる。
  - シークレットと通常のモードで、Cookie の規則が同じになり、試験と説明が簡単になる。
- 引き受けるコスト：
  - 本家で動くサイトの一部（SSO、埋め込みの決済・コメント・動画）が壊れる。互換性の目標（NFR-007）の検査で、この原因の崩れを分けて数え、一時的な許可の規則と例外で補う。
  - 壊れたサイトを利用者が報告し、サイトごとの例外を作る UI が要る（[browser-ui.md](../architecture/browser-ui.md)）。
  - Web の開発者に、本家との差として説明する文書が要る。

## Confirmation

- Web Platform Tests の `cookies/`・`storage-access-api/` と、CHIPS の試験を CI で回す（[build-and-test.md](../architecture/build-and-test.md)）。
- 既定の設定で、サードパーティの文脈の `Set-Cookie`（`Partitioned` なし）が保存されず、送られないことを、分割のキーの組み合わせの表駆動テストで確かめる。
- 主要サイト 1,000 件の自動検査で、ログインと埋め込みの流れを、本家の既定と比べて差分を記録する。
