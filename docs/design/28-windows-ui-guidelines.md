# 28 Windows アプリの良い UI — 原則と AI 実装規則

対応要件: AGENTS.md「実装方針（UI は Fluent UI React v9）」、[23 UI 2モード・移行](23-ui-and-migration.md)

本書は「Windows アプリにおける良い UI とは何か」を一般論として調査・言語化し、生成 AI がそのまま
実装・レビューに使える規則へ落としたものである。前半（1–7章）は ScopePilot2 に依存しない一般論で、
1–6章が「使いやすさ」、7章が「格好良さ（美的品質）」とその両立規則である。
後半（8–9章）は Electron + React + Fluent UI React v9 への写像、10章が ScopePilot2 への適用メモである。
数値・用語は 2026-10-19 時点の Microsoft Learn / Fluent 2 / Electron 文書に基づく（出典は10章）。
出典で確認できなかった事項は「未確認」と明記する。

## 1. 要約: 良い Windows UI の定義

良い Windows UI とは、**利用者が Windows で既に身につけた操作・見た目・言葉づかいがそのまま通用し、
目的の作業に集中でき、どの入力手段・表示環境・能力の人でも同じ結果に到達できる UI** である。

これを 5 つの性質に分解する。以降の規則はすべてこのいずれかに紐づく。

| # | 性質 | 一言で | 根拠 |
|---|---|---|---|
| P1 | 馴染み (Familiar) | Windows の標準どおりに振る舞い、学習コストがない | Windows 11 design principles: Familiar |
| P2 | 静穏・集中 (Calm / Effortless) | 装飾より内容。必要なものだけが前に出る | Calm, Effortless、Nielsen「美的で最小限」 |
| P3 | 一貫 (Complete + Coherent) | 同じ意味のものは同じ見た目・位置・言葉 | Complete + Coherent、Nielsen「一貫性と標準」 |
| P4 | 適応 (Personal) | テーマ・DPI・ウィンドウ幅・入力手段・言語に追従する | Personal、epx・レスポンシブ指針 |
| P5 | 誰でも使える (Accessible) | キーボードだけ・スクリーンリーダー・高コントラストで完走できる | Windows accessibility 指針、WCAG |

加えて、業務ツールとしての良さ（Nielsen の 10 ヒューリスティクスのうち特に重要なもの）:

- **状態の可視性**: いま何が起きているか（処理中・成功・失敗・停止）が常に見える。
- **利用者の制御と自由**: 取り消し・停止・戻るが常に可能。破壊的操作は確認か Undo を持つ。
- **エラー予防と回復**: 誤操作をそもそも起こしにくくし、起きたら原因と直し方を言葉で示す。
- **段階的開示 (progressive disclosure)**: 頻用機能は最初の画面に、上級機能は一段奥に置く。
  初心者の誤りを減らし、熟練者の走査コストも減らす。

さらに、上記を満たしたうえで **格好良い**（P6 美的品質: 抑制・秩序・精度・一貫した個性）ことを目指す（7章）。
規則が衝突したときの優先順位は次のとおりで、格好良さは上位の規則を満たす範囲の自由度で追求する。

> 安全・アクセシビリティ（P5） ＞ 馴染み・一貫（P1, P3） ＞ 集中・適応（P2, P4） ＞ 格好良さ（P6）

## 2. 視覚の基礎（Foundations）

### 2.1 単位・グリッド

- レイアウトは **effective pixel (epx)** で設計する。物理解像度・DPI は OS が吸収する。
- 要素のサイズ・余白・位置は **4epx の倍数**。スケーリング段階（100/125/150/175/200…%）で輪郭が
  にじまないため。テキストのサイズはこの制約の対象外。
- 標準の間隔（Microsoft の例示値）:

| 用途 | 値 |
|---|---|
| ボタン同士、コントロールとそのヘッダー | 8epx |
| コンテンツ領域同士、コントロールとラベル | 12epx |
| 面（surface）の端とその中のテキスト | 16epx |

- 同じ種類の区切りには同じ間隔を使う。間隔の一貫性がグルーピングを伝える（ゲシュタルトの近接）。

### 2.2 タイポグラフィ

- UI 全体で **フォントは 1 種類**。Windows 既定は **Segoe UI Variable**（weight と optical size の可変軸を持つ）。
- Windows 11 type ramp（size/line-height, epx）:

| 名前 | サイズ/行高 | weight | 用途 |
|---|---|---|---|
| Caption | 12/16 | Regular | 補足、メタ情報 |
| Body | 14/20 | Regular | 本文・既定 |
| Body Strong | 14/20 | Semibold | セクション見出し、強調 |
| Subtitle | 20/28 | Semibold | 小見出し |
| Title | 28/36 | Semibold | ページタイトル |
| Title Large / Display | 40/52, 68/92 | Semibold | ヒーロー（業務アプリではほぼ使わない） |

- 下限: **12px Regular / 14px Semibold 未満は使わない**（言語によって判読困難になる）。日本語 UI では 12px を
  常用せず、Body 14px を基準にする。
- 多くの文字は Regular、見出しだけ Semibold。太字・色・サイズを同時に重ねて強調しない。
- 切り詰めは **末尾の省略記号 (…)** を基本とし、全文はツールチップか詳細ペインで読めるようにする。
- **Sentence case**（文頭のみ大文字）をタイトル含む全 UI 文字列に使う（英語表記時）。

### 2.3 色・テーマ

- **Light / Dark / 高コントラスト** の 3 系統に追従する。OS 設定の変更に実行中も追従する。
- 色は直接値を書かず **意味づけされたトークン**（背景1/2/3、前景1/2、ブランド、危険、成功…）で指定する。
- コントラスト比: 通常テキスト **4.5:1 以上**、大きなテキスト（18pt 以上、または 14pt 太字以上）と
  アイコン・コントロール境界 **3:1 以上**。
- **色だけで意味を伝えない**。状態は色＋アイコン＋文言の 2 つ以上で示す（色覚多様性、高コントラスト時に
  色が置換されるため）。
- アクセントカラー（ブランド色）は主要アクション・選択状態・フォーカスなど「注意を向けるべき少数」に限る。
- 高コントラストを「読みにくさの救済策」にしない。既定テーマ自体で基準を満たす。高コントラスト時は
  OS 指定のシステム色に置き換わることを前提に、背景画像や独自色に依存した情報を置かない。

### 2.4 素材（Materials）・奥行き

| 素材 | 置く場所 | 置かない場所 |
|---|---|---|
| Mica / Mica Alt | ウィンドウの基層（特にタイトルバー領域）。長寿命の面 | 一時的な面 |
| Acrylic | 一時的・軽く閉じる面（コンテキストメニュー、フライアウト） | 主作業領域の背景 |
| 不透明の面 | 作業領域のカード・表・エディタ | — |

- Mica は透明効果オフ・省電力・低性能機・非アクティブ時に **単色へフォールバック**する。素材が無くても
  成立するデザインにする（素材は飾りであり情報を担わない）。
- 奥行き（elevation）は影と境界で「どの面が上にあるか」を示すためだけに使う。重なり順と影の強さを一致させる。
- 角丸: コントロール 4px、ウィンドウ・ダイアログ等の上位面 8px（Windows 11 の geometry）。

### 2.5 アイコン・モーション

- アイコンは 1 系統（Windows では Fluent System Icons / Segoe Fluent Icons）に統一し、線の太さ・サイズを揃える
  （UI 内は 16 または 20epx、リスト 2 行表示では 32epx）。アイコンだけのボタンには必ずツールチップと
  アクセシブル名を付ける。
- モーションは「何がどこから来てどこへ行ったか」を伝える目的に限る。短く（概ね 100–300ms）、
  OS の「アニメーション効果」オフ（`prefers-reduced-motion`）で無効化する。

## 3. 構造（Layout・Navigation・Commanding）

### 3.1 ウィンドウとタイトルバー

- タイトルバーにはアプリ名（＋必要なら文書名）、ドラッグ領域、OS 標準のキャプションボタン（最小化・最大化・閉じる）。
  キャプションボタンを自作しない（Snap Layouts など OS 機能を失う）。
- タイトルバーをカスタムする場合も、**ドラッグ可能な余白を十分に残し**、ダブルクリック最大化・右クリックの
  システムメニュー・Snap を壊さない。非アクティブ時は表示を弱める。
- 最小ウィンドウサイズを設け、それ未満でレイアウトが崩れないようにする。ウィンドウ位置・サイズ・最大化状態・
  ペイン幅を記憶して次回復元する。
- マルチモニター・DPI の異なるモニター間移動で表示がぼやけない・崩れない。

### 3.2 レスポンシブ

- 幅で 3 クラスに分けて組み替える（目安: 小 <640, 中 641–1007, 大 ≥1008 epx。値は二次資料経由で未確認のため
  実装時に Learn の "Screen sizes and breakpoints" で確認）。
- 手法: 再配置（横並び→縦積み）、表示/非表示（補助ペインを畳む）、置換（左ナビ→ハンバーガー）、
  再構成（list/details の分割→一覧と詳細の遷移）。
- 業務アプリは「大」を主対象としつつ、Snap で画面半分（≈ 960epx 前後）にしても主要作業が完遂できること。

### 3.3 ナビゲーション

| 状況 | 推奨 |
|---|---|
| 同格の最上位カテゴリが 5 以下、内容領域を広く取りたい | 上部ナビ（タブ型） |
| 同格の最上位カテゴリが 5–10、カテゴリを目立たせたい | 左ナビ（NavigationView） |
| 狭い幅 | 左ナビをアイコンのみ（compact）→メニューボタンのみ（minimal）へ自動縮退 |

- 左ナビの末尾（下端）に「設定」を置く。現在位置は選択インジケーターで常に示す。
- 階層が 3 段を超えるならパンくず（BreadcrumbBar）を併用する。「戻る」はタイトルバー左端。
- 一覧と詳細は **list/details** パターン: 左に一覧、右に選択項目の詳細。選択が変わったら詳細を更新し、
  幅が狭いときは一覧→詳細の遷移に切り替える。詳細が空にならないよう、直前/先頭の項目を選択しておく。

### 3.4 コマンド配置

- コマンドは **対象の近く**に置く: 画面全体に効くものはページ上部の CommandBar、項目に効くものは
  その項目のコンテキストメニュー・行内ボタン。
- CommandBar は **重要度順**に並べ、幅が足りないと右端から「…」（オーバーフロー）へ移る。
  よく使うもの（コピー・削除・共有など）は primary、まれなものは secondary（オーバーフロー内）。
- 同じコマンドは **どこから呼んでも同じ名前・同じアイコン・同じショートカット**。
- 主要アクション（primary/accent ボタン）は **1 画面（1 ダイアログ）に 1 つ**。
- ボタンの並び: 肯定（OK・保存・実行）を左、否定（キャンセル）を右（Windows 規約。macOS と逆）。
- 実行できない状態のコマンドは無効化して見せる（隠すと存在が学習されない）。無効の理由はツールチップで示す。

## 4. 振る舞い（Feedback・Dialog・Progress）

### 4.1 通知手段の使い分け

| 手段 | 使う場面 | 使わない場面 |
|---|---|---|
| ContentDialog（モーダル） | 操作の確認、必ず読ませる情報、アプリ全体を止めるべき重大な状態変化 | 単なる成功通知、頻繁な確認 |
| InfoBar / MessageBar（ページ内帯） | 永続的・非ブロッキングな状態（オフライン、権限不足、警告、処理結果） | 選択を迫る事柄 |
| Flyout / Popover | 特定要素に紐づく補足・軽い入力。外側クリックで閉じる | 重要情報（すぐ消えるため） |
| TeachingTip | 新機能・使い方の一時的な案内 | エラー、重要な状態変化、必須情報 |
| Toast（OS 通知） | アプリが背面・最小化中に完了した長時間処理 | 前面で見えている操作の結果 |
| ツールチップ | アイコンの名前、切り詰めた文字の全文、無効理由 | 操作手順、必須情報 |

- モーダルは割り込みであり、最小限にする。可能なら **確認より Undo** を選ぶ（取り消せる操作には確認を出さない）。
- 確認ダイアログは「何が起きるか」をタイトルに書き、ボタンは **具体的な動詞**（「削除」「送信を開始」）＋「キャンセル」。
  「はい/いいえ」「OK」だけにしない。破壊的操作の既定フォーカスはキャンセル側。

### 4.2 進捗

| 状況 | 表示 |
|---|---|
| 所要が分かる、作業を妨げない | 確定 ProgressBar（％や件数を併記） |
| 所要不明、作業を妨げない | 不確定 ProgressBar（帯状） |
| 完了まで操作を待たせる（接続中・サインイン中） | ProgressRing ＋ 状態文言 |
| 利用者が起動していない背景処理 | 原則表示しない（必要ならステータス欄に控えめに） |
| 一覧・詳細の読み込み | Skeleton（形の予告）で、レイアウトの跳ねを防ぐ |

- 約 1 秒以内に終わる処理にはインジケーターを出さない（ちらつく）。10 秒を超えるなら残り/件数と **停止ボタン**。
- 「読込中」「打切り（上限到達）」「失敗」「0 件」を **別の表示**にする。空状態には次の行動（何をすれば埋まるか）を書く。

### 4.3 エラー

- エラー文は **何が起きたか → なぜ（分かれば対象名つき）→ どうすれば直るか** の順で、利用者の言葉で書く。
  内部コード・スタックトレースは「詳細」に畳む（コピー可能にする）。
- 入力エラーは該当フィールドの直下にインラインで、入力中ではなくフォーカス離脱時・送信時に出す。
  エラー時も入力値を消さない。
- 責める・脅す・ふざける表現をしない。「無効です」ではなく「〜を入力してください」。

## 5. 入力（キーボード・マウス・タッチ）

- **キーボードだけで全機能が使える**こと。操作可能な要素はすべて Tab で到達でき、Tab 順は視覚順（左→右、上→下）と一致。
- 複合コントロール（ツールバー、リスト、ツリー、タブ、グリッド）は **Tab で 1 停止、内部は矢印キー**で移動（roving tabindex）。
- 画面を開いたときの **初期フォーカス** を意図して決める（主入力欄、または一覧の選択行）。ダイアログを閉じたら
  開く前の要素へフォーカスを戻す。
- **フォーカス表示は常に見える**（キーボード操作時。マウス操作時は出さない＝`:focus-visible`）。独自に消さない。
- ショートカット 2 種:
  - **アクセラレーター**（Ctrl+S 等）: 頻用操作の直行手段。Windows 慣習を優先する（下表）。メニュー・ツールチップに併記する。
  - **アクセスキー**（Alt を押すと出る 1 文字）: UI 要素への到達手段。
- 慣習キー（独自の意味で上書きしない）:

| キー | 意味 |
|---|---|
| Ctrl+C / X / V / Z / Y / A | コピー / 切取 / 貼付 / 元に戻す / やり直し / 全選択 |
| Ctrl+F, F3 / Shift+F3 | 検索、次/前を検索 |
| Ctrl+S, Ctrl+O, Ctrl+N, Ctrl+W | 保存、開く、新規、タブ/文書を閉じる |
| Ctrl+Tab / Ctrl+Shift+Tab | 次/前のタブ |
| F1 / F2 / F5 / Del | ヘルプ / 名前変更 / 更新 / 削除 |
| Esc | 取消・閉じる（ダイアログ、フライアウト、編集中断） |
| Enter / Space | 既定動作 / トグル・選択 |
| Shift+F10, アプリケーションキー | コンテキストメニュー |
| Alt+F4 | ウィンドウを閉じる（OS 管理） |

- マウス: 右クリックのコンテキストメニュー、ダブルクリックで既定動作（開く）、ドラッグでのペイン幅変更・並べ替え、
  ホバーで補助情報。**ホバーでしか出ない操作を作らない**（タッチ・キーボードで到達不能になる）。
- タッチ（2-in-1 を考慮）: 操作対象は **40×40epx 推奨**。密度の高い業務面でも 32×32epx を下回らない。

## 6. アクセシビリティ・言葉・国際化

### 6.1 アクセシビリティ（必須）

- すべての操作要素に **アクセシブル名・役割・状態** を与える（Windows では UI Automation 経由で Narrator が読む）。
  アイコンボタン、画像、入力欄（ラベルと関連付け）、状態変化（ライブリージョン）を漏らさない。
- 高コントラスト 4 テーマで、全テキストが読め、全アイコン・境界が見えることを確認する。
- テキスト拡大（Windows 設定「文字の大きさ」）とズーム 200% で切れない・重ならない。
- アニメーション抑制、点滅しない（3 回/秒以上の点滅禁止）。
- 時間制限のある操作を作らない（作るなら延長可能に）。

### 6.2 言葉（UI テキスト）

- 簡潔・具体・利用者の言葉。機能名でなく **目的** を書く（「ZAP Active Scan」より「脆弱性を検査」、詳細で機能名を示す）。
- ボタン・メニューは **動詞から**（「保存」「エクスポート…」）。続けて入力が要るコマンドは末尾に「…」。
- 用語を統一する（同じものを別名で呼ばない）。用語集を持ち、AI 生成文言もそれに従わせる。
- 句点: ボタン・ラベル・チェックボックス・見出しには付けない。完全な文（ツールチップ、エラー、ダイアログ本文）には付ける。
- 英語表記は sentence case、略語は大文字（ID, URL, HTTP）。

### 6.3 国際化

- 文字列を外部化し、連結で文を組まない（語順が言語で変わる）。
- 文字列長の増加（英→独で +30% 程度）と日本語の行高に耐えるレイアウト。固定幅ボタンに文字を詰めない。
- 日付・数値・単位はロケール書式。タイムゾーンを明示すべき記録（証跡など）は ISO 8601 ＋ オフセット。

## 7. 格好良さ（美的品質）の言語化

### 7.1 定義と位置づけ

一般に「格好良い」と評されるソフトウェア UI（Windows 11 の標準アプリ、Linear、Raycast、VS Code などが
よく例に挙がる）に共通するのは、派手さではなく **「すべての細部に意図が行き届いている」印象** である。
本書ではこれを次の 4 語で定義する。

| 語 | 意味 | 逆（格好悪い） |
|---|---|---|
| 抑制 | 要素・色・強調・装飾が必要最小限。足すより削る | 色や強調の乱発、飾りの箱と罫線 |
| 秩序 | 整列・間隔・階層に規則があり、目が迷わない | ずれ、不揃いな余白、階層の曖昧さ |
| 精度 | ピクセル・状態・タイミングの細部まで仕上がっている | 1px のずれ、ぼやけ、ちらつき、跳ね |
| 一貫した個性 | 色・形・言葉・動きが一つの声で語る | 部品ごとに流儀が違う寄せ集め感 |

なぜ重要か（aesthetic-usability effect）: 見た目が良い UI は「使いやすい」と感じられ、小さな使いにくさが
許容され、製品への信頼が上がる（Kurosu & Kashimura 1995 の ATM 実験ほか）。一方で、見た目の良さは
ユーザーテストで問題を **覆い隠し**、実際に作業で詰まると評価は反転する。したがって格好良さは
使いやすさの **上に載せるもの** であり、代わりにはならない（§1 の優先順位）。

### 7.2 格好良さを作る 10 の要素

各要素は 2–6 章の規則と矛盾しない形で書いてある。

1. **色の抑制**: 画面の大半をニュートラル（灰階調）で構成し、有彩色は **アクセント 1 色＋意味色（危険・警告・成功）** だけ。
   アクセントは主要アクション・選択状態・フォーカスに限る（§2.3）。1 画面で目を引く点は 1–2 か所。
2. **明快な階層**: 階層は「サイズ」「ウェイト」「明度」の 3 つで作り、各段の差をはっきりさせる
   （type ramp の 14→20→28 のように段差を飛ばす。13px と 14px のような曖昧な差を作らない）。
   テキストの明度は 2–3 段（主・副・補足）に限る。
3. **整列とリズム**: すべての要素を少数の縦横ラインに揃える（左端・ベースライン・数値の右端）。
   4epx グリッド上で「関連は近く、無関係は遠く」の間隔を守る（§2.1）。中央揃えは短い見出し・空状態だけ。
4. **区切りは軽く**: 領域の区切りは **余白 → 背景の明度差 → 細い罫線** の順に検討し、箱の中に箱（box in box）を作らない。
   影は浮いている面（メニュー・ダイアログ）だけに、小さく柔らかく。
5. **面と光**: 面の上下関係は明度の段で表す。ダークテーマは **純黒を避けた濃灰** を基調にし、上の面ほど明るく、
   有彩色は彩度を下げる（純黒＋純白の文字は滲んで見え、影も効かない）。Mica/Acrylic は質感として控えめに、
   基層と一時面にだけ（§2.4）。作業面にグラデーションやガラス表現を使わない。
6. **タイポグラフィの品位**: 書体は 1 系統＋等幅 1 系統（コード・HTTP・ハッシュ用）。数値は等幅数字（tabular figures）で
   右揃え、桁区切り。行長は本文で 1 行 40–80 字程度。全角と半角の間の扱い、単位の表記を統一する。
7. **形の一貫**: 角丸半径・線幅・アイコンの線の太さとサイズを統一する。入れ子の角丸は「内側 = 外側 − 内側余白」
   にして平行に見せる。アイコンは光学的に中央へ置く。
8. **状態の作り込み**: 通常・hover・押下・選択・フォーカス・無効の全状態を同じ体系で作る。空状態・エラー・
   読込中も「完成した画面」として整える（§4.2）。
9. **動きの質**: 速く（100–300ms）、自然に減速し、何がどこへ移ったかを伝える動きだけ。ループする飾りの動き、
   跳ねるレイアウト、1 秒未満で消えるスピナーのちらつきは作らない（§2.5, §4.2）。
10. **速さそのもの**: 体感速度は格好良さの一部である。操作への反応は 100ms 以内（押下の視覚変化・楽観的更新・Skeleton）、
    レイアウトは読込前後で動かさない。

### 7.3 相反しやすい点と両立のしかた

| 「格好良い」側の誘惑 | 衝突する規則 | 両立のしかた |
|---|---|---|
| 薄いグレーの文字で洗練感を出す | コントラスト 4.5:1（§2.3） | 4.5:1 を下限に、階層は明度 2–3 段で作る。基準を下回れるのは無効状態の文字だけ |
| 罫線・入力枠を極薄にする | 操作要素の境界 3:1（§2.3） | 入力欄・ボタンなど **操作できるもの** の境界は 3:1。装飾的な区切り線だけ薄くする |
| アイコンだけ・ホバーで出る操作でミニマルに | 発見性・キーボード・タッチ（§5, §6.1） | アイコンのみなら名前とツールチップを付ける。ホバーで現れる操作は、右クリックメニュー・キーボードで同じことができる場合に限る |
| 余白をたっぷり取る | 業務画面の情報密度 | 密度は画面種別で決める（表・ログは compact）。余白は罫線と箱を減らすために使い、総面積は増やさない |
| 独自スタイルでブランド感を出す | 馴染み（P1） | 変えてよい: アクセント色、イラスト・空状態、オンボーディング、言葉の調子。変えない: コントロールの形と振る舞い、ショートカット、ボタン順、タイトルバーとキャプションボタン |
| ダークテーマを既定にする | 適応（P4）、可読性 | 既定は OS 設定に追従。利用者が選べるようにする |
| 動きで華やかにする | 集中（P2）、`prefers-reduced-motion` | 情報を伝える動きだけにし、動きの抑制設定で止める |
| ガラス表現・グラデーション | 可読性、高コントラスト、性能 | 素材は基層と一時面だけ。無効時の単色でも成立させる |
| 色で状態を美しく塗り分ける | 色だけに頼らない（§2.3） | 色は補助として使い、形（アイコン）と文言を主にする |

### 7.4 格好悪いとされる典型（アンチパターン）

- 多色づかい、強調（太字・色・枠）の乱発、すべてが目立とうとする画面
- 1–2px の整列ずれ、間隔の不揃い、要素ごとに違う角丸・影・アイコンの線幅
- 書体の混在、全角英数、全大文字の長文、中央揃えの長文
- 箱の中に箱、意味のない罫線、強すぎる影
- ぼやけたラスター画像・アイコン（高 DPI 非対応）
- 読込でのレイアウトの跳ね、ちらつくスピナー、遅い・ぎこちないアニメーション
- 作り込まれていない空状態・エラー画面（生のエラー文、真っ白な画面）

## 8. AI 実装規則（Electron + React + Fluent UI React v9）

生成 AI は UI コードを書く・直すとき、以下を **MUST（違反は差し戻し）/ SHOULD（理由があれば例外可）** として守る。

### 8.1 MUST

1. **Fluent UI v9 のコンポーネントを第一選択**にする。同等品があるのに素の HTML 要素や独自コンポーネントを作らない。
   無い場合は Fluent の `makeStyles` とトークンで組み、外部 UI ライブラリを追加しない（依存追加は [21](21-update-management.md) の手続き）。
2. **色・余白・角丸・影・フォントは `tokens` 経由**で指定する。`#hex`・`rgb()`・生の `px` 余白を書かない。
   例外は 1px 境界線と、トークンに無いレイアウト寸法（ペイン最小幅など。4 の倍数）だけ。
3. アプリ全体を 1 つの `FluentProvider` で包み、テーマは OS に追従させる:
   `webLightTheme` / `webDarkTheme` を `prefers-color-scheme`（Electron では `nativeTheme`）で切替、
   `forced-colors: active`（高コントラスト）時は `teamsHighContrastTheme` を用いるか、システム色に委ねる。
   テーマ変更は再起動なしで反映する。
4. 文字は Fluent の typography（`Body1` 14/20、`Caption1` 12/16、`Subtitle2`、`Title3` 等、または `typographyStyles`）
   を使い、`fontSize` を直書きしない。12px 未満を作らない。
5. アイコンは `@fluentui/react-icons` のみ（16/20 サイズ、Regular と Filled の使い分けは選択状態のみ）。
   アイコンのみのボタンは `aria-label` と `Tooltip`（`relationship="label"`）を持つ。
6. キーボード: 全操作が Tab/矢印/Enter/Esc で可能。複合要素には `useArrowNavigationGroup`、
   領域単位の移動には `useFocusableGroup` 等の tabster フックを使う。`outline: none` でフォーカスを消さない。
   ダイアログは Fluent `Dialog` を使い、フォーカストラップと復帰を任せる。
7. 状態を色だけで示さない（`Badge`/アイコン＋文言を併用）。
8. 破壊的・外部送信を伴う操作は、確認 `Dialog`（具体的な動詞ボタン、既定フォーカスはキャンセル）か Undo を持つ。
9. 非同期の表示は「読込中（`Skeleton`/`Spinner`）・空（次の行動つき）・打切り・失敗（`MessageBar` intent=error と再試行）」
   の 4 状態を必ず実装する。成功時だけのコードにしない。
10. UI 文字列はコンポーネントに直書きせず、文字列資源（i18n キー）から引く。文の連結をしない。
11. 一覧が数百件を超えうるなら仮想化する。全件を DOM に描画しない。
12. タイトルバーを自作する場合も OS のキャプションボタンを残す（Electron: `titleBarStyle: 'hidden'` ＋
    `titleBarOverlay`、ドラッグ領域は CSS `app-region: drag`、その上のボタン等は `app-region: no-drag`）。
    オーバーレイの色はテーマ変更時に `setTitleBarOverlay` で更新する。

### 8.2 SHOULD

1. 余白はトークン段階に限定する: `spacingHorizontalXS`(4) / `S`(8) / `M`(12) / `L`(16) / `XL`(20) / `XXL`(24)
   （縦方向も同様）。§2.1 の 8/12/16 の使い分けに従う。
2. 情報密度の高い業務画面（表・ログ・エディタ）は Fluent の `size="small"` 系を使い、
   行高 32px 前後を基準とする。密度は画面種別ごとに統一し、同じ画面内で混在させない。
3. 背景は Mica（Electron: `backgroundMaterial: 'mica'`、Windows 11 22H2 以降のみ）を基層とし、
   作業面は不透明トークン（`colorNeutralBackground1` 等）で塗る。Mica 不可環境では単色で完結すること。
   `titleBarOverlay` との併用可否は Electron の版で挙動が変わりうるため **未確認**、実機で確認してから採用する。
4. フォントスタックは `"Segoe UI Variable", "Segoe UI", "Yu Gothic UI", "Meiryo UI", sans-serif`（Windows）、
   macOS はシステムフォント。Fluent の `fontFamilyBase` をテーマ上書きで設定する。
5. ペイン幅・選択タブ・ソート・列幅は利用者ごとに記憶して復元する。
6. メニュー（Electron `Menu`）とアプリ内コマンドで同じ accelerator を定義し、表記を一致させる。
7. アニメーションは Fluent の motion トークン（`durationFast` 等、`curveEasyEase` 等）を使い、
   `prefers-reduced-motion` で止める。

### 8.3 格好良さのための実装規則（SHOULD。§7 の具体化）

1. ブランド色（`colorBrand*` 系トークン）を使うのは、1 画面につき主要ボタン 1 つ・選択状態・フォーカス・リンクだけ。
   それ以外の強調はウェイトと明度で行う。
2. テキスト色は `colorNeutralForeground1`（主）/ `2`（副）/ `3`（補足）の 3 段に限る。独自の灰色を作らない。
3. 面は `colorNeutralBackground1`–`3` の段で分け、区切りは「余白 → 背景段 → `colorNeutralStroke2` の 1px 線」の順に検討する。
   カードの中にカードを置かない。影（`shadow4` 等）は浮く面だけに付ける。
4. 角丸は `borderRadiusMedium`（コントロール）と `borderRadiusXLarge`（ダイアログ等の上位面）に限り、
   入れ子の内側は外側から余白分を引いた値にする。
5. 数値列は `font-variant-numeric: tabular-nums` で右揃え。HTTP メッセージ・コード・ハッシュは等幅
   （`fontFamilyMonospace`。Windows では Cascadia Mono / Consolas）。
6. hover・押下・選択・無効・フォーカスの見た目は Fluent コンポーネントの既定を使い、独自部品でも
   同じトークン（`colorNeutralBackground1Hover` / `Pressed` / `Selected` 等）で揃える。
7. 読込前後でレイアウトが動かないよう、Skeleton と固定寸法で場所を確保する。スピナーは約 1 秒経ってから表示する。
8. 新しい画面や大きな変更では、Light / Dark それぞれのスクリーンショットを Playwright で撮り、
   §7.2 の 10 要素と §7.4 のアンチパターンに照らしてセルフレビューし、指摘と直した内容をプルリクエストに書く。

### 8.4 コンポーネント対応表

| 用途 | WinUI 名 | Fluent UI React v9 |
|---|---|---|
| 左ナビ | NavigationView | `Nav`/`NavDrawer`（無い版では `TabList vertical`） |
| 上部タブ | TabView / Pivot | `TabList` |
| ページのコマンド | CommandBar | `Toolbar`（＋`Menu` でオーバーフロー） |
| 右クリック | MenuFlyout | `Menu`（`openOnContext`） |
| 確認・重大通知 | ContentDialog | `Dialog`（`modalType="alert"` は破壊的確認） |
| ページ内通知 | InfoBar | `MessageBar` |
| 補足ポップアップ | Flyout | `Popover` |
| 案内 | TeachingTip | `TeachingPopover`（版により preview） |
| 一時通知 | Toast | `Toast`/`Toaster`（OS 通知は Electron `Notification`） |
| 進捗 | ProgressBar / ProgressRing | `ProgressBar` / `Spinner` |
| 一覧・表 | ListView / DataGrid | `DataGrid`、`Table`（大量時は仮想化） |
| 分割ペイン | SplitView | CSS grid ＋ドラッグ可能な区切り（キーボードでも幅変更可能に） |
| パンくず | BreadcrumbBar | `Breadcrumb` |

コンポーネント名・安定度は Fluent UI の版で変わるため、実装時は固定した版の Storybook で確認する。

## 9. レビュー用チェックリスト

AI・人がプルリクエストで確認する項目。全項目「はい」で合格。

- [ ] 色・余白・フォント・角丸がトークン経由（直値なし）
- [ ] Light / Dark / 高コントラストで崩れず、全テキストが 4.5:1 以上
- [ ] キーボードだけで全操作が完了し、フォーカスが常に見え、Tab 順が視覚順
- [ ] アイコンのみのボタンにアクセシブル名とツールチップ
- [ ] 状態が色以外（アイコン・文言）でも分かる
- [ ] 読込中・空・打切り・失敗の 4 状態がある
- [ ] 破壊的・外部送信操作に確認（具体的動詞）または Undo、停止手段
- [ ] 主要アクションは 1 画面に 1 つ。肯定ボタンが左
- [ ] 文字列は資源化、ボタンは動詞、用語は用語集どおり
- [ ] 125% / 150% / 200% スケーリング、ウィンドウ半分幅（Snap）で崩れない
- [ ] 大量データは仮想化、詳細は遅延読込
- [ ] ウィンドウ状態・ペイン幅などが復元される
- [ ] `prefers-reduced-motion` でアニメーションが止まる
- [ ] 有彩色はアクセント 1 色＋意味色だけで、目を引く点は 1 画面に 1–2 か所
- [ ] 整列ライン・間隔・角丸・線幅・アイコンサイズが揃っている（ずれ・混在がない）
- [ ] 箱の中に箱がなく、区切りは余白・背景段を優先している
- [ ] 数値は等幅数字で右揃え、コード・HTTP は等幅書体
- [ ] 空状態・エラー・読込中も整った画面になっており、読込前後でレイアウトが跳ねない
- [ ] Light / Dark のスクリーンショットで §7.4 のアンチパターンがない

自動化できるもの: axe-core によるアクセシビリティ検査、Playwright によるキーボード操作テスト
（Tab 順・Esc で閉じる・フォーカス復帰）、テーマ別スクリーンショット比較、ESLint によるトークン外の色・px の検出。

## 10. ScopePilot2 への適用メモ

一般論を本プロジェクトへ当てる際の要点。正式な画面設計は [23](23-ui-and-migration.md) と
[詳細設計 02](../detailed-design/02-ui-information-architecture.md) が正本で、本章はそれらを補う。

- **2 モード = 段階的開示**。Simple は guided flow（§1 の段階的開示）、Advanced は同じコンポーネント・トークンで
  密度と編集範囲だけを増やす。モードで見た目の体系を変えない（P3）。
- **安全情報は常時表示の帯**。案件・scope・認可・実行状態（[23 §3](23-ui-and-migration.md)）は
  ページ上部の固定領域に置き、状態は色＋アイコン＋文言（§2.3）。警告は `MessageBar` で非ブロッキングに、
  送信前の最終確認だけを `Dialog` にする（§4.1。確認の乱発は確認疲れを招き安全性を下げる）。
- **送信は最も重い操作**として扱う: 主要アクション 1 つ、具体的動詞（「12 件の検査を送信」）、既定フォーカスはキャンセル、
  実行中は常に見える「停止」（§4.2、利用者の制御）。
- **通信履歴・所見は list/details**（§3.3）。一覧は仮想化（§8.1-11）、詳細は遅延読込、ペイン幅は記憶。
- **格好良さの方向性は「精密な計測器」**（§7）。ニュートラル基調にアクセント 1 色、重大度などの意味色は彩度を抑えて
  アイコン・文言と組で使う。HTTP・ハッシュ・数値は等幅で揃えて道具としての精度を見せる。セキュリティ製品に
  ありがちな「黒地にネオン色」「ハッカー風」の演出はしない（§7.3: 可読性・馴染み・信頼を損なうため）。
- **観測・エンジン判定・人の確認・文書の記載・AI の提案の区別**を、色だけでなくラベル・アイコンで一貫表示する（§2.3, P3）。
- **ナビは左**（最上位カテゴリが [23 §3](23-ui-and-migration.md) で 7 つ → §3.3 の 5–10 に該当）。設定は左ナビ下端。
- Burp 等の熟練者向けに、Repeater/通信履歴の操作へ慣習的ショートカット（§5）を割り当て、`Ctrl+Space` 等の独自割当は一覧化して設定で変更可能にする。

## 11. 出典

- Microsoft Learn — [Design Windows apps](https://learn.microsoft.com/windows/apps/design) / [Guidelines overview](https://learn.microsoft.com/windows/apps/design/guidelines-overview) / [Windows 11 design principles](https://learn.microsoft.com/windows/apps/design/signature-experiences/design-principles)
- Microsoft Learn — [Typography](https://learn.microsoft.com/windows/apps/design/signature-experiences/typography) / [Spacing](https://learn.microsoft.com/windows/apps/design/style/spacing) / [Content basics](https://learn.microsoft.com/windows/uwp/layout/content-basics)
- Microsoft Learn — [Mica material](https://learn.microsoft.com/windows/apps/design/style/mica) / [Screen sizes and breakpoints](https://learn.microsoft.com/windows/uwp/design/layout/screen-sizes-and-breakpoints-for-responsive-design)
- Microsoft Learn — [NavigationView](https://learn.microsoft.com/windows/apps/design/controls/navigationview) / [List/details](https://learn.microsoft.com/windows/apps/design/controls/list-details) / [Command bar](https://learn.microsoft.com/windows/apps/design/controls/command-bar)
- Microsoft Learn — [InfoBar](https://learn.microsoft.com/windows/apps/design/controls/infobar) / [Teaching tip](https://learn.microsoft.com/windows/apps/design/controls/dialogs-and-flyouts/teaching-tip) / [Progress controls](https://learn.microsoft.com/windows/apps/design/controls/progress-controls)
- Microsoft Learn — [Keyboard interactions](https://learn.microsoft.com/windows/apps/design/input/keyboard-interactions) / [Accessibility](https://learn.microsoft.com/windows/apps/accessibility) / [High contrast themes](https://learn.microsoft.com/windows/apps/design/accessibility/high-contrast-themes) / [Accessible text requirements](https://learn.microsoft.com/windows/apps/design/accessibility/accessible-text-requirements)
- Microsoft Learn — [Writing style](https://learn.microsoft.com/windows/apps/design/style/writing-style) / [Windows Admin Center UI text style guide](https://learn.microsoft.com/windows-server/manage/windows-admin-center/extend/guides/ui-text-style-guide)
- [Fluent 2 Design System](https://fluent2.microsoft.design/)（typography ほか）
- Electron — [Custom Title Bar](https://electronjs.org/docs/latest/tutorial/custom-title-bar)、`BrowserWindow` の `backgroundMaterial`（[feat: support Mica/Acrylic on Windows #38163](https://github.com/electron/electron/pull/38163)）
- Jakob Nielsen — 10 Usability Heuristics、Progressive Disclosure（nngroup.com）
- 美的品質 — [Laws of UX: Aesthetic-Usability Effect](https://lawsofux.com/aesthetic-usability-effect/)（Kurosu & Kashimura 1995、NN/g Kate Moran の記事を参照）/
  [Linear: How we redesigned the Linear UI](https://linear.app/now/how-we-redesigned-the-linear-ui)（ノイズ削減、LCH による面の段）/
  [Dark mode UI best practices](https://atmos.style/blog/dark-mode-ui-best-practices)・[12 Principles of Dark Mode Design](https://uxcel.com/blog/12-principles-of-dark-mode-design-627)（純黒回避、彩度低減、明度による elevation）/
  [Visual hierarchy](https://octet.design/visual-hierarchy)（サイズ・明度・整列・余白による階層）
