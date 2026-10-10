# Decisions: X

X の再構築に関する決定。リポジトリ共通の決定は [docs/decisions/](../../../../docs/decisions/README.md) にある（本家の名前・接頭辞を使わない規則は、その ADR-0006。本家の実装を核に使わない規則は、その ADR-0007）。領域ごとの設計と、領域ごとの ADR の番号の範囲は [architecture/](../architecture/README.md) の 7 節を見る。

<!-- adr-index:start -->
| ADR | 決定 | 状態 |
| --- | --- | --- |
| [0001](0001-platform-and-stack.md) | 共通の基盤を引き継ぎ、タイムライン・推薦・カウンター・検索の核を自前で作る。アプリは React Native、学習だけ Python | accepted |
| [0002](0002-post-ids-and-ordering.md) | 投稿・利用者・DM のメッセージに、時刻の順に並ぶ 64 ビットの `tid` を振る | accepted |
| [0003](0003-timeline-fanout-hybrid.md) | ホームのタイムラインは、フォロワーの少ない作者はプッシュ、多い作者はプルで作る | accepted |
| [0004](0004-single-tenant-and-visibility.md) | テナントは 1 つ。本人だけの表に FORCE RLS をかけ、公開の表の見える範囲は 1 つの関数 `visible()` で読み出しの時に決める | accepted |
| [0005](0005-event-log-and-outbox.md) | 確定した変更は outbox から Kinesis Data Streams の出来事のログへ流す。閲覧の数だけは Aurora を通さない | accepted |
| [0006](0006-ranking-boundary.md) | おすすめは自前の段のパイプラインにし、ML はスコアと取り出しだけに使う。安全と法令の判定を上書きしない | accepted |
| [0007](0007-follow-graph-storage.md) | フォローの関係は、向きの違う 2 つの隣接の表を正本にし、同じトランザクションで書く。グラフ DB を使わない | accepted |
| [0008](0008-post-write-path-and-idempotency.md) | 投稿の書き込みは、検証の後に `tid` を振り、投稿の行・抜き出した要素・冪等の記録・outbox を 1 つの DB のトランザクションで確定する。再送は `(author_id, client_request_id)` で同じ投稿を返す | accepted |
| [0009](0009-post-state-tombstones-and-state-cache.md) | 削除と措置は行を消さずに状態と `state_version` を変える。投稿の状態の写しはバージョンの新しいものだけを書き、寿命を 45 秒にして、出来事が止まっても 60 秒の中で正本に戻る | accepted |
| [0010](0010-post-table-partitioning-s2.md) | S2 で投稿の表を投稿の ID のハッシュで分割する。作者・会話ごとの一覧は、出来事から作る別の索引の表に、それぞれ作者・会話の ID で分割して持つ | accepted |
| [0011](0011-graph-edge-state-machine-and-locking.md) | フォロー・申請・ブロックの辺を 1 つのステートマシンで扱い、2 人の組ごとの勧告ロックで直列にする。ブロックは同じトランザクションで両向きのフォローと申請を外し、鍵を外したら待っている申請をすべて承認する | accepted |
| [0012](0012-viewer-sets-cache.md) | 閲覧者の集合（ブロックの両向き、ミュート、承認済みの鍵アカウントのフォロー先、ミュートの語）を Valkey にバージョンつきの写しで持ち、書き込みの確定の直後に更新する。寿命は 1 時間。ミュートは逆向きの表を持たない | accepted |
| [0013](0013-graph-partitioning.md) | 関係の表を利用者の ID のハッシュで 1,024 の論理の分割に分け、物理のクラスタへの対応表で置く。S2 は 4 クラスタから。分割の後は `following` と `blocks` を正本にし、逆向きの表は出来事から作る | accepted |
| [0014](0014-home-timeline-replica-format.md) | ホームの写しは、32 バイトの項目を ID の降順に詰めた Valkey の文字列にし、挿入・合わせ・除去を Valkey Functions で行う。返信の項目は 4 つ目の欄に返信先の利用者を入れる | accepted |
| [0015](0015-fanout-pipeline-and-burst-control.md) | 振り分け役は全作者の最近の投稿の写しを先に書いてから、フォロワーのページの仕事を作者の大きさで 2 つの待ち行列に分けて作る。瞬間のピークでは閾値を一時的に下げ、プルに回した作者を 7 日間プルの合わせの対象に入れる | accepted |
| [0016](0016-timeline-rebuild-single-flight.md) | 写しの作り直しは、空の「作り直し中」の写しを先に置いてから、フォローしている作者の最近の投稿の写しを合わせて作る。single flight は Valkey の鍵で行い、全体の作り直しの速さに上限を置き、超えたら範囲を狭めて返す | accepted |
| [0017](0017-profile-and-conversation-reads.md) | プロフィールの一覧は作者の最近の投稿の写しと作者の索引から読む。会話は会話の索引から読み、返信を段と規則の点で並べる。直接の返信が 1,000 件を超える会話は上位 200 件の候補の写しを持つ | accepted |
| [0018](0018-ranking-candidates-and-two-stage-scoring.md) | おすすめの候補は S1 で 5 つの源から 800 件まで集め、軽いランクと重いランクの 2 段で点を付け、作者とフォロー外の割合を混ぜ合わせで抑える | accepted |
| [0019](0019-ranking-features-and-training-platform.md) | ランキングの特徴の定義を 1 か所に置き、配信の時の特徴を記録して学習に使う。学習は SageMaker と Step Functions、推論は ONNX Runtime をサービスの中で動かす | accepted |
| [0020](0020-ranking-evaluation-experiments-and-transparency.md) | ランキングの変更はオフラインの評価と利用者の単位の A/B で判定し、返した投稿の理由を記録して示す。利用者の操作と個人化しない設定を持つ | accepted |
| [0022](0022-engagement-relations-and-writes.md) | いいねは投稿の側と利用者の側の 2 つの向きの表を正本にし、リポストは `reposts` を正本にする。状態が変わったときだけ出来事を出す。ブックマークは本人だけの表。いいねした人の一覧は投稿の作者だけ、利用者のいいねの一覧は本人だけが見られる | accepted |
| [0023](0023-counter-aggregation-and-reconciliation.md) | `engagement` の流れの鍵を「投稿の ID と利用者の ID の下 3 ビット」にし、数の写しは Valkey の投稿ごとのハッシュに部分ごとの最後の連番を持って Function で冪等に足す。返信・引用の数も投稿の書き込みが `engagement` の流れへ出す。書き戻しは 60 秒、照合は静かな投稿で数え直す | accepted |
| [0024](0024-view-counts-ingest-and-approximation.md) | 閲覧は「画面に投稿の 50% 以上が 500ms 以上出た」こと。Ingest はクライアントの束を閲覧者のセッションで分けた鍵で `views` の流れへ入れ、集計は位置を先に記録してから足して数えすぎない。データレイクとの日ごとの補正で上にだけ直し、表示は減らない | accepted |
| [0025](0025-search-engine-and-japanese-analysis.md) | 検索は OpenSearch で、一致の判定は 1〜2 文字の N-gram、関連度の点は kuromoji で付ける。正規化は 1 つの関数で索引と問い合わせにかける | accepted |
| [0026](0026-search-index-layout-and-visibility.md) | 投稿の索引は月ごとに分けて `tid` の時刻で書き先を決め、`state_version` を外部のバージョンにする。問い合わせは 1 つの組み立て関数で見える範囲の条件を必ず含め、返す前に `visible()` で判定し直す | accepted |
| [0027](0027-trends-burst-detection.md) | トレンドは地域ごとに 5 分の区切りで「重み付きの一意の投稿者の数」を数え、基準との差をポアソンの揺れで割った点で急上昇を決める | accepted |
| [0029](0029-notification-rows-and-grouping.md) | 通知の行は受け手の本人だけの表に書き、いいね・リポスト・フォローは対象ごとに 1 行にまとめて、開いている間は行為者を足す。殺到を受けている受け手は、行為者の集合を Valkey で数えて 60 秒ごとに書き戻す | accepted |
| [0030](0030-push-and-email-delivery.md) | プッシュは送る直前に見える範囲・設定・送る量の上限を確かめる。本文を載せない形を既定にし、端末が API で中身を取る。まとめの通知は collapse の鍵で上書きする。メールは日ごとの要約だけ | accepted |
| [0031](0031-read-state-and-visibility-rechecks.md) | 通知の既読は受け手ごとの 1 本の位置で持ち、未読の数は Valkey の写しで数えて Realtime Gateway で届ける。見える範囲は、作る時・送る時・読む時の 3 回判定する | accepted |
| [0032](0032-media-upload-and-processing.md) | メディアはクライアントから S3 へ分割で直接上げ、検査とハッシュの照合を通るまで公開しない。画像は位置の情報を消して決まったバージョンに、動画は MediaConvert で HLS にする | accepted |
| [0033](0033-media-delivery-and-takedown.md) | 公開のメディアは推測できないキーの URL で 1 年キャッシュして配り、鍵アカウントと DM のメディアは署名付きの URL で配る。措置では CloudFront KeyValueStore の拒否の一覧で数秒で止め、元を隔離して無効にする | accepted |
| [0034](0034-media-hash-matching.md) | 有害なメディアのハッシュの照合は差し替えられる口の後ろに置き、公開のメディアは照合を通るまで公開しない。自前で措置したメディアの PDQ の一覧も持つ。DM のメディアは L3 の確認まで照合しない | accepted |
| [0035](0035-dm-conversation-model-and-storage.md) | DM は会話ごとの連番で並べ、参加者の FORCE RLS と会話ごとの鍵の列の暗号化で守る。配信は ID だけを流して受け手の権限で読み直す | accepted |
| [0036](0036-dm-consent-requests-and-reporting.md) | フォローしていない人からの DM は申請に入れ、受け手の設定とブロックで決定表の順に判定する。通報は参加者が選んだメッセージを同意の画面を経て証拠へ写す | accepted |
| [0037](0037-dm-e2ee-readiness.md) | DM のエンドツーエンドの暗号化は MVP の後に入れる。MVP では本文を中身の分からない入れ物として扱い、サーバーが本文を読む機能を作らない。方式の第一の候補は MLS | accepted |
| [0038](0038-moderation-action-model.md) | 措置は追記だけの `moderation_actions` に根拠と主体を書き、同じトランザクションで措置の要約と `state_version` と outbox を書いてから効かせる | accepted |
| [0039](0039-reports-queues-and-appeals.md) | 通報は対象と区分ごとの案件にまとめ、重さと広がりと信頼と速さで優先度を付けて P0〜P3 の待ち行列に入れる。作業の画面は通報の時の証拠の写しを見せ、異議は別の担当が見る | accepted |
| [0040](0040-spam-and-bot-defense.md) | スパムとボットは、エッジ・登録・レート制限・行動の規則・アカウントの危険の点の層で防ぎ、点の帯ごとに決まった扱いをする。点は見える範囲を変えない | accepted |
| [0041](0041-legal-requests-and-transparency.md) | 法令の案件は通報と別の表で持ち、受け付けの時刻から期限を計算して警告する。期限・基準・通知の値は `legal.*` に置き、法務の確認の後に決める。保全は `legal_holds` で削除を止め、公表は記録から集計する | accepted |
| [0043](0043-auth-methods-and-sessions.md) | 認証は Better Auth を包んで使い、パスワードを持たない。登録には電話かメールの確認を必須にし、セッションの写しを Valkey に置いて取り消しを 5 秒で効かせる | accepted |
| [0044](0044-account-states-deletion-and-age.md) | アカウントの状態を 5 つにし、Accounts だけが outbox を通して変える。停止は 30 日の猶予の後に削除する。年齢は区分だけを `visible()` に渡し、境の値は法務の L5 の後に設定で入れる | accepted |
| [0046](0046-public-api-shape-and-oauth.md) | 公開 API は `/v1/` の REST で、ID は文字列、一覧は `tid` の範囲と署名した `next_token` で送る。認証は OAuth 2.0 の認可コード＋PKCE と、公開の読み出しだけのアプリのトークン | accepted |
| [0047](0047-rate-limit-token-buckets.md) | レート制限は Valkey の上のトークンバケットを Valkey Functions で複数同時に引く。利用者の行動の上限は画面と API で共通にし、応答は IETF の `RateLimit` のヘッダーで返す | accepted |
| [0048](0048-usage-plans-and-metering.md) | 公開 API は返した件数と書き込みの回数で計量し、プランの月の上限を Valkey で強制する。請求の連携と活動の Webhook は MVP の後 | accepted |
| [0049](0049-client-data-layer-and-offline.md) | クライアントは共通のパッケージとデータの層を持ち、ホームの 200 件を手元に保存する。DM の中身は手元に置かない。オフラインの投稿は `Idempotency-Key` つきの待ち行列にする。公開の URL は App API が最小の HTML を返す | accepted |
| [0050](0050-timeline-list-rendering.md) | タイムラインの一覧は、アプリは FlashList、Web は自前の仮想化で描き、落ちたフレームを固定の端末と RUM で測る。基準を 2 回の改善で満たせない画面だけ、ネイティブの一覧の部品にする | accepted |
| [0051](0051-encryption-and-key-layout.md) | KMS の鍵をデータの種類ごとに分け、電話番号・メールアドレス・生年月日・IP アドレスはアプリの層でも封筒の暗号化をし、検索は鍵付きの HMAC の列で行う | accepted |
| [0052](0052-audit-and-operator-access.md) | 監査ログは DB の追記だけの表と log-archive の Object Lock の 2 か所に書く。本番のデータへの人の常時のアクセスを置かず、読み出しは理由を必須にしたロールと 2 人の承認の break-glass だけにする | accepted |
| [0053](0053-data-lifecycle-and-retention.md) | データを種類ごとの保持の方針の表で管理し、法令に関わる種類は法務の値が入るまで物理の削除を止める。削除は墓石から後始末を経て物理の削除へ進み、法的な保全で止まる | accepted |
| [0054](0054-accounts-network-and-services.md) | アカウントとネットワークは他の題材の形を引き継ぎ、入口は CloudFront → ALB にする。サービスは入口・書き込み・読み出し・消費者・Worker に分けて ECS Fargate に置き、外の宛先への送信は egress の専用の経路にする | accepted |
| [0055](0055-kinesis-consumers-and-valkey-clusters.md) | Kinesis の消費者は自前の TypeScript の読み手にし、遅れに厳しい消費者は拡張ファンアウトで読む。シャードの担当と位置は Aurora に持つ。Valkey は用途で 4 つのクラスタに分ける | accepted |
| [0056](0056-disaster-recovery-osaka.md) | 大阪にウォームスタンバイを持ち、人の判断でワークフローで切り替える。大阪は生成器の番号 512〜1023 だけを使い、送った outbox の行を 1 時間残して切り替えの後に送り直す。写しは空から作り直し、合わせに要る `ar:` を入口を開く前に作る | accepted |
| [0058](0058-timeline-freshness-measurement.md) | タイムラインの届く速さは合成監視を正解にし、出来事に運ぶ確定の時刻からの区間の内訳と、読み出しの抜き取りで補う | accepted |
| [0059](0059-guardrail-and-audit-metrics.md) | ランキングのガードレールは 5 分ごとの近似で自動に止め、データレイクの日ごとの値で広げる判断をする。見える範囲の抜き取りの監査は 5 秒後に正本で判定し直し、説明のつく不一致を除いて数える | accepted |
| [0060](0060-capacity-headroom-and-load-shedding.md) | 各部品は AZ を 1 つ失っても S1 のピークをさばける大きさにし、fan-out は瞬間のピークの 2/3 を続けて書ける大きさにする。超えるときに削る順を決め、投稿の書き込みと `visible()` は削らない | accepted |
| [0061](0061-ci-gates.md) | PR の必須の関門に、漏れの経路の表、`visible()` の決定表、fan-out の性質、出来事の再生、本人だけの表の RLS、ランキングのオフラインの評価、本家の実装の検査、契約の互換を入れ、変更のパスで足す。外すラベルを持たない | accepted |
| [0062](0062-mobile-release-and-min-version.md) | アプリは週 1 回の列車でストアに出し、iOS は 7 日の段階的リリース、Android は段階的公開で広げる。JS だけの修正は自前の Expo Updates の形のサーバーから署名した束で配る。最低のバージョンは `426` で強制し、支えるバージョンは 12 週 | accepted |
| [0063](0063-contract-change-ordering.md) | 契約の変更は、広げる → 読む側を新旧に対応 → 書く側を移す → 縮める、の順にする。DB の縮めは別のリリース、出来事は共通の頭とバージョンを持ち、公開 API は同じバージョンの中で足すだけ、画面の API は 12 週前のアプリが読める形を保つ | accepted |
<!-- adr-index:end -->

この一覧は、各 ADR の frontmatter と見出しから生成したもの。ADR を追加・更新したら生成し直す。
