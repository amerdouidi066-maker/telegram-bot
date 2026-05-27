const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose");
const http = require("http");
const { authenticator } = require("otplib"); 
const crypto = require("crypto");
const emailCheck = require("email-check"); 

// --- إعدادات متغيرات البيئة ---
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_ID = parseInt(process.env.ADMIN_ID, 10);
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

if (!BOT_TOKEN) throw new Error("BOT_TOKEN مطلوب في متغيرات البيئة");
if (!MONGODB_URI) throw new Error("MONGODB_URI مطلوب في متغيرات البيئة");
if (!ADMIN_ID || isNaN(ADMIN_ID)) throw new Error("ADMIN_ID مطلوب في متغيرات البيئة");
if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length !== 64) {
  throw new Error("يجب توفير ENCRYPTION_KEY في متغيرات البيئة بطول 64 حرفاً ورقمًا بالضبط (Hex).");
}

const IV_LENGTH = 16; 
const processingUsers = new Set();

// --- مخططات قاعدة البيانات ---
const userSchema = new mongoose.Schema({
  telegramId: { type: Number, required: true, unique: true },
  username: String,
  firstName: String,
  balance: { type: Number, default: 0, min: 0 }, 
  referralCode: { type: String, unique: true },
  referredBy: { type: Number, default: null },
  referralCount: { type: Number, default: 0 },
  state: { type: String, default: null },
  stateMeta: { type: mongoose.Schema.Types.Mixed, default: null },
  banned: { type: Boolean, default: false },
  twoFASecret: { type: String, default: null },
  twoFAEnabled: { type: Boolean, default: false }
}, { timestamps: true });

const accountSchema = new mongoose.Schema({
  firstName: { type: String, required: true },
  lastName: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true }, 
  birthDate: { type: String, required: true },
  assigned: { type: Boolean, default: false },
  assignedTo: { type: Number, default: null },
  assignedAt: { type: Date, default: null },
  isWasted: { type: Boolean, default: false }
}, { timestamps: true });

const taskSchema = new mongoose.Schema({
  userId: { type: Number, required: true },
  amount: { type: Number, required: true },
  accountEmail: { type: String, required: true },
  accountId: { type: mongoose.Schema.Types.ObjectId, ref: "Account" },
  backupCodes: { type: String, default: "" }, 
  status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },
  submittedAt: { type: Date, default: Date.now },
}, { timestamps: true });

const withdrawSchema = new mongoose.Schema({
  userId: { type: Number, required: true },
  amount: { type: Number, required: true },
  fee: { type: Number, default: 0 },
  totalDeduction: { type: Number, required: true },
  address: { type: String, required: true },
  network: { type: String, default: "USDT-BEP20" },
  status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },
}, { timestamps: true });

const User = mongoose.model("User", userSchema);
const Account = mongoose.model("Account", accountSchema);
const Task = mongoose.model("Task", taskSchema);
const Withdrawal = mongoose.model("Withdrawal", withdrawSchema);

const FIRST_NAMES = ["James", "John", "Robert", "Michael", "William", "David", "Richard", "Joseph", "Thomas", "Charles"];
const LAST_NAMES = ["Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Rodriguez", "Martinez"];
function getRandomItem(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// --- وظائف التشفير والأمان ---
function encrypt(text) {
  if (!text) return "";
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv("aes-256-cbc", Buffer.from(ENCRYPTION_KEY, "hex"), iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  return iv.toString("hex") + ":" + encrypted;
}

// فك التشفير
function decrypt(text) {
  if (!text) return "";
  try {
    const textParts = text.split(":");
    const iv = Buffer.from(textParts.shift(), "hex");
    const encryptedText = Buffer.from(textParts.join(":"), "hex");
    const decipher = crypto.createDecipheriv("aes-256-cbc", Buffer.from(ENCRYPTION_KEY, "hex"), iv);
    let decrypted = decipher.update(encryptedText, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch (err) {
    console.error("فشل فك التشفير:", err.message);
    return "خطأ في فك تشفير البيانات";
  }
}

function escapeHtml(text) {
  if (!text) return "";
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function genReferralCode(id) { return "REF" + id.toString(36).toUpperCase(); }

async function getOrCreateUser(msg) {
  const { id, first_name, username } = msg.from;
  let user = await User.findOne({ telegramId: id });
  if (!user) {
    user = await User.create({
      telegramId: id,
      firstName: first_name || "مستخدم",
      username: username || null,
      referralCode: genReferralCode(id),
    });
  } else {
    user.firstName = first_name || user.firstName;
    user.username = username || user.username;
    await user.save();
  }
  return user;
}

function fmt(n) { return Number(n).toFixed(2); }

async function cleanupStaleSessions() {
  try {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const stuckUsers = await User.find({ state: "awaiting_confirmation", updatedAt: { $lte: twoHoursAgo } });
    for (const user of stuckUsers) {
      const accountId = user.stateMeta?.accountId;
      if (accountId) await Account.findByIdAndUpdate(accountId, { assigned: false, assignedTo: null, assignedAt: null });
      user.state = null; user.stateMeta = null;
      await user.save();
    }
  } catch (err) {
    console.error("خطأ أثناء تنظيف الجلسات المعلقة:", err);
  }
}

// دالة فحص الوجود الفعلي للإيميل
async function verifyEmail(email) {
  try {
    const emailRegex = /^[a-z0-9_](\.?[a-z0-9_]){4,29}@gmail\.com$/i;
    if (!emailRegex.test(email)) {
      return { valid: false, reason: "صيغة البريد الإلكتروني غير صالحة" };
    }
    
    const existingTask = await Task.findOne({ accountEmail: email, status: { $in: ["pending", "approved"] } });
    if (existingTask) return { valid: false, reason: "هذا الإيميل مستخدم بالفعل في النظام" };

    const exists = await emailCheck(email);
    if (!exists) {
      return { valid: false, reason: "لم يتم إنشاء هذا الإيميل فعلياً على جوجل! يرجى إنشاؤه أولاً كما هو مطلوب." };
    }

    return { valid: true, reason: "صيغة وجودة الإيميل سليمة وجاهز للتأمين." };
  } catch (err) {
    console.error("فحص SMTP مهمل أو مقيد حالياً:", err.message);
    return { valid: true, reason: "مرور للمراجعة اليدوية" };
  }
}

setInterval(cleanupStaleSessions, 30 * 60 * 1000);

// --- القوائم الثابتة للمتصفح والمستخدمين ---
const MAIN_MENU = { reply_markup: { keyboard: [["➕ أنشئ حساب Gmail جديد", "📋 حساباتي"], ["💰 الرصيد", "👥 الإحالات الخاصة بي"], ["⚙️ الإعدادات", "💬 مساعدة"]], resize_keyboard: true } };
const CONFIRM_MENU = { reply_markup: { keyboard: [["✅ تم التفعيل والإنشاء"], ["❌ إلغاء إنشاء الحساب"], ["🔙 رجوع"]], resize_keyboard: true } };
const CANCEL_MENU = { reply_markup: { keyboard: [["❌ إلغاء العملية"]], resize_keyboard: true } };
const BALANCE_MENU = { reply_markup: { keyboard: [["📝 سجل الرصيد", "💳 سحب"], ["🔙 رجوع"]], resize_keyboard: true } };
const SETTINGS_MENU = { reply_markup: { keyboard: [["🔐 إعدادات التحقق بخطوتين للبوت"], ["🔙 رجوع"]], resize_keyboard: true } };
const NETWORK_MENU = { reply_markup: { keyboard: [["💎 Tether (USDT-BEP-20) | 0% +0.03$ | min: 0.20$"], ["🔙 رجوع"]], resize_keyboard: true } };

const ADMIN_MENU = {
  reply_markup: {
    keyboard: [
      ["📊 الإحصائيات العامة", "📬 مراجعة الحسابات المعلقة"],
      ["💸 طلبات السحب المنتظرة", "➕ توليد حسابات للمستودع"],
      ["🚫 حظر / إلغاء حظر مستخدم", "💰 شحن رصيد مستخدم يدوياً"],
      ["🗑️ تفريغ المستودع بالكامل", "🔙 خروج من الإدارة"]
    ],
    resize_keyboard: true
  }
};

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

async function sendPendingTasksToAdmin(chatId) {
  try {
    const pendingTasks = await Task.find({ status: "pending" });
    if (!pendingTasks.length) { bot.sendMessage(chatId, "🎉 لا توجد طلبات معلقة حالياً لحسابات Gmail.").catch(() => {}); return; }
    for (const task of pendingTasks) {
      const account = await Account.findById(task.accountId);
      const plainPassword = account ? decrypt(account.password) : "غير متوفر";
      const decryptedCodes = decrypt(task.backupCodes);

      await bot.sendMessage(chatId, 
        `📬 <b>طلب مراجعة حساب Gmail</b>\n\n` +
        `👤 من المستخدم: <code>${task.userId}</code>\n` +
        `📧 البريد: <code>${escapeHtml(task.accountEmail)}</code>\n` +
        `🔑 الباسورد: <code>${escapeHtml(plainPassword)}</code>\n\n` +
        `🚨 <b>رمز النسخ الاحتياطي المرسل (2FA):</b>\n<code>${escapeHtml(decryptedCodes)}</code>`, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "✅ قبول وضخ رصيد", callback_data: `app_task_${task._id}` }, { text: "❌ رفض الطلب نهائياً", callback_data: `rej_task_${task._id}` }]] }
      }).catch((e) => console.error(e.message));
    }
  } catch (err) {
    console.error(err);
  }
}

async function sendStatsToAdmin(chatId) {
  const totalUsers = await User.countDocuments();
  const totalTasks = await Task.countDocuments({ status: "approved" });
  const pendingTasks = await Task.countDocuments({ status: "pending" });
  const totalStock = await Account.countDocuments({ assigned: false, isWasted: false });
  const pendingWithdraws = await Withdrawal.countDocuments({ status: "pending" });

  bot.sendMessage(chatId, 
    `📊 <b>إحصائيات النظام السريعة والشاملة:</b>\n\n` +
    `👥 إجمالي المستخدمين بالبوت: <b>${totalUsers}</b>\n` +
    `📦 الحسابات الجاهزة بالمستودع للعمل: <b>${totalStock}</b>\n` +
    `✅ إجمالي الحسابات المقبولة (المباعة): <b>${totalTasks}</b>\n` +
    `⏳ حسابات قيد المراجعة حالياً: <b>${pendingTasks}</b>\n` +
    `💸 طلبات سحب معلقة تنتظر التحويل: <b>${pendingWithdraws}</b>`,
    { parse_mode: "HTML", ...ADMIN_MENU }
  ).catch(() => {});
}

// القائمة الترحيبية بعد تعديل الشروط (حذف بريد الاستعادة)
bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  try {
    const user = await getOrCreateUser(msg);
    const refCode = match && match[1] ? match[1].trim() : null;
    
    if (user.state) {
      const accountId = user.stateMeta?.accountId;
      if (accountId) await Account.findByIdAndUpdate(accountId, { assigned: false, assignedTo: null, assignedAt: null });
      user.state = null; user.stateMeta = null;
    }
    await user.save();
    
    if (refCode && !user.referredBy) {
      const referrer = await User.findOne({ referralCode: refCode });
      if (referrer && referrer.telegramId !== user.telegramId) {
        user.referredBy = referrer.telegramId; await user.save();
        referrer.referralCount += 1; await referrer.save();
        bot.sendMessage(referrer.telegramId, `🎉 انضم مستخدم جديد عبر رابط إحالتك!`).catch(() => {});
      }
    }
    bot.sendMessage(msg.chat.id,
      `👋 <b>أهلاً ${escapeHtml(user.firstName)}!</b>\n\n` +
      `💰 <b>اكسب من إنشاء حسابات Gmail الآمنة!</b>\n\n` +
      `📌 <b>شروط قبول الحسابات الجديدة الإلزامية:</b>\n` +
      `1️⃣ إنشاء الحساب بالبيانات المعطاة لك.\n` +
      `2️⃣ تفعيل التحقق بخطوتين (2FA) لـ Google **وإرسال أحد الرموز الاحتياطية المكون من 8 أرقام.**\n\n` +
      `💵 السعر لكل حساب مطابق للشروط: <b>$0.15</b>`,
      { parse_mode: "HTML", ...MAIN_MENU }
    ).catch(() => {});
  } catch (err) {
    console.error(err);
  }
});

bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  if (processingUsers.has(userId)) return;
  processingUsers.add(userId);
  
  const safetyTimeout = setTimeout(() => processingUsers.delete(userId), 15000);
  
  try {
    const user = await getOrCreateUser(msg);
    if (user.banned && userId !== ADMIN_ID) { bot.sendMessage(chatId, "🚫 تم حظرك من استخدام البوت.").catch(() => {}); return; }
    const text = msg.text;

    // --- معالجة شاشات وأوامر الأدمن الحصرية ---
    if (userId === ADMIN_ID) {
      if (text === "📊 الإحصائيات العامة") { await sendStatsToAdmin(chatId); return; }
      if (text === "📬 مراجعة الحسابات المعلقة") { await sendPendingTasksToAdmin(chatId); return; }
      
      if (text === "💸 طلبات السحب المنتظرة") {
        const pendingWithdraws = await Withdrawal.find({ status: "pending" });
        if (!pendingWithdraws.length) { 
          bot.sendMessage(chatId, "🎉 لا توجد طلبات سحب معلقة حالياً.", ADMIN_MENU).catch(() => {}); 
        } else {
          for (const w of pendingWithdraws) {
            bot.sendMessage(chatId, `💸 <b>طلب سحب معلق:</b>\n\n👤 المستخدم آيدي: <code>${w.userId}</code>\n🌐 الشبكة: <b>${w.network}</b>\n💵 الصافي: $${fmt(w.amount)}\n📮 العنوان: <code>${escapeHtml(w.address)}</code>`, {
              parse_mode: "HTML",
              reply_markup: { inline_keyboard: [[{ text: "✅ تأكيد التحويل", callback_data: `app_with_${w._id}` }, { text: "❌ رفض وإعادة رصيد", callback_data: `rej_with_${w._id}` }]] }
            }).catch(() => {});
          }
        }
        return;
      }

      if (text === "➕ توليد حسابات للمستودع") {
        user.state = "admin_awaiting_generate_count"; await user.save();
        bot.sendMessage(chatId, "🔢 أرسل عدد الحسابات المراد توليدها تلقائياً للمستودع (مثال: 50):", { reply_markup: { keyboard: [["❌ إلغاء العملية"]], resize_keyboard: true } }).catch(() => {});
        return;
      }

      if (text === "🚫 حظر / إلغاء حظر مستخدم") {
        user.state = "admin_awaiting_ban_id"; await user.save();
        bot.sendMessage(chatId, "🆔 أرسل الـ Telegram ID الخاص بالمستخدم المراد تعديل حالته وحظره/إلغاء حظره:", { reply_markup: { keyboard: [["❌ إلغاء العملية"]], resize_keyboard: true } }).catch(() => {});
        return;
      }

      if (text === "💰 شحن رصيد مستخدم يدوياً") {
        user.state = "admin_awaiting_charge_id"; await user.save();
        bot.sendMessage(chatId, "👤 أرسل الـ Telegram ID للمستخدم المراد شحن حسابه:", { reply_markup: { keyboard: [["❌ إلغاء العملية"]], resize_keyboard: true } }).catch(() => {});
        return;
      }

      if (text === "🗑️ تفريغ المستودع بالكامل") {
        const result = await Account.deleteMany({});
        bot.sendMessage(chatId, `🗑️ تم مسح وتفريغ المستودع بالكامل لحساباتك بنجاح!\n✨ عدد المحذوفات: <b>${result.deletedCount}</b> حساب تم تصفيره.`, { parse_mode: "HTML", ...ADMIN_MENU }).catch(() => {});
        return;
      }

      if (text === "🔙 خروج من الإدارة") { 
        user.state = null; user.stateMeta = null; await user.save();
        bot.sendMessage(chatId, "👋 تم الخروج من لوحة التحكم والعودة للقائمة العامة للمستخدمين.", MAIN_MENU).catch(() => {}); 
        return; 
      }

      if (user.state === "admin_awaiting_generate_count") {
        if (text === "❌ إلغاء العملية") { user.state = null; await user.save(); bot.sendMessage(chatId, "🛑 تم إلغاء العملية.", ADMIN_MENU).catch(() => {}); return; }
        const count = parseInt(text.trim(), 10);
        if (isNaN(count) || count <= 0) { bot.sendMessage(chatId, "❌ رقم غير صالح، أرسل عدداً صحيحاً:").catch(() => {}); return; }
        user.state = null; await user.save();
        bot.sendMessage(chatId, `⚙️ جاري بدء توليد ${count} حساب بشكل مؤتمت...`).catch(() => {});
        let success = 0;
        for (let i = 0; i < count; i++) {
          try {
            const fn = getRandomItem(FIRST_NAMES); const ln = getRandomItem(LAST_NAMES);
            const uniqueSuffix = crypto.randomBytes(3).toString("hex");
            const email = `${fn.toLowerCase()}${ln.toLowerCase()}_${uniqueSuffix}@gmail.com`;
            const plainPassword = "Pass_" + crypto.randomBytes(4).toString("hex");
            await Account.create({ firstName: fn, lastName: ln, email, password: encrypt(plainPassword), birthDate: "1998-05-12" });
            success++;
          } catch {}
        }
        bot.sendMessage(chatId, `✅ انتهاء التوليد التلقائي للفرادة والأسماء! النجاح الفعلي: <b>${success}</b> حساب تم ضخه للمستودع.`, { parse_mode: "HTML", ...ADMIN_MENU }).catch(() => {});
        return;
      }

      if (user.state === "admin_awaiting_ban_id") {
        if (text === "❌ إلغاء العملية") { user.state = null; await user.save(); bot.sendMessage(chatId, "🛑 تم إلغاء العملية.", ADMIN_MENU).catch(() => {}); return; }
        const targetId = parseInt(text.trim(), 10);
        if (isNaN(targetId)) { bot.sendMessage(chatId, "❌ معرف غير صحيح.").catch(() => {}); return; }
        const targetUser = await User.findOne({ telegramId: targetId });
        if (!targetUser) { bot.sendMessage(chatId, "❌ هذا المستخدم غير مسجل بالبوت أساساً.", ADMIN_MENU).catch(() => {}); user.state = null; await user.save(); return; }
        targetUser.banned = !targetUser.banned;
        await targetUser.save();
        user.state = null; await user.save();
        bot.sendMessage(chatId, `⚙️ تم تغيير حالة المستخدم بنجاح! وضع الحظر الحالي للحساب هو: <b>${targetUser.banned ? "🚫 محظور حالياً" : "🟢 نشط وسليم"}</b>`, { parse_mode: "HTML", ...ADMIN_MENU }).catch(() => {});
        return;
      }

      if (user.state === "admin_awaiting_charge_id") {
        if (text === "❌ إلغاء العملية") { user.state = null; await user.save(); bot.sendMessage(chatId, "🛑 تم إلغاء العملية.", ADMIN_MENU).catch(() => {}); return; }
        const targetId = parseInt(text.trim(), 10);
        if (isNaN(targetId)) { bot.sendMessage(chatId, "❌ معرف غير صحيح.").catch(() => {}); return; }
        user.state = "admin_awaiting_charge_amount"; user.stateMeta = { targetId }; await user.save();
        bot.sendMessage(chatId, `💵 أرسل الآن القيمة الرقمية المراد إضافتها لرصيد حساب المستخدم <code>${targetId}</code> (مثال: 1.50):`, { parse_mode: "HTML", reply_markup: { keyboard: [["❌ إلغاء العملية"]], resize_keyboard: true } }).catch(() => {});
        return;
      }

      if (user.state === "admin_awaiting_charge_amount") {
        if (text === "❌ إلغاء العملية") { user.state = null; user.stateMeta = null; await user.save(); bot.sendMessage(chatId, "🛑 تم إلغاء العملية.", ADMIN_MENU).catch(() => {}); return; }
        const amount = parseFloat(text.trim());
        if (isNaN(amount) || amount <= 0) { bot.sendMessage(chatId, "❌ القيمة غير صالحة، أرسل رقماً صحيحاً:").catch(() => {}); return; }
        const targetId = user.stateMeta?.targetId;
        const targetUser = await User.findOneAndUpdate({ telegramId: targetId }, { $inc: { balance: amount } }, { new: true });
        user.state = null; user.stateMeta = null; await user.save();
        if (!targetUser) { bot.sendMessage(chatId, "❌ فشل الشحن، الحساب غير موجود.", ADMIN_MENU).catch(() => {}); return; }
        bot.sendMessage(chatId, `✅ تم بنجاح شحن الحساب وإضافة القيمة! رصيد المستخدم الجديد الحالي هو: $${fmt(targetUser.balance)}`, ADMIN_MENU).catch(() => {});
        bot.sendMessage(targetId, `💰 <b>تنبيه من الإدارة:</b> تم شحن وإضافة $${fmt(amount)} يدوياً إلى حسابك بنجاح من قبل المسؤول!`).catch(() => {});
        return;
      }
    }

    // --- منطق ومعالجة شاشات وحالات المستخدمين ---
    if (user.state === "awaiting_2fa_verification") {
      if (text === "❌ إلغاء العملية") {
        user.state = null; user.stateMeta = null; await user.save();
        bot.sendMessage(chatId, "❌ تم إلغاء الإعداد.", MAIN_MENU).catch(() => {}); return;
      }
      const code = text.trim();
      const encryptedSecret = user.stateMeta?.tempSecret;
      const tempSecret = decrypt(encryptedSecret); 
      
      if (authenticator.check(code, tempSecret)) {
        user.twoFASecret = encryptedSecret; 
        user.twoFAEnabled = true; user.state = null; user.stateMeta = null; await user.save();
        bot.sendMessage(chatId, "🔒 <b>تم تفعيل التحقق بخطوتين لحسابك بالبوت بنجاح!</b>", MAIN_MENU).catch(() => {});
      } else {
        bot.sendMessage(chatId, "❌ الكود غير صحيح أو انتهت صلاحيته.", CANCEL_MENU).catch(() => {});
      }
      return;
    }

    if (user.state === "awaiting_2fa_for_withdraw") {
      if (text === "🔙 رجوع") {
        user.state = null; user.stateMeta = null; await user.save();
        bot.sendMessage(chatId, "👋 تم إلغاء العملية والعودة.", MAIN_MENU).catch(() => {}); return;
      }
      const plainSecret = decrypt(user.twoFASecret);
      if (authenticator.check(text.trim(), plainSecret)) {
        user.state = "awaiting_withdraw_network"; await user.save();
        bot.sendMessage(chatId, `🔓 <b>تم التحقق!</b> اختر شبكة السحب:`, NETWORK_MENU).catch(() => {});
      } else {
        bot.sendMessage(chatId, "❌ كود الأمان غير صحيح. يرجى إعادة المحاولة:", { reply_markup: { keyboard: [["🔙 رجوع"]], resize_keyboard: true } }).catch(() => {});
      }
      return;
    }

    // شاشة استلام الكود والتعليمات (خالية تماماً من بريد الاستعادة)
    if (user.state === "awaiting_gmail_backup_codes") {
      if (text === "❌ إلغاء إنشاء الحساب" || text === "🔙 رجوع") {
        const accountId = user.stateMeta?.accountId;
        if (accountId) await Account.findByIdAndUpdate(accountId, { assigned: false, assignedTo: null });
        user.state = null; user.stateMeta = null; await user.save();
        bot.sendMessage(chatId, "👋 تم إلغاء العملية والعودة للقائمة الرئيسية.", MAIN_MENU).catch(() => {}); return;
      }

      if (text === "❓ كيفية التفعيل") {
        bot.sendMessage(chatId, 
          `📱 <b>طريقة استخراج كود 2FA لـ Gmail:</b>\n\n` +
          `1️⃣ افتح حساب Gmail الجديد الخاص بك.\n` +
          `2️⃣ اذهب لإعدادات الحساب ➡️ <b>الأمان (Security)</b>.\n` +
          `3️⃣ قم بتفعيل <b>التحقق بخطوتين (2-Step Verification)</b> برقم هاتفك.\n` +
          `4️⃣ بعد انتهاء التفعيل، انقر على خيار <b>الرموز الاحتياطية (Backup Codes)</b>.\n` +
          `5️⃣ قم بإنشاء الرموز، وانسخ **رمزًا واحدًا فقط مكونًا من 8 أرقام** وأرسله هنا لتأكيد المراجعة.`,
          { 
            parse_mode: "HTML",
            reply_markup: { 
              keyboard: [
                ["❓ كيفية التفعيل"],
                ["🔙 رجوع", "❌ إلغاء إنشاء الحساب"]
              ], 
              resize_keyboard: true 
            } 
          }
        ).catch(() => {});
        return;
      }
      
      const backupCodes = text.trim().replace(/\s/g, ""); 
      
      if (!/^\d{8}$/.test(backupCodes)) {
        bot.sendMessage(chatId, "⚠️ خطأ! يرجى إرسال **أحد الرموز الاحتياطية المكون من 8 أرقام فقط** بدون حروف أو رموز أخرى لتتم مراجعة حسابك بنجاح:", { 
          reply_markup: { 
            keyboard: [
              ["❓ كيفية التفعيل"],
              ["🔙 رجوع", "❌ إلغاء إنشاء الحساب"]
            ], 
            resize_keyboard: true 
          } 
        }).catch(() => {});
        return;
      }
      
      const accountId = user.stateMeta?.accountId;
      const account = await Account.findById(accountId);
      if (!account) {
        user.state = null; user.stateMeta = null; await user.save();
        bot.sendMessage(chatId, "❌ حدث خطأ، الحساب لم يعد متوفراً.", MAIN_MENU).catch(() => {}); return;
      }
      
      user.state = null; user.stateMeta = null; await user.save();
      
      const task = await Task.create({
        userId: user.telegramId,
        amount: 0.15,
        accountEmail: account.email,
        accountId: account._id,
        backupCodes: encrypt(backupCodes), 
        submittedAt: new Date()
      });
      
      bot.sendMessage(chatId, `✅ <b>تم استلام الرمز بنجاح وإرسال الحساب للمراجعة الإدارية والمالية!</b>`, MAIN_MENU).catch(() => {});
      bot.sendMessage(ADMIN_ID,
        `📬 <b>طلب مراجعة حساب Gmail جديد (محمي بـ 2FA)</b>\n\n` +
        `👤 المستخدم: ${escapeHtml(user.firstName)} (<code>${user.telegramId}</code>)\n` +
        `📧 البريد: <code>${escapeHtml(account.email)}</code>\n` +
        `🔑 الباسورد: <code>${escapeHtml(decrypt(account.password))}</code>\n\n` + 
        `🚨 <b>رمز النسخ الاحتياطي (8 أرقام):</b>\n<code>${escapeHtml(backupCodes)}</code>`,
        {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [[{ text: "✅ قبول وضخ رصيد", callback_data: `app_task_${task._id}` }, { text: "❌ رفض الطلب نهائياً", callback_data: `rej_task_${task._id}` }]] }
        }
      ).catch(() => {});
      return;
    }

    if (text === "➕ أنشئ حساب Gmail جديد") {
      const pendingTasks = await Task.find({ userId: user.telegramId, status: "pending" });
      if (pendingTasks.length >= 2) {
        bot.sendMessage(chatId, `⚠️ لا يمكنك إنشاء حساب جديد حتى تنتهي مراجعة حساباتك المعلقة أولاً لحماية المخزون.`).catch(() => {}); return;
      }

      const updatedUser = await User.findOneAndUpdate(
        { telegramId: user.telegramId, state: null },
        { $set: { state: "awaiting_confirmation" } },
        { new: true }
      );

      if (!updatedUser) {
        bot.sendMessage(chatId, `⚠️ لديك عملية معلقة بالفعل حالياً.`, CONFIRM_MENU).catch(() => {}); return;
      }

      const account = await Account.findOneAndUpdate(
        { assigned: false, isWasted: false }, 
        { assigned: true, assignedTo: user.telegramId, assignedAt: new Date() }, 
        { new: true }
      );

      if (!account) { 
        await User.findOneAndUpdate({ telegramId: user.telegramId }, { $set: { state: null } });
        bot.sendMessage(chatId, `❌ لا توجد حسابات متاحة بالمستودع حالياً. فضلاً أبلغ الإدارة لتوليد وضخ دفعة جديدة.`, MAIN_MENU).catch(() => {}); return; 
      }
      
      const sentMsg = await bot.sendMessage(chatId,
        `📧 <b>بيانات الحساب المطلوب إنشاؤه:</b>\n\n` +
        `👤 الاسم الأول: <code>${escapeHtml(account.firstName)}</code>\n` +
        `👥 اسم العائلة: <code>${escapeHtml(account.lastName)}</code>\n` +
        `📅 تاريخ الميلاد: <code>${escapeHtml(account.birthDate)}</code>\n` +
        `📧 البريد الإلكتروني: <code>${escapeHtml(account.email)}</code>\n` +
        `🔑 كلمة المرور السحرية: <code>${escapeHtml(decrypt(account.password))}</code>`,
        { parse_mode: "HTML", ...CONFIRM_MENU }
      ).catch(() => {});

      updatedUser.stateMeta = { accountId: account._id.toString(), dataMessageId: sentMsg.message_id };
      await updatedUser.save();
      return;
    }

    if (user.state === "awaiting_confirmation") {
      if (text === "🔙 رجوع" || text === "❌ إلغاء إنشاء الحساب") {
        const accountId = user.stateMeta?.accountId;
        const msgToDelete = user.stateMeta?.dataMessageId;
        
        if (msgToDelete) { bot.deleteMessage(chatId, msgToDelete).catch(() => {}); }
        if (accountId) await Account.findByIdAndUpdate(accountId, { assigned: false, assignedTo: null });
        
        user.state = null; user.stateMeta = null; await user.save();
        bot.sendMessage(chatId, "👋 تم إلغاء العملية بنجاح والعودة للقائمة الرئيسية.", MAIN_MENU).catch(() => {});
        return;
      }

      // رسالة الخطوات والتنبيه بعد حذف بريد الاستعادة
      if (text === "✅ تم التفعيل والإنشاء") {
        const accountId = user.stateMeta?.accountId;
        const msgToDelete = user.stateMeta?.dataMessageId;
        const account = await Account.findById(accountId);
        
        bot.sendMessage(chatId, `🔍 <b>جاري فحص صيغة الحساب والتحقق الأولي التلقائي من وجوده...</b>`, { parse_mode: "HTML" }).catch(() => {});
        
        const verification = await verifyEmail(account.email);
        
        if (!verification.valid) {
          if (msgToDelete) { bot.deleteMessage(chatId, msgToDelete).catch(() => {}); }
          await Account.findByIdAndUpdate(accountId, { assigned: false, assignedTo: null });
          user.state = null; user.stateMeta = null; await user.save();
          bot.sendMessage(chatId, `❌ <b>فشل الفحص:</b> ${escapeHtml(verification.reason)}`, MAIN_MENU).catch(() => {}); return;
        }
        
        if (msgToDelete) { bot.deleteMessage(chatId, msgToDelete).catch(() => {}); }

        user.state = "awaiting_gmail_backup_codes";
        await user.save();

        bot.sendMessage(chatId, 
          `✅ <b>تم فحص صيغة وجودة الحساب بنجاح!</b>\n\n` +
          `⚠️ <b>الخطوات التالية الإلزامية لاستحقاق الدفع وتأمين الحساب:</b>\n\n` +
          `1️⃣ توجه الآن فوراً إلى إعدادات حساب جوجل هذا، وقم بتفعيل ميزة <b>(التحقق بخطوتين - 2FA)</b>.\n` +
          `2️⃣ استخرج <b>أحد الرموز الاحتياطية المكون من 8 أرقام (Backup Codes)</b> وأرسله هنا في الشات.\n` +
          `3️⃣ 🚨 <b>تنبيه هام جداً:</b> يرجى <b>حذف تسجيل دخول الحساب من هاتفك أو متصفحك بالكامل فوراً</b> بعد إرسال الكود ليدخل الحساب في مرحلة المراجعة الرسمية بأمان.\n\n` +
          `🛑 <i>بدون إرسال الرمز الاحتياطي، أو في حال اكتشاف استمرار فتح الحساب على جهازك أثناء الفحص، فلن تتمكن الإدارة من قبول حسابك أو دفع الـ $0.15 لك.</i>\n\n` +
          `💡 <i>إذا لم تكن تعرف طريقة التفعيل، اضغط على زر "❓ كيفية التفعيل" بالأسفل لمعرفة الخطوات بالتفصيل.</i>`, 
          { 
            parse_mode: "HTML", 
            reply_markup: { 
              keyboard: [
                ["❓ كيفية التفعيل"],
                ["🔙 رجوع", "❌ إلغاء إنشاء الحساب"]
              ], 
              resize_keyboard: true 
            } 
          }
        ).catch(() => {});
        return;
      }
    }

    if (text === "📋 حساباتي") {
      const tasks = await Task.find({ userId: user.telegramId }).sort({ createdAt: -1 }).limit(10);
      if (!tasks.length) { bot.sendMessage(chatId, `📋 لا توجد حسابات مسجلة باسمك في النظام حتى الآن.`, MAIN_MENU).catch(() => {}); return; }
      let txt = `📋 <b>حساباتك الأخيرة المرسلة (آخر 10):</b>\n\n`;
      for (const t of tasks) {
        const emoji = t.status === "approved" ? "✅" : t.status === "rejected" ? "❌" : "⏳";
        txt += `${emoji} <code>${escapeHtml(t.accountEmail)}</code> — $${fmt(t.amount)}\n`;
      }
      bot.sendMessage(chatId, txt, { parse_mode: "HTML", ...MAIN_MENU }).catch(() => {}); return;
    }

    if (text === "💰 الرصيد") {
      const approved = await Task.countDocuments({ userId: user.telegramId, status: "approved" });
      bot.sendMessage(chatId, `💵 <b>الرصيد الحالي القابل للسحب الفوري:</b> $${fmt(user.balance)} USDT\n✅ إجمالي الحسابات المقبولة والناجحة: ${approved}`, { parse_mode: "HTML", ...BALANCE_MENU }).catch(() => {}); return;
    }

    if (text === "📝 سجل الرصيد") {
      const withdrawals = await Withdrawal.find({ userId: user.telegramId }).sort({ createdAt: -1 }).limit(10);
      if (!withdrawals.length) { bot.sendMessage(chatId, "📝 لا توجد عمليات سحب مسجلة لحسابك حالياً.", BALANCE_MENU).catch(() => {}); return; }
      let txt = `📝 <b>سجل طلبات السحب والمحفظة الخاصة بك:</b>\n\n`;
      for (const w of withdrawals) {
        const emoji = w.status === "approved" ? "✅" : w.status === "rejected" ? "❌" : "⏳";
        txt += `${emoji} مبلغ: $${fmt(w.amount)} — شبكة السحب: <code>${w.network}</code>\n`;
      }
      bot.sendMessage(chatId, txt, { parse_mode: "HTML", ...BALANCE_MENU }).catch(() => {}); return;
    }

    if (text === "👥 الإحالات الخاصة بي") {
      const refLink = `https://t.me/${(await bot.getMe()).username}?start=${user.referralCode}`;
      bot.sendMessage(chatId, 
        `👥 <b>نظام الإحالات وشبكة الدعوة الخاصة بك</b>\n\n` +
        `📈 عدد الإحالات النشطة والمسجلة عبرك: <b>${user.referralCount}</b> مستخدم\n` +
        `🔗 رابط الإحالة الفريد والخاص بك لدعوة أصدقائك:\n<code>${refLink}</code>`, 
        { parse_mode: "HTML", ...MAIN_MENU }
      ).catch(() => {});
      return;
    }

    if (text === "💳 سحب") {
      if (user.twoFAEnabled) {
        user.state = "awaiting_2fa_for_withdraw"; await user.save();
        bot.sendMessage(chatId, "🔐 يرجى إدخل رمز الـ 2FA الخاص بحسابك لتأكيد السحب وحماية أمان محفظتك:", { reply_markup: { keyboard: [["🔙 رجوع"]], resize_keyboard: true } }).catch(() => {});
        return;
      }
      user.state = "awaiting_withdraw_network"; await user.save();
      bot.sendMessage(chatId, `💰 رصيدك المتاح الحالي هو: $${fmt(user.balance)} USDT\nاختر شبكة السحب المناسبة لك:`, NETWORK_MENU).catch(() => {}); return;
    }

    if (user.state === "awaiting_withdraw_network") {
      if (text === "🔙 رجوع") {
        user.state = null; user.stateMeta = null; await user.save();
        bot.sendMessage(chatId, "👋 تم العودة للقائمة السابقة.", MAIN_MENU).catch(() => {}); return;
      }
      if (text.includes("USDT-BEP-20")) {
        user.state = "awaiting_withdraw_amount_network"; user.stateMeta = { network: "USDT20", feeAmount: 0.03 }; await user.save();
        bot.sendMessage(chatId, "💸 أدخل قيمة المبلغ المراد سحبه رقمياً (الحد الأدنى 0.20):", { reply_markup: { keyboard: [["🔙 رجوع"]], resize_keyboard: true } }).catch(() => {});
      } else {
        user.state = null; await user.save(); bot.sendMessage(chatId, "👋 تم العودة للقائمة الرئيسية.", MAIN_MENU).catch(() => {});
      }
      return;
    }

    if (user.state === "awaiting_withdraw_amount_network") {
      if (text === "🔙 رجوع") {
        user.state = "awaiting_withdraw_network"; await user.save();
        bot.sendMessage(chatId, `اختر شبكة السحب من جديد:`, NETWORK_MENU).catch(() => {}); return;
      }
      const amount = parseFloat(text.trim());
      if (isNaN(amount) || amount < 0.20) { bot.sendMessage(chatId, "❌ قيمة خاطئة أو أقل من الحد الأدنى المقدر بـ 0.20$").catch(() => {}); return; }
      
      user.state = "awaiting_withdraw_address_network"; 
      user.stateMeta = { ...user.stateMeta, amount }; 
      await user.save();
      bot.sendMessage(chatId, "📮 أدخل عنوان محفظتك لشبكة BSC (BEP-20) بدقة:", { reply_markup: { keyboard: [["🔙 رجوع"]], resize_keyboard: true } }).catch(() => {}); 
      return;
    }

    if (user.state === "awaiting_withdraw_address_network") {
      if (text === "🔙 رجوع") {
        user.state = "awaiting_withdraw_amount_network"; await user.save();
        bot.sendMessage(chatId, "💸 أدخل قيمة المبلغ رقمياً من جديد (حد أدنى 0.20):", { reply_markup: { keyboard: [["🔙 رجوع"]], resize_keyboard: true } }).catch(() => {}); return;
      }
      const address = text.trim();
      const bep20Regex = /^0x[a-fA-F0-9]{40}$/;
      
      if (!bep20Regex.test(address)) {
        bot.sendMessage(chatId, "❌ العنوان غير صالح! أرسل عنوان محفظة صحيح ومعتمد لشبكة العقود الذكية يبدأ بـ 0x:").catch(() => {}); return;
      }

      const { network, feeAmount, amount } = user.stateMeta || {};
      const totalRequired = amount + feeAmount;

      const updatedUser = await User.findOneAndUpdate(
        { telegramId: user.telegramId, state: "awaiting_withdraw_address_network", balance: { $gte: totalRequired } },
        { $inc: { balance: -totalRequired }, $set: { state: null, stateMeta: null } },
        { new: true }
      );

      if (!updatedUser) {
        user.state = null; user.stateMeta = null; await user.save();
        bot.sendMessage(chatId, "❌ فشل تسجيل الطلب: رصيدك المتاح غير كافٍ لتغطية قيمة السحب بالإضافة إلى رسوم الشبكة السريعة.", MAIN_MENU).catch(() => {}); return;
      }

      await Withdrawal.create({ userId: user.telegramId, amount, fee: feeAmount, totalDeduction: totalRequired, address, network, status: "pending" });
      bot.sendMessage(chatId, `✅ تم تسجيل طلب سحبك بنجاح للقسم المالي وهو قيد المراجعة والتحويل الفوري!`, MAIN_MENU).catch(() => {});
      return;
    }

    if (text === "⚙️ الإعدادات") {
      bot.sendMessage(chatId, `⚙️ <b>إعدادات النظام والحساب بالبوت</b>\n\n🔒 تفعيل التحقق الثنائي الداخلي للبوت: <b>${user.twoFAEnabled ? "🟢 مفعل ويحمي سحوباتك" : "🔴 غير مفعل وعرضة للمخاطر"}</b>`, { parse_mode: "HTML", ...SETTINGS_MENU }).catch(() => {}); return;
    }

    if (text === "🔐 إعدادات التحقق بخطوتين للبوت") {
      if (user.twoFAEnabled) {
        user.twoFAEnabled = false; user.twoFASecret = null; await user.save();
        bot.sendMessage(chatId, "🔓 تم تعطيل التحقق بخطوتين لحساب البوت بأمان.", SETTINGS_MENU).catch(() => {}); return;
      }
      const secret = authenticator.generateSecret();
      const encryptedSecret = encrypt(secret); 
      
      user.state = "awaiting_2fa_verification"; 
      user.stateMeta = { tempSecret: encryptedSecret }; 
      await user.save();
      
      bot.sendMessage(chatId, `🔑 <b>مفتاح الأمان والسيكرت الخاص بك بالبوت:</b>\n<code>${secret}</code>\n\nقم بنسخ المفتاح وأضفه في تطبيق Google Authenticator then send the 6-digit code to verify:`, { parse_mode: "HTML", ...CANCEL_MENU }).catch(() => {}); return;
    }

    // رسالة المساعدة بعد حذف بريد الاستعادة
    if (text === "💬 مساعدة") {
      bot.sendMessage(chatId, 
        `💬 <b>دليل تفعيل التحقق بخطوتين (2FA) واستخراج الكود الاحتياطي للحسابات:</b>\n\n` +
        `1️⃣ افتح إعدادات حساب Google الذي أنشأته عبر البوت.\n` +
        `2️⃣ انتقل إلى علامة تبويب <b>الأمان (Security)</b>.\n` +
        `3️⃣ ابحث عن خيار <b>التحقق بخطوتين (2-Step Verification)</b> وقم بتفعيله برقم هاتفك.\n` +
        `4️⃣ بعد انتهاء التفعيل، انزل لأسفل نفس الصفحة وابحث عن خيار <b>الرموز الاحتياطية (Backup Codes)</b>.\n` +
        `5️⃣ اضغط على "الحصول على الرموز"، ثم قم بنسخ **رمز واحد فقط مكون من 8 أرقام** وأرسله للبوت ليتم تأكيد حسابك بنجاح وضخ رصيدك.\n\n` +
        `📞 <b>للدعم الفني المباشر والاستفسارات الأخرى:</b> @CX_GCP`, 
        { parse_mode: "HTML", disable_web_page_preview: false, ...MAIN_MENU }
      ).catch(() => {}); 
      return;
    }

    if (text === "🔙 رجوع") { 
      user.state = null; user.stateMeta = null; await user.save();
      bot.sendMessage(chatId, "👋 العودة الذكية للقائمة الرئيسية.", MAIN_MENU).catch(() => {}); return; 
    }

  } catch (err) {
    console.error("خطأ عام في البوت:", err);
    bot.sendMessage(chatId, "❌ حدث خطأ داخلي في النظام. الرجاء إعادة المحاولة.", MAIN_MENU).catch(() => {});
  } finally {
    clearTimeout(safetyTimeout);
    processingUsers.delete(userId);
  }
});

bot.onText(/\/admin/, async (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  bot.sendMessage(msg.chat.id, `⚙️ <b>مرحباً بك في لوحة تحكم الإدارة الشاملة</b>\n\nاختر أحد الأوامر والوظائف من القائمة أدناه لإدارة البوت بالكامل وبضغطة واحدة:`, ADMIN_MENU).catch(() => {});
});

bot.on("callback_query", async (query) => {
  if (query.from.id !== ADMIN_ID) return;
  const data = query.data;
  const msgId = query.message.message_id;
  const adminChatId = query.message.chat.id;

  try {
    if (data.startsWith("app_task_")) {
      const taskId = data.replace("app_task_", "");
      const task = await Task.findOne({ _id: taskId, status: "pending" });
      
      if (task) {
        if (!task.backupCodes || decrypt(task.backupCodes).trim().length < 7) {
          bot.sendMessage(adminChatId, `⚠️ <b>تنبيه أمني للأدمن:</b> لا يمكن قبول هذا الحساب لأن المستخدم لم يقم بتزويد البوت بالرمز الاحتياطي المطلوب!`, { parse_mode: "HTML" }).catch(() => {});
          return;
        }

        task.status = "approved";
        await task.save();
        
        await User.findOneAndUpdate({ telegramId: task.userId }, { $inc: { balance: task.amount } });
        bot.sendMessage(task.userId, `✅ تم قبول حسابك ومضاف لك $${task.amount}`).catch(() => {});
        bot.editMessageText(`✅ <b>تمت الموافقة بنجاح على الحساب وضخ الرصيد للمستخدم:</b>\n<code>${escapeHtml(task.accountEmail)}</code>`, { chat_id: adminChatId, message_id: msgId, parse_mode: "HTML" }).catch(() => {});
      }
    }

    if (data.startsWith("rej_task_")) {
      const taskId = data.replace("rej_task_", "");
      const task = await Task.findOneAndUpdate({ _id: taskId, status: "pending" }, { status: "rejected" });
      if (task && task.accountId) {
        await Account.findByIdAndUpdate(task.accountId, { assigned: true, isWasted: true });
        bot.sendMessage(task.userId, `❌ تم رفض حساب الـ Gmail الخاص بك من قبل المسؤول لأنه غير مطابق للتعليمات أو مسحوب الـ 2FA.`).catch(() => {});
        bot.editMessageText(`❌ <b>تم رفض هذا الحساب وإتلافه نهائياً من المستودع:</b>\n<code>${escapeHtml(task.accountEmail)}</code>`, { chat_id: adminChatId, message_id: msgId, parse_mode: "HTML" }).catch(() => {});
      }
    }

    if (data.startsWith("app_with_")) {
      const withId = data.replace("app_with_", "");
      const withdraw = await Withdrawal.findOneAndUpdate({ _id: withId, status: "pending" }, { status: "approved" });
      if (withdraw) {
        bot.sendMessage(withdraw.userId, `💸 <b>تمت الموافقة على طلب سحبك بنجاح! تم تحويل الرصيد المالي لمحفظتك المذكورة بنجاح.</b>`, { parse_mode: "HTML" }).catch(() => {});
        bot.editMessageText(`✅ <b>تمت الموافقة على التحويل وإرسال الرصيد:</b>\nالمبلغ الإجمالي: $${fmt(withdraw.amount)}`, { chat_id: adminChatId, message_id: msgId, parse_mode: "HTML" }).catch(() => {});
      }
    }

    if (data.startsWith("rej_with_")) {
      const withId = data.replace("rej_with_", "");
      const withdraw = await Withdrawal.findOneAndUpdate({ _id: withId, status: "pending" }, { status: "rejected" });
      if (withdraw) {
        await User.findOneAndUpdate({ telegramId: withdraw.userId }, { $inc: { balance: withdraw.totalDeduction } });
        bot.sendMessage(withdraw.userId, `❌ <b>تم رفض طلب السحب الخاص بك من قبل الإدارة المخصصة.</b> وأعيدت الأموال والرسوم إلى رصيدك الداخلي بالكامل لتعديل البيانات.`, { parse_mode: "HTML" }).catch(() => {});
        bot.editMessageText(`❌ <b>تم رفض السحب وإعادة الرصيد بالكامل للمستخدم:</b>\nالمعرف الفريد: <code>${withdraw.userId}</code>`, { chat_id: adminChatId, message_id: msgId, parse_mode: "HTML" }).catch(() => {});
      }
    }
  } catch (err) {
    console.error("خطأ في تنفيذ الـ callback بالتفاعلات البينية للأدمن:", err);
  } finally {
    bot.answerCallbackQuery(query.id, { text: "تمت المعالجة بنجاح" }).catch(() => {});
  }
});

mongoose.connect(MONGODB_URI)
  .then(() => console.log("MongoDB active and Dashboard ready completely"))
  .catch((err) => console.error(err));

http.createServer((req, res) => { res.end("Online Live Server ready"); }).listen(process.env.PORT || 8080);
