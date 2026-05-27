const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose");
const http = require("http");
const nodemailer = require("nodemailer");
const { authenticator } = require("otplib"); 
const crypto = require("crypto");

// --- إعدادات متغيرات البيئة ---
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_ID = parseInt(process.env.ADMIN_ID, 10);
const RECOVERY_EMAIL = process.env.RECOVERY_EMAIL || "ryal2422@gmail.com";
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD; 
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

if (!BOT_TOKEN) throw new Error("BOT_TOKEN مطلوب في متغيرات البيئة");
if (!MONGODB_URI) throw new Error("MONGODB_URI مطلوب في متغيرات البيئة");
if (!ADMIN_ID || isNaN(ADMIN_ID)) throw new Error("ADMIN_ID مطلوب في متغيرات البيئة");
if (!GMAIL_APP_PASSWORD) throw new Error("GMAIL_APP_PASSWORD مطلوب في متغيرات البيئة");
if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length !== 64) {
  throw new Error("يجب توفير ENCRYPTION_KEY في متغيرات البيئة بطول 64 حرفاً ورقمًا بالضبط (Hex).");
}

const IV_LENGTH = 16; 
const processingUsers = new Set();

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: { user: RECOVERY_EMAIL, pass: GMAIL_APP_PASSWORD }
});

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
  recoveryEmail: { type: String, default: RECOVERY_EMAIL },
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

// --- وظائف التشفير ---
function encrypt(text) {
  if (!text) return "";
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv("aes-256-cbc", Buffer.from(ENCRYPTION_KEY, "hex"), iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  return iv.toString("hex") + ":" + encrypted;
}

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

async function verifyEmail(email) {
  try {
    const emailRegex = /^[a-z0-9](\.?[a-z0-9]){4,29}@gmail\.com$/i;
    if (!emailRegex.test(email)) {
      return { valid: false, reason: "صيغة البريد الإلكتروني غير صالحة" };
    }
    const existingTask = await Task.findOne({ accountEmail: email, status: { $in: ["pending", "approved"] } });
    if (existingTask) return { valid: false, reason: "هذا الإيميل مستخدم بالفعل في النظام" };
    return { valid: true, reason: "صيغة الإيميل سليمة." };
  } catch (err) {
    return { valid: false, reason: "خطأ داخلي أثناء الفحص" };
  }
}

setInterval(cleanupStaleSessions, 30 * 60 * 1000);

// --- القوائم ---
const MAIN_MENU = { reply_markup: { keyboard: [["➕ أنشئ حساب Gmail جديد", "📋 حساباتي"], ["💰 الرصيد", "👥 الإحالات الخاصة بي"], ["⚙️ الإعدادات", "💬 مساعدة"]], resize_keyboard: true } };
const CONFIRM_MENU = { reply_markup: { keyboard: [["✅ تم التفعيل والإنشاء"], ["❌ إلغاء إنشاء الحساب"]], resize_keyboard: true } };
const CANCEL_MENU = { reply_markup: { keyboard: [["❌ إلغاء العملية"]], resize_keyboard: true } };
const BALANCE_MENU = { reply_markup: { keyboard: [["📝 سجل الرصيد", "💳 سحب"], ["🔙 رجوع"]], resize_keyboard: true } };
const SETTINGS_MENU = { reply_markup: { keyboard: [["🔐 إعدادات التحقق بخطوتين للبوت"], ["🔙 رجوع"]], resize_keyboard: true } };

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

async function sendPendingTasksToAdmin(chatId) {
  try {
    const pendingTasks = await Task.find({ status: "pending" });
    if (!pendingTasks.length) { bot.sendMessage(chatId, "🎉 لا توجد طلبات معلقة.").catch(() => {}); return; }
    for (const task of pendingTasks) {
      const account = await Account.findById(task.accountId);
      const plainPassword = account ? decrypt(account.password) : "غير متوفر";
      const decryptedCodes = decrypt(task.backupCodes);

      await bot.sendMessage(chatId, 
        `📬 <b>طلب مراجعة حساب Gmail</b>\n\n` +
        `👤 من المستخدم: <code>${task.userId}</code>\n` +
        `📧 البريد: <code>${escapeHtml(task.accountEmail)}</code>\n` +
        `🔑 الباسورد: <code>${escapeHtml(plainPassword)}</code>\n\n` +
        `🚨 <b>أكواد الطوارئ (2FA):</b>\n<code>${escapeHtml(decryptedCodes)}</code>`, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "✅ قبول", callback_data: `app_task_${task._id}` }, { text: "❌ رفض ونهو الحساب", callback_data: `rej_task_${task._id}` }]] }
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
  const pendingWithdraws = await Withdrawal.countDocuments({ status: "pending" });

  bot.sendMessage(chatId, 
    `📊 <b>إحصائيات النظام السريعة:</b>\n\n` +
    `👥 إجمالي المستخدمين: <b>${totalUsers}</b>\n` +
    `✅ الحسابات المقبولة: <b>${totalTasks}</b>\n` +
    `⏳ حسابات قيد المراجعة: <b>${pendingTasks}</b>\n` +
    `💸 طلبات سحب معلقة: <b>${pendingWithdraws}</b>`,
    { parse_mode: "HTML" }
  ).catch(() => {});
}

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
      `📌 <b>شروط قبول الحسابات الجديدة:</b>\n` +
      `1️⃣ إنشاء الحساب بالبيانات المعطاة.\n` +
      `2️⃣ ربط بريد الاستعادة المعتمد تلقائياً.\n` +
      `3️⃣ <b>تفعيل التحقق بخطوتين (2FA) داخل إعدادات Google للحساب وإرسال الأكواد الاحتياطية للبوت.</b>\n\n` +
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
    if (user.banned) { bot.sendMessage(chatId, "🚫 تم حظرك من استخدام البوت.").catch(() => {}); return; }
    const text = msg.text;

    if (userId === ADMIN_ID) {
      if (text === "📋 عرض الحسابات المعلقة") { await sendPendingTasksToAdmin(chatId); return; } 
      if (text === "📊 إحصائيات النظام السريعة") { await sendStatsToAdmin(chatId); return; } 
      if (text === "💰 طلبات السحب المنتظرة") {
        const pendingWithdraws = await Withdrawal.find({ status: "pending" });
        if (!pendingWithdraws.length) { 
          bot.sendMessage(chatId, "🎉 لا توجد طلبات سحب معلقة حالياً.").catch(() => {}); 
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
      if (text === "🔙 خروج من الإدارة") { bot.sendMessage(chatId, "👋 تم الخروج والعودة للقائمة العامة.", MAIN_MENU).catch(() => {}); return; }
    }

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
      const plainSecret = decrypt(user.twoFASecret);
      if (authenticator.check(text.trim(), plainSecret)) {
        user.state = "awaiting_withdraw_network"; await user.save();
        const NETWORK_MENU = { reply_markup: { keyboard: [["💎 Tether (USDT-BEP-20) | 0% +0.03$ | min: 0.20$"]], resize_keyboard: true } };
        bot.sendMessage(chatId, `🔓 <b>تم التحقق!</b> اختر شبكة السحب:`, NETWORK_MENU).catch(() => {});
      } else {
        bot.sendMessage(chatId, "❌ كود الأمان غير صحيح. يرجى إعادة المحاولة:", { reply_markup: { keyboard: [["🔙 رجوع"]], resize_keyboard: true } }).catch(() => {});
      }
      return;
    }

    if (user.state === "awaiting_gmail_backup_codes") {
      if (text === "❌ إلغاء إنشاء الحساب") {
        const accountId = user.stateMeta?.accountId;
        if (accountId) await Account.findByIdAndUpdate(accountId, { assigned: false, assignedTo: null });
        user.state = null; user.stateMeta = null; await user.save();
        bot.sendMessage(chatId, "🚫 تم إلغاء العملية.", MAIN_MENU).catch(() => {}); return;
      }
      
      const backupCodes = text.trim();
      if (backupCodes.length < 8) {
        bot.sendMessage(chatId, "⚠️ صيغة الأكواد تبدو غير صحيحة. يرجى إرسال الرموز الاحتياطية بشكل صحيح:", { reply_markup: { keyboard: [["❌ إلغاء إنشاء الحساب"]], resize_keyboard: true } }).catch(() => {});
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
      
      bot.sendMessage(chatId, `✅ <b>تم استلام الأكواد وإرسال الحساب للمراجعة!</b>`, MAIN_MENU).catch(() => {});
      bot.sendMessage(ADMIN_ID,
        `📬 <b>طلب مراجعة حساب Gmail (محمي بـ 2FA)</b>\n\n` +
        `👤 المستخدم: ${escapeHtml(user.firstName)} (<code>${user.telegramId}</code>)\n` +
        `📧 البريد: <code>${escapeHtml(account.email)}</code>\n` +
        `🔑 الباسورد: <code>${escapeHtml(decrypt(account.password))}</code>\n` + 
        `🚨 <b>أكواد النسخ الاحتياطي:</b>\n<code>${escapeHtml(backupCodes)}</code>`,
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
        bot.sendMessage(chatId, `⚠️ لا يمكنك إنشاء حساب جديد حتى تنتهي مراجعة حساباتك المعلقة.`).catch(() => {}); return;
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
        bot.sendMessage(chatId, `❌ لا توجد حسابات متاحة بالمستودع حالياً.`, MAIN_MENU).catch(() => {}); return; 
      }
      
      updatedUser.stateMeta = { accountId: account._id.toString() };
      await updatedUser.save();
      
      // إصلاح الرسالة الأولى: الاسم واللقب منفصلان وبدون نص الـ 2FA نهائياً
      bot.sendMessage(chatId,
        `📧 <b>بيانات الحساب المطلوب إنشاؤه:</b>\n\n` +
        `👤 الاسم: <code>${escapeHtml(account.firstName)}</code>\n` +
        `👥 اللقب: <code>${escapeHtml(account.lastName)}</code>\n` +
        `📅 الميلاد: <code>${escapeHtml(account.birthDate)}</code>\n` +
        `📧 البريد الإلكتروني: <code>${escapeHtml(account.email)}</code>\n` +
        `🔑 كلمة المرور: <code>${escapeHtml(decrypt(account.password))}</code>\n` + 
        `🔗 إيميل الاستعادة الإلزامي: <code>${escapeHtml(RECOVERY_EMAIL)}</code>`,
        { parse_mode: "HTML", ...CONFIRM_MENU }
      ).catch(() => {});
      return;
    }

    if (text === "✅ تم التفعيل والإنشاء") {
      if (user.state !== "awaiting_confirmation") { bot.sendMessage(chatId, "❌ لا يوجد حساب معلق لك.", MAIN_MENU).catch(() => {}); return; }
      const accountId = user.stateMeta?.accountId;
      const account = await Account.findById(accountId);
      
      bot.sendMessage(chatId, `🔍 <b>جاري التحقق الأولي من الحساب...</b>`, { parse_mode: "HTML" }).catch(() => {});
      const verification = await verifyEmail(account.email);
      
      // إصلاح خطأ الـ HTML المشوه وسياق النص البرمجي المقبول هنا
      if (!verification.valid) {
        await Account.findByIdAndUpdate(accountId, { assigned: false, assignedTo: null });
        user.state = null; user.stateMeta = null; await user.save();
        bot.sendMessage(chatId, `❌ <b>فشل الفحص:</b> ${escapeHtml(verification.reason)}`, MAIN_MENU).catch(() => {}); return;
      }
      
      user.state = "awaiting_gmail_backup_codes";
      await user.save();

      // إظهار رسالة الأكواد والـ 2FA هنا فقط بعد نجاح عملية التحقق من الحساب
      bot.sendMessage(chatId, 
        `✅ <b>تم فحص وتأكيد ربط بريد الاستعادة بنجاح!</b>\n\n` +
        `⚠️ <b>الخطوة التالية الهامة والأخيرة (تأمين الحساب):</b>\n` +
        `توجه الآن إلى إعدادات حساب جوجل هذا، وقم بتفعيل ميزة <b>(التحقق بخطوتين - 2FA)</b>، ثم استخرج <b>أكواد النسخ الاحتياطي الـ 8 (Backup Codes)</b> وأرسلها كاملة هنا في الشات لحفظ أمان الحساب:`, 
        { parse_mode: "HTML", reply_markup: { keyboard: [["❌ إلغاء إنشاء الحساب"]], resize_keyboard: true } }
      ).catch(() => {});
      return;
    }

    if (text === "❌ إلغاء إنشاء الحساب") {
      const accountId = user.stateMeta?.accountId;
      if (accountId) await Account.findByIdAndUpdate(accountId, { assigned: false, assignedTo: null });
      user.state = null; user.stateMeta = null; await user.save();
      bot.sendMessage(chatId, "🚫 تم إلغاء العملية.", MAIN_MENU).catch(() => {}); return;
    }

    if (text === "📋 حساباتي") {
      const tasks = await Task.find({ userId: user.telegramId }).sort({ createdAt: -1 }).limit(10);
      if (!tasks.length) { bot.sendMessage(chatId, `📋 لا توجد حسابات مسجلة.`, MAIN_MENU).catch(() => {}); return; }
      let txt = `📋 <b>حساباتك الأخيرة:</b>\n\n`;
      for (const t of tasks) {
        const emoji = t.status === "approved" ? "✅" : t.status === "rejected" ? "❌" : "⏳";
        txt += `${emoji} <code>${escapeHtml(t.accountEmail)}</code> — $${fmt(t.amount)}\n`;
      }
      bot.sendMessage(chatId, txt, { parse_mode: "HTML", ...MAIN_MENU }).catch(() => {}); return;
    }

    if (text === "💰 الرصيد") {
      const approved = await Task.countDocuments({ userId: user.telegramId, status: "approved" });
      bot.sendMessage(chatId, `💵 <b>الرصيد القابل للسحب:</b> $${fmt(user.balance)} USDT\n✅ الحسابات المقبولة: ${approved}`, { parse_mode: "HTML", ...BALANCE_MENU }).catch(() => {}); return;
    }

    if (text === "📝 سجل الرصيد") {
      const withdrawals = await Withdrawal.find({ userId: user.telegramId }).sort({ createdAt: -1 }).limit(10);
      if (!withdrawals.length) { bot.sendMessage(chatId, "📝 لا توجد عمليات سحب مسجلة لحسابك حالياً.", BALANCE_MENU).catch(() => {}); return; }
      let txt = `📝 <b>سجل طلبات السحب الخاصة بك (آخر 10):</b>\n\n`;
      for (const w of withdrawals) {
        const emoji = w.status === "approved" ? "✅" : w.status === "rejected" ? "❌" : "⏳";
        txt += `${emoji} مبلغ: $${fmt(w.amount)} — شبكة: <code>${w.network}</code>\n`;
      }
      bot.sendMessage(chatId, txt, { parse_mode: "HTML", ...BALANCE_MENU }).catch(() => {}); return;
    }

    if (text === "👥 الإحالات الخاصة بي") {
      const refLink = `https://t.me/${(await bot.getMe()).username}?start=${user.referralCode}`;
      bot.sendMessage(chatId, 
        `👥 <b>نظام الإحالات الخاص بك</b>\n\n` +
        `📈 عدد الإحالات النشطة: <b>${user.referralCount}</b> مستخدم\n` +
        `🔗 رابط الإحالة الفريد الخاص بك:\n<code>${refLink}</code>`, 
        { parse_mode: "HTML", ...MAIN_MENU }
      ).catch(() => {});
      return;
    }

    if (text === "💳 سحب") {
      if (user.twoFAEnabled) {
        user.state = "awaiting_2fa_for_withdraw"; await user.save();
        bot.sendMessage(chatId, "🔐 يرجى إدخال رمز الـ 2FA الخاص بحسابك لتأكيد السحب:", { reply_markup: { keyboard: [["🔙 رجوع"]], resize_keyboard: true } }).catch(() => {});
        return;
      }
      user.state = "awaiting_withdraw_network"; await user.save();
      const NETWORK_MENU = { reply_markup: { keyboard: [["💎 Tether (USDT-BEP-20) | 0% +0.03$ | min: 0.20$"]], resize_keyboard: true } };
      bot.sendMessage(chatId, `💰 رصيدك: $${fmt(user.balance)} USDT\nاختر الشبكة:`, NETWORK_MENU).catch(() => {}); return;
    }

    if (user.state === "awaiting_withdraw_network") {
      if (text.includes("USDT-BEP-20")) {
        user.state = "awaiting_withdraw_amount_network"; user.stateMeta = { network: "USDT-BEP20", feeAmount: 0.03 }; await user.save();
        bot.sendMessage(chatId, "💸 أدخل قيمة المبلغ رقمياً (حد أدنى 0.20):", { reply_markup: { keyboard: [["🔙 رجوع"]], resize_keyboard: true } }).catch(() => {});
      } else {
        user.state = null; await user.save(); bot.sendMessage(chatId, "👋 تم العودة للقائمة", MAIN_MENU).catch(() => {});
      }
      return;
    }

    if (user.state === "awaiting_withdraw_amount_network") {
      const amount = parseFloat(text.trim());
      if (isNaN(amount) || amount < 0.20) { bot.sendMessage(chatId, "❌ قيمة خاطئة أو أقل من الحد الأدنى.").catch(() => {}); return; }
      
      user.state = "awaiting_withdraw_address_network"; 
      user.stateMeta = { ...user.stateMeta, amount }; 
      await user.save();
      bot.sendMessage(chatId, "📮 أدخل عنوان محفظتك لشبكة BSC (BEP-20):", { reply_markup: { keyboard: [["🔙 رجوع"]], resize_keyboard: true } }).catch(() => {}); 
      return;
    }

    if (user.state === "awaiting_withdraw_address_network") {
      const address = text.trim();
      const bep20Regex = /^0x[a-fA-F0-9]{40}$/;
      
      if (!bep20Regex.test(address)) {
        bot.sendMessage(chatId, "❌ العنوان غير صالح! أرسل عنوان محفظة صحيح يبدأ بـ 0x:").catch(() => {}); return;
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
        bot.sendMessage(chatId, "❌ فشل تسجيل الطلب: رصيدك الحالي غير كافٍ شامل الرسوم.", MAIN_MENU).catch(() => {}); return;
      }

      await Withdrawal.create({ userId: user.telegramId, amount, fee: feeAmount, totalDeduction: totalRequired, address, network, status: "pending" });
      bot.sendMessage(chatId, `✅ تم تسجيل طلب سحبك بنجاح وهو قيد المراجعة!`, MAIN_MENU).catch(() => {});
      return;
    }

    if (text === "⚙️ الإعدادات") {
      bot.sendMessage(chatId, `⚙️ <b>إعدادات النظام</b>\n\n🔒 التحقق الثنائي للبوت: <b>${user.twoFAEnabled ? "🟢 مفعل" : "🔴 غير مفعل"}</b>`, { parse_mode: "HTML", ...SETTINGS_MENU }).catch(() => {}); return;
    }

    if (text === "🔐 إعدادات التحقق بخطوتين للبوت") {
      if (user.twoFAEnabled) {
        user.twoFAEnabled = false; user.twoFASecret = null; await user.save();
        bot.sendMessage(chatId, "🔓 تم تعطيل التحقق بخطوتين للبوت.", SETTINGS_MENU).catch(() => {}); return;
      }
      const secret = authenticator.generateSecret();
      const encryptedSecret = encrypt(secret); 
      
      user.state = "awaiting_2fa_verification"; 
      user.stateMeta = { tempSecret: encryptedSecret }; 
      await user.save();
      
      bot.sendMessage(chatId, `🔑 كود السيكرت الخاص بك بالبوت:\n<code>${secret}</code>\n\nأدخل الرمز المكون من 6 أرقام من تطبيق Authenticator للتأكيد:`, { parse_mode: "HTML", ...CANCEL_MENU }).catch(() => {}); return;
    }

    if (text === "💬 مساعدة") {
      bot.sendMessage(chatId, `💬 <b>مركز الدعم وشرح تفعيل الأمان (2FA)</b>\n\nتواصل مع الدعم الفني: @YourNewAdmin`, { parse_mode: "HTML", ...MAIN_MENU }); return;
    }

    if (text === "🔙 رجوع") { 
      user.state = null; user.stateMeta = null; await user.save();
      bot.sendMessage(chatId, "👋 العودة للقائمة رئيسية", MAIN_MENU).catch(() => {}); return; 
    }

  } catch (err) {
    console.error("خطأ عام:", err);
    bot.sendMessage(chatId, "❌ حدث خطأ داخلي في النظام.", MAIN_MENU).catch(() => {});
  } finally {
    clearTimeout(safetyTimeout);
    processingUsers.delete(userId);
  }
});

// --- لوحة التحكم والمسؤول ---
bot.onText(/\/admin/, async (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  bot.sendMessage(msg.chat.id, `⚙️ <b>لوحة تحكم الإدارة</b>`, {
    parse_mode: "HTML",
    reply_markup: { keyboard: [["📋 عرض الحسابات المعلقة", "💰 طلبات السحب المنتظرة"], ["📊 إحصائيات النظام السريعة", "🔙 خروج من الإدارة"]], resize_keyboard: true }
  }).catch(() => {});
});

bot.on("callback_query", async (query) => {
  if (query.from.id !== ADMIN_ID) return;
  const data = query.data;
  const msgId = query.message.message_id;
  const adminChatId = query.message.chat.id;

  try {
    if (data.startsWith("app_task_")) {
      const taskId = data.replace("app_task_", "");
      const task = await Task.findOneAndUpdate({ _id: taskId, status: "pending" }, { status: "approved" });
      if (task) {
        await User.findOneAndUpdate({ telegramId: task.userId }, { $inc: { balance: task.amount } });
        bot.sendMessage(task.userId, `✅ تم قبول حسابك ومضاف لك $${task.amount}`).catch(() => {});
        
        bot.editMessageText(`✅ <b>تمت الموافقة بنجاح على الحساب:</b>\n<code>${escapeHtml(task.accountEmail)}</code>`, {
          chat_id: adminChatId,
          message_id: msgId,
          parse_mode: "HTML"
        }).catch(() => {});
      }
    }

    if (data.startsWith("rej_task_")) {
      const taskId = data.replace("rej_task_", "");
      const task = await Task.findOneAndUpdate({ _id: taskId, status: "pending" }, { status: "rejected" });
      if (task && task.accountId) {
        await Account.findByIdAndUpdate(task.accountId, { assigned: true, isWasted: true });
        bot.sendMessage(task.userId, `❌ تم رفض حساب الـ Gmail الخاص بك.`).catch(() => {});
        
        bot.editMessageText(`❌ <b>تم رفض هذا الحساب وإتلافه نهائياً:</b>\n<code>${escapeHtml(task.accountEmail)}</code>`, {
          chat_id: adminChatId,
          message_id: msgId,
          parse_mode: "HTML"
        }).catch(() => {});
      }
    }

    if (data.startsWith("app_with_")) {
      const withId = data.replace("app_with_", "");
      const withdraw = await Withdrawal.findOneAndUpdate({ _id: withId, status: "pending" }, { status: "approved" });
      if (withdraw) {
        bot.sendMessage(withdraw.userId, `💸 <b>تمت الموافقة على طلب سحبك بنجاح!</b>`, { parse_mode: "HTML" }).catch(() => {});
        
        bot.editMessageText(`✅ <b>تمت الموافقة على التحويل وإرسال الرصيد:</b>\nالمبلغ: $${fmt(withdraw.amount)}`, {
          chat_id: adminChatId,
          message_id: msgId,
          parse_mode: "HTML"
        }).catch(() => {});
      }
    }

    if (data.startsWith("rej_with_")) {
      const withId = data.replace("rej_with_", "");
      const withdraw = await Withdrawal.findOneAndUpdate({ _id: withId, status: "pending" }, { status: "rejected" });
      if (withdraw) {
        await User.findOneAndUpdate({ telegramId: withdraw.userId }, { $inc: { balance: withdraw.totalDeduction } });
        bot.sendMessage(withdraw.userId, `❌ <b>تم رفض طلب السحب الخاص بك.</b> وأعيدت الأموال إلى رصيدك.`, { parse_mode: "HTML" }).catch(() => {});
        
        bot.editMessageText(`❌ <b>تم رفض السحب وإعادة الرصيد للمستخدم:</b>\nالمعرف: <code>${withdraw.userId}</code>`, {
          chat_id: adminChatId,
          message_id: msgId,
          parse_mode: "HTML"
        }).catch(() => {});
      }
    }
  } catch (err) {
    console.error("خطأ في تنفيذ الـ callback:", err);
  } finally {
    bot.answerCallbackQuery(query.id, { text: "تمت العملية" }).catch(() => {});
  }
});

// أمر تصفير وقسم الحسابات القديمة (متاح للأدمن فقط)
bot.onText(/\/clearall/, async (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  try {
    bot.sendMessage(msg.chat.id, "⚙️ جاري مسح جميع الحسابات من قاعدة البيانات...").catch(() => {});
    const result = await Account.deleteMany({});
    bot.sendMessage(msg.chat.id, `🗑️ تم مسح المستودع بنجاح!\n✨ عدد الحسابات المخزنة السابقة التي حُذفت: <b>${result.deletedCount}</b> حساب.`, { parse_mode: "HTML" }).catch(() => {});
  } catch (err) {
    console.error("خطأ أثناء مسح الحسابات:", err.message);
    bot.sendMessage(msg.chat.id, "❌ حدث خطأ أثناء محاولة مسح الحسابات.").catch(() => {});
  }
});

bot.onText(/\/generate (\d+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const count = parseInt(match[1], 10);
  let successCount = 0;

  bot.sendMessage(msg.chat.id, `⚙️ جاري بدء توليد ${count} حساب بشكل عالي الفرادة...`).catch(() => {});

  for (let i = 0; i < count; i++) {
    try {
      const fn = getRandomItem(FIRST_NAMES); 
      const ln = getRandomItem(LAST_NAMES);
      const uniqueSuffix = crypto.randomBytes(3).toString("hex");
      const email = `${fn.toLowerCase()}${ln.toLowerCase()}_${uniqueSuffix}@gmail.com`;
      const plainPassword = "Pass_" + crypto.randomBytes(4).toString("hex");

      await Account.create({ firstName: fn, lastName: ln, email, password: encrypt(plainPassword), birthDate: "1998-05-12", recoveryEmail: RECOVERY_EMAIL });
      successCount++;
    } catch (err) {
      console.error("فشل توليد حساب فردي:", err.message);
    }
  }
  bot.sendMessage(msg.chat.id, `✅ تم توليد الحسابات بنجاح. الناجح الفعلي: ${successCount}`).catch(() => {});
});

mongoose.connect(MONGODB_URI)
  .then(() => console.log("MongoDB active"))
  .catch((err) => console.error(err));

http.createServer((req, res) => { res.end("Online"); }).listen(process.env.PORT || 8080);
