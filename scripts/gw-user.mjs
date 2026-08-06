#!/usr/bin/env node
// GraphWrangler のログインユーザー管理（packages/server/src/auth.ts と同じハッシュ形式）。
// サーバは users.json を毎リクエスト読み直すので、実行後の再起動は不要。
//
//   node scripts/gw-user.mjs <users.json> list
//   node scripts/gw-user.mjs <users.json> add <email> [password]   # password 省略で自動生成して表示
//   node scripts/gw-user.mjs <users.json> remove <email>
//   node scripts/gw-user.mjs <users.json> passwd <email> [password]
//   node scripts/gw-user.mjs <users.json> name <email> <表示名>     # 表示名の設定（UIでメールの代わりに出る）
//   node scripts/gw-user.mjs <users.json> admin <email> on|off      # 管理者（ユーザー管理UIが使える）
//   node scripts/gw-user.mjs <users.json> disable <email> on|off    # 無効化（ログイン拒否・履歴の帰属は保持）
//   node scripts/gw-user.mjs <users.json> discord <email> <ID|off>  # DiscordユーザーID（あなたの番のメンション通知用）
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const [file, cmd, email, passwordArg] = process.argv.slice(2);
if (!file || !cmd) {
  console.error(
    "usage: gw-user.mjs <users.json> list|add|remove|passwd|name|admin|disable|discord [email] [password|表示名|on|off|DiscordID]",
  );
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
    for (const u of data.users) {
      const flags = [u.admin ? "admin" : null, u.disabled ? "disabled" : null]
        .filter(Boolean)
        .join(",");
      console.log(
        `${u.email}\t${u.displayName ?? "(表示名なし)"}\t${flags || "-"}\t(created: ${u.created ?? "?"})`,
      );
    }
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
  case "name": {
    const u = data.users.find((x) => x.email === email);
    if (!u) throw new Error(`見つかりません: ${email}`);
    if (!passwordArg) throw new Error("表示名を指定してください");
    u.displayName = passwordArg;
    save(data);
    console.log(`表示名を設定しました: ${email} → ${passwordArg}`);
    break;
  }
  case "discord": {
    const u = data.users.find((x) => x.email === email);
    if (!u) throw new Error(`見つかりません: ${email}`);
    if (!passwordArg) throw new Error("Discord のユーザーID（数字）か off を指定してください");
    if (passwordArg === "off") {
      delete u.discordId;
      save(data);
      console.log(`Discord ID を解除しました: ${email}`);
      break;
    }
    if (!/^\d{5,25}$/.test(passwordArg)) {
      throw new Error("Discord ID は数字です（開発者モード→ユーザー右クリック→IDをコピー）");
    }
    u.discordId = passwordArg;
    save(data);
    console.log(`Discord ID を設定しました: ${email} → ${passwordArg}`);
    break;
  }
  case "admin":
  case "disable": {
    const u = data.users.find((x) => x.email === email);
    if (!u) throw new Error(`見つかりません: ${email}`);
    if (passwordArg !== "on" && passwordArg !== "off") throw new Error("on か off を指定してください");
    const key = cmd === "admin" ? "admin" : "disabled";
    if (passwordArg === "on") u[key] = true;
    else delete u[key];
    save(data);
    console.log(`${cmd} ${passwordArg}: ${email}`);
    break;
  }
  default:
    throw new Error(`不明なコマンド: ${cmd}`);
}
