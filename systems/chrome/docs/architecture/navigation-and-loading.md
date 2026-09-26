# Navigation and loading: Chrome

ナビゲーションの流れ、応答の検査、コミットでのプロセスの選択、セッション履歴と bfcache、Renderer への読み込み、エラーページ、ダウンロード。この文書で決めたことは、Browser が主導するナビゲーションとコミットの手順（[ADR-0008](../decisions/0008-browser-driven-navigation-commit.md)）と、bfcache の方式（[ADR-0009](../decisions/0009-back-forward-cache.md)）。前提は、サイトごとのプロセス（[ADR-0003](../decisions/0003-multi-process-site-isolation.md)）、IPC（[ADR-0006](../decisions/0006-typed-capability-ipc.md)）、プロセスの割り当て（[ADR-0007](../decisions/0007-process-allocation-policy.md)。[process-model.md](process-model.md)）。

本家の設計と仕様の出典：

- [Life of a Navigation](https://chromium.googlesource.com/chromium/src/+/main/docs/navigation.md)、[Navigation Concepts](https://chromium.googlesource.com/chromium/src/+/main/docs/navigation_concepts.md)
- [RenderDocument](https://chromium.googlesource.com/chromium/src/+/main/docs/render_document.md)
- [HTML: Navigation and session history](https://html.spec.whatwg.org/multipage/browsing-the-web.html)
- [Back/forward cache（web.dev）](https://web.dev/articles/bfcache)、[bfcache と Cache-Control: no-store](https://developer.chrome.com/docs/web-platform/bfcache-ccns)、[notRestoredReasons](https://developer.chrome.com/docs/web-platform/bfcache-notrestoredreasons)
- [ORB](https://github.com/annevk/orb)、[CORB の説明](https://chromium.googlesource.com/chromium/src/+/HEAD/services/network/cross_origin_read_blocking_explainer.md)

## 1. 原則

- **ナビゲーションは Browser が主導する。** 文書の取得（リクエスト、リダイレクト、応答）は Browser が Network サービスに頼んで行い、Renderer は取得に関わらない（ADR-0008）。
- **行き先のプロセスは、応答を見てから決める。** リダイレクトの後の最終の URL と、応答のヘッダー（COOP、COEP など）で、サイトとプロセスの鍵が決まる。
- **応答の検査は、Renderer に本文を渡す前に Browser で行う。** frame への埋め込みの可否（X-Frame-Options、CSP の `frame-ancestors`）、COOP、ダウンロードの判定は、侵害された Renderer に任せられない。
- **文書ごとに、frame の Browser 側の実体を作り直す。** クロスドキュメントのナビゲーションでは、同じプロセスでも新しい実体を作る（本家の RenderDocument。本家は段階的に移行中だが、最初からこの形にする）。前の文書の権限・状態を次の文書へ持ち越さない。
- **仕様の用語に合わせる。** 手順は HTML の navigate、populate a history entry's document、apply the history step に沿って組み、Web Platform Tests の `html/browsers/` で確かめる。

## 2. 用語とモデル

| 用語 | 内容 | 本家 / 仕様 |
| --- | --- | --- |
| frame の木 | タブごとの frame の木。各ノードは 1 つの frame（最上位・iframe）で、ナビゲーションをまたいで残る | FrameTree / FrameTreeNode、navigable |
| 文書の実体 | 1 つの frame の 1 つの文書に対応する、Browser 側の実体。プロセス、コミットしたオリジン、ポリシー、渡した端点を持つ | RenderFrameHost（RenderDocument の後） |
| ナビゲーションの要求 | 開始からコミット（または中止）までの 1 回のナビゲーション。frame ごとに、進行中のものは原則 1 つ | NavigationRequest |
| 検査の段 | 開始・リダイレクト・応答の各時点で、ナビゲーションを止める・待たせる・中止する処理（Safe Browsing、混在コンテンツ、埋め込みの可否など） | NavigationThrottle |
| セッション履歴 | タブごとの履歴の項目の列。各項目は、frame の木に沿った frame ごとの項目を持つ | NavigationController / NavigationEntry / FrameNavigationEntry、session history entry |
| ポリシーの入れ物 | 文書に付くポリシー（CSP、参照元のポリシー、COEP、サンドボックスのフラグ） | policy container |

URL は 3 つを区別する（[Navigation Concepts](https://chromium.googlesource.com/chromium/src/+/main/docs/navigation_concepts.md)）。

| URL | 意味 | アドレスバーに出すか |
| --- | --- | --- |
| 最後にコミットした URL | 今の文書の URL | 出す |
| 進行中の URL | 開始したがコミットしていない行き先 | Browser が始めたナビゲーションで、新しいタブでないときだけ出す（偽装の防止） |
| 表示用の URL | 表示のために書き換えた URL（`view-source:` など） | 出す |

## 3. ナビゲーションの流れ

### 3.1 全体

```
Browser（UI・frame の木）          Network サービス             Renderer（行き先）
  │ 1. 開始（Browser か Renderer から）
  │ 2. beforeunload（前の文書のプロセスに問う。3.3）
  │ 3. 検査の段：開始時
  │ 4. リクエスト ─────────────────▶│
  │◀──── リダイレクト ───────────────│ 5. 検査の段：リダイレクトごと（3.4）
  │◀──── 応答のヘッダー ─────────────│
  │ 6. 検査の段：応答（4 節）
  │    埋め込みの可否、COOP/COEP、ダウンロード、204/205、MIME の判定
  │ 7. 行き先の文書の実体とプロセスを決める（5.1）
  │ 8. コミットの指示 ──────────────────────────────────────────▶│ 応答のヘッダー＋本文のパイプ
  │                                                               │ ＋オリジン・ポリシー・端点
  │                                 本文 ═══ データのパイプ ═════▶│ 9. 文書を作り、解析を始める
  │◀──────────────────────────────────── コミットの完了 ─────────│
  │ 10. 完了を検査し（5.3）、履歴・アドレスバー・鍵の表示を更新
  │ 11. 前の文書を片付ける（同じプロセスなら unload、または bfcache へ。6.3）
```

- 1〜7 の間、前の文書は表示され、操作もできる。
- 本家は、Browser 側で始めたナビゲーションで行き先のプロセスを予測し、応答を待つ間に起動しておく。ここでも、Browser が始めたナビゲーションでは、開始の時点で行き先のサイトのプロセス（なければ予備の Renderer）を用意し始める。リダイレクトでサイトが変われば、用意したものを使わない。
- ナビゲーションの状態の変化（開始、リダイレクト、コミットの直前、完了）を、Browser の中の観測者（UI、拡張機能の `webNavigation`、DevTools）へ通知する。本家の `DidStartNavigation` などに当たる。

### 3.2 Browser が始めるもの、Renderer が始めるもの

| | Browser が始める | Renderer が始める |
| --- | --- | --- |
| 例 | アドレスバー、ブックマーク、戻る・進む（UI）、再読み込み | リンク、フォームの送信、`location` の代入、`window.open` |
| 信頼 | 利用者の操作なので、より信頼できる | 侵害されたプロセスからも来うる |
| 行き先の制限 | 内部のページ（`<brand>://`）、`file:` も可 | 内部のページ、`file:`（`file:` の文書から以外）は不可。最上位の frame を `data:` の URL へ移すことも不可（本家と同じ。偽装に使われるため） |
| 進行中の URL の表示 | 出す | 出さない |

- Renderer が始めたナビゲーションの要求は、Browser が次を検査してから受け付ける：発信元の frame がそのプロセスのものか、行き先がそのプロセスに許された範囲か、POST の本文に添えたファイルが許可されたものか、利用者の操作（user activation）の申告が Browser の記録と合うか。
- 別の frame を行き先にする要求（`target`、`window.open` の名前）は、名前の解決を Browser が frame の木で行い、仕様の「ナビゲーションを許される」規則（祖先・opener の関係、sandbox のフラグ）で検査する。

### 3.3 beforeunload と unload

- 前の文書の `beforeunload` は、行き先へのリクエストの前に、前の文書のプロセスへ問う。Browser が始めたナビゲーションで、`beforeunload` の処理器がない文書には問わない（Renderer が、処理器の有無を事前に Browser へ知らせる）。
- 確認の画面は Browser が出す。利用者の操作がない文書の `beforeunload` の確認は出さない（仕様が許す範囲の本家の挙動）。
- 前の文書の応答がない場合、一定時間で打ち切って進める。時間は **未検証**（本家の既定を確かめる）。
- `unload` は、コミットの後、前の文書のプロセスで実行する（別のプロセスなら、並行して行う）。`unload` は bfcache を妨げるので、将来は本家の段階的な廃止に合わせて、使えないようにしていく（6.3）。

### 3.4 リダイレクト

- リダイレクトごとに、開始時と同じ検査をやり直す（Safe Browsing、混在コンテンツ、Renderer が始めたナビゲーションの行き先の制限、CSP の `navigate-to` に当たるもの）。
- 回数の上限は 20（Fetch の仕様の redirect count）。
- リダイレクトで行き先のサイトが変わったら、用意していたプロセスは使わない（プロセスは 5.1 で決め直す）。
- リダイレクトの応答の本文は捨てる。Renderer には渡さない。

### 3.5 同時に起きるナビゲーション

- 1 つの frame に進行中のナビゲーションは原則 1 つ。新しいものが始まれば、古いものを中止する。
- 例外：Browser が始めたナビゲーションが進行中で、Renderer が利用者の操作なしに新しいナビゲーションを始めたら、Renderer のほうを無視する（本家の規則。ページが利用者の操作を妨げ続けるのを防ぐ）。
- コミットの指示を送った後に届いた新しいナビゲーションは、コミットが終わってから処理する。

### 3.6 同じ文書の中のナビゲーション

- 断片（`#id`）、`history.pushState`・`replaceState`、同じ文書の中の戻る・進むは、Renderer の中で完結させ、Browser へ結果を知らせる。
- Browser は、新しい URL が今の文書のオリジンと同じであることを検査する（`pushState` で別のオリジンの URL を名乗らせない）。違えば、不正なメッセージとして扱う（[process-model.md](process-model.md) の 6.2）。
- Navigation API（`navigation.navigate` など）も、同じ文書の中のものは同じ扱いにする。

## 4. 応答の検査

### 4.1 順序

応答のヘッダーを受けたら、次の順で判定する。前のもので止まれば、後は行わない。

| 順 | 検査 | 結果 |
| --- | --- | --- |
| 1 | Safe Browsing（[safe-browsing-and-permissions.md](safe-browsing-and-permissions.md)） | 危険ならインタースティシャル（8 節） |
| 2 | 204・205 | ナビゲーションを終える。文書を作らない |
| 3 | ダウンロードにするか（4.5） | ダウンロードの管理へ渡す。ナビゲーションは終える |
| 4 | iframe への埋め込みの可否（4.2） | 不可なら、その frame にエラーページをコミットする |
| 5 | COOP・COEP（4.3） | 閲覧のグループを分けるか、プロセスの鍵の属性を決める |
| 6 | MIME の判定（必要なら本文の先頭を読んで推測） | 表示できない形式ならダウンロードにする |
| 7 | 行き先のプロセスを決め、コミットする（5 節） | |

### 4.2 X-Frame-Options と CSP の frame-ancestors

- 埋め込みの可否は、Browser が frame の木の祖先を見て判定する。祖先のオリジンは Browser の記録から取り、Renderer の申告を使わない。
- CSP の `frame-ancestors` があれば、それを優先し、`X-Frame-Options` は無視する（CSP の仕様と HTML の「X-Frame-Options に従っているかの検査」の通り）。
- 拒否したときは、その iframe に、不透明なオリジンのエラーページをコミットする。応答の本文は Renderer へ渡さない。
- クリックジャッキングそのものは Site Isolation では防げない（[Site Isolation](https://www.chromium.org/developers/design-documents/site-isolation/) の範囲の外）。ここでの検査が防御の本体になる。

### 4.3 COOP と COEP

- 最上位の文書の `Cross-Origin-Opener-Policy` が、前の文書と両立しないとき、新しい閲覧のグループでコミットする。opener との参照は切れ、プロセスも別になる（HTML の COOP の手順）。
- `same-origin` の COOP と `require-corp`（または `credentialless`）の COEP を両方持つ文書は、クロスオリジン隔離（`crossOriginIsolated`）の状態になる。その文書は、隔離の属性を持つプロセスの鍵でだけ動かす（同じサイトでも、隔離されていない文書と同じプロセスに置かない）。`SharedArrayBuffer` などはこの状態でだけ使える。
- iframe の COEP：親が COEP を求めるとき、子の応答が CORP（または COEP の `credentialless` の条件）を満たさなければ、その iframe を読み込まない。
- `Cross-Origin-Opener-Policy-Report-Only` と報告の送信は S2 で入れる。

### 4.4 サブリソースの応答（ナビゲーションでないもの）

- サブリソース（画像、スクリプト、`fetch`）の取得は、Renderer が、Browser からもらった `URLLoaderFactory` の端点で直接 Network サービスへ頼む（ナビゲーションのように Browser を通らない）。
- 端点は、発信元のオリジンを Browser が固定したもので、Network サービスが CORS・CORP・ORB を適用する。`no-cors` の別のオリジンの応答のうち、HTML・JSON・XML など、画像やスクリプトとして使えないものは、ORB が Renderer へ渡す前にネットワークのエラーにする（本家は CORB から ORB へ段階的に移行した。[ORB v0.2](https://chromestatus.com/feature/5166834424217600)）。
- 詳細は [networking.md](networking.md) で扱う。

### 4.5 ダウンロードにする条件

| 条件 | 扱い |
| --- | --- |
| `Content-Disposition: attachment` | ダウンロード |
| 表示できない MIME の形式 | ダウンロード |
| `<a download>`（同じオリジン） | ダウンロード。ファイル名は属性の値 |
| `<a download>`（別のオリジン） | ダウンロード。ファイル名は応答のヘッダーから（属性の名前は使わない） |
| sandbox の iframe で `allow-downloads` がない | 止める |
| 利用者の操作なしに、短い間に何度も始める | 2 つめ以降を止め、許可を求める（[safe-browsing-and-permissions.md](safe-browsing-and-permissions.md)） |

## 5. コミット

### 5.1 行き先のプロセスを決める

最終の URL と 4.3 の結果から、行き先の閲覧のグループとサイトの実体を決め、[process-model.md](process-model.md) の 3.2 の流れでプロセスを選ぶ。

| 場合 | 文書の実体 | プロセス |
| --- | --- | --- |
| 同じサイト、同じ閲覧のグループ | 新しく作る（RenderDocument） | 今のプロセス |
| 別のサイト（最上位） | 新しく作る | 別のプロセス。前の文書の実体はコミットまで残す |
| 別のサイト（iframe） | 新しく作る | 別のプロセス（OOPIF）。親のプロセスには代理を置く |
| COOP で閲覧のグループを分ける | 新しく作る | 新しいグループのサイトの実体のプロセス |
| エラーページ | 新しく作る | エラーページ専用のプロセス（8 節） |
| bfcache からの復元 | 保存していたもの | 保存していたもの（6.3） |

### 5.2 コミットの指示

Browser から行き先の Renderer へ、1 つのメッセージで次を渡す。

- 応答のヘッダー（Renderer に渡してよいものだけ。`Set-Cookie` は除く）
- 本文のデータのパイプ（Network サービスから流れ続ける。7 節）
- コミットするオリジン（Browser が計算したもの。sandbox なら不透明なオリジン）、ポリシーの入れ物
- その文書用の端点：`URLLoaderFactory`（発信元を固定）、BrowserInterfaceBroker、Cookie、保存領域
- 履歴の項目の識別子、ナビゲーションの種類（新しい項目・置き換え・履歴の移動・再読み込み）
- 復元する状態（履歴の移動のとき。スクロールの位置、フォームの値。6.2）

### 5.3 コミットの完了の検査

Renderer は、文書を作ったら完了を知らせる。Browser は、完了の内容を次で検査し、合わなければ不正なメッセージとしてそのプロセスを終了させる（本家の `CanCommitOriginAndUrl`）。

- 完了の対象のナビゲーションが、そのプロセスに送ったコミットの指示と一致する。
- URL とオリジンが、送ったものと一致する。
- オリジンが、プロセスの鍵のサイトに属する（不透明なオリジンなら、その元のサイトが属する）。
- 同じ文書の中のナビゲーション（3.6）は、オリジンが変わっていない。

検査に通ったら、次を行う。

- 前の文書の実体を片付けるか、bfcache に入れる（6.3）。
- 履歴の項目を確定し、アドレスバー・鍵の表示・タブの題名を更新する。
- 別のプロセスへ移った場合、元のプロセスに代理を置き直す（iframe の親と、同じ閲覧のグループの他のタブのため）。

### 5.4 コミットの競合と失敗

- コミットの指示の後、完了の前に行き先のプロセスが落ちたら、その frame に sad frame（最上位なら sad tab）を出す。前の文書には戻さない（既に片付けを始めているため）。
- 行き先の Renderer が、本文の読み込み中に別のナビゲーションを始めても、先にコミットの完了を返させる（順序は IPC の関連付けたインターフェースで保つ。[process-model.md](process-model.md) の 4.1）。

## 6. セッション履歴と bfcache

### 6.1 履歴のモデル

- タブごとに、履歴の項目の列と、今の位置を持つ。各項目は、その時点の frame の木に沿った、frame ごとの項目（URL、オリジン、文書の状態、POST の本文の識別子）を持つ。
- iframe の中のナビゲーションも、項目を増やす（仕様の joint session history）。戻るは、どの frame を動かすかを項目の差から決める。
- 項目の数の上限は 50（本家と同じ既定。**未検証**。`NavigationController` の上限を確かめる）。超えたら古いものから捨てる。
- `history.pushState` の状態（シリアライズした値）は、Renderer から受け取る不透明なバイト列として保存し、同じオリジンの文書にだけ戻す。大きさの上限を設ける（仕様の上限は実装に任される。本家の値は **未検証**）。

### 6.2 履歴の移動

- 戻る・進むは Browser が始めるナビゲーションとして扱い、仕様の apply the history step に沿って、動かす frame を決める。
- 各 frame について、bfcache にあれば復元（6.3）、なければ通常のナビゲーション（キャッシュを優先して読む）。
- 移動の前に、動かす frame のうち `beforeunload` を持つ文書に問う。
- Renderer から受け取った「文書の状態」（スクロールの位置、フォームの値）は、侵害された Renderer が作りうるので、復元先の文書のオリジンと一致する項目にだけ渡し、Browser は中身を解釈しない。

### 6.3 bfcache

方式は [ADR-0009](../decisions/0009-back-forward-cache.md) で決めた。ページ全体（JavaScript のヒープを含む）を、同じプロセスのメモリに凍結して残し、戻る・進むで即座に表示する。本家では、デスクトップのナビゲーションの約 1 割が戻る・進む（[web.dev](https://web.dev/articles/bfcache)）。

- **入れる**：最上位のクロスドキュメントのナビゲーションで離れるとき、ページ（frame の木のすべての文書）が条件を満たせば、`pagehide`（`persisted: true`）を送り、凍結する。タイマー・Promise の実行・ネットワークの読み込みを止める。
- **入れない条件**（MVP）：`unload` の処理器、`window.opener` を持つ・持たれる、進行中の `fetch`・XHR、開いた IndexedDB の接続で他のタブをふさいでいるもの、WebRTC、`Cache-Control: no-store` の文書、ダウンロードや権限のダイアログの表示中。条件の一覧は 1 か所で持ち、理由のコードを付ける。
- **追い出す**：凍結中に JavaScript を実行しなければならない事態（別のタブからの `BroadcastChannel` のメッセージの配送など）が起きたら、実行せずに追い出す。凍結中のページが動いたように見えることを防ぐ。
- **保持の上限**：タブあたり 6 ページ、1 ページあたり 10 分（本家の既定。10 分は [Chrome のドキュメント](https://developer.chrome.com/docs/web-platform/bfcache-ccns)で確認。6 ページは `cache_size` の既定として見たが **未検証**）。メモリの圧迫で減らす（[process-model.md](process-model.md) の 3.5）。
- **プロセス**：凍結したページのプロセスは、プロセスの鍵を保ったまま残す。上限の計算では、凍結中のページだけのプロセスを優先して止める候補にする。
- **復元**：戻るで該当のページがあれば、ネットワークに行かず、凍結を解いて `pageshow`（`persisted: true`）を送る。文書の実体は保存していたものを使うので、コミットの検査（5.3）は要らないが、プロセスが生きていること・鍵が変わっていないことは確かめる。
- **理由の公開**：復元できなかった理由を、`notRestoredReasons`（Navigation Timing）で返す。自分たちの理由のコードを、仕様の名前に対応づける。
- `Cache-Control: no-store` の文書を条件付きで入れる（本家は Cookie が変わっていなければ 3 分だけ入れる）のは、E3 の後で検討する。

### 6.4 セッションの保存と復元

- 各タブの履歴を、プロファイルのディレクトリに保存する（形式は [data-model.md](data-model.md) の索引に載せる）。変更のたびに書くのではなく、数秒ごとにまとめて追記する。
- 保存するのは、項目の URL・題名・文書の状態・POST の有無。POST の本文は保存しない（復元時に再送の確認を出す）。
- シークレットのタブは保存しない。
- 復元は、見えているタブだけを読み込み、他は読み込まずに履歴だけを戻す。

## 7. Renderer への読み込み

- 本文は、Network サービスから Renderer へ、データのパイプで直接流す。Browser は本文を中継しない（コミットの指示の中でパイプの端点を渡すだけ）。
- ネットワークを使わないスキーム（`file:`、`data:`、`blob:`、内部のページ）は、Browser の中の読み込み器が本文を作り、同じくデータのパイプで渡す。`blob:` は、Blob の登録簿で、その URL を作ったオリジンからの読み込みかを検査する。
- Renderer の HTML の解析器は、届いた分から解析する（ストリーミング）。解析を止めるスクリプトの待ちの間も、先読みの走査（preload scanner）で後のサブリソースを見つけて要求する。
- 文字コードの判定（BOM、ヘッダー、`<meta charset>` の先読み）は Renderer で行う。
- 読み込みの状態（`DOMContentLoaded`、`load`、読み込み中の表示）を Browser へ知らせる。タブの読み込み中の表示と、`webNavigation` の通知に使う。
- 詳細（解析器、スクリプトの実行の順序、優先度）は [rendering.md](rendering.md) と [networking.md](networking.md) で扱う。

## 8. エラーページとインタースティシャル

| 場合 | 表示 | コミット先 |
| --- | --- | --- |
| ネットワークのエラー（DNS、接続、TLS 以外） | Browser が作るエラーページ | エラーページ専用のプロセス（本家と同じ。サイトのプロセスに、中身のないエラーの文書を入れない） |
| HTTP の 4xx・5xx で本文あり | サーバーの本文を表示する | 通常のプロセス |
| 埋め込みの拒否（4.2）、ブロック（拡張機能、管理者のポリシー） | エラーページ | エラーページ専用のプロセス。再読み込みしても再試行しない |
| TLS の証明書のエラー、Safe Browsing の警告 | インタースティシャル（利用者が進むかを選ぶ） | コミットしたエラーページとして扱う。元のナビゲーションは中止し、進むを選んだら新しいナビゲーションを始める |

- エラーページの文書の URL は、行き先の URL を表示用に持つが、オリジンは不透明にする。

## 9. ダウンロード

- ダウンロードにすると決めたら（4.5）、応答をダウンロードの管理（Browser）へ渡す。Renderer には何も渡さない。
- 保存先・ファイル名の決定、危険な形式の確認、Safe Browsing の判定は Browser で行う（[safe-browsing-and-permissions.md](safe-browsing-and-permissions.md)）。
- 保存したファイルに、取得元の印を付ける。Windows は Mark of the Web（`Zone.Identifier`）、macOS は隔離の拡張属性（`com.apple.quarantine`）、Linux は拡張属性 `user.xdg.origin.url`・`user.xdg.referrer.url`（本家と同じ。OS の検査には使われない）。
- ダウンロードの一覧と再開は [browser-ui.md](browser-ui.md) と [storage.md](storage.md) で扱う。

## 10. 先読み（後で）

- Speculation Rules による prefetch と prerender は、MVP に含めない。E3 の後、S2 で入れる。
- 入れるときの論点：prerender した文書のプロセスとサイトの実体を、有効化の時点でどう付け替えるか。有効化までに禁止する API（権限の要求、ダウンロード）。別のサイトの prefetch で Cookie を送らない扱い。
- アドレスバーの候補での先読み（接続の事前の確立）は、ネットワークの先読みとして [networking.md](networking.md) で扱う。

## 11. 指標

[observability.md](observability.md) に載せる。

- ナビゲーションの区間ごとの時間（開始 → 応答、応答 → コミット、コミット → 最初の描画）
- プロセスの選択の結果（同じプロセス、予備、新規、再利用）の割合
- bfcache の利用率（戻る・進むのうち復元できた割合）と、復元できなかった理由の分布
- コミットの完了の検査に失敗して終了させた数

## 12. リスクと未解決事項

- **RenderDocument を最初から採る費用**：同じサイトのナビゲーションごとに文書の実体を作り直すので、本家が段階的に移行している理由（テストの前提の変更、性能）に最初からぶつかる。E3 で、同じサイトのナビゲーションの遅延を測る。
- **互換性**：履歴の移動と frame の木の組み合わせは、仕様と実装の差が大きい。WPT の `html/browsers/browsing-the-web/` と `html/browsers/history/` の合格率を E2 で追う。
- **bfcache の条件**：入れない条件が多いほど、利用率が下がる。本家の `notRestoredReasons` の理由の一覧と、利用率を比べて、条件を減らす順を決める。
