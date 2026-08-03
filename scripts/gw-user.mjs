#!/usr/bin/env node
// GraphWrangler のログインユーザー管理（packages/server/src/auth.ts と同じハッシュ形式）。
// サーバは users.json を毎リクエスト読み直すので、実行後の再起動は不要。
//
//   node scripts/gw-user.mjs <users.json> list
//   node scripts/gw-user.mjs <users.json> add <email> [password]   # password 省略で自動生成して表示
//   node scripts/gw-user.mjs <users.json> remove <email>
//   node scripts/gw-user.mjs <users.json> passwd <email> [password]
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const [file, cmd, email, passwordArg] = process.argv.slice(2);
if (!file || !cmd) {
  console.error("usage: gw-user.mjs <users.json> list|add|remove|passwd [email] [password]");
  process.exit(1);
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { users: [] };
  }
}
function save(data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
}
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return { hash: crypto.scryptSync(password, salt, 32).toString("hex"), salt };
}
// 紛らわしい文字（0O1lI）を除いた自動生成パスワード
function generatePassword() {
  const chars = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(crypto.randomBytes(16), (b) => chars[b % chars.length]).join("");
}

const data = load();
data.users ??= [];

switch (cmd) {
  case "list": {
    for (const u of data.users) console.log(`${u.email}\t(created: ${u.created ?? "?"})`);
    if (data.users.length === 0) console.log("(ユーザーなし=ログイン不要モード)");
    break;
  }
  case "add": {
    if (!email) throw new Error("email を指定してください");
    if (data.users.some((u) => u.email === email)) throw new Error(`既に存在します: ${email}`);
    const password = passwordArg ?? generatePassword();
    data.users.push({ email, ...hashPassword(password), created: new Date().toISOString() });
    save(data);
    console.log(`追加しました: ${email}`);
    if (!passwordArg) console.log(`初期パスワード: ${password}`);
    break;
  }
  case "remove": {
    const before = data.users.length;
    data.users = data.users.filter((u) => u.email !== email);
    if (data.users.length === before) throw new Error(`見つかりません: ${email}`);
    save(data);
    console.log(`削除しました: ${email}`);
    break;
  }
  case "passwd": {
    const u = data.users.find((x) => x.email === email);
    if (!u) throw new Error(`見つかりません: ${email}`);
    const password = passwordArg ?? generatePassword();
    Object.assign(u, hashPassword(password));
    save(data);
    console.log(`更新しました: ${email}`);
    if (!passwordArg) console.log(`新パスワード: ${password}`);
    break;
  }
  default:
    throw new Error(`不明なコマンド: ${cmd}`);
}
