# loka の HTML の書きかた

> 紙とインクと、余白。速さより、健やかさ。
> ここに置く HTML は、誰かを急かすためではなく、そっと手を貸すためにある。

loka の共有ドライブ(`shared_drive/`)に置く、一枚ものの HTML アプリを書くときの
手ざわり。深い理由は元の方法論にある(`playground/kind-html-css-methodology.md` と、
その補章の `quiet-design-principles.md` / `soboku-kawaii-supplement.md`)。
ここは、手を動かすときに横に置く、短いほう。

## 0. まず、三つのこと

- **一枚で完結する。** HTML/CSS/JS 一枚。外部フォントと追跡は無し。
  操作や状態のあるページでは、petite-vue の固定版 CDN を使う(読み込みにはネットが要る)。
- **読む人を急かさない。** 動きは控えめ。色は静か。点滅しない。
- **余白を残す。** 詰めない。空白は、息。

## 0.1 操作のあるページは petite-vue

HTML の中に小さな状態や操作があるときは、petite-vue で書く。ビルドは要らず、
既存の HTML に `v-scope` と `@click` などを足せる。単なる読み物なら、素の HTML のままでよい。

```html
<script src="https://unpkg.com/petite-vue@0.4.1/dist/petite-vue.iife.js" defer init></script>

<div v-scope="{ count: 0 }">
  <p>いまの数: {{ count }}</p>
  <button @click="count++">ひとつ増やす</button>
</div>
```

- petite-vue は `v-scope` の式を JavaScript として評価する。利用者が書いた HTML を、
  `v-scope` の中へ入れない。
- 公開ページは sandbox された枠で動く。フォーム送信や親ページの操作を前提にしない。
- バージョンを固定する。最新追従で表示が変わるのを避ける。

## 1. 色 ── 紙と、インク

白ではなく、すこし温かい紙の上に。黒ではなく、すこし茶のインクで。

```
:root {
  --bg:     #fbf6ee;  /* 紙 */
  --card:   #ffffff;  /* カード */
  --ink:    #4a3f37;  /* 本文 */
  --sub:    #a99a89;  /* 補助・muted */
  --accent: #9a5b3f;  /* リンク・主ボタンの縁 */
  --line:   #eee3d5;  /* 境界線 */
}
```

- データの色(収入の緑、支出の赤など)は、**意味があるときだけ**。彩度はひかえめに。
  例: `--income #2e8b57` / `--expense #c0392b` / `--accent-blue #4a6fa5`。
- コントラストは確保する(本文 4.5:1 以上)。明るい場所でも、暗い場所でも。
- **色だけで意味を運ばない。** 記号や文字も添える。

## 2. 字と、行

```
font-family: system-ui, -apple-system, "Hiragino Sans", "Yu Gothic", sans-serif;
body { font-size: 16px; line-height: 1.8; }
h1   { font-weight: normal; font-size: 1.2rem; letter-spacing: .02em; }
```

- 見出しは**太らせない。** 静けさは、太さではなく、余白と階層でつくる。
- 数字は `font-variant-numeric: tabular-nums;` で、桁を揃える。
- 一行は 40 字くらいまで。長い行は、読む目を疲れさせる。

## 3. かたち

```
--radius: 10px;                     /* 8〜14px の範囲で */
--shadow: 0 1px 3px rgba(0,0,0,.06);
```

- カードは白、1px のやわらかい線、ごく薄い影。
- 強い影、グラデーション、光沢は使わない。
- ボタンは控えめ。**主ボタンだけ**、インクで塗る。
- 押せる範囲は 44×44px 以上。見た目より、指のほうを広く。

## 4. 幅と、画面

- 読み物は `max-width: 40rem; margin: 3rem auto; padding: 0 1rem;`
- アプリは `max-width: 480px;` を中心に。
- モバイルが先。
  `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`
- 下に固定する帯は `padding-bottom: env(safe-area-inset-bottom);` を足す。
- `box-sizing: border-box` で、はみ出させない。

## 5. 意味のある HTML

- `<button>` はボタン、`<a>` は行き先。混ぜない。
- 入力には `<label>`。見出しは `<h1>` から順に、飛ばさない。
- ページの言語を言う: `<html lang="ja">`。
- フォーカスの輪を消さない。` :focus-visible { outline: 2px solid var(--accent); }`
- 並ぶものは、`<ul>` / `<li>` で。

## 6. 動き

- 変化は 120〜200ms、ease。跳ねない、舞わない、音を鳴らさない。
- `@media (prefers-reduced-motion: reduce)` で、動きを止められるように。
- 読み込みで中身が飛び跳ねないよう、場所を先に確保しておく。

## 7. データを読む・置く

小さな HTML は、同じフォルダのデータを相対パスで読める。助手もある(`/loka.js`)。

```
<script src="/loka.js"></script>
<script>
  const rows = await loka.json("data.json");          // 同じフォルダ
  const cfg  = await loka.sharedJson("config.json");  // shared_drive の直下
</script>
```

- 読みは相対パスか `loka.js`。**書きは、シロの手(MCP の run_mruby_shell)を通す。**
  HTML から勝手に部屋を書き換えない。
- 手元だけの状態は `localStorage` に。人にも見せたいものは、共有のファイルに。
- JSON が無い・壊れているときは、白い画面にしない。やさしい一文を出す。

公開ページで先に必要なテキストを HTML と一緒に返したいときは、入口の HTML に
bundle marker を置く。公開 URL ではサーバーがテキストを同じレスポンスに埋め込み、
ブラウザーからの後追い fetch を省ける。通常の `/raw` で開いたときは、相対 fetch に戻る。

```
<!-- loka:bundle data.md -->
<script>
  (async () => {
    const bundled = document.getElementById("loka-bundle-data.md");
    const text = bundled ? JSON.parse(bundled.textContent) : await loka.text("data.md");
    // text をここで読む
  })();
</script>
```

marker で同梱できるのは、公開フォルダー内のテキストファイル(合計 1 MiB まで)。

連番の Markdown が複数あるときは glob marker を使う。サーバーが一度に読み、番号順の
文字列配列を同じ HTML に埋め込む。

```
<!-- loka:bundle-glob floorp/issue_*.md as issues -->
<script>
  const bundled = document.getElementById("loka-bundle-issues");
  const issues = bundled ? JSON.parse(bundled.textContent) : null;
</script>
```

## 8. ことば

- 命令しない。急かさない。「押せ」ではなく「押す」。
- 空やエラーも、責めない。「まだ記録がありません」「入り直してみてください」。
- 相手を高くも、低くもしない。`!` は、一画面にひとつまで。

## 9. はじまりの一枚

```
<!doctype html>
<html lang="ja">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>…</title>
<style>
  :root{ --bg:#fbf6ee; --card:#fff; --ink:#4a3f37; --sub:#a99a89; --accent:#9a5b3f; --line:#eee3d5; }
  *{ box-sizing:border-box; }
  body{ font:16px/1.8 system-ui, -apple-system, "Hiragino Sans", "Yu Gothic", sans-serif;
        color:var(--ink); background:var(--bg);
        max-width:480px; margin:0 auto;
        padding:24px 16px calc(32px + env(safe-area-inset-bottom)); }
  h1{ font-weight:normal; font-size:1.2rem; letter-spacing:.02em; }
  .card{ background:var(--card); border:1px solid var(--line); border-radius:12px;
         padding:16px; margin:16px 0; box-shadow:0 1px 3px rgba(0,0,0,.06); }
  button{ font:inherit; min-height:44px; padding:10px 14px; cursor:pointer;
          border:1px solid var(--line); border-radius:10px;
          background:var(--card); color:var(--ink); }
  .muted{ color:var(--sub); font-size:.9rem; }
  :focus-visible{ outline:2px solid var(--accent); outline-offset:2px; }
</style>
<body>
  <h1>…</h1>
  <div class="card">…</div>
</body>
</html>
```

## 10. 出す前の、小さな確認

- [ ] 一枚で開くか(外部読み込みゼロ)
- [ ] スマホの幅で、はみ出さないか
- [ ] キーボードだけで使えるか(focus が見えるか)
- [ ] 空・エラーのときの一文があるか
- [ ] 色を消しても、意味が残るか
- [ ] 動きを止めても、困らないか

---

速さより、健やかさ。淡く、一期一会。
