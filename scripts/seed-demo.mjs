// デモデータ投入スクリプト。空のデータディレクトリに対して実行する。
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

// ---- ゴール1: 伝説のカレーを作る ----

const curry = await post("/api/nodes", {
  title: "伝説のカレーを作る",
  kind: "goal",
  detail: "近所で語り草になるレベルのカレー。妥協しない。",
  lifecycle: "committed",
});

// ゴールは「先頭ノード」ではなく「ノード群のフォルダ」。メンバーは group で所属し、
// 依存(parents)はメンバー同士の順序だけを表す。
const research = await post("/api/nodes", {
  title: "世界のカレーレシピを調査する",
  group: curry.id,
  executor: "ai",
  status: "done",
  lifecycle: "committed",
  actor: { kind: "agent", name: "planner" },
  via: "engine",
});

const blend = await post("/api/nodes", {
  title: "スパイス配合を決める",
  group: curry.id,
  parents: [research.id],
  executor: "ai",
  status: "running",
  lifecycle: "committed",
});

const shopping = await post("/api/nodes", {
  title: "スパイスを買い出しに行く",
  group: curry.id,
  parents: [blend.id],
  executor: "human",
  detail: "大津屋かカルダモンの量り売りがある店。ガラムマサラは自作するので単品で。",
  lifecycle: "committed",
});

const scorer = await post("/api/nodes", {
  title: "味見スコアを記録するスクリプト",
  group: curry.id,
  parents: [research.id],
  executor: "script",
  detail: "試作ごとに辛さ・コク・香りを5段階で記録して回帰を検出する",
  lifecycle: "committed",
});

const cook = await post("/api/nodes", {
  title: "試作1号を仕込む",
  group: curry.id,
  parents: [shopping.id, scorer.id],
  executor: "human",
  status: "unplanned", // やり方未定（「ここだけまだ考えてない」）の例
  detail: "圧力鍋か土鍋か、仕込み方をまだ決めていない",
  lifecycle: "draft",
});

const serve = await post("/api/nodes", {
  title: "近所に振る舞う",
  group: curry.id,
  parents: [cook.id],
  executor: "human",
  impact: "irreversible",
  detail: "一度振る舞ったら評判は取り消せない",
  lifecycle: "draft",
});

// 分岐ノード（kind=decision。docs/design.md 3.9）の実例: 試食の評価。
// 「試作1号を仕込む」の後続として置き、合格なら既存の「近所に振る舞う」へ、
// 再調整なら新設の「配合を見直す」へ進む。
const tasteCheck = await post("/api/nodes", {
  title: "試食の評価",
  group: curry.id,
  parents: [cook.id],
  kind: "decision",
  executor: "human",
  detail: "味見して、このまま振る舞うか配合をやり直すかを決める",
  branches: [
    { id: "pass", label: "合格", then: "このまま近所に振る舞う" },
    { id: "retry", label: "再調整", then: "配合を見直してもう一度仕込む" },
  ],
  lifecycle: "draft",
});

// 既存の「近所に振る舞う」を、cook の直接の後続から「試食の評価」の合格枝の後続へ付け替える
await post(`/api/nodes/${serve.id}`, {
  parents: [tasteCheck.id],
  parentOptions: { [tasteCheck.id]: "pass" },
});

await post("/api/nodes", {
  title: "配合を見直す",
  group: curry.id,
  parents: [tasteCheck.id],
  parentOptions: { [tasteCheck.id]: "retry" },
  executor: "ai",
  detail: "試食のフィードバックを踏まえてスパイス配合をやり直す",
  lifecycle: "draft",
});

// 調査ノードのスレッド（完了済みAIの仕事の跡）
await post(`/api/nodes/${research.id}/messages`, {
  kind: "status",
  body: "調査開始: 北インド/南インド/欧風/スリランカの4系統で情報収集",
  actor: { kind: "agent", name: "executor:claude" },
  via: "engine",
});
await post(`/api/nodes/${research.id}/messages`, {
  kind: "say",
  body: "調査完了。スリランカ系のロースト深煎りが「伝説」方向に一番伸びしろがあります。モルディブフィッシュの代わりに鰹節が使える点も日本の台所と相性good。",
  actor: { kind: "agent", name: "executor:claude" },
  via: "engine",
});

// 配合ノードに判断リクエスト（open のまま = 受信箱に載る）
const req = await post(`/api/nodes/${blend.id}/request`, {
  via: "engine",
  actor: { kind: "agent", name: "executor:claude" },
  request: {
    context:
      "カレーの配合を詰めている。辛さの方針で唐辛子の種類と量が根本から変わるので、先に決めてほしい。",
    question: "辛さはどのレベルにする？",
    options: [
      { id: "mild", label: "甘口", then: "家族全員が食べられる。伝説性は香りで稼ぐ" },
      {
        id: "medium",
        label: "中辛",
        then: "辛さと香りのバランス型。万人向けの伝説",
        recommended: true,
      },
      { id: "hot", label: "激辛", then: "明日を捨てる覚悟の配合になる。振る舞う相手を選ぶ" },
    ],
    impact: "safe",
    undo: "次の試作から変えられる",
    expires: null,
    on_expire: null,
  },
});

// ラリー（聞き返し）を1往復入れておく
await post(`/api/nodes/${blend.id}/answer`, {
  requestId: req.id,
  option: null,
  note: "子どもも食べる可能性ある？",
});
await post(`/api/nodes/${blend.id}/messages`, {
  kind: "say",
  body: "振る舞い先リストに小学生が2人います。甘口ベース+後がけ辛味オイルの二段構えも設計できます。",
  actor: { kind: "agent", name: "executor:claude" },
  via: "engine",
});

// ---- ゴール2: ベランダ菜園を軌道に乗せる ----

const garden = await post("/api/nodes", {
  title: "ベランダ菜園を軌道に乗せる",
  kind: "goal",
  lifecycle: "committed",
});

const watering = await post("/api/nodes", {
  title: "水やりリマインダーを自動化する",
  group: garden.id,
  executor: "script",
  status: "done",
  lifecycle: "committed",
});

await post("/api/nodes", {
  title: "バジルの徒長を診断してもらう",
  group: garden.id,
  parents: [watering.id],
  executor: "ai",
  detail: "写真を撮って原因(日照不足?水のやりすぎ?)を切り分ける",
  lifecycle: "draft",
});

// ---- 手順ページ: 毎朝のベランダ見回り（繰り返し、ランが流れる） ----

const patrol = await post("/api/nodes", {
  title: "毎朝のベランダ見回り",
  kind: "procedure",
  detail: "起きたらベランダの状態を確認して記録する定例。",
  lifecycle: "committed",
});

const sensor = await post("/api/nodes", {
  title: "土の乾き具合を記録する",
  group: patrol.id,
  executor: "script",
  impl: { type: "script", command: "echo 土壌湿度: 34%（センサー読み取りのダミー）" },
  lifecycle: "committed",
});

const diagnose = await post("/api/nodes", {
  title: "様子から今日の世話を判断する",
  group: patrol.id,
  parents: [sensor.id],
  executor: "ai",
  impl: {
    type: "doc",
    text: "記録された土壌湿度と季節から、今日の水やり・肥料の要否を1〜2行で判断する。40%未満なら水やりを推奨。",
  },
  lifecycle: "committed",
});

await post("/api/nodes", {
  title: "水やりする",
  group: patrol.id,
  parents: [diagnose.id],
  executor: "human",
  lifecycle: "committed",
});

// ラン1本を開始して、最初のワークアイテムだけ完了済みにしておく（台帳のデモ用）
const run = await post(`/api/procedures/${patrol.id}/runs`, { trigger: "manual" });
await post(`/api/runs/${run.id}/items/${sensor.id}`, {
  status: "done",
  note: "土壌湿度: 34%",
  actor: { kind: "agent", name: "executor:script" },
  via: "engine",
});

console.log("demo seeded:", BASE);
