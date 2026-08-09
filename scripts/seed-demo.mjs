// デモデータ投入スクリプト。空のデータディレクトリに対して実行する。
// README のスクリーンショットはこのデータで撮っている。
// 題材は「AIに任せる部分・人間が判断する部分・スクリプトに固める部分」が
// 自然に混ざる実務ワークフロー（LP公開プロジェクト + 週次の競合ウォッチ）。
// 注意: GraphWrangler 自身の開発タスクをデモに使わない（再帰的で頭がバグる）。
// 使い方: node scripts/seed-demo.mjs [baseUrl]
const BASE = process.argv[2] ?? "http://localhost:8770";

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

// ---- プロジェクト1: 新サービスのLPを公開する ----
// AIが調査・起草を進め、人間は訴求軸の決定とレビューだけを返す構図。

const lp = await post("/api/nodes", {
  title: "新サービスのLPを公開する",
  kind: "goal",
  detail: "リリースに合わせてランディングページを作って公開する。",
  lifecycle: "committed",
});

// ゴールは「先頭ノード」ではなく「ノード群のフォルダ」。メンバーは group で所属し、
// 依存(parents)はメンバー同士の順序だけを表す。
const research = await post("/api/nodes", {
  title: "競合のLPを10本調査する",
  group: lp.id,
  executor: "ai",
  status: "done",
  lifecycle: "committed",
  actor: { kind: "agent", name: "planner" },
  via: "engine",
});

// status は指定しない（後で開く判断リクエストが waiting にする）
const axis = await post("/api/nodes", {
  title: "訴求軸を決める",
  group: lp.id,
  parents: [research.id],
  executor: "ai",
  lifecycle: "committed",
});

const draft = await post("/api/nodes", {
  title: "構成案とコピーを起草する",
  group: lp.id,
  parents: [axis.id],
  executor: "ai",
  detail: "決まった訴求軸でファーストビュー〜CTAまでの構成とコピーを書く",
  lifecycle: "committed",
});

// 未計画（やり方未定）の例
const assets = await post("/api/nodes", {
  title: "画像素材を用意する",
  group: lp.id,
  parents: [axis.id],
  executor: "human",
  status: "unplanned",
  detail: "製品スクショと利用シーン写真。誰が撮るかまだ決めていない",
  lifecycle: "draft",
});

// Fix（ロック）済み + impl=script の例: やり方が確定していて中身も決定的
const build = await post("/api/nodes", {
  title: "LPをビルドして検品する",
  group: lp.id,
  parents: [draft.id, assets.id],
  executor: "script",
  detail: "静的ビルド + リンク切れ・画像欠けの機械チェック",
  impl: { type: "script", command: "echo ビルド完了: リンク切れ0 画像欠け0" },
  fixed: true,
  lifecycle: "committed",
});

// 分岐ノード（kind=decision）: 公開前レビュー。OKなら公開、ダメなら構成へ差し戻し
const review = await post("/api/nodes", {
  title: "公開前レビュー",
  group: lp.id,
  parents: [build.id],
  kind: "decision",
  executor: "human",
  detail: "ビルド結果を見て、公開するか構成へ差し戻すかを決める",
  branches: [
    { id: "ship", label: "公開OK", then: "本番へ公開する" },
    { id: "back", label: "差し戻し", then: "構成案からやり直す" },
  ],
  lifecycle: "committed",
});

await post("/api/nodes", {
  title: "本番へ公開する",
  group: lp.id,
  parents: [review.id],
  parentOptions: { [review.id]: "ship" },
  executor: "script",
  approval: true, // 公開は取り消しても「見られた」事実は戻らない → 実行前承認
  detail: "デプロイスクリプトで公開。実行前に必ず人間の承認を挟む",
  impl: { type: "script", command: "echo デプロイ完了: https://example.com/lp" },
  lifecycle: "draft",
});

await post("/api/nodes", {
  title: "構成案を修正する",
  group: lp.id,
  parents: [review.id],
  parentOptions: { [review.id]: "back" },
  executor: "ai",
  detail: "レビューの指摘を反映して構成とコピーを直す",
  lifecycle: "draft",
});

// 調査ノードのスレッド（完了済みAIの仕事の跡）
await post(`/api/nodes/${research.id}/messages`, {
  kind: "status",
  body: "調査開始: 同価格帯のSaaS 10社のLPを構成・訴求・CTAの3点で比較",
  actor: { kind: "agent", name: "executor:claude" },
  via: "engine",
});
await post(`/api/nodes/${research.id}/messages`, {
  kind: "say",
  body: "調査完了。10本中7本が機能列挙型で、導入後の変化を見せているのは2本だけでした。「導入した後の1日」を見せる構成は差別化になります。",
  actor: { kind: "agent", name: "executor:claude" },
  via: "engine",
});

// 訴求軸ノードに判断リクエスト（open のまま = あなたの番）
const req = await post(`/api/nodes/${axis.id}/request`, {
  via: "engine",
  actor: { kind: "agent", name: "executor:claude" },
  request: {
    context:
      "競合調査の結果、刺さりそうな訴求軸は3つに絞れた。どれを主軸にするかで構成もコピーも根本から変わるので、先に決めてほしい。",
    question: "LPの主軸はどの訴求で行く？",
    options: [
      {
        id: "time",
        label: "時短",
        then: "「導入した後の1日」を見せる構成に。競合7割の機能列挙型と差別化できる",
        recommended: true,
      },
      { id: "trust", label: "安心", then: "導入実績とサポート体制を前面に。堅い業界に刺さる" },
      { id: "price", label: "価格", then: "最安級を打ち出す。比較サイト経由の流入には強い" },
    ],
    approval: false,
    undo: "構成案の段階なら差し替えは1日で済む",
  },
});

// ラリー（聞き返し）を1往復入れておく
await post(`/api/nodes/${axis.id}/answer`, {
  requestId: req.id,
  option: null,
  note: "時短と安心って両方は無理なの？",
});
await post(`/api/nodes/${axis.id}/messages`, {
  kind: "say",
  body: "主軸は1つに絞るのが定石ですが、両立はできます。主軸=時短で構成を作り、安心は導入実績バッジとサポートの一行で「補強」に回す案を推します。",
  actor: { kind: "agent", name: "executor:claude" },
  via: "engine",
});

// ---- プロジェクト2: ヘルプセンターを立ち上げる ----

const help = await post("/api/nodes", {
  title: "ヘルプセンターを立ち上げる",
  kind: "goal",
  lifecycle: "committed",
});

const faq = await post("/api/nodes", {
  title: "問い合わせ履歴からFAQを洗い出す",
  group: help.id,
  executor: "ai",
  status: "done",
  lifecycle: "committed",
});

const articles = await post("/api/nodes", {
  title: "FAQ記事の下書きを書く",
  group: help.id,
  parents: [faq.id],
  executor: "ai",
  detail: "洗い出した上位20問ぶん。トーンは既存ドキュメントに合わせる",
  lifecycle: "committed",
});

await post("/api/nodes", {
  title: "記事をレビューして公開する",
  group: help.id,
  parents: [articles.id],
  executor: "human",
  lifecycle: "draft",
});

// ---- 完了済みプロジェクト（左レールのアーカイブ節に入る例） ----

const logo = await post("/api/nodes", {
  title: "社名ロゴを刷新する",
  kind: "goal",
  status: "done",
  lifecycle: "committed",
});
await post("/api/nodes", {
  title: "デザイン案を選んで入稿する",
  group: logo.id,
  executor: "human",
  status: "done",
  lifecycle: "committed",
});

// ---- ルーティーン1: 週次の競合ウォッチ（トリガー起点。ランが流れる） ----
// 収集=スクリプト、要約と影響度判定=AI、共有の判断=人間、という分担の定番形。

const watch = await post("/api/nodes", {
  title: "週次の競合ウォッチ",
  kind: "goal",
  detail: "競合の動きを毎週まとめて、重要なものだけチームに共有する。",
  lifecycle: "committed",
});

const watchTrigger = await post("/api/nodes", {
  title: "毎週月曜9時",
  group: watch.id,
  kind: "trigger",
  executor: "script",
  schedule: "weekly mon 09:00",
  fixed: true,
  lifecycle: "committed",
});

const collect = await post("/api/nodes", {
  title: "競合サイトの更新を収集する",
  group: watch.id,
  parents: [watchTrigger.id],
  executor: "script",
  impl: { type: "script", command: "echo 新着3件: 競合Aが料金改定、競合Bが新機能、競合Cが採用強化" },
  fixed: true,
  lifecycle: "committed",
});

const summarize = await post("/api/nodes", {
  title: "要約して影響度を判定する",
  group: watch.id,
  parents: [collect.id],
  executor: "ai",
  impl: {
    type: "doc",
    text: "収集された更新を各3行で要約し、自社への影響を高/中/低で判定する。「高」があればチーム共有を提案する。",
  },
  lifecycle: "committed",
});

const share = await post("/api/nodes", {
  title: "チームに共有する",
  group: watch.id,
  parents: [summarize.id],
  executor: "human",
  detail: "影響「高」のときだけ。共有文はAIの要約をそのまま使ってよい",
  lifecycle: "committed",
});

// ランを3本流しておく（台帳のデモ用）: 過去2本は完走、最新はAIが人間の番まで進めた状態
for (let i = 0; i < 2; i++) {
  const run = await post(`/api/nodes/${watchTrigger.id}/run`, { via: "manual" });
  for (const n of [collect, summarize]) {
    await post(`/api/runs/${run.id}/items/${n.id}`, {
      status: "done",
      actor: { kind: "agent", name: "engine" },
      via: "engine",
    });
  }
  await post(`/api/runs/${run.id}/items/${share.id}`, {
    status: "done",
    actor: { kind: "human" },
    via: "ui",
  });
}

const runNow = await post(`/api/nodes/${watchTrigger.id}/run`, { via: "manual" });
await post(`/api/runs/${runNow.id}/items/${collect.id}`, {
  status: "done",
  note: "新着3件",
  actor: { kind: "agent", name: "executor:script" },
  via: "engine",
});
await post(`/api/runs/${runNow.id}/items/${summarize.id}`, {
  status: "waiting",
  note: "競合Aの料金改定は影響「高」。共有文を作ったので確認してほしい",
  actor: { kind: "agent", name: "executor:claude" },
  via: "engine",
});

// ---- ルーティーン2: 問い合わせの一次対応（AIトリガーの例。ランを作るかの判断自体をAIがする） ----

const inbox = await post("/api/nodes", {
  title: "問い合わせの一次対応",
  kind: "goal",
  lifecycle: "committed",
});
const inboxTrigger = await post("/api/nodes", {
  title: "未対応が溜まったら",
  group: inbox.id,
  kind: "trigger",
  executor: "ai",
  schedule: "every 1h",
  detail: "サポート宛の未対応メールが3件以上溜まっていたらランを作る",
  lifecycle: "committed",
});
const reply = await post("/api/nodes", {
  title: "返信の下書きを作る",
  group: inbox.id,
  parents: [inboxTrigger.id],
  executor: "ai",
  impl: {
    type: "doc",
    text: "過去の回答例とヘルプ記事を根拠に、各問い合わせへの返信下書きを作る。判断がつかないものは人間へ回す。",
  },
  lifecycle: "committed",
});
await post("/api/nodes", {
  title: "確認して送信する",
  group: inbox.id,
  parents: [reply.id],
  executor: "human",
  approval: true, // 送ったメールは取り消せない → 実行前承認
  lifecycle: "committed",
});

console.log("demo seeded:", BASE);
