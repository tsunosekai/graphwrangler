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

// status は指定しない（後で開く判断リクエストが waiting にする。以前ここで "running" を
// 作為していたが、status と pendingRequest の食い違いの種になるのでやめた。2026-07-31）
const blend = await post("/api/nodes", {
  title: "スパイス配合を決める",
  group: curry.id,
  parents: [research.id],
  executor: "ai",
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

// Fix（ロック）済み + impl=script の例: やり方が確定していて中身も決定的
const scorer = await post("/api/nodes", {
  title: "味見スコアを記録するスクリプト",
  group: curry.id,
  parents: [research.id],
  executor: "script",
  detail: "試作ごとに辛さ・コク・香りを5段階で記録して回帰を検出する",
  impl: { type: "script", command: "echo 記録完了: 辛さ3 コク4 香り5" },
  fixed: true,
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
// lifecycle は committed にする（親の「試作1号を仕込む」が unplanned=未完のままなので、
// 実行フェーズゲート（docs/design.md 3.9）が「前のノードが終わっていない」で分岐を選ばせない
// デモになる）
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
  lifecycle: "committed",
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

// 中止(dropped)の例
await post("/api/nodes", {
  title: "LED育成ライトを導入する",
  group: garden.id,
  executor: "human",
  status: "dropped",
  detail: "ベランダの日照で十分と判明したのでやめた",
  lifecycle: "committed",
});

// ---- 完了済みゴール（左レールのアーカイブ節に入る例） ----

const syrup = await post("/api/nodes", {
  title: "梅シロップを仕込む",
  kind: "goal",
  status: "done",
  lifecycle: "committed",
});
await post("/api/nodes", {
  title: "青梅1kgを氷砂糖と漬ける",
  group: syrup.id,
  executor: "human",
  status: "done",
  lifecycle: "committed",
});

// ---- ルーティーンページ: 毎朝のベランダ見回り（繰り返し、ランが流れる）。
// docs/design.md 3.8 新モデル: 「ルーティーンであること」はページ種別(procedure)でなく、
// 先頭に置く trigger ノードから導出される。ページ自体は goal のまま ----

const patrol = await post("/api/nodes", {
  title: "毎朝のベランダ見回り",
  kind: "goal",
  detail: "起きたらベランダの状態を確認して記録する定例。",
  lifecycle: "committed",
});

// トリガー（kind=trigger）: フロー先頭に置く起点ノード。parents は持てない。
// executor=script + schedule="daily 07:30" = 毎朝7:30に発火するcron的な定期実行
const patrolTrigger = await post("/api/nodes", {
  title: "毎朝の起動",
  group: patrol.id,
  kind: "trigger",
  executor: "script",
  schedule: "daily 07:30",
  fixed: true,
  lifecycle: "committed",
});

const sensor = await post("/api/nodes", {
  title: "土の乾き具合を記録する",
  group: patrol.id,
  parents: [patrolTrigger.id],
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

// ラン1本を開始して、最初のワークアイテムだけ完了済みにしておく（台帳のデモ用）。
// 発火はトリガーノードの /fire で行う（旧ラン作成APIは使わない。docs/design.md 3.8 新モデル）
const run = await post(`/api/nodes/${patrolTrigger.id}/fire`, { via: "manual" });
await post(`/api/runs/${run.id}/items/${sensor.id}`, {
  status: "done",
  note: "土壌湿度: 34%",
  actor: { kind: "agent", name: "executor:script" },
  via: "engine",
});

// ---- ルーティーンページ2: AIトリガーの例（executor=ai + チェック間隔。
// 発火するかどうか自体をAIが判断する。docs/design.md 3.8） ----

const laundry = await post("/api/nodes", {
  title: "洗濯物を雨から守る",
  kind: "goal",
  lifecycle: "committed",
});
const rainCheck = await post("/api/nodes", {
  title: "雨雲チェック",
  group: laundry.id,
  kind: "trigger",
  executor: "ai",
  schedule: "every 3h",
  detail: "予報と空模様から「そろそろ降る」と判断したら発火する",
  lifecycle: "committed",
});
await post("/api/nodes", {
  title: "ベランダの洗濯物を取り込む",
  group: laundry.id,
  parents: [rainCheck.id],
  executor: "human",
  lifecycle: "committed",
});

// ---- ルーティーンページ3: 人間トリガーの例（executor=human = ▶手動発火が唯一の起動経路） ----

const guests = await post("/api/nodes", {
  title: "来客前の家リセット",
  kind: "goal",
  lifecycle: "committed",
});
const guestTrigger = await post("/api/nodes", {
  title: "来客が決まったら",
  group: guests.id,
  kind: "trigger",
  executor: "human",
  lifecycle: "committed",
});
const tidy = await post("/api/nodes", {
  title: "リビングを片付ける",
  group: guests.id,
  parents: [guestTrigger.id],
  executor: "human",
  lifecycle: "committed",
});
await post("/api/nodes", {
  title: "トイレと洗面台を磨く",
  group: guests.id,
  parents: [tidy.id],
  executor: "human",
  lifecycle: "committed",
});

console.log("demo seeded:", BASE);
