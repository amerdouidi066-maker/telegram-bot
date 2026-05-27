const TelegramBot = require("node-telegram-bot-api"); 
const mongoose = require("mongoose");
const http = require("http");
const nodemailer = require("nodemailer");
const { authenticator } = require("otplib"); 

// --- إعدادات متغيرات البيئة ---
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_ID = parseInt(process.env.ADMIN_ID, 10);
const RECOVERY_EMAIL = process.env.RECOVERY_EMAIL || "ryal2422@gmail.com";
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD; 

if (!BOT_TOKEN) throw new Error("BOT_TOKEN مطلوب في متغيرات البيئة");
if (!MONGODB_URI) throw new Error("MONGODB_URI مطلوب في متغيرات البيئة");
if (!ADMIN_ID || isNaN(ADMIN_ID)) throw new Error("ADMIN_ID مطلوب في متغيرات البيئة");
if (!GMAIL_APP_PASSWORD) throw new Error("GMAIL_APP_PASSWORD مطلوب في متغيرات البيئة");

// مصفوفة لمنع تكرار معالجة الطلبات المتزامنة لنفس المستخدم
const processingUsers = new Set();

// إعداد ناقل البريد الإلكتروني للتحقق الذكي
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: RECOVERY_EMAIL,
    pass: GMAIL_APP_PASSWORD
  }
});

// --- مخططات قاعدة البيانات (Mongoose Schemas) ---
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

// --- الوظائف المساعدة (Helper Functions) ---
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

// تنظيف الجلسات المعلقة التي تجاوزت الساعتين ولم تكتمل
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

// التحقق من صحة وصلاحية البريد الإلكتروني وإرسال بريد اختباري
async function verifyEmail(email) {
  try {
    const emailRegex = /^[a-z0-9](\.?[a-z0-9]){4,29}@gmail\.com$/i;
    if (!emailRegex.test(email)) {
      return { valid: false, reason: "صيغة البريد الإلكتروني غير صالحة" };
    }
    const existingTask = await Task.findOne({ accountEmail: email, status: { $in: ["pending", "approved"] } });
    if (existingTask) return { valid: false, reason: "هذا الإيميل مستخدم بالفعل في النظام" };

    try {
      await transporter.sendMail({
        from: `"نظام التحقق الذكي" <${RECOVERY_EMAIL}>`,
        to: email,
        subject: "تنشيط الخدمة",
        text: "تم التحقق من الحساب وننتظر أكواد النسخ الاحتياطي الخاصة بالتحقق بخطوتين."
      });
      return { valid: true, reason: "الحساب شغال" };
    } catch (mailErr) {
      return { valid: false, reason: "الحساب غير موجود أو فشل استقبال بريد الاستعادة" };
    }
  } catch (err) {
    return { valid: false, reason: "خطأ داخلي أثناء الفحص" };
  }
}

// تشغيل دورة التنظيف كل 30 دقيقة
setInterval(cleanupStaleSessions, 30 * 60 * 1000);

// --- قوائم لوحة المفاتيح (Keyboards) ---
const MAIN_MENU = {
  reply_markup: {
    keyboard: [
      ["➕ أنشئ حساب Gmail جديد", "📋 حساباتي"],
      ["💰 الرصيد", "👥 الإحالات الخاصة بي"],
      ["⚙️ الإعدادات", "💬 مساعدة"],
    ],
    resize_keyboard: true,
  },
};

const CONFIRM_MENU = {
  reply_markup: {
    keyboard: [["✅ تم التفعيل والإنشاء"], ["❌ إلغاء إنشاء الحساب"]],
    resize_keyboard: true,
  },
};

const BALANCE_MENU = {
  reply_markup: {
    keyboard: [["📝 سجل الرصيد", "💳 سحب"], ["🔙 رجوع"]],
    resize_keyboard: true,
  },
};

const SETTINGS_MENU = {
  reply_markup: {
    keyboard: [["🔐 إعدادات التحقق بخطوتين للبوت"], ["🔙 رجوع"]],
    resize_keyboard: true,
  },
};

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// --- معالجة أمر البداية /start ---
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
      `👋 *أهلاً ${user.firstName}!*\n\n` +
      `💰 *اكسب من إنشاء حسابات Gmail الآمنة!*\n\n` +
      `📌 *شروط قبول الحسابات الجديدة:*\n` +
      `1️⃣ إنشاء الحساب بالبيانات المعطاة.\n` +
      `2️⃣ ربط بريد الاستعادة المعتمد تلقائياً.\n` +
      `3️⃣ *تفعيل التحقق بخطوتين (2FA) داخل إعدادات Google للحساب وإرسال أكواد النسخ الاحتياطي (Backup Codes) للبوت لإثبات الأمان.*\n\n` +
      `💵 السعر لكل حساب مطابق للشروط: *$0.15*`,
      { parse_mode: "Markdown", ...MAIN_MENU }
    );
  } catch (err) {
    console.error("خطأ في أمر start:", err);
  }
});

// --- المعالجة الرئيسية للرسائل الواردة ---
bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  if (processingUsers.has(userId)) return;
  processingUsers.add(userId);
  
  try {
    const user = await getOrCreateUser(msg);
    if (user.banned) { bot.sendMessage(chatId, "🚫 تم حظرك من استخدام البوت."); return; }
    const text = msg.text;

    // --- قسم المسؤول - الصلاحيات الخاصة بالأدمن ---
    if (userId === ADMIN_ID) {
      if (text === "📋 عرض الحسابات المعلقة") {
        bot.processUpdate({ message: { chat: msg.chat, from: msg.from, text: "/pending" } }); return;
      } else if (text === "📊 إحصائيات النظام السريعة") {
        bot.processUpdate({ message: { chat: msg.chat, from: msg.from, text: "/stats" } }); return;
      } else if (text === "💰 طلبات السحب المنتظرة") {
        const pendingWithdraws = await Withdrawal.find({ status: "pending" });
        if (!pendingWithdraws.length) { 
          bot.sendMessage(chatId, "🎉 لا توجد طلبات سحب معلقة حالياً."); 
        } else {
          for (const w of pendingWithdraws) {
            bot.sendMessage(chatId, `💸 *طلب سحب معلق:*\n\n👤 المستخدم آيدي: \`${w.userId}\`\n🌐 الشبكة: *${w.network}*\n💵 الصافي: $${fmt(w.amount)}\n📮 العنوان: \`${w.address}\``, {
              parse_mode: "Markdown",
              reply_markup: { inline_keyboard: [[{ text: "✅ تأكيد التحويل", callback_data: `app_with_${w._id}` }, { text: "❌ رفض وإعادة رصيد", callback_data: `rej_with_${w._id}` }]] }
            });
          }
        }
        return;
      } else if (text === "🔙 خروج من الإدارة") {
        bot.sendMessage(chatId, "👋 تم الخروج من لوحة التحكم والعودة للقائمة العامة.", MAIN_MENU); return;
      }
    }

    // --- نظام أمان التحقق الثنائي للبوت نفسه ---
    if (user.state === "awaiting_2fa_verification") {
      if (text === "❌ إلغاء العملية") {
        user.state = null; user.stateMeta = null; await user.save();
        bot.sendMessage(chatId, "❌ تم إلغاء الإعداد.", MAIN_MENU); return;
      }
      const code = text.trim();
      const tempSecret = user.stateMeta?.tempSecret;
      if (authenticator.check(code, tempSecret)) {
        user.twoFASecret = tempSecret; user.twoFAEnabled = true; user.state = null; user.stateMeta = null; await user.save();
        bot.sendMessage(chatId, "🔒 *تم تفعيل التحقق بخطوتين لحسابك بالبوت بنجاح!*", MAIN_MENU);
      } else {
        bot.sendMessage(chatId, "❌ الكود غير صحيح أو انتهت صلاحيته.");
      }
      return;
    }

    if (user.state === "awaiting_2fa_for_withdraw") {
      if (authenticator.check(text.trim(), user.twoFASecret)) {
        user.state = "awaiting_withdraw_network"; await user.save();
        const NETWORK_MENU = { reply_markup: { keyboard: [["💎 Tether (USDT-BEP-20) | 0% +0.03$ | min: 0.20$"]], resize_keyboard: true } };
        bot.sendMessage(chatId, `🔓 *تم التحقق!* اختر شبكة السحب:`, NETWORK_MENU);
      } else {
        bot.sendMessage(chatId, "❌ كود الأمان غير صحيح. يرجى إعادة المحاولة:");
      }
      return;
    }

    // --- استقبال أكواد الاحتياط الخاصة بحساب الـ Gmail المنشأ ---
    if (user.state === "awaiting_gmail_backup_codes") {
      const backupCodes = text.trim();
      if (backupCodes.length < 8) {
        bot.sendMessage(chatId, "⚠️ صيغة الأكواد تبدو غير صحيحة. يرجى نسخ أكواد النسخ الاحتياطي المقدمة من Google ولصقها هنا:");
        return;
      }
      
      const accountId = user.stateMeta?.accountId;
      const account = await Account.findById(accountId);
      
      user.state = null; user.stateMeta = null; await user.save();
      
      const task = await Task.create({
        userId: user.telegramId,
        amount: 0.15,
        accountEmail: account.email,
        accountId: account._id,
        backupCodes: backupCodes, 
        submittedAt: new Date()
      });
      
      bot.sendMessage(chatId, `✅ *تم استلام الأكواد وإرسال الحساب للمراجعة اليدوية!*\n\n💵 القيمة عند القبول: *$0.15 USDT*`, MAIN_MENU);
      
      bot.sendMessage(ADMIN_ID,
        `📬 *طلب مراجعة حساب Gmail (محمي بـ 2FA)*\n\n` +
        `👤 المستخدم: ${user.firstName} (\`${user.telegramId}\`)\n` +
        `📧 البريد: \`${account.email}\`\n` +
        `🔑 الباسورد: \`${account.password}\`\n` +
        `🚨 *أكواد النسخ الاحتياطي (Backup Codes):*\n\`${backupCodes}\``,
        {
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: [[{ text: "✅ قبول وضخ رصيد", callback_data: `app_task_${task._id}` }, { text: "❌ رفض الطلب", callback_data: `rej_task_${task._id}` }]] }
        }
      ).catch(() => {});
      return;
    }

    // --- طلب إنشاء حساب جديد وحجز البيانات ---
    if (text === "➕ أنشئ حساب Gmail جديد") {
      const pendingTasks = await Task.find({ userId: user.telegramId, status: "pending" });
      if (pendingTasks.length >= 2) {
        bot.sendMessage(chatId, `⚠️ لا يمكنك إنشاء حساب جديد حتى تنتهي مراجعة حساباتك المعلقة الحالية.`); return;
      }

      // حماية ذرية لتثبيت حالة المستخدم ومنع الضغط المتكرر المتزامن
      const updatedUser = await User.findOneAndUpdate(
        { telegramId: user.telegramId, state: null },
        { $set: { state: "awaiting_confirmation" } },
        { new: true }
      );

      if (!updatedUser) {
        bot.sendMessage(chatId, `⚠️ لديك عملية معلقة بالفعل أو جاري معالجة طلب آخر لك الآن.`, CONFIRM_MENU);
        return;
      }

      const account = await Account.findOneAndUpdate(
        { assigned: false }, 
        { assigned: true, assignedTo: user.telegramId, assignedAt: new Date() }, 
        { new: true }
      );

      if (!account) { 
        await User.findOneAndUpdate({ telegramId: user.telegramId }, { $set: { state: null } });
        bot.sendMessage(chatId, `❌ لا توجد حسابات متاحة بالمستودع حالياً.`); 
        return; 
      }
      
      updatedUser.stateMeta = { accountId: account._id.toString() };
      await updatedUser.save();
      
      bot.sendMessage(chatId,
        `📧 *بيانات الحساب المطلوب إنشاؤه:*\n\n` +
        `👤 الاسم: \`${account.firstName} ${account.lastName}\`\n` +
        `📅 الميلاد: \`${account.birthDate}\`\n` +
        `📧 البريد الإلكتروني: \`${account.email}\`\n` +
        `🔑 كلمة المرور: \`${account.password}\`\n` +
        `🔗 إيميل الاستعادة الإلزامي: \`${RECOVERY_EMAIL}\`\n\n` +
        `⚠️ *الخطوة الإلزامية الجديدة:*\n` +
        `بعد فتح الحساب، توجه إلى (الأمان -> التحقق بخطوتين) في Google وقم بتفعيلها، ثم استخرج *أكواد النسخ الاحتياطي (Backup Codes)* واضغط على الزر بالأسفل.`,
        { parse_mode: "Markdown", ...CONFIRM_MENU }
      );
      return;
    }

    if (text === "✅ تم التفعيل والإنشاء") {
      if (user.state !== "awaiting_confirmation") { bot.sendMessage(chatId, "❌ لا يوجد حساب معلق لك.", MAIN_MENU); return; }
      const accountId = user.stateMeta?.accountId;
      const account = await Account.findById(accountId);
      
      bot.sendMessage(chatId, `🔍 *جاري التحقق الأولي من وجود الحساب...*`);
      const verification = await verifyEmail(account.email);
      
      if (!verification.valid) {
        await Account.findByIdAndUpdate(accountId, { assigned: false, assignedTo: null });
        user.state = null; user.stateMeta = null; await user.save();
        bot.sendMessage(chatId, `❌ *فشل الفحص:* ${verification.reason}`, MAIN_MENU); return;
      }
      
      user.state = "awaiting_gmail_backup_codes";
      await user.save();
      bot.sendMessage(chatId, "🔐 *أحسنت! الحساب متصل. الآن أرسل (أكواد النسخ الاحتياطي الـ 8) الخاصة بحساب الـ Gmail لحفظ أمانه وثباته لديك:*");
      return;
    }

    if (text === "❌ إلغاء إنشاء الحساب") {
      const accountId = user.stateMeta?.accountId;
      if (accountId) await Account.findByIdAndUpdate(accountId, { assigned: false, assignedTo: null });
      user.state = null; user.stateMeta = null; await user.save();
      bot.sendMessage(chatId, "🚫 تم إلغاء العملية.", MAIN_MENU); return;
    }

    // --- عرض التقارير والإحصائيات والواجهات للمستخدم ---
    if (text === "📋 حساباتي") {
      const tasks = await Task.find({ userId: user.telegramId }).sort({ createdAt: -1 }).limit(10);
      if (!tasks.length) { bot.sendMessage(chatId, `📋 لا توجد حسابات مسجلة.`); return; }
      let txt = `📋 *حساباتك الأخيرة:*\n\n`;
      for (const t of tasks) {
        const emoji = t.status === "approved" ? "✅" : t.status === "rejected" ? "❌" : "⏳";
        txt += `${emoji} \`${t.accountEmail}\` — $${fmt(t.amount)}\n`;
      }
      bot.sendMessage(chatId, txt, { parse_mode: "Markdown", ...MAIN_MENU }); return;
    }

    if (text === "💰 الرصيد") {
      const approved = await Task.countDocuments({ userId: user.telegramId, status: "approved" });
      bot.sendMessage(chatId, `💵 *الرصيد القابل للسحب:* $${fmt(user.balance)} USDT\n✅ الحسابات المقبولة: ${approved}`, BALANCE_MENU); return;
    }

    if (text === "📝 سجل الرصيد") {
      const withdrawals = await Withdrawal.find({ userId: user.telegramId }).sort({ createdAt: -1 }).limit(10);
      if (!withdrawals.length) { bot.sendMessage(chatId, "📝 لا توجد عمليات سحب مسجلة لحسابك حالياً.", BALANCE_MENU); return; }
      let txt = `📝 *سجل طلبات السحب الخاصة بك (آخر 10):*\n\n`;
      for (const w of withdrawals) {
        const emoji = w.status === "approved" ? "✅" : w.status === "rejected" ? "❌" : "⏳";
        txt += `${emoji} مبلغ: $${fmt(w.amount)} — شبكة: \`${w.network}\`\n`;
      }
      bot.sendMessage(chatId, txt, { parse_mode: "Markdown", ...BALANCE_MENU });
      return;
    }

    if (text === "👥 الإحالات الخاصة بي") {
      const refLink = `https://t.me/${(await bot.getMe()).username}?start=${user.referralCode}`;
      bot.sendMessage(chatId, 
        `👥 *نظام الإحالات الخاص بك*\n\n` +
        `📈 عدد الإحالات النشطة: *${user.referralCount}* مستخدم\n` +
        `🔗 رابط الإحالة الفريد الخاص بك:\n\`${refLink}\`\n\n` +
        `شارك الرابط مع أصدقائك لزيادة أرباحك عند إتمام المهام داخل النظام!`, 
        { parse_mode: "Markdown", ...MAIN_MENU }
      );
      return;
    }

    // --- نظام السحب المالي المطور ---
    if (text === "💳 سحب") {
      if (user.twoFAEnabled) {
        user.state = "awaiting_2fa_for_withdraw"; await user.save();
        bot.sendMessage(chatId, "🔐 يرجى إدخال رمز الـ 2FA الخاص بحساب التيليجرام لتأكيد السحب:", { reply_markup: { remove_keyboard: true } });
        return;
      }
      user.state = "awaiting_withdraw_network"; await user.save();
      const NETWORK_MENU = { reply_markup: { keyboard: [["💎 Tether (USDT-BEP-20) | 0% +0.03$ | min: 0.20$"]], resize_keyboard: true } };
      bot.sendMessage(chatId, `💰 رصيدك: $${fmt(user.balance)} USDT\nاختر الشبكة:`, NETWORK_MENU); return;
    }

    if (user.state === "awaiting_withdraw_network") {
      // تعديل الأخطاء الإملائية ليتوافق فحص النص المرسل مع اسم الشبكة المعروض في الكيبورد تماماً
      if (text.includes("USDT-BEP-20")) {
        user.state = "awaiting_withdraw_amount_network"; user.stateMeta = { network: "USDT-BEP20", feeAmount: 0.03 }; await user.save();
        bot.sendMessage(chatId, "💸 أدخل قيمة المبلغ رقمياً (حد أدنى 0.20):");
      } else {
        user.state = null; await user.save(); bot.sendMessage(chatId, "👋 تم الإلغاء العودة للقائمة", MAIN_MENU);
      }
      return;
    }

    if (user.state === "awaiting_withdraw_amount_network") {
      const amount = parseFloat(text.trim());
      if (isNaN(amount) || amount < 0.20) { bot.sendMessage(chatId, "❌ قيمة خاطئة أو أقل من الحد الأدنى."); return; }
      
      user.state = "awaiting_withdraw_address_network"; 
      user.stateMeta = { ...user.stateMeta, amount }; 
      await user.save();
      bot.sendMessage(chatId, "📮 أدخل عنوان محفظتك:"); 
      return;
    }

    if (user.state === "awaiting_withdraw_address_network") {
      const address = text.trim();
      const { network, feeAmount, amount } = user.stateMeta || {};
      const totalRequired = amount + feeAmount;

      // حماية ذرية فائقة: فحص وتأكيد رصيد الملاءة المالية والخصم في استعلام واحد متزامن ومضمون لمنع ثغرات السحب المتكرر
      const updatedUser = await User.findOneAndUpdate(
        { telegramId: user.telegramId, balance: { $gte: totalRequired } },
        { 
          $inc: { balance: -totalRequired },
          $set: { state: null, stateMeta: null }
        },
        { new: true }
      );

      if (!updatedUser) {
        user.state = null; user.stateMeta = null; await user.save();
        bot.sendMessage(chatId, "❌ فشل تسجيل الطلب: رصيدك الحالي غير كافٍ لتغطية المبلغ والعمولة.", MAIN_MENU);
        return;
      }

      await Withdrawal.create({ 
        userId: user.telegramId, 
        amount, 
        fee: feeAmount, 
        totalDeduction: totalRequired, 
        address, 
        network, 
        status: "pending" 
      });

      bot.sendMessage(chatId, `✅ تم تسجيل طلب سحبك بنجاح وهو قيد المراجعة الفورية!`, MAIN_MENU);
      return;
    }

    if (text === "⚙️ الإعدادات") {
      bot.sendMessage(chatId, `⚙️ *إعدادات النظام*\n\n🔒 التحقق الثنائي للبوت: *${user.twoFAEnabled ? "🟢 مفعل" : "🔴 غير مفعل"}*`, { parse_mode: "Markdown", ...SETTINGS_MENU }); return;
    }

    if (text === "🔐 إعدادات التحقق بخطوتين للبوت") {
      if (user.twoFAEnabled) {
        user.twoFAEnabled = false; user.twoFASecret = null; await user.save();
        bot.sendMessage(chatId, "🔓 تم تعطيل التحقق بخطوتين للبوت.", SETTINGS_MENU); return;
      }
      const secret = authenticator.generateSecret();
      user.state = "awaiting_2fa_verification"; user.stateMeta = { tempSecret: secret }; await user.save();
      bot.sendMessage(chatId, `🔑 كود السيكرت الخاص بك بالبوت:\n\`${secret}\`\n\nأرسل الرمز المكون من 6 أرقام للتأكيد:`, { parse_mode: "Markdown" }); return;
    }

    if (text === "💬 مساعدة") {
      bot.sendMessage(chatId,
        `💬 *مركز الدعم وشرح تفعيل الأمان (2FA)*\n\n` +
        `❓ *كيفية تفعيل التحقق بخطوتين وجلب الأكواد:*\n` +
        `1️⃣ افتح الرابط في المتصفح للحساب الجديد: [myaccount.google.com](https://myaccount.google.com)\n` +
        `2️⃣ توجه إلى تبويب 🔑 *الأمان (Security)*.\n` +
        `3️⃣ انزل لأسفل واضغط على *التحقق بخطوتين (2-Step Verification)* وقم بتفعيلها برقم هاتفك.\n` +
        `4️⃣ بعد إتمام التفعيل، ارجع لنفس الصفحة وانزل لأسفل واضغط على *الرموز الاحتياطية (Backup Codes)*.\n` +
        `5️⃣ اضغط على زر "الحصول على رموز احتياطية"، ثم انسخ الأكواد التي ظهرت لك وأرسلها هنا للبوت.\n\n` +
        `📌 *ملاحظة:* تأكد دائماً من إضافة إيميل الاستعادة الإلزامي: \`${RECOVERY_EMAIL}\` عند إنشاء البريد.\n\n` +
        `لأي استفسار إضافي تواصل مع الدعم الفني: @YourNewAdmin`, 
        { parse_mode: "Markdown", ...MAIN_MENU }
      ); 
      return;
    }

    if (text === "🔙 رجوع") { bot.sendMessage(chatId, "👋 العودة للقائمة رئيسية", MAIN_MENU); return; }

  } catch (err) {
    console.error("خطأ في معالجة الرسالة العامة:", err);
    bot.sendMessage(chatId, "❌ حدث خطأ داخلي في النظام، يرجى المحاولة لاحقاً.", MAIN_MENU).catch(() => {});
  } finally {
    processingUsers.delete(userId);
  }
});

// --- أوامر التحكم الخاصة بالمسؤول (Admin Commands) ---
bot.onText(/\/admin/, async (msg) => {
  try {
    if (msg.from.id !== ADMIN_ID) return;
    bot.sendMessage(msg.chat.id, `⚙️ *لوحة تحكم الإدارة*`, {
      reply_markup: { keyboard: [["📋 عرض الحسابات المعلقة", "💰 طلبات السحب المنتظرة"], ["📊 إحصائيات النظام السريعة", "🔙 خروج من الإدارة"]], resize_keyboard: true }
    });
  } catch (err) {
    console.error("خطأ في أمر admin:", err);
  }
});

bot.onText(/\/pending/, async (msg) => {
  try {
    if (msg.from.id !== ADMIN_ID) return;
    const pendingTasks = await Task.find({ status: "pending" });
    if (!pendingTasks.length) { bot.sendMessage(msg.chat.id, "🎉 لا توجد طلبات معلقة."); return; }
    for (const task of pendingTasks) {
      bot.sendMessage(msg.chat.id, `📧 إيميل: \`${task.accountEmail}\`\n🚨 أكواد الطوارئ المرفقة:\n\`${task.backupCodes}\``, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[{ text: "✅ قبول", callback_data: `app_task_${task._id}` }, { text: "❌ رفض", callback_data: `rej_task_${task._id}` }]] }
      });
    }
  } catch (err) {
    console.error("خطأ في أمر pending:", err);
  }
});

bot.onText(/\/stats/, async (msg) => {
  try {
    if (msg.from.id !== ADMIN_ID) return;
    const totalUsers = await User.countDocuments();
    const totalTasks = await Task.countDocuments({ status: "approved" });
    const pendingTasks = await Task.countDocuments({ status: "pending" });
    const pendingWithdraws = await Withdrawal.countDocuments({ status: "pending" });

    bot.sendMessage(msg.chat.id, 
      `📊 *إحصائيات النظام السريعة:*\n\n` +
      `👥 إجمالي المستخدمين: *${totalUsers}*\n` +
      `✅ الحسابات المقبولة: *${totalTasks}*\n` +
      `⏳ حسابات قيد المراجعة: *${pendingTasks}*\n` +
      `💸 طلبات سحب معلقة: *${pendingWithdraws}*`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    console.error("خطأ في أمر stats:", err);
  }
});

// الأزرار التفاعلية المضمنة داخل لوحة التحكم (Callback Queries)
bot.on("callback_query", async (query) => {
  if (query.from.id !== ADMIN_ID) return;
  const data = query.data;

  try {
    if (data.startsWith("app_task_")) {
      const taskId = data.replace("app_task_", "");
      const task = await Task.findOneAndUpdate({ _id: taskId, status: "pending" }, { status: "approved" });
      if (task) {
        await User.findOneAndUpdate({ telegramId: task.userId }, { $inc: { balance: task.amount } });
        bot.sendMessage(task.userId, `✅ تم قبول حسابك ومضاف لك $${task.amount}`).catch(() => {});
      }
    }

    if (data.startsWith("rej_task_")) {
      const taskId = data.replace("rej_task_", "");
      const task = await Task.findOneAndUpdate({ _id: taskId, status: "pending" }, { status: "rejected" });
      if (task) {
        if (task.accountId) await Account.findByIdAndUpdate(task.accountId, { assigned: false, assignedTo: null });
        bot.sendMessage(task.userId, `❌ تم رفض حساب الـ Gmail الخاص بك.`).catch(() => {});
      }
    }

    if (data.startsWith("app_with_")) {
      const withId = data.replace("app_with_", "");
      const withdraw = await Withdrawal.findOneAndUpdate({ _id: withId, status: "pending" }, { status: "approved" });
      if (withdraw) {
        bot.sendMessage(withdraw.userId, `💸 *تمت الموافقة على طلب سحبك بنجاح!*\nالمبلغ: $${fmt(withdraw.amount)} وصل إلى محفظتك.`).catch(() => {});
      }
    }

    if (data.startsWith("rej_with_")) {
      const withId = data.replace("rej_with_", "");
      const withdraw = await Withdrawal.findOneAndUpdate({ _id: withId, status: "pending" }, { status: "rejected" });
      if (withdraw) {
        await User.findOneAndUpdate({ telegramId: withdraw.userId }, { $inc: { balance: withdraw.totalDeduction } });
        bot.sendMessage(withdraw.userId, `❌ *تم رفض طلب السحب الخاص بك.* وأعيدت الأموال إلى رصيدك بالبوت.`).catch(() => {});
      }
    }
  } catch (err) {
    console.error("خطأ أثناء تنفيذ الـ Callback للزر:", err);
  } finally {
    bot.answerCallbackQuery(query.id, { text: "تمت العملية" }).catch(() => {});
  }
});

// --- توليد عينات بيانات تلقائية لمستودع الحسابات ---
const FIRST_NAMES = ["James","John","Robert","Michael","William"];
const LAST_NAMES = ["Smith","Johnson","Williams","Brown","Jones"];
function getRandomItem(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

bot.onText(/\/generate (\d+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const count = parseInt(match[1], 10);
  let successCount = 0;

  bot.sendMessage(msg.chat.id, `⚙️ جاري بدء توليد ${count} حساب...`);

  for (let i = 0; i < count; i++) {
    try {
      const fn = getRandomItem(FIRST_NAMES); 
      const ln = getRandomItem(LAST_NAMES);
      const email = `${fn.toLowerCase()}${ln.toLowerCase()}${Math.floor(1000 + Math.random() * 9000)}@gmail.com`;
      
      await Account.create({ 
        firstName: fn, 
        lastName: ln, 
        email, 
        password: "Pass_" + Math.random().toString(36).substring(2,8), 
        birthDate: "1998-05-12", 
        recoveryEmail: RECOVERY_EMAIL 
      });
      successCount++;
    } catch (err) {
      console.error("فشل توليد حساب فردي، جاري التخطي:", err.message);
    }
  }
  bot.sendMessage(msg.chat.id, `✅ تم توليد الحسابات بنجاح.\nالعدد الإجمالي المطلوب: ${count}\nالعدد الناجح الفعلي: ${successCount}`);
});

// --- بدء الاتصال بقاعدة البيانات والخادم ---
mongoose.connect(MONGODB_URI)
  .then(() => console.log("MongoDB active"))
  .catch((err) => console.error("فشل الاتصال بقاعدة البيانات المونجو:", err));

// خادم وهمي لإبقاء الخدمة نشطة عبر منصات الاستضافة (مثل Render)
http.createServer((req, res) => { res.end("Online"); }).listen(process.env.PORT || 8080);
