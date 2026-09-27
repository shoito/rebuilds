---
status: accepted
date: 2026-09-27
---

# ADR-0002: 多人数は SFU で中継し、1:1 も SFU を通す。大きな会議は SFU をカスケードし、映像は simulcast と SVC で送る

## Context

多人数の会議で、音声と映像をどう届けるかには、主に 3 つの形がある。

- **P2P（メッシュ）**：参加者どうしが直接つながる。n 人の会議で、各自が n−1 本を送る。上りの帯域が足りなくなるので、数人が限界になる。
- **MCU**：サーバーが全員の映像を復号し、1 本に合成して送り直す。受け手の帯域は小さいが、サーバーの CPU の費用が大きく、合成の分だけ遅れる。受け手ごとに表示を変えられない。
- **SFU**：サーバーは復号せず、受けた RTP を選んで転送する。各自の上りは 1 本（または層ごとに数本）で済む。

本家 Zoom は、1 本の上りと複数の下りを、サーバーの群れで最適に中継する「Multimedia Router」を使うと説明されている（二次の資料。[CometChat の解説](https://www.cometchat.com/blog/zoom-video-technology-architecture)、2026-09-27 に確認。本家の一次の資料では未確認）。

映像の層の作り方には 2 つある。

- **simulcast**：同じ映像を、解像度の違う独立した複数の本数で送る（[RFC 8853](https://www.rfc-editor.org/rfc/rfc8853.html)）。VP8・H.264 を含め、どのブラウザでも使える。
- **SVC**：1 本の中に、空間と時間の層を重ねる。VP9・AV1 で使える。ブラウザでの設定は [WebRTC-SVC](https://www.w3.org/TR/webrtc-svc/) の `scalabilityMode`（例：`L1T3`、`L3T3_KEY`）で行う（2026-09-27 に確認した時点で Working Draft）。

参加者が多い会議（S3 で 1,000 人）は、1 台の SFU に収まらない。参加者が国内の東西や海外に散らばると、1 か所の SFU までの遅れも増える。

## Options

1. **SFU。1:1 も SFU を通す。大きな会議は SFU をカスケードする**
2. **SFU。ただし 1:1 は P2P にする**
3. **MCU**
4. **SFU と MCU の組み合わせ（大きな会議の受け手に合成した映像を送る）**

## Decision

1 を採用する。

- **多人数の会議は SFU で中継する。** サーバーは映像を復号しない。受け手ごとに、帯域と表示の大きさに合わせて層を選んで送る。
- **1:1 の会議も SFU を通す。** 録画・字幕・主催者の操作・品質の計測・3 人目の参加が、人数によらず同じ経路で動く。P2P は S2 で、費用と品質を計測してから別の ADR で判断する。
- **映像の層**：
  - 既定はカメラの映像を simulcast の 3 本（例：180p・360p・720p）で送る。VP8 を基準にする。
  - SVC（VP9・AV1 の `L3T3_KEY` など）は、送り手と受け手のブラウザがすべて対応する会議で使う。どの形を使うかは Meeting Actor が決め、会議の途中で切り替えうる。
  - 画面共有は、解像度を保ち、フレームの数を落とす方針で、時間の層だけを使う。
- **音声**：Opus を使い、DTX、インバンド FEC、RED（冗長の符号化）を有効にする。mediasoup は RED に対応しないので、RED の転送と受け手ごとの剥がしを mediasoup のフォークに足す（[ADR-0017](0017-opus-dtx-fec-red.md)）。音声の大きさのヘッダー拡張で話者を決め、受け手には声の大きい数人（既定で 3 人）の音声だけを転送する（[ADR-0011](0011-forwarding-and-layer-selection.md)）。100 人を超える会議では、受け手ごとの 3 つの音声の枠に話者を付け替えて送る（[ADR-0057](0057-audio-slots-for-large-meetings.md)）。
- **帯域の推定**：送り手の側の推定（transport-cc の帰還と Google Congestion Control）を使う。SFU は受け手ごとに下りの帯域を推定し、層を選ぶ。transport-cc と GCC は、どちらも IETF の草案のまま失効している（[transport-cc](https://datatracker.ietf.org/doc/html/draft-holmer-rmcat-transport-wide-cc-extensions-01)、[GCC](https://datatracker.ietf.org/doc/draft-ietf-rmcat-gcc/)、2026-09-27 に確認）が、ブラウザの実装の事実上の標準であり、それに合わせる。
- **カスケード**：
  - リージョンの中：1 台に収まらない会議は、複数の Media Node に広げ、台の間を中継でつなぐ（S2）。
  - リージョンの間：参加者の近くの Media Node に接続させ、Node の間を中継でつなぐ（S3）。中継の経路は木にし、ある Node から別の Node へは 1 ホップだけにする（遅れを抑えるため）。
  - Node の間の中継（mediasoup の pipe）は、送り手の producer のすべての層を運ぶ（[ADR-0012](0012-media-assignment-and-cascading.md)）。リージョンの中の帯域は安いので S2 では受け入れる。先の Node の受け手が要る層だけを運ぶことは、リージョンの間の帯域が効く S3 の課題として、S3 の前に試作して別の ADR で決める（[media-server-sfu.md](../architecture/media-server-sfu.md) の 8.4 節）。
- 2 は、1:1 で転送の費用を減らせる。ただし、3 人目の参加や録画の開始で SFU へ移る処理が要り、経路が 2 種類になる。
- 3 は、サーバーの費用と遅れが大きい。E2EE とも両立しない（サーバーが復号する必要がある）。
- 4 は、ウェビナーのような視聴専用の配信で検討する価値がある。双方向の会議では、MVP の範囲外にする。

## Consequences

- 良くなること：
  - サーバーは復号しないので、1 台で多くの参加者を扱える。E2EE（SFrame）とも両立する。
  - 受け手ごとに層を変えられるので、悪い回線の人が他の人の品質を下げない。
- 引き受けるコスト：
  - 送り手の上りは、simulcast で 1 本の場合より 3〜4 割ほど増える（未検証。E4 で計測する）。
  - 層の選択、キーフレームの要求の集約、話者の検出を、SFU で正しく作る必要がある。
  - RED（[ADR-0017](0017-opus-dtx-fec-red.md)）と、E2EE の会議の Dependency Descriptor の判断（[ADR-0028](0028-sframe-encoded-transform-and-dependency-descriptor.md)）のため、mediasoup のフォークを持ち、上流の版に追従する。
  - カスケードの中継の経路と、Node の障害の時の付け替えが、Meeting Actor の設計を複雑にする（[ADR-0005](0005-meeting-state-and-signaling.md)）。

## Confirmation

- ネットワークの劣化の試験：3 人の会議で 1 人の下りを 500 kbps に絞ったとき、その人は低い層を受け、他の 2 人の受ける層は変わらない。
- ネットワークの劣化の試験：損失 20% の回線の参加者の音声を、他の参加者が NFR-003 の品質で聞ける。
- 負荷試験（E10）：2 つの Media Node にまたがる会議で、Node をまたぐ参加者どうしの遅れの増加が、同じ Node の場合と比べて p95 30ms 以内（同じリージョンの中）。
