# Design log: Slack

設計の工程ごとに決めたことの記録。今の結論は [README.md](README.md) と各領域の文書と ADR にあり、ここはその経緯を残す。新しい記録は末尾に足す。

記録は README.md から本文のまま移したもので、本文の中の「1.4 節」「6 節」などの節の番号は、[README.md](README.md) の節を指す。

## 2026-09-26：既定案

PM の方針（本家 Slack に寄せる、既定案）により、次のとおり決めた。上のリスクのうち、計測で確かめるものは決定の対象にせず、下の「持ち越し」に置いた。

- **対応ブラウザの下限は Safari 17**（macOS・iOS / iPadOS）。本家のモバイルアプリの下限（iOS 17）に合わせ、半年ごとに見直す（[client.md](client.md) の 13 節）。
- **通知の遅延を NFR にする（NFR-010）。** DM と @メンバーの Web Push を、投稿から p95 5 秒以内に送信する。本家は数値を公開していないが、「取りこぼさない」（[intent.md](../intent.md)）の価値を測るために、PM の案のまま NFR にした。runbooks の SLI と quality.md の E5 の合否基準に加えた。
- **@channel / @here / @everyone の制限は、本家に合わせる。** 提案の「1,000 人以上のチャンネルで制限」ではなく、本家の規則にした。
  - 参加者が 6 人以上のチャンネルでは送信前に確認を求める。owner・admin は確認を無効にできる。
  - owner・admin は使えるロールを絞れる。
  - 参加者が 10,000 人以上のチャンネルでは、@channel / @here を owner・admin だけが使える。
  - スレッドの返信の中では通知しない。
  - 出典：[Notify a channel or workspace](https://slack.com/help/articles/202009646-Notify-a-channel-or-workspace)、[Manage who can notify a channel or workspace](https://slack.com/help/articles/115004855143-Manage-who-can-notify-a-channel-or-workspace)（2026-09-26 に確認）。詳細は [messaging.md](messaging.md) の「誰が使えるか」。E3 の `mentions-and-broadcast` の spec で決定表にする。
- **監査ログの保持**は [ADR-0033](../decisions/0033-slack-aligned-platform-and-plan-decisions.md) で決めた（DB に 1 年、アーカイブに 2 年）。解決済み。
- 領域ごとの問いの決定は、各文書の「決定（2026-09-26、既定案）」にある：[client.md](client.md)、[security.md](security.md)、[identity-and-access.md](identity-and-access.md)、[search.md](search.md)、[mcp.md](mcp.md)、[public-api.md](public-api.md)、[apps.md](apps.md)。

持ち越し（計測・PoC・後の段階で決めるもの）：

| 項目 | いつ・どう決めるか |
| --- | --- |
| 巨大チャンネルのファンアウト、`last_seq` のホットスポット、RLS の性能 | E7 の `capacity-load-tests`（k6）で計測して判断する。足りなければ E10 の `large-channel-path` へ |
| 大阪の headless の二次クラスタの切り替え手順 | 対応状況は確認済み（ADR-0011）。E1 の `terraform-foundation` の後、staging で手順を試す |
| iOS の PWA のバックグラウンドでの接続の寿命 | E4 の着手前に、実機の PoC で測る（[client.md](client.md) の 3.4 節） |

## 2026-09-28：推奨案で確定

残っていた問いを、推奨案で次のとおり決めた。

- **Better Auth の `secondaryStorage` は使わない。** セッションの正本を DB の 1 か所に保ち、取り消しを単純にするため（[identity-and-access.md](identity-and-access.md) の 3.2 節）。
- **S3 で Global が止まったときは、キャッシュの切れたセッションを最長 4 時間まで延長して受け入れる。** 拒否すると Global が単一障害点に戻るため（[ADR-0023](../decisions/0023-cell-based-architecture.md)、[infrastructure.md](infrastructure.md) の 10.2 節）。上の「持ち越し」から外した。
- **オンコールの呼び出しの道具は PagerDuty にする。** SNS からそのまま受けられ、当番の表とエスカレーションを自前で作らずに済むため（[runbooks/incident-response.md](../runbooks/incident-response.md)、[ADR-0021](../decisions/0021-observability-stack.md) の注記）。
- **ファイルのバケットの暗号化は SSE-KMS とバケットキーにする。** ADR-0017 で決まっていたのに、files.md が「security.md で決める」のままだったので直した（[files.md](files.md)、[ADR-0017](../decisions/0017-encryption-and-key-management.md)）。

- **データモデルを 1 か所にまとめた。** [data-model.md](data-model.md) を正本にし、領域ごとの表の定義を [data-model/](data-model/identity.md) に分けた。領域の文書で名前や列が食い違っていたところは、data-model に合わせて直した。あわせて、次の細部を推奨案で決めた。
  - **時間で切る表は、UUIDv7 の ID の範囲で分割する。** PostgreSQL は分割した表の一意制約に分割キーを求める。`created_at` で切ると、冪等性に使う一意制約（`notification_log` など）が効かなくなるため（[data-model.md](data-model.md) の 2.8 節）。
  - **テナントをまたぐ `SECURITY DEFINER` 関数は、専用のロール `tenant_resolver` が持つ。** `BYPASSRLS` を与えず、関数が読む表だけにそのロール向けのポリシーを置く。期限の来た行を探す定期の Worker も、`scheduler_due_items` で `workspace_id` と主キーだけを得てから、RLS の下で読み直す（同 2.3 節）。
  - **`workspaces` にも RLS を掛ける**（`id` がコンテキストと一致する行だけ）。別のワークスペースの名前も漏らさないため（NFR-009）。
  - **メッセージに付かないファイル（アイコン、カスタム絵文字、アプリの画像）は `files.purpose` で区別し、ワークスペースのメンバー全員が読める**（[data-model/files-and-search.md](data-model/files-and-search.md)）。
  - **`members.kind` に `sample`（開発用のワークスペースのダミー）を加えた**（[ADR-0031](../decisions/0031-app-platform.md) の注記）。
  - **専用の表を持たないワークスペースの設定は `workspace_settings` の 1 行にまとめ、上書き（entitlement）は `workspace_entitlement_overrides` に 1 件ずつ理由と期限つきで置く**（[data-model/identity.md](data-model/identity.md)、[data-model/governance.md](data-model/governance.md)）。
  - **削除の台帳は、DB ではなく S3 の別のバケットに置く。** 復元で DB と一緒に巻き戻らないようにするため。**`response_url` の状態は Valkey に置く**（`trigger_id` と同じ扱い。失ったらアプリにやり直してもらう）（[data-model/stores.md](data-model/stores.md)）。
  - **KMS に `apps` キーを加えた**（[ADR-0017](../decisions/0017-encryption-and-key-management.md) の注記）。
