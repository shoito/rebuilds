---
status: accepted
date: 2026-09-26
---

# ADR-0022: 権限は、要求したオリジンと最上位のオリジンの組で持ち、端末の中の信号で静かにし、自動で失効させる

## Context

カメラ・マイク・位置・通知などの権限は、利用者を守るための確認であると同時に、確認の多さが利用者を疲れさせ、何でも許可させる原因にもなる。本家 Chrome は、通知の確認を「静かな UI」にする仕組み（許可率の低いサイトを自動で対象にする）と、使っていないサイトや通知の多いサイトの権限を自動で外す仕組みを持つ。本家の許可率の判断は、多くの利用者の集計に基づく。

## Options

1. **本家の形に寄せ、許可率など利用者の集計が要る判断は、端末の中の信号と公開のリストに置き換える**
2. **本家と同じく、利用者の集計で静かな UI を決める**
3. **確認だけを持ち、静かな UI と自動の失効を持たない**

## Decision

1 を採用する。詳細は [safe-browsing-and-permissions.md](../architecture/safe-browsing-and-permissions.md) の 5 節。

- 単位は、要求したオリジンと最上位のオリジンの組。iframe は Permissions Policy で委ねられたときだけ要求できる。判断は Browser プロセスで、Browser が知るフレームのオリジンで行う。
- 許可は「常に」と「今回だけ」。画面の共有は毎回確認する。
- 静かな確認は、利用者の選択・端末の中の拒否の履歴・悪用する通知のリストで決める。
- 自動の失効：使っていないサイト（初期値 60 日）、関わりの少ないのに通知の多いサイト、悪用する通知のリストに入ったサイト。
- MVP では、権限を端末の間で同期しない。
- 2 は、閲覧のデータの集計が要り、ADR-0005 に反する。
- 3 は、通知の確認の濫用から利用者を守れない。

## Consequences

- 良くなること：
  - 閲覧のデータを集めずに、確認の疲れと通知の濫用を抑えられる。
- 引き受けるコスト：
  - サイトごとの許可率を使えないため、初めて訪れる濫用のサイトへの対応は、悪用する通知のリストの質に依存する。
  - 端末を替えると、権限をあらためて確認することになる。

## Confirmation

- 表駆動テストで、（要求したオリジン、最上位のオリジン、Permissions Policy、保存した状態、利用者の操作）の組み合わせごとの結果を確かめる。
- 侵害された Renderer を模したテストで、他のオリジンの名の要求が、Browser のオリジンで判断されることを確かめる。

## References

- Chromium Blog: [Introducing quieter permission UI for notifications（2020-01）](https://blog.chromium.org/2020/01/introducing-quieter-permission-ui-for.html)
- Chromium Blog: [Reducing notification overload for a quieter browsing experience in Chrome（2025-10）](https://blog.chromium.org/2025/10/automatic-notification-permission.html)
- Google Chrome Help: [Manage Chrome safety and security](https://support.google.com/chrome/answer/10468685)
