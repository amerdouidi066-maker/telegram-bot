"use strict";

const TelegramBot    = require("node-telegram-bot-api");
const mongoose       = require("mongoose");
const http           = require("http");
const crypto         = require("crypto");
const { authenticator } = require("otplib");

// ═══════════════════════════════════════════════
// ⚙️  إعدادات متغيرات البيئة
// ═══════════════════════════════════════════════
const BOT_TOKEN      = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
const MONGODB_URI    = process.env.MONGODB_URI;
const ADMIN_ID       = parseInt(process.env.ADMIN_ID, 10);
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
const CHANNEL_ID     = process.env.CHANNEL_ID || null;

if (!BOT_TOKEN)      throw new Error("BOT_TOKEN مطلوب في متغيرات البيئة");
if (!MONGODB_URI)    throw new Error("MONGODB_URI مطلوب في متغيرات البيئة");
if (!ADMIN_ID || isNaN(ADMIN_ID)) throw new Error("ADMIN_ID مطلوب في متغيرات البيئة");
if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length !== 64) {
  throw new Error("ENCRYPTION_KEY يجب أن يكون 64 حرفاً Hex في متغيرات البيئة");
}

// ═══════════════════════════════════════════════
// 📐 ثوابت النظام
// ═══════════════════════════════════════════════
const IV_LENGTH              = 16;
const DEFAULT_PRICE          = 0.17;
let   currentPrice           = DEFAULT_PRICE;
let   maintenanceMode        = false;
const MIN_WITHDRAW           = 0.20;
const WITHDRAW_FEE           = 0.03;
const MAX_PENDING_TASKS      = 2;
const PROCESSING_TIMEOUT_MS  = 15_000;
const CLEANUP_INTERVAL_MS    = 30 * 60 * 1000;
const SESSION_TIMEOUT_MS     = 2  * 60 * 60 * 1000;
const LEADERBOARD_SIZE       = 10;
const BEP20_REGEX            = /^0x[a-fA-F0-9]{40}$/;

/** أسماء الأزرار */
const B = {
  // ─── المستخدم ───
  CREATE_GMAIL:          "➕ أنشئ حساب Gmail جديد",
  MY_ACCOUNTS:           "📋 حساباتي",
  BALANCE:               "💰 الرصيد",
  REFERRALS:             "👥 الإحالات الخاصة بي",
  LEADERBOARD:           "🏆 المتصدرون",
  SETTINGS:              "⚙️ الإعدادات",
  HELP:                  "💬 مساعدة",
  BACK:                  "🔙 رجوع",
  CANCEL:                "❌ إلغاء العملية",
  CONFIRMED_CREATE:      "✅ تم التفعيل والإنشاء",
  CANCEL_CREATE:         "❌ إلغاء إنشاء الحساب",
  BALANCE_LOG:           "📝 سجل الرصيد",
  WITHDRAW:              "💳 سحب",
  TWO_FA_SETTINGS:       "🔐 إعدادات التحقق بخطوتين للبوت",
  HOW_TO_ACTIVATE:       "❓ كيفية التفعيل",
  NETWORK_USDT:          "💎 Tether (USDT-BEP-20) | 0% +0.03$ | min: 0.20$",
  // ─── الأدمن ───
  ADMIN_STATS:           "📊 الإحصائيات العامة",
  ADMIN_PENDING:         "📬 مراجعة الحسابات المعلقة",
  ADMIN_WITHDRAWS:       "💸 طلبات السحب المنتظرة",
  ADMIN_GENERATE:        "➕ توليد حسابات للمستودع",
  ADMIN_BAN:             "🚫 حظر / إلغاء حظر مستخدم",
  ADMIN_CHARGE:          "💰 شحن رصيد مستخدم يدوياً",
  ADMIN_CLEAR_STOCK:     "🗑️ تفريغ المستودع بالكامل",
  ADMIN_BOUGHT_ACCOUNTS: "📦 قائمة الحسابات المشتراة",
  ADMIN_USER_BALANCES:   "👛 رصيد المستخدمين",
  ADMIN_CHANGE_PRICE:    "💲 تغيير سعر الإنشاء",
  ADMIN_MAINTENANCE_ON:  "🔴 تفعيل وضع الصيانة",
  ADMIN_MAINTENANCE_OFF: "🟢 إيقاف وضع الصيانة",
  ADMIN_EXIT:            "🔙 خروج من الإدارة",
};

// ═══════════════════════════════════════════════
// 🗄️  مخططات قاعدة البيانات
// ═══════════════════════════════════════════════
const userSchema = new mongoose.Schema({
  telegramId:    { type: Number, required: true, unique: true },
  username:      { type: String, default: null },
  firstName:     { type: String, default: "مستخدم" },
  balance:       { type: Number, default: 0, min: 0 },
  referralCode:  { type: String, unique: true },
  referredBy:    { type: Number, default: null },
  referralCount: { type: Number, default: 0 },
  totalEarned:   { type: Number, default: 0 },
  state:         { type: String, default: null },
  stateMeta:     { type: mongoose.Schema.Types.Mixed, default: null },
  banned:        { type: Boolean, default: false },
  twoFASecret:   { type: String, default: null },
  twoFAEnabled:  { type: Boolean, default: false },
}, { timestamps: true });

const accountSchema = new mongoose.Schema({
  firstName:  { type: String, required: true },
  lastName:   { type: String, required: true },
  email:      { type: String, required: true, unique: true },
  password:   { type: String, required: true },
  birthDate:  { type: String, required: true },
  assigned:   { type: Boolean, default: false },
  assignedTo: { type: Number, default: null },
  assignedAt: { type: Date,   default: null },
  isWasted:   { type: Boolean, default: false },
}, { timestamps: true });

const taskSchema = new mongoose.Schema({
  userId:           { type: Number, required: true, index: true },
  amount:           { type: Number, required: true },
  accountEmail:     { type: String, required: true },
  accountId:        { type: mongoose.Schema.Types.ObjectId, ref: "Account" },
  google2FASecret:  { type: String, default: "" },
  status:           { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },
  submittedAt:      { type: Date, default: Date.now },
}, { timestamps: true });

const withdrawSchema = new mongoose.Schema({
  userId:         { type: Number, required: true, index: true },
  amount:         { type: Number, required: true },
  fee:            { type: Number, default: 0 },
  totalDeduction: { type: Number, required: true },
  address:        { type: String, required: true },
  network:        { type: String, default: "USDT-BEP20" },
  status:         { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },
}, { timestamps: true });

const configSchema = new mongoose.Schema({
  key:   { type: String, required: true, unique: true },
  value: { type: mongoose.Schema.Types.Mixed, required: true },
}, { timestamps: true });

const User       = mongoose.model("User", userSchema);
const Account    = mongoose.model("Account", accountSchema);
const Task       = mongoose.model("Task", taskSchema);
const Withdrawal = mongoose.model("Withdrawal", withdrawSchema);
const Config     = mongoose.model("Config", configSchema);

// ═══════════════════════════════════════════════
// ⌨️  القوائم والأزرار
// ═══════════════════════════════════════════════
const MAIN_MENU = {
  reply_markup: {
    keyboard: [
      [B.CREATE_GMAIL,  B.MY_ACCOUNTS],
      [B.BALANCE,       B.REFERRALS],
      [B.LEADERBOARD,   B.SETTINGS],
      [B.HELP],
    ],
    resize_keyboard: true,
  },
};

const CONFIRM_MENU = {
  reply_markup: {
    keyboard: [
      [B.CONFIRMED_CREATE],
      [B.CANCEL_CREATE, B.BACK],
    ],
    resize_keyboard: true,
  },
};

const CANCEL_MENU = {
  reply_markup: { keyboard: [[B.CANCEL]], resize_keyboard: true },
};

const BALANCE_MENU = {
  reply_markup: {
    keyboard: [[B.BALANCE_LOG, B.WITHDRAW], [B.BACK]],
    resize_keyboard: true,
  },
};

const SETTINGS_MENU = {
  reply_markup: {
    keyboard: [[B.TWO_FA_SETTINGS], [B.BACK]],
    resize_keyboard: true,
  },
};

const NETWORK_MENU = {
  reply_markup: {
    keyboard: [[B.NETWORK_USDT], [B.BACK]],
    resize_keyboard: true,
  },
};

function buildAdminMenu() {
  return {
    reply_markup: {
      keyboard: [
        [B.ADMIN_STATS,           B.ADMIN_PENDING],
        [B.ADMIN_WITHDRAWS,       B.ADMIN_GENERATE],
        [B.ADMIN_BAN,             B.ADMIN_CHARGE],
        [B.ADMIN_BOUGHT_ACCOUNTS, B.ADMIN_USER_BALANCES],
        [B.ADMIN_CHANGE_PRICE,    B.ADMIN_CLEAR_STOCK],
        [maintenanceMode ? B.ADMIN_MAINTENANCE_OFF : B.ADMIN_MAINTENANCE_ON],
        [B.ADMIN_EXIT],
      ],
      resize_keyboard: true,
    },
  };
}

const ADMIN_MENU = buildAdminMenu();

const CANCEL_ROW        = { reply_markup: { keyboard: [[B.CANCEL]], resize_keyboard: true } };
const BACK_ROW          = { reply_markup: { keyboard: [[B.BACK]],   resize_keyboard: true } };
const TWO_FA_GMAIL_MENU = {
  reply_markup: {
    keyboard: [[B.HOW_TO_ACTIVATE], [B.BACK, B.CANCEL_CREATE]],
    resize_keyboard: true,
  },
};

// ═══════════════════════════════════════════════
// 🔐 وظائف التشفير
// ═══════════════════════════════════════════════
function encrypt(text) {
  if (!text) return "";
  const iv        = crypto.randomBytes(IV_LENGTH);
  const cipher    = crypto.createCipheriv("aes-256-cbc", Buffer.from(ENCRYPTION_KEY, "hex"), iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return iv.toString("hex") + ":" + encrypted.toString("hex");
}

function decrypt(text) {
  if (!text) return "";
  try {
    const [ivHex, ...rest] = text.split(":");
    const iv            = Buffer.from(ivHex, "hex");
    const encryptedText = Buffer.from(rest.join(":"), "hex");
    const decipher      = crypto.createDecipheriv("aes-256-cbc", Buffer.from(ENCRYPTION_KEY, "hex"), iv);
    return Buffer.concat([decipher.update(encryptedText), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}

// ═══════════════════════════════════════════════
// 🛠️  وظائف مساعدة
// ═══════════════════════════════════════════════
const FIRST_NAMES = ["Oliver","Jack","Harry","Jacob","Charley","Thomas","George","Oscar","James","William","Noah","Liam","Lucas","Mason","Ethan"];
const LAST_NAMES  = ["Smith","Johnson","Williams","Brown","Jones","Miller","Davis","Wilson","Anderson","Taylor","Thomas","Moore","Martin","Clark"];

function getRandomItem(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function generateRandomBirthDate() {
  const start = new Date(1995, 0, 1).getTime();
  const end   = new Date(2003, 11, 31).getTime();
  const d     = new Date(start + Math.random() * (end - start));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function generateStrongPassword() {
  const lower   = "abcdefghijklmnopqrstuvwxyz";
  const upper   = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const digits  = "0123456789";
  const special = "@#$!";
  const all     = lower + upper + digits + special;
  const pick    = (set) => set[crypto.randomInt(set.length)];
  const parts   = [pick(upper), pick(lower), pick(digits), pick(special)];
  for (let i = parts.length; i < 12; i++) parts.push(pick(all));
  for (let i = parts.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [parts[i], parts[j]] = [parts[j], parts[i]];
  }
  return parts.join("");
}

function escapeHtml(text) {
  if (!text) return "";
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function genReferralCode(id) { return "REF" + id.toString(36).toUpperCase(); }
function fmt(n) { return Number(n).toFixed(2); }

async function getOrCreateUser(msg) {
  const { id, first_name, username } = msg.from;
  let user = await User.findOne({ telegramId: id });
  if (!user) {
    user = await User.create({
      telegramId:   id,
      firstName:    first_name || "مستخدم",
      username:     username || null,
      referralCode: genReferralCode(id),
    });
  } else {
    user.firstName = first_name || user.firstName;
    user.username  = username  || user.username;
    await user.save();
  }
  return user;
}

async function resetUserState(user, wasteAccount = false) {
  const accountId = user.stateMeta?.accountId;
  if (accountId && wasteAccount) {
    await Account.findByIdAndUpdate(accountId, { assigned: true, isWasted: true, assignedAt: null });
  }
  user.state     = null;
  user.stateMeta = null;
  user.markModified("stateMeta");
  await user.save();
}

async function cleanupStaleSessions() {
  try {
    const cutoff = new Date(Date.now() - SESSION_TIMEOUT_MS);
    const stuck  = await User.find({ state: "awaiting_confirmation", updatedAt: { $lte: cutoff } });
    for (const u of stuck) await resetUserState(u, true);
  } catch (err) {
    console.error("خطأ في تنظيف الجلسات:", err.message);
  }
}

async function loadDynamicPrice() {
  try {
    const doc = await Config.findOne({ key: "accountPrice" });
    if (doc && typeof doc.value === "number" && doc.value > 0) {
      currentPrice = doc.value;
      console.log(`💲 تم تحميل سعر الإنشاء من DB: $${currentPrice}`);
    } else {
      await Config.updateOne({ key: "accountPrice" }, { value: DEFAULT_PRICE }, { upsert: true });
      currentPrice = DEFAULT_PRICE;
      console.log(`💲 تم حفظ السعر الافتراضي: $${currentPrice}`);
    }
  } catch (err) {
    console.error("خطأ في تحميل السعر:", err.message);
  }
}

async function loadMaintenanceMode() {
  try {
    const doc = await Config.findOne({ key: "maintenanceMode" });
    if (doc && typeof doc.value === "boolean") {
      maintenanceMode = doc.value;
      console.log(`🔧 وضع الصيانة: ${maintenanceMode ? "مفعّل 🔴" : "معطّل 🟢"}`);
    } else {
      await Config.updateOne({ key: "maintenanceMode" }, { value: false }, { upsert: true });
      maintenanceMode = false;
    }
  } catch (err) {
    console.error("خطأ في تحميل وضع الصيانة:", err.message);
  }
}

async function toggleMaintenanceMode(chatId) {
  maintenanceMode = !maintenanceMode;
  await Config.updateOne({ key: "maintenanceMode" }, { value: maintenanceMode }, { upsert: true });

  const statusText = maintenanceMode
    ? "🔴 <b>تم تفعيل وضع الصيانة</b>\nالبوت متوقف مؤقتاً للمستخدمين."
    : "🟢 <b>تم إيقاف وضع الصيانة</b>\nالبوت يعمل بشكل طبيعي الآن.";

  await bot.sendMessage(chatId, statusText, { parse_mode: "HTML", ...buildAdminMenu() });

  if (maintenanceMode) {
    try {
      const since    = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const actives  = await User.find({ updatedAt: { $gte: since }, banned: false, telegramId: { $ne: chatId } });
      const msg      =
        `🔧 <b>البوت في وضع الصيانة حالياً</b>\n\n` +
        `نعمل على تحسين الخدمة. سيعود البوت للعمل قريباً.\n` +
        `نعتذر عن أي إزعاج! 🙏`;
      for (const u of actives) {
        bot.sendMessage(u.telegramId, msg, { parse_mode: "HTML" }).catch(() => {});
        await new Promise(r => setTimeout(r, 50));
      }
    } catch (err) {
      console.error("خطأ في إشعار المستخدمين:", err.message);
    }
  }
}

// ═══════════════════════════════════════════════
// 🤖 تهيئة البوت
// ═══════════════════════════════════════════════
const bot             = new TelegramBot(BOT_TOKEN, { polling: true });
const processingUsers = new Set();

bot.setMyCommands([
  { command: "start",       description: "🚀 ابدأ استخدام البوت" },
  { command: "withdraw",    description: "💸 طلب سحب" },
  { command: "leaderboard", description: "🏆 قائمة المتصدرين" },
  { command: "admin",       description: "⚙️ لوحة الإدارة (للمسؤول فقط)" },
]).catch((err) => console.error("خطأ في تعيين الأوامر:", err.message));

bot.on("polling_error", (err) => console.error("Polling error:", err.code, err.message));

// ═══════════════════════════════════════════════
// 🚀 /start
// ═══════════════════════════════════════════════
bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  try {
    const chatId  = msg.chat.id;
    const user    = await getOrCreateUser(msg);
    const refCode = match?.[1]?.trim() ?? null;

    if (user.state) await resetUserState(user, true);

    if (refCode && !user.referredBy) {
      const referrer = await User.findOne({ referralCode: refCode });
      if (referrer && referrer.telegramId !== user.telegramId) {
        user.referredBy        = referrer.telegramId;
        referrer.referralCount += 1;
        await Promise.all([user.save(), referrer.save()]);
        bot.sendMessage(referrer.telegramId, "🎉 انضم مستخدم جديد عبر رابط إحالتك!").catch(() => {});
      }
    }

    await bot.sendMessage(chatId,
      `👋 <b>أهلاً ${escapeHtml(user.firstName)}!</b>\n\n` +
      `💰 <b>اكسب من إنشاء حسابات Gmail الآمنة!</b>\n\n` +
      `📌 <b>شروط قبول الحسابات الإلزامية:</b>\n` +
      `1️⃣ إنشاء الحساب بالبيانات المعطاة.\n` +
      `2️⃣ ربط الحساب بتطبيق Google Authenticator وإرسال مفتاح الأمان السري.\n\n` +
      `💵 السعر لكل حساب مطابق للشروط: <b>$${currentPrice}</b>`,
      { parse_mode: "HTML", ...MAIN_MENU }
    );
  } catch (err) {
    console.error("/start خطأ:", err.message);
  }
});

// ═══════════════════════════════════════════════
// 🏆 /leaderboard
// ═══════════════════════════════════════════════
bot.onText(/\/leaderboard/, async (msg) => {
  await handleLeaderboard(msg.chat.id);
});

// ═══════════════════════════════════════════════
// ⚙️ /admin
// ═══════════════════════════════════════════════
bot.onText(/\/admin/, async (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  const modeLabel = maintenanceMode ? "🔴 الصيانة مفعّلة" : "🟢 البوت يعمل";
  await bot.sendMessage(msg.chat.id,
    `⚙️ <b>لوحة تحكم الإدارة الشاملة</b>\n\nالحالة الحالية: <b>${modeLabel}</b>\n\nاختر الأمر المطلوب:`,
    { parse_mode: "HTML", ...buildAdminMenu() }
  ).catch(() => {});
});

// ═══════════════════════════════════════════════
// 💬 معالج الرسائل الرئيسي
// ═══════════════════════════════════════════════
bot.on("message", async (msg) => {
  const hasText = Boolean(msg.text && !msg.text.startsWith("/"));
  if (!hasText) return;

  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (processingUsers.has(userId)) return;
  processingUsers.add(userId);
  const safetyTimer = setTimeout(() => processingUsers.delete(userId), PROCESSING_TIMEOUT_MS);

  try {
    const user = await getOrCreateUser(msg);
    const text = msg.text || "";

    if (user.banned && userId !== ADMIN_ID) {
      await bot.sendMessage(chatId, "🚫 تم حظرك من استخدام البوت.");
      return;
    }

    if (maintenanceMode && userId !== ADMIN_ID) {
      await bot.sendMessage(chatId,
        `🔧 <b>البوت في وضع الصيانة حالياً</b>\n\n` +
        `نعمل على تحسين الخدمة وسيعود البوت للعمل قريباً.\n` +
        `نعتذر عن أي إزعاج! 🙏`,
        { parse_mode: "HTML" }
      );
      return;
    }

    if (userId === ADMIN_ID && hasText) {
      const handled = await handleAdminText(bot, msg, user, chatId, text);
      if (handled) return;
    }

    if (text === B.BACK) {
      await resetUserState(user, false);
      await bot.sendMessage(chatId, "👋 القائمة الرئيسية.", MAIN_MENU);
      return;
    }

    if (user.state === "awaiting_2fa_verification")   { await handle2FAVerification(user, chatId, text);     return; }
    if (user.state === "awaiting_gmail_backup_codes") { await handleGmail2FASecret(user, msg, chatId, text); return; }
    if (user.state === "awaiting_confirmation")       { await handleConfirmation(user, msg, chatId, text);   return; }
    if (user.state === "awaiting_2fa_for_withdraw")   { await handle2FAForWithdraw(user, chatId, text);      return; }
    if (user.state === "awaiting_withdraw_network")   { await handleWithdrawNetwork(user, chatId, text);     return; }
    if (user.state === "awaiting_withdraw_amount")    { await handleWithdrawAmount(user, chatId, text);      return; }
    if (user.state === "awaiting_withdraw_address")   { await handleWithdrawAddress(user, chatId, text);     return; }

    if (text === B.CREATE_GMAIL)    { await handleCreateGmail(user, chatId);    return; }
    if (text === B.MY_ACCOUNTS)     { await handleMyAccounts(user, chatId);     return; }
    if (text === B.BALANCE)         { await handleBalance(user, chatId);        return; }
    if (text === B.BALANCE_LOG)     { await handleBalanceLog(user, chatId);     return; }
    if (text === B.REFERRALS)       { await handleReferrals(user, chatId);      return; }
    if (text === B.LEADERBOARD)     { await handleLeaderboard(chatId);          return; }
    if (text === B.SETTINGS)        { await handleSettings(user, chatId);       return; }
    if (text === B.TWO_FA_SETTINGS) { await handleTwoFASettings(user, chatId); return; }
    if (text === B.HELP)            { await handleHelp(chatId);                 return; }
    if (text === B.WITHDRAW)        { await handleWithdrawStart(user, chatId);  return; }

  } catch (err) {
    console.error("خطأ عام:", err.message);
    bot.sendMessage(chatId, "❌ حدث خطأ داخلي. الرجاء المحاولة مجدداً.", MAIN_MENU).catch(() => {});
  } finally {
    clearTimeout(safetyTimer);
    processingUsers.delete(userId);
  }
});

// ═══════════════════════════════════════════════
// 🔧 وظائف الأدمن
// ═══════════════════════════════════════════════

async function handleAdminText(bot, msg, user, chatId, text) {

  if (text === B.ADMIN_STATS)           { await sendAdminStats(chatId);              return true; }
  if (text === B.ADMIN_PENDING)         { await sendPendingTasksToAdmin(chatId);     return true; }
  if (text === B.ADMIN_WITHDRAWS)       { await sendPendingWithdrawsToAdmin(chatId); return true; }
  if (text === B.ADMIN_BOUGHT_ACCOUNTS) { await sendBoughtAccountsToAdmin(chatId);  return true; }
  if (text === B.ADMIN_USER_BALANCES)   { await sendUserBalancesToAdmin(chatId);     return true; }

  if (text === B.ADMIN_MAINTENANCE_ON || text === B.ADMIN_MAINTENANCE_OFF) {
    await toggleMaintenanceMode(chatId);
    return true;
  }

  if (text === B.ADMIN_CHANGE_PRICE) {
    user.state = "admin_change_price";
    user.markModified("stateMeta");
    await user.save();
    await bot.sendMessage(chatId,
      `💲 <b>تغيير سعر الإنشاء</b>\n\n` +
      `السعر الحالي: <b>$${currentPrice}</b>\n\n` +
      `أرسل السعر الجديد بالدولار (مثال: <code>0.20</code>):`,
      { parse_mode: "HTML", ...CANCEL_ROW }
    );
    return true;
  }

  if (user.state === "admin_change_price") { await handleAdminChangePrice(user, chatId, text); return true; }

  if (text === B.ADMIN_GENERATE) {
    user.state = "admin_gen_count";
    user.markModified("stateMeta");
    await user.save();
    await bot.sendMessage(chatId, "🔢 أرسل عدد الحسابات المراد توليدها (مثال: 50):", CANCEL_ROW);
    return true;
  }

  if (text === B.ADMIN_BAN) {
    user.state = "admin_ban_id";
    user.markModified("stateMeta");
    await user.save();
    await bot.sendMessage(chatId, "🆔 أرسل Telegram ID للمستخدم:", CANCEL_ROW);
    return true;
  }

  if (text === B.ADMIN_CHARGE) {
    user.state = "admin_charge_id";
    user.markModified("stateMeta");
    await user.save();
    await bot.sendMessage(chatId, "👤 أرسل Telegram ID للمستخدم المراد شحن حسابه:", CANCEL_ROW);
    return true;
  }

  if (text === B.ADMIN_CLEAR_STOCK) {
    const result = await Account.deleteMany({});
    await bot.sendMessage(chatId,
      `🗑️ تم تفريغ المستودع بالكامل!\n✨ عدد المحذوفات: <b>${result.deletedCount}</b> حساب.`,
      { parse_mode: "HTML", ...ADMIN_MENU }
    );
    return true;
  }

  if (text === B.ADMIN_EXIT) {
    await resetUserState(user, false);
    await bot.sendMessage(chatId, "👋 تم الخروج من لوحة التحكم.", MAIN_MENU);
    return true;
  }

  if (user.state === "admin_gen_count")     { await handleAdminGenCount(user, chatId, text);     return true; }
  if (user.state === "admin_ban_id")        { await handleAdminBanId(user, chatId, text);        return true; }
  if (user.state === "admin_charge_id")     { await handleAdminChargeId(user, chatId, text);     return true; }
  if (user.state === "admin_charge_amount") { await handleAdminChargeAmount(user, chatId, text); return true; }

  return false;
}

async function handleAdminGenCount(user, chatId, text) {
  if (text === B.CANCEL) { await resetUserState(user, false); await bot.sendMessage(chatId, "🛑 إلغاء.", ADMIN_MENU); return; }

  const count = parseInt(text.trim(), 10);
  if (isNaN(count) || count <= 0 || count > 500) {
    await bot.sendMessage(chatId, "❌ أدخل عدداً صحيحاً بين 1 و 500:");
    return;
  }

  await resetUserState(user, false);
  await bot.sendMessage(chatId, `⚙️ جاري توليد ${count} حساب...`);

  let success = 0;
  for (let i = 0; i < count; i++) {
    try {
      const fn    = getRandomItem(FIRST_NAMES);
      const ln    = getRandomItem(LAST_NAMES);
      const yr    = Math.floor(Math.random() * (2003 - 1995 + 1)) + 1995;
      const num   = Math.floor(Math.random() * 900) + 100;
      const email = `${fn.toLowerCase()}${ln.toLowerCase()}${yr}${num}@gmail.com`;
      await Account.create({ firstName: fn, lastName: ln, email, password: encrypt(generateStrongPassword()), birthDate: generateRandomBirthDate() });
      success++;
    } catch { /* تجاهل تكرار الإيميل */ }
  }

  await bot.sendMessage(chatId,
    `✅ انتهى التوليد! تمت إضافة <b>${success}</b> حساب للمستودع.`,
    { parse_mode: "HTML", ...ADMIN_MENU }
  );
}

async function handleAdminBanId(user, chatId, text) {
  if (text === B.CANCEL) { await resetUserState(user, false); await bot.sendMessage(chatId, "🛑 إلغاء.", ADMIN_MENU); return; }

  const targetId = parseInt(text.trim(), 10);
  if (isNaN(targetId)) { await bot.sendMessage(chatId, "❌ معرّف غير صحيح:"); return; }

  const target = await User.findOne({ telegramId: targetId });
  if (!target) { await resetUserState(user, false); await bot.sendMessage(chatId, "❌ المستخدم غير موجود.", ADMIN_MENU); return; }

  target.banned = !target.banned;
  await target.save();
  await resetUserState(user, false);

  await bot.sendMessage(chatId,
    `⚙️ تم تعديل حالة المستخدم <code>${targetId}</code>:\n<b>${target.banned ? "🚫 محظور" : "🟢 نشط"}</b>`,
    { parse_mode: "HTML", ...ADMIN_MENU }
  );
}

async function handleAdminChargeId(user, chatId, text) {
  if (text === B.CANCEL) { await resetUserState(user, false); await bot.sendMessage(chatId, "🛑 إلغاء.", ADMIN_MENU); return; }

  const targetId = parseInt(text.trim(), 10);
  if (isNaN(targetId)) { await bot.sendMessage(chatId, "❌ معرّف غير صحيح:"); return; }

  const target = await User.findOne({ telegramId: targetId });
  if (!target) { await resetUserState(user, false); await bot.sendMessage(chatId, "❌ المستخدم غير موجود.", ADMIN_MENU); return; }

  user.state     = "admin_charge_amount";
  user.stateMeta = { targetId };
  user.markModified("stateMeta");
  await user.save();

  await bot.sendMessage(chatId,
    `👤 المستخدم: <b>${escapeHtml(target.firstName)}</b> (<code>${targetId}</code>)\n` +
    `💵 رصيده الحالي: $${fmt(target.balance)}\n\nأرسل المبلغ المراد إضافته:`,
    { parse_mode: "HTML", ...CANCEL_ROW }
  );
}

async function handleAdminChargeAmount(user, chatId, text) {
  if (text === B.CANCEL) { await resetUserState(user, false); await bot.sendMessage(chatId, "🛑 إلغاء.", ADMIN_MENU); return; }

  const amount = parseFloat(text.trim());
  if (isNaN(amount) || amount <= 0) { await bot.sendMessage(chatId, "❌ قيمة غير صالحة:"); return; }

  const targetId = user.stateMeta?.targetId;
  const updated  = await User.findOneAndUpdate(
    { telegramId: targetId },
    { $inc: { balance: amount, totalEarned: amount } },
    { new: true }
  );

  await resetUserState(user, false);
  if (!updated) { await bot.sendMessage(chatId, "❌ فشل الشحن.", ADMIN_MENU); return; }

  await bot.sendMessage(chatId,
    `✅ تم شحن $${fmt(amount)} للمستخدم <code>${targetId}</code>\nرصيده الجديد: <b>$${fmt(updated.balance)}</b>`,
    { parse_mode: "HTML", ...ADMIN_MENU }
  );
  bot.sendMessage(targetId,
    `💰 <b>إشعار:</b> تم إضافة <b>$${fmt(amount)}</b> لرصيدك من قِبَل الإدارة.\nرصيدك الحالي: $${fmt(updated.balance)}`,
    { parse_mode: "HTML" }
  ).catch(() => {});
}

async function sendAdminStats(chatId) {
  const [totalUsers, approvedTasks, pendingTasks, stock, pendingWithdraws] = await Promise.all([
    User.countDocuments(),
    Task.countDocuments({ status: "approved" }),
    Task.countDocuments({ status: "pending" }),
    Account.countDocuments({ assigned: false, isWasted: false }),
    Withdrawal.countDocuments({ status: "pending" }),
  ]);
  await bot.sendMessage(chatId,
    `📊 <b>إحصائيات النظام:</b>\n\n` +
    `👥 إجمالي المستخدمين: <b>${totalUsers}</b>\n` +
    `📦 حسابات جاهزة بالمستودع: <b>${stock}</b>\n` +
    `✅ حسابات مقبولة: <b>${approvedTasks}</b>\n` +
    `⏳ قيد المراجعة: <b>${pendingTasks}</b>\n` +
    `💸 طلبات سحب معلقة: <b>${pendingWithdraws}</b>`,
    { parse_mode: "HTML", ...ADMIN_MENU }
  );
}

async function sendPendingTasksToAdmin(chatId) {
  const pending = await Task.find({ status: "pending" });
  if (!pending.length) { await bot.sendMessage(chatId, "🎉 لا توجد طلبات معلقة حالياً.", ADMIN_MENU); return; }

  for (const task of pending) {
    const account     = await Account.findById(task.accountId);
    const plainPass   = account ? decrypt(account.password) : "غير متوفر";
    const plainSecret = decrypt(task.google2FASecret).replace(/\s/g, "").toUpperCase();
    let liveCode = "—", timeLeft = 0;
    try { liveCode = authenticator.generate(plainSecret); timeLeft = authenticator.timeRemaining(); } catch {}

    await bot.sendMessage(chatId,
      `📬 <b>طلب مراجعة Gmail</b>\n\n` +
      `👤 المستخدم: <code>${task.userId}</code>\n` +
      `📧 البريد: <code>${escapeHtml(task.accountEmail)}</code>\n` +
      `🔑 الباسورد: <code>${escapeHtml(plainPass)}</code>\n\n` +
      `🔐 <b>OTP الحالي:</b> <code>${liveCode}</code> (ينتهي خلال ${timeLeft}s)\n` +
      `⚙️ Secret Key:\n<code>${plainSecret}</code>`,
      { parse_mode: "HTML", reply_markup: { inline_keyboard: [[
        { text: "✅ قبول وضخ رصيد",    callback_data: `app_task_${task._id}` },
        { text: "❌ رفض الطلب نهائياً", callback_data: `rej_task_${task._id}` },
      ]] } }
    ).catch(() => {});
  }
}

async function sendPendingWithdrawsToAdmin(chatId) {
  const pending = await Withdrawal.find({ status: "pending" });
  if (!pending.length) { await bot.sendMessage(chatId, "🎉 لا توجد طلبات سحب معلقة حالياً.", ADMIN_MENU); return; }

  for (const w of pending) {
    await bot.sendMessage(chatId,
      `💸 <b>طلب سحب معلق</b>\n\n` +
      `👤 المستخدم: <code>${w.userId}</code>\n` +
      `🌐 الشبكة: <b>${w.network}</b>\n` +
      `💵 الصافي: $${fmt(w.amount)}\n` +
      `📮 العنوان: <code>${escapeHtml(w.address)}</code>`,
      {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[
          { text: "✅ تأكيد التحويل",   callback_data: `app_with_${w._id}` },
          { text: "❌ رفض وإعادة رصيد", callback_data: `rej_with_${w._id}` },
        ]]},
      }
    ).catch(() => {});
  }
}

async function sendBoughtAccountsToAdmin(chatId) {
  const approved = await Task.find({ status: "approved" })
    .sort({ updatedAt: -1 })
    .limit(20);

  if (!approved.length) {
    await bot.sendMessage(chatId, "📦 لا توجد حسابات مشتراة بعد.", ADMIN_MENU);
    return;
  }

  let txt = `📦 <b>آخر 20 حساب تم شراؤه وقبوله:</b>\n\n`;
  for (let i = 0; i < approved.length; i++) {
    const t       = approved[i];
    const account = await Account.findById(t.accountId);
    const pass    = account ? decrypt(account.password) : "—";
    const date    = t.updatedAt.toISOString().slice(0, 10);

    txt += `<b>${i + 1}.</b> 📧 <code>${escapeHtml(t.accountEmail)}</code>\n` +
           `   🔑 <code>${escapeHtml(pass)}</code>\n` +
           `   👤 ID: <code>${t.userId}</code> | 💵 $${fmt(t.amount)} | 📅 ${date}\n\n`;
  }

  if (txt.length > 3800) {
    const half = Math.floor(approved.length / 2);
    await bot.sendMessage(chatId, txt.slice(0, txt.indexOf(`<b>${half + 1}.`)), { parse_mode: "HTML" }).catch(() => {});
    await bot.sendMessage(chatId, `<b>تابع...</b>\n\n` + txt.slice(txt.indexOf(`<b>${half + 1}.`)), { parse_mode: "HTML", ...ADMIN_MENU }).catch(() => {});
  } else {
    await bot.sendMessage(chatId, txt, { parse_mode: "HTML", ...ADMIN_MENU });
  }
}

async function sendUserBalancesToAdmin(chatId) {
  const users = await User.find({ balance: { $gt: 0 } })
    .sort({ balance: -1 })
    .limit(25);

  if (!users.length) {
    await bot.sendMessage(chatId, "👛 لا يوجد مستخدمون برصيد حالياً.", ADMIN_MENU);
    return;
  }

  const medals = ["🥇","🥈","🥉"];
  let txt = `👛 <b>أعلى 25 مستخدم برصيد:</b>\n\n`;

  users.forEach((u, i) => {
    const rank     = medals[i] ?? `${i + 1}.`;
    const name     = escapeHtml(u.firstName);
    const user_tag = u.username ? `@${escapeHtml(u.username)}` : `<code>${u.telegramId}</code>`;
    txt += `${rank} ${name} (${user_tag})\n` +
           `   💰 الرصيد: <b>$${fmt(u.balance)}</b> | إجمالي المكسب: $${fmt(u.totalEarned)}\n\n`;
  });

  await bot.sendMessage(chatId, txt, { parse_mode: "HTML", ...ADMIN_MENU });
}

async function handleAdminChangePrice(user, chatId, text) {
  if (text === B.CANCEL) {
    await resetUserState(user, false);
    await bot.sendMessage(chatId, "🛑 إلغاء.", ADMIN_MENU);
    return;
  }
  const newPrice = parseFloat(text.trim());
  if (isNaN(newPrice) || newPrice <= 0 || newPrice > 100) {
    await bot.sendMessage(chatId, "❌ سعر غير صالح. أدخل رقماً موجباً بين 0.01 و 100:");
    return;
  }
  const oldPrice  = currentPrice;
  currentPrice    = parseFloat(newPrice.toFixed(4));
  await Config.updateOne({ key: "accountPrice" }, { value: currentPrice }, { upsert: true });
  await resetUserState(user, false);
  await bot.sendMessage(chatId,
    `✅ <b>تم تغيير السعر بنجاح!</b>\n\n` +
    `📉 السعر القديم: <b>$${fmt(oldPrice)}</b>\n` +
    `📈 السعر الجديد: <b>$${fmt(currentPrice)}</b>\n\n` +
    `⚠️ سيُطبَّق على جميع الحسابات الجديدة فوراً.`,
    { parse_mode: "HTML", ...ADMIN_MENU }
  );
  console.log(`💲 تم تغيير السعر من $${oldPrice} إلى $${currentPrice} بواسطة الأدمن.`);
}

// ═══════════════════════════════════════════════
// 👤 وظائف المستخدم
// ═══════════════════════════════════════════════

async function handleCreateGmail(user, chatId) {
  const pendingCount = await Task.countDocuments({ userId: user.telegramId, status: "pending" });
  if (pendingCount >= MAX_PENDING_TASKS) {
    await bot.sendMessage(chatId, `⚠️ لديك ${pendingCount} طلبات معلقة. انتظر مراجعتها أولاً.`);
    return;
  }

  const updated = await User.findOneAndUpdate(
    { telegramId: user.telegramId, state: null },
    { $set: { state: "awaiting_confirmation" } },
    { new: true }
  );

  if (!updated) { await bot.sendMessage(chatId, "⚠️ لديك عملية معلقة بالفعل.", CONFIRM_MENU); return; }

  const account = await Account.findOneAndUpdate(
    { assigned: false, isWasted: false },
    { assigned: true, assignedTo: user.telegramId, assignedAt: new Date() },
    { new: true }
  );

  if (!account) {
    await User.findOneAndUpdate({ telegramId: user.telegramId }, { $set: { state: null } });
    await bot.sendMessage(chatId, "❌ لا توجد حسابات متاحة حالياً. تواصل مع الإدارة.", MAIN_MENU);
    return;
  }

  const sentMsg = await bot.sendMessage(chatId,
    `📧 <b>بيانات الحساب المطلوب إنشاؤه:</b>\n\n` +
    `👤 الاسم الأول: <code>${escapeHtml(account.firstName)}</code>\n` +
    `👥 اسم العائلة: <code>${escapeHtml(account.lastName)}</code>\n` +
    `📅 تاريخ الميلاد: <code>${account.birthDate}</code>\n` +
    `📧 البريد: <code>${escapeHtml(account.email)}</code>\n` +
    `🔑 كلمة المرور: <code>${escapeHtml(decrypt(account.password))}</code>`,
    { parse_mode: "HTML", ...CONFIRM_MENU }
  );

  await User.findOneAndUpdate(
    { telegramId: user.telegramId },
    { stateMeta: { accountId: account._id.toString(), dataMessageId: sentMsg.message_id } }
  );
}

// ═══════════════════════════════════════════════
// ✅ handleConfirmation — بدون تحقق من جوجل
// ═══════════════════════════════════════════════
async function handleConfirmation(user, msg, chatId, text) {
  if (text === B.BACK || text === B.CANCEL_CREATE) {
    await bot.deleteMessage(chatId, user.stateMeta?.dataMessageId).catch(() => {});
    await resetUserState(user, true);
    await bot.sendMessage(chatId, "👋 تم الإلغاء.", MAIN_MENU);
    return;
  }

  if (text !== B.CONFIRMED_CREATE) return;

  const accountId = user.stateMeta?.accountId;
  const account   = await Account.findById(accountId);
  if (!account) {
    await resetUserState(user, false);
    await bot.sendMessage(chatId, "❌ حدث خطأ، الحساب غير متوفر.", MAIN_MENU);
    return;
  }

  // حذف رسالة بيانات الحساب والانتقال مباشرة لخطوة الـ 2FA
  await bot.deleteMessage(chatId, user.stateMeta?.dataMessageId).catch(() => {});

  user.state = "awaiting_gmail_backup_codes";
  user.markModified("stateMeta");
  await user.save();

  await bot.sendMessage(chatId,
    `⚙️ <b>الخطوة التالية — مفتاح الـ 2FA (إلزامي):</b>\n\n` +
    `1️⃣ توجه لإعدادات الحساب ← الأمان ← التحقق بخطوتين.\n` +
    `2️⃣ اختر تطبيق Authenticator واضغط <b>"لا يمكن مسحه ضوئياً"</b>.\n` +
    `3️⃣ انسخ <b>المفتاح السري (Secret Key)</b> وأرسله هنا.\n` +
    `4️⃣ 🚨 احذف تسجيل الدخول من هاتفك فوراً بعد الإرسال.\n\n` +
    `🛑 <i>بدون المفتاح الصحيح لن يتم قبول الحساب أو دفع $${currentPrice}.</i>`,
    { parse_mode: "HTML", ...TWO_FA_GMAIL_MENU }
  );
}

async function handleGmail2FASecret(user, msg, chatId, text) {
  if (text === B.BACK || text === B.CANCEL_CREATE) {
    await resetUserState(user, true);
    await bot.sendMessage(chatId, "👋 تم الإلغاء.", MAIN_MENU);
    return;
  }

  if (text === B.HOW_TO_ACTIVATE) {
    await bot.sendMessage(chatId,
      `📱 <b>كيفية استخراج مفتاح الـ 2FA:</b>\n\n` +
      `1️⃣ افتح حساب Gmail الجديد.\n` +
      `2️⃣ إعدادات الحساب ← <b>الأمان (Security)</b>.\n` +
      `3️⃣ <b>التحقق بخطوتين (2-Step Verification)</b>.\n` +
      `4️⃣ اختر <b>Authenticator</b> ← إعداد.\n` +
      `5️⃣ اضغط <b>"لا يمكن مسحه ضوئياً"</b> لظهور النص.\n` +
      `6️⃣ انسخ المفتاح وأرسله هنا.`,
      { parse_mode: "HTML", ...TWO_FA_GMAIL_MENU }
    );
    return;
  }

  const cleanSecret = text.trim().replace(/\s/g, "").toUpperCase();

  if (cleanSecret.length < 16) {
    await bot.sendMessage(chatId, "⚠️ المفتاح قصير جداً. Secret Key عادةً يكون 16 حرفاً أو أكثر.", TWO_FA_GMAIL_MENU);
    return;
  }

  try { authenticator.generate(cleanSecret); } catch {
    await bot.sendMessage(chatId, "⚠️ المفتاح غير صالح. تأكد من نسخ Secret Key الصحيح.", TWO_FA_GMAIL_MENU);
    return;
  }

  const accountId = user.stateMeta?.accountId;
  const account   = await Account.findById(accountId);
  if (!account) { await resetUserState(user, false); await bot.sendMessage(chatId, "❌ الحساب غير متوفر.", MAIN_MENU); return; }

  const task = await Task.create({
    userId:          user.telegramId,
    amount:          currentPrice,
    accountEmail:    account.email,
    accountId:       account._id,
    google2FASecret: encrypt(cleanSecret),
    submittedAt:     new Date(),
  });

  await resetUserState(user, false);
  await bot.sendMessage(chatId,
    "✅ <b>تم استلام المفتاح وإرسال الحساب للمراجعة!</b>\nسيتم إضافة الرصيد فور القبول.",
    { parse_mode: "HTML", ...MAIN_MENU }
  );

  let liveCode = "—";
  try { liveCode = authenticator.generate(cleanSecret); } catch {}

  bot.sendMessage(ADMIN_ID,
    `📬 <b>طلب Gmail جديد</b>\n\n` +
    `👤 ${escapeHtml(user.firstName)} (<code>${user.telegramId}</code>)\n` +
    `📧 <code>${escapeHtml(account.email)}</code>\n` +
    `🔑 <code>${escapeHtml(decrypt(account.password))}</code>\n\n` +
    `🔥 OTP الحالي: <code>${liveCode}</code>\n` +
    `⚙️ Secret Key:\n<code>${cleanSecret}</code>`,
    {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[
        { text: "✅ قبول وضخ رصيد",    callback_data: `app_task_${task._id}` },
        { text: "❌ رفض الطلب نهائياً", callback_data: `rej_task_${task._id}` },
      ]]},
    }
  ).catch(() => {});
}

async function handle2FAVerification(user, chatId, text) {
  if (text === B.CANCEL) { await resetUserState(user, false); await bot.sendMessage(chatId, "❌ تم الإلغاء.", MAIN_MENU); return; }

  const tempSecret = decrypt(user.stateMeta?.tempSecret);
  if (!tempSecret || !authenticator.check(text.trim(), tempSecret)) {
    await bot.sendMessage(chatId, "❌ الرمز غير صحيح أو انتهت صلاحيته. حاول مجدداً:", CANCEL_MENU);
    return;
  }

  user.twoFASecret  = user.stateMeta.tempSecret;
  user.twoFAEnabled = true;
  user.state        = null;
  user.stateMeta    = null;
  user.markModified("stateMeta");
  await user.save();

  await bot.sendMessage(chatId, "🔒 <b>تم تفعيل التحقق بخطوتين بنجاح!</b>", { parse_mode: "HTML", ...MAIN_MENU });
}

async function handleTwoFASettings(user, chatId) {
  if (user.twoFAEnabled) {
    user.twoFAEnabled = false;
    user.twoFASecret  = null;
    await user.save();
    await bot.sendMessage(chatId, "🔓 تم تعطيل التحقق بخطوتين.", SETTINGS_MENU);
    return;
  }

  const secret   = authenticator.generateSecret();
  user.state     = "awaiting_2fa_verification";
  user.stateMeta = { tempSecret: encrypt(secret) };
  user.markModified("stateMeta");
  await user.save();

  await bot.sendMessage(chatId,
    `🔑 <b>مفتاح الأمان الخاص بك:</b>\n<code>${secret}</code>\n\n` +
    `أضفه في Google Authenticator ثم أرسل الرمز المكون من 6 أرقام:`,
    { parse_mode: "HTML", ...CANCEL_MENU }
  );
}

async function handleWithdrawStart(user, chatId) {
  if (user.twoFAEnabled) {
    user.state = "awaiting_2fa_for_withdraw";
    user.markModified("stateMeta");
    await user.save();
    await bot.sendMessage(chatId, "🔐 أدخل رمز الـ 2FA لتأكيد السحب:", BACK_ROW);
    return;
  }
  user.state = "awaiting_withdraw_network";
  user.markModified("stateMeta");
  await user.save();
  await bot.sendMessage(chatId, `💰 رصيدك: <b>$${fmt(user.balance)}</b>\nاختر شبكة السحب:`, { parse_mode: "HTML", ...NETWORK_MENU });
}

async function handle2FAForWithdraw(user, chatId, text) {
  if (text === B.BACK) { await resetUserState(user, false); await bot.sendMessage(chatId, "👋 تم الإلغاء.", MAIN_MENU); return; }
  const plain = decrypt(user.twoFASecret);
  if (!authenticator.check(text.trim(), plain)) { await bot.sendMessage(chatId, "❌ رمز غير صحيح:", BACK_ROW); return; }
  user.state = "awaiting_withdraw_network";
  user.markModified("stateMeta");
  await user.save();
  await bot.sendMessage(chatId, `🔓 <b>تم التحقق!</b> اختر شبكة السحب:`, { parse_mode: "HTML", ...NETWORK_MENU });
}

async function handleWithdrawNetwork(user, chatId, text) {
  if (text === B.BACK) { await resetUserState(user, false); await bot.sendMessage(chatId, "👋 القائمة الرئيسية.", MAIN_MENU); return; }
  if (text.includes("USDT-BEP-20")) {
    user.state     = "awaiting_withdraw_amount";
    user.stateMeta = { network: "USDT-BEP20", fee: WITHDRAW_FEE };
    user.markModified("stateMeta");
    await user.save();
    await bot.sendMessage(chatId, `💸 الحد الأدنى $${MIN_WITHDRAW} | الرسوم $${WITHDRAW_FEE}\nأدخل المبلغ:`, BACK_ROW);
  } else {
    await resetUserState(user, false);
    await bot.sendMessage(chatId, "👋 القائمة الرئيسية.", MAIN_MENU);
  }
}

async function handleWithdrawAmount(user, chatId, text) {
  if (text === B.BACK) {
    user.state = "awaiting_withdraw_network";
    user.markModified("stateMeta");
    await user.save();
    await bot.sendMessage(chatId, "اختر شبكة السحب:", NETWORK_MENU);
    return;
  }
  const amount = parseFloat(text.trim());
  if (isNaN(amount) || amount < MIN_WITHDRAW) { await bot.sendMessage(chatId, `❌ الحد الأدنى $${MIN_WITHDRAW}. أعد الإدخال:`); return; }
  const total = amount + (user.stateMeta?.fee ?? WITHDRAW_FEE);
  if (user.balance < total) {
    await bot.sendMessage(chatId, `❌ رصيدك ($${fmt(user.balance)}) غير كافٍ. المطلوب: $${fmt(total)}.`);
    return;
  }
  user.stateMeta = { ...user.stateMeta, amount };
  user.state     = "awaiting_withdraw_address";
  user.markModified("stateMeta");
  await user.save();
  await bot.sendMessage(chatId, "📮 أدخل عنوان محفظة BSC (BEP-20):", BACK_ROW);
}

async function handleWithdrawAddress(user, chatId, text) {
  if (text === B.BACK) {
    user.state = "awaiting_withdraw_amount";
    user.markModified("stateMeta");
    await user.save();
    await bot.sendMessage(chatId, "أدخل المبلغ من جديد:", BACK_ROW);
    return;
  }
  const address = text.trim();
  if (!BEP20_REGEX.test(address)) { await bot.sendMessage(chatId, "❌ عنوان غير صالح. يجب أن يبدأ بـ 0x ويكون 42 حرفاً:"); return; }

  const { network, fee, amount } = user.stateMeta || {};
  const total = amount + fee;

  const updated = await User.findOneAndUpdate(
    { telegramId: user.telegramId, balance: { $gte: total }, state: "awaiting_withdraw_address" },
    { $inc: { balance: -total }, $set: { state: null, stateMeta: null } },
    { new: true }
  );

  if (!updated) { await resetUserState(user, false); await bot.sendMessage(chatId, "❌ فشل الطلب: الرصيد غير كافٍ.", MAIN_MENU); return; }

  await Withdrawal.create({ userId: user.telegramId, amount, fee, totalDeduction: total, address, network });
  await bot.sendMessage(chatId,
    `✅ تم تسجيل طلب السحب!\n💵 المبلغ: $${fmt(amount)} | الرسوم: $${fmt(fee)}\n⏳ قيد المراجعة.`,
    MAIN_MENU
  );
}

async function handleMyAccounts(user, chatId) {
  const tasks = await Task.find({ userId: user.telegramId }).sort({ createdAt: -1 }).limit(10);
  if (!tasks.length) { await bot.sendMessage(chatId, "📋 لا توجد حسابات مسجلة بعد.", MAIN_MENU); return; }
  const emoji = { approved: "✅", rejected: "❌", pending: "⏳" };
  const lines = tasks.map(t => `${emoji[t.status]} <code>${escapeHtml(t.accountEmail)}</code> — $${fmt(t.amount)}`);
  await bot.sendMessage(chatId, `📋 <b>آخر 10 حسابات:</b>\n\n${lines.join("\n")}`, { parse_mode: "HTML", ...MAIN_MENU });
}

async function handleBalance(user, chatId) {
  const approved = await Task.countDocuments({ userId: user.telegramId, status: "approved" });
  await bot.sendMessage(chatId,
    `💵 <b>رصيدك:</b> $${fmt(user.balance)} USDT\n` +
    `📈 إجمالي ما كسبته: $${fmt(user.totalEarned ?? 0)}\n` +
    `✅ حسابات مقبولة: ${approved}`,
    { parse_mode: "HTML", ...BALANCE_MENU }
  );
}

async function handleBalanceLog(user, chatId) {
  const ws = await Withdrawal.find({ userId: user.telegramId }).sort({ createdAt: -1 }).limit(10);
  if (!ws.length) { await bot.sendMessage(chatId, "📝 لا توجد عمليات سحب بعد.", BALANCE_MENU); return; }
  const emoji = { approved: "✅", rejected: "❌", pending: "⏳" };
  const lines = ws.map(w => `${emoji[w.status]} $${fmt(w.amount)} — <code>${w.network}</code>`);
  await bot.sendMessage(chatId, `📝 <b>سجل السحوبات:</b>\n\n${lines.join("\n")}`, { parse_mode: "HTML", ...BALANCE_MENU });
}

async function handleReferrals(user, chatId) {
  const me      = await bot.getMe();
  const refLink = `https://t.me/${me.username}?start=${user.referralCode}`;
  await bot.sendMessage(chatId,
    `👥 <b>نظام الإحالات</b>\n\n📈 إجمالي الإحالات: <b>${user.referralCount}</b>\n🔗 رابطك الخاص:\n<code>${refLink}</code>`,
    { parse_mode: "HTML", ...MAIN_MENU }
  );
}

async function handleLeaderboard(chatId) {
  const topUsers = await User.find({ totalEarned: { $gt: 0 } })
    .sort({ totalEarned: -1 })
    .limit(LEADERBOARD_SIZE);

  if (!topUsers.length) {
    await bot.sendMessage(chatId,
      "🏆 <b>قائمة المتصدرين</b>\n\nلا يوجد متصدرون بعد. كن أول من يكسب!",
      { parse_mode: "HTML", ...MAIN_MENU }
    );
    return;
  }

  const medals = ["🥇","🥈","🥉","4️⃣","5️⃣","6️⃣","7️⃣","8️⃣","9️⃣","🔟"];
  let txt = `🏆 <b>قائمة المتصدرين — أعلى ${topUsers.length} كاسب:</b>\n\n`;

  topUsers.forEach((u, i) => {
    const name     = escapeHtml(u.firstName);
    const accounts = Math.round((u.totalEarned ?? 0) / currentPrice);
    txt += `${medals[i]} <b>${name}</b> — <b>$${fmt(u.totalEarned ?? 0)}</b> (${accounts} حساب)\n`;
  });

  txt += `\n💡 <i>كل حساب مقبول = $${currentPrice} — انضم وأنشئ حساباتك الآن!</i>`;

  await bot.sendMessage(chatId, txt, { parse_mode: "HTML", ...MAIN_MENU });
}

async function handleSettings(user, chatId) {
  await bot.sendMessage(chatId,
    `⚙️ <b>الإعدادات</b>\n\n🔒 التحقق بخطوتين: <b>${user.twoFAEnabled ? "🟢 مفعّل" : "🔴 معطّل"}</b>`,
    { parse_mode: "HTML", ...SETTINGS_MENU }
  );
}

async function handleHelp(chatId) {
  await bot.sendMessage(chatId,
    `💬 <b>كيفية الحصول على مكافأة $${currentPrice}:</b>\n\n` +
    `1️⃣ اضغط "➕ أنشئ حساب Gmail جديد".\n` +
    `2️⃣ أنشئ الحساب بالبيانات المعطاة.\n` +
    `3️⃣ اضغط "✅ تم التفعيل والإنشاء".\n` +
    `4️⃣ فعّل الـ 2FA وأرسل Secret Key.\n` +
    `5️⃣ انتظر مراجعة الإدارة وضخ الرصيد.\n\n` +
    `📞 للدعم: تواصل مع الإدارة مباشرة.`,
    { parse_mode: "HTML", ...MAIN_MENU }
  );
}

// ═══════════════════════════════════════════════
// 🔘 Callback Queries (أزرار Inline)
// ═══════════════════════════════════════════════
bot.on("callback_query", async (query) => {
  if (query.from.id !== ADMIN_ID) {
    await bot.answerCallbackQuery(query.id, { text: "⛔ غير مصرح لك." }).catch(() => {});
    return;
  }

  const { data, message } = query;
  const msgId  = message.message_id;
  const chatId = message.chat.id;

  try {
    if (data.startsWith("app_task_")) {
      const taskId = data.slice("app_task_".length);
      const task   = await Task.findOne({ _id: taskId, status: "pending" });
      if (!task) { await bot.answerCallbackQuery(query.id, { text: "⚠️ تمت المعالجة مسبقاً." }); return; }

      task.status = "approved";
      await task.save();

      await User.findOneAndUpdate(
        { telegramId: task.userId },
        { $inc: { balance: task.amount, totalEarned: task.amount } }
      );

      bot.sendMessage(task.userId,
        `✅ <b>تمت الموافقة على حسابك!</b>\nتم إضافة <b>$${fmt(task.amount)}</b> لرصيدك.`,
        { parse_mode: "HTML" }
      ).catch(() => {});
      bot.editMessageText(
        `✅ <b>تمت الموافقة:</b> <code>${escapeHtml(task.accountEmail)}</code>`,
        { chat_id: chatId, message_id: msgId, parse_mode: "HTML" }
      ).catch(() => {});
    }

    else if (data.startsWith("rej_task_")) {
      const taskId = data.slice("rej_task_".length);
      const task   = await Task.findOneAndUpdate({ _id: taskId, status: "pending" }, { status: "rejected" }, { new: true });
      if (!task) { await bot.answerCallbackQuery(query.id, { text: "⚠️ تمت المعالجة مسبقاً." }); return; }

      if (task.accountId) await Account.findByIdAndUpdate(task.accountId, { isWasted: true });

      bot.sendMessage(task.userId,
        `❌ <b>تم رفض حسابك</b>\nالسبب: الحساب غير مطابق للشروط أو الـ 2FA غير صحيح.`,
        { parse_mode: "HTML" }
      ).catch(() => {});
      bot.editMessageText(
        `❌ <b>تم الرفض:</b> <code>${escapeHtml(task.accountEmail)}</code>`,
        { chat_id: chatId, message_id: msgId, parse_mode: "HTML" }
      ).catch(() => {});
    }

    else if (data.startsWith("app_with_")) {
      const withId   = data.slice("app_with_".length);
      const withdraw = await Withdrawal.findOneAndUpdate({ _id: withId, status: "pending" }, { status: "approved" }, { new: true });
      if (!withdraw) { await bot.answerCallbackQuery(query.id, { text: "⚠️ تمت المعالجة مسبقاً." }); return; }

      bot.sendMessage(withdraw.userId,
        `💸 <b>تمت الموافقة على طلب السحب!</b>\nتم تحويل <b>$${fmt(withdraw.amount)}</b> لمحفظتك.`,
        { parse_mode: "HTML" }
      ).catch(() => {});
      bot.editMessageText(
        `✅ <b>تم تأكيد التحويل:</b> $${fmt(withdraw.amount)} → <code>${escapeHtml(withdraw.address)}</code>`,
        { chat_id: chatId, message_id: msgId, parse_mode: "HTML" }
      ).catch(() => {});

      if (CHANNEL_ID) {
        const withdrawUser = await User.findOne({ telegramId: withdraw.userId });
        const userTag  = withdrawUser?.username
          ? `@${escapeHtml(withdrawUser.username)}`
          : `<b>${escapeHtml(withdrawUser?.firstName || "مستخدم")}</b>`;
        const now       = new Date().toISOString().slice(0, 16).replace("T", " ");
        const addrShort = withdraw.address.slice(0, 8) + "..." + withdraw.address.slice(-6);
        bot.sendMessage(CHANNEL_ID,
          `👤 ${userTag}\n` +
          `💸 <b>تم صرف سحب ناجح!</b>\n\n` +
          `💵 المبلغ: <b>$${fmt(withdraw.amount)} USDT</b>\n` +
          `🌐 الشبكة: <b>${withdraw.network}</b>\n` +
          `📮 المحفظة: <code>${addrShort}</code>\n` +
          `🕐 التوقيت: <code>${now}</code>\n\n` +
          `✅ <i>دليل دفع حقيقي ومؤكد</i>`,
          { parse_mode: "HTML" }
        ).catch((e) => console.error("خطأ في نشر إشعار القناة:", e.message));
      }
    }

    else if (data.startsWith("rej_with_")) {
      const withId   = data.slice("rej_with_".length);
      const withdraw = await Withdrawal.findOneAndUpdate({ _id: withId, status: "pending" }, { status: "rejected" }, { new: true });
      if (!withdraw) { await bot.answerCallbackQuery(query.id, { text: "⚠️ تمت المعالجة مسبقاً." }); return; }

      await User.findOneAndUpdate({ telegramId: withdraw.userId }, { $inc: { balance: withdraw.totalDeduction } });

      bot.sendMessage(withdraw.userId,
        `❌ <b>تم رفض طلب السحب</b>\nتم إعادة <b>$${fmt(withdraw.totalDeduction)}</b> لرصيدك.`,
        { parse_mode: "HTML" }
      ).catch(() => {});
      bot.editMessageText(
        `❌ <b>تم رفض السحب وإعادة الرصيد:</b> <code>${withdraw.userId}</code>`,
        { chat_id: chatId, message_id: msgId, parse_mode: "HTML" }
      ).catch(() => {});
    }

  } catch (err) {
    console.error("خطأ في callback_query:", err.message);
  } finally {
    bot.answerCallbackQuery(query.id, { text: "✅ تمت المعالجة" }).catch(() => {});
  }
});

// ═══════════════════════════════════════════════
// 🏁 تشغيل النظام
// ═══════════════════════════════════════════════
mongoose.connect(MONGODB_URI)
  .then(async () => {
    console.log("✅ MongoDB متصل. البوت يعمل الآن.");
    await loadDynamicPrice();
    await loadMaintenanceMode();
  })
  .catch((err) => { console.error("❌ فشل الاتصال بـ MongoDB:", err.message); process.exit(1); });

setInterval(cleanupStaleSessions, CLEANUP_INTERVAL_MS);

http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Bot is running");
}).listen(process.env.PORT || 8080);
