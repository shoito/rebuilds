---
status: accepted
date: 2026-09-27
---

# ADR-0026: 日本語の音声認識は、S1 では Amazon Transcribe の ja-JP のストリーミングを話者ごとの流れで使い、エンジンは ASR Adapter の裏に置く

## Context

日本語のライブ字幕と文字起こし（[intent.md](../intent.md) の MVP）には、音声認識のエンジンが要る。目標は、会議の音声で文字の誤り率（CER）15% 以下、発話から字幕の表示まで p95 2 秒以内（K7、NFR-010）。自前のモデルの学習はしない（intent.md の Non-goals）。

確かめたこと（いずれも 2026-09-27 に確認）：

- Amazon Transcribe は ja-JP を batch と streaming の両方で扱う。東京（ap-northeast-1）にストリーミングのエンドポイントがあり、ja-JP は東京で streaming が使えない言語に入っていない（[Supported languages](https://docs.aws.amazon.com/transcribe/latest/dg/supported-languages.html)、[endpoints and quotas](https://docs.aws.amazon.com/general/latest/gr/transcribe.html)）。
- ストリーミングは PCM・FLAC・Ogg の Opus を受ける。16 kHz を勧め、塊は 50〜200ms（[Transcribing streaming audio](https://docs.aws.amazon.com/transcribe/latest/dg/streaming.html)）。
- 同時の流れは既定で 1 リージョン 25（引き上げの申請ができる）。1 つの流れの長さには引き上げられない上限がある（同上）。上限は 4 時間（[Transcribe の FAQ](https://aws.amazon.com/transcribe/faqs/)）。
- Transcribe は大阪（ap-northeast-3）に batch・streaming のどちらの受け口もない（[endpoints and quotas](https://docs.aws.amazon.com/general/latest/gr/transcribe.html)）。
- カスタム語彙はすべての対応言語で使える（[Custom vocabularies](https://docs.aws.amazon.com/transcribe/latest/dg/custom-vocabulary.html)）。
- 東京の streaming の料金は 1 秒 0.0001667 USD（1 分 0.01 USD）（[AWS Price List API](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/transcribe/current/ap-northeast-1/index.json)）。
- 途中の結果の安定化がある（[Streaming and partial results](https://docs.aws.amazon.com/transcribe/latest/dg/streaming-partial-results.html)）。
- 話者の区別は streaming でも使え、最大 30 人（[Partitioning speakers](https://docs.aws.amazon.com/transcribe/latest/dg/diarization.html)）。
- 日本語の CER と遅れは確かめていない（**未検証**。E8 の `asr-evaluation-set` で測る）。
- Whisper は、音声を 30 秒の窓で処理する（[openai/whisper の README](https://github.com/openai/whisper)）。そのままではストリーミングに向かず、区切って処理する必要がある。

SFU は参加者ごとに音声の producer を持つので、参加者ごとの音声を別々に取り出せる。

## Options

1. **Amazon Transcribe streaming（ja-JP、東京）。参加者ごとの音声を別の流れで送る**
2. **Amazon Transcribe streaming。全員の音声を混ぜた 1 本を送り、話者の区別をエンジンに任せる**
3. **自前でホストする Whisper 系（faster-whisper、kotoba-whisper など）を GPU の EC2 で動かす**
4. **ほかのクラウドの音声認識の API**

## Decision

1 を採用する。エンジンは ASR Adapter の裏に置き、E8 の前に 3・4 と比べる。詳細は [recording-and-transcription.md](../architecture/recording-and-transcription.md) の 5 節と 8 節。

- Transcriber が producer ごとに Opus を復号し、16 kHz の PCM にして、100ms の塊で送る。
- 1 会議に「話者の枠」を 4 つ持ち、発話を検出した人に枠を渡す。枠ごとに 1 本の流れを開く。前の 1 秒を貯めて最初に送る。20 秒発話がなければ枠を返す。
- 話者は流れで決まるので、エンジンの話者の区別は使わない。
- 途中の結果の安定化を `high` にする。
- 3 時間 50 分で新しい流れに切り替える。
- 同時の流れの上限は、capacity.md の見積もりをもとに引き上げを申請する。
- ASR Adapter の境界：`open(stream_id, lang, vocab_ref) → push(pcm_100ms) → results(partial|final, text, stable_len, start_ms, end_ms, confidence) → close()`。エンジンを替えても、Transcriber とクライアントは変えない。
- 2 を採らない理由：話者の区別の誤りが、そのまま字幕の名前の誤りになる。会議の参加者の名前と結び付けられない。重なった発話で両方の誤りが増える。
- 3 を今は採らない理由：GPU のインスタンスの運用、区切りによる遅れの増加、モデルのバージョンの管理を、E8 の時点で抱えることになる。一方で、会議の音声を外部の事業者に渡さずに済み、量が増えると安くなりうる。評価の結果と L6 の結論しだいで、S2 で切り替える候補にする。
- 4 を今は採らない理由：評価の前に選ぶ根拠がない。8 節の評価に含める。

## Consequences

- 良くなること：
  - 字幕と文字起こしの話者が、会議の参加者の名前と必ず合う。
  - GPU の運用を持たずに E8 を始められる。東京の中で完結する。
  - エンジンを替えても、ASR Adapter の外は変わらない。
- 引き受けるコスト：
  - 流れの数が「話している人の数」に比例する。1 会議 4 枠でも、同時の会議が多いと、既定の上限 25 をすぐに超える。
  - 枠を返すまでの無音も送るので、費用に入る（streaming は音声の秒で数える。1 回の枠の返却までに最大 20 秒、約 0.0033 USD）。
  - 東京のリージョンの障害で大阪に切り替えている間は、字幕と文字起こしを止める（大阪に Transcribe がない。[ADR-0050](0050-disaster-recovery-and-edge-migration.md)）。
  - 会議の音声を外部の事業者（AWS）の音声認識に渡す。委託と外国にある第三者の整理は L6 に従う。
  - 1 本のマイクを複数の人で使う会議では、話者を分けられない（MVP では受け入れる）。

## Confirmation

- E8 の前の評価（recording-and-transcription.md の 8 節）：候補ごとに CER、遅れ（p50・p95）、1 時間あたりの費用を比べ、E8 の変更の `quality.md` に残す。Transcribe が K7 を満たさなければ、新しい ADR でエンジンを替える。
- 結合試験：4 人が順に話す会議で、字幕の `participant` が話した人と一致する。
- 負荷試験：同時の流れを上限の近くまで開き、`LimitExceededException` の時の再試行と、字幕の `degraded` の表示を確かめる。
- レビュー：ASR Adapter の外のコードが、エンジンの SDK を直接呼んでいない（import の lint）。
