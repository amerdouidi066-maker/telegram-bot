const TelegramBot = require("node-telegram-bot-api"); // ✅ تم تصحيح Const
const mongoose = require("mongoose");
const http = require("http");
const nodemailer = require("nodemailer");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_ID = parseInt(process.env.ADMIN_ID, 10);
const RECOVERY_EMAIL = process.env.RECOVERY_EMAIL || "ryal2422@gmail.com";

// 🔐 حماية كلمة المرور - الاعتماد الكلي على البيئة ومنع التسريب النصي
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD; 

if (!BOT_TOKEN) throw new Error("BOT_TOKEN مطلوب في متغيرات البيئة");
if (!MONGODB_URI) throw new Error("MONGODB_URI مطلوب في متغيرات البيئة");
if (!ADMIN_ID || isNaN(ADMIN_ID)) throw new Error("ADMIN_ID مطلوب في متغيرات البيئة");
if (!GMAIL_APP_PASSWORD) throw new Error("GMAIL_APP_PASSWORD مطلوب في متغيرات البيئة لحماية حسابك");

const processingUsers = new Set();

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: RECOVERY_EMAIL,
    pass: GMAIL_APP_PASSWORD
  }
});

const userSchema = new mongoose.Schema({
  telegramId: { type: Number, required: true, unique: true },
  username: String,
  firstName: String,
  balance: { type: Number, default: 0 },
  referralCode: { type: String, unique: true },
  referredBy: { type: Number, default: null },
  referralCount: { type: Number, default: 0 },
  state: { type: String, default: null },
  stateMeta: { type: mongoose.Schema.Types.Mixed, default: null },
  banned: { type: Boolean, default: false },
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
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const stuckUsers = await User.find({ state: "awaiting_confirmation", updatedAt: { $lte: twoHoursAgo } });
  for (const user of stuckUsers) {
    const accountId = user.stateMeta?.accountId;
    if (accountId) await Account.findByIdAndUpdate(accountId, { assigned: false, assignedTo: null, assignedAt: null });
    user.state = null; user.stateMeta = null;
    await user.save();
  }
}

async function verifyEmail(email) {
  try {
    const emailRegex = /^[a-zA-Z0-9][a-zA-Z0-9.]*[a-zA-Z0-9]@gmail\.com$/;
    if (!emailRegex.test(email) || email.includes("..")) {
      return { valid: false, reason: "صيغة البريد الإلكتروني غير صالحة" };
    }
    const existingTask = await Task.findOne({ accountEmail: email, status: { $in: ["pending", "approved"] } });
    if (existingTask) return { valid: false, reason: "هذا الإيميل مستخدم بالفعل في النظام" };

    try {
      await transporter.sendMail({
        from: `"نظام التحقق الذكي" <${RECOVERY_EMAIL}>`,
        to: email,
        subject: "تنشيط الخدمة",
        text: "تم التحقق من إنشاء الحساب بنجاح."
      });
      return { valid: true, reason: "الحساب شغال وموجود على خوادم Google." };
    } catch (mailErr) {
      return { valid: false, reason: "الحساب غير موجود على سيرفرات Google أو يرفض استقبال الرسائل تلقائياً" };
    }
  } catch (err) {
    return { valid: false, reason: "خطأ داخلي أثناء الفحص" };
  }
}

setInterval(cleanupStaleSessions, 30 * 60 * 1000);

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
    keyboard: [["✅ تم"], ["❌ إلغاء إنشاء الحساب"]],
    resize_keyboard: true,
  },
};

const BALANCE_MENU = {
  reply_markup: {
    keyboard: [["📝 سجل الرصيد", "💳 سحب"], ["🔙 رجوع"]],
    resize_keyboard: true,
  },
};

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  const user = await getOrCreateUser(msg);
  const refCode = match && match[1] ? match[1].trim() : null;
  if (user.state === "awaiting_confirmation" || user.state) {
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
    `💰 *اكسب من إنشاء حسابات Gmail!*\n\n` +
    `📌 *كيف يعمل البوت:*\n` +
    `1️⃣ اضغط "أنشئ حساب Gmail جديد"\n` +
    `2️⃣ ستحصل على بيانات جاهزة\n` +
    `3️⃣ سجّل الحساب باستخدام البيانات\n` +
    `4️⃣ اضغط "تم" واحصل على $0.15\n\n` +
    `💵 السعر لكل حساب: *$0.145 - $0.15*`,
    { parse_mode: "Markdown", ...MAIN_MENU }
  );
});

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

    if (text === "➕ أنشئ حساب Gmail جديد") {
      const pendingTasks = await Task.find({ userId: user.telegramId, status: "pending" });
      if (pendingTasks.length >= 2) {
        let replyMsg = `⏳ *لديك حسابان قيد المراجعة اليدوية*\n\n`;
        pendingTasks.forEach((t, i) => { replyMsg += `📧 الحساب ${i + 1}: \`${t.accountEmail}\`\n`; });
        replyMsg += `\n⚠️ لا يمكنك إنشاء حساب جديد حتى تنتهي مراجعة حساباتك الحالية من قبل الإدارة.`;
        bot.sendMessage(chatId, replyMsg, { parse_mode: "Markdown" }); return;
      }
      if (user.state === "awaiting_confirmation") {
        bot.sendMessage(chatId, `⚠️ *لديك حساب قيد الإنشاء حالياً*\n\nاضغط ✅ *تم* بعد إنشاء الحساب\nأو ❌ *إلغاء إنشاء الحساب* للإلغاء.`, { parse_mode: "Markdown", ...CONFIRM_MENU }); return;
      }
      const account = await Account.findOneAndUpdate({ assigned: false }, { assigned: true, assignedTo: user.telegramId, assignedAt: new Date() }, { new: true });
      if (!account) { bot.sendMessage(chatId, `❌ *لا توجد حسابات متاحة حالياً*\n\nيرجى المحاولة لاحقاً.`, { parse_mode: "Markdown" }); return; }
      user.state = "awaiting_confirmation"; user.stateMeta = { accountId: account._id.toString() };
      await user.save();
      
      bot.sendMessage(chatId,
        `📧 *قم بتسجيل حساب Gmail باستخدام البيانات المحددة*\n\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `👤 الاسم: \`${account.firstName}\`\n` +
        `👤 اللقب: \`${account.lastName}\`\n` +
        `📅 تاريخ الميلاد: \`${account.birthDate}\`\n` +
        `📧 البريد الإلكتروني: \`${account.email}\`\n` +
        `🔑 كلمة المرور: \`${account.password}\`\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `🔒 *تأكد من استخدام البيانات المحددة*\n\n` +
        `⚠️ *يجب إضافة إيميل الاستعادة التالي عند إنشاء الحساب:*\n` +
        `\`${RECOVERY_EMAIL}\`\n\n` +
        `❗ *بدون هذا الإيميل لن يتم الدفع وسيتم رفض الطلب يدوياً!*\n\n` +
        `بعد إنشاء الحساب اضغط ✅ *تم*`,
        { parse_mode: "Markdown", ...CONFIRM_MENU }
      );
      return;
    }

    if (text === "✅ تم") {
      if (user.state !== "awaiting_confirmation") { bot.sendMessage(chatId, "❌ لا يوجد حساب نشط محجوز لك حالياً.", MAIN_MENU); return; }
      const accountId = user.stateMeta?.accountId;
      const account = await Account.findById(accountId);
      if (!account) { user.state = null; user.stateMeta = null; await user.save(); bot.sendMessage(chatId, "❌ حدث خطأ في النظام. حاول مرة أخرى.", MAIN_MENU); return; }
      
      bot.sendMessage(chatId, `🔍 *جاري فحص وجود الحساب وتنشيطه على سيرفرات Google تلقائياً...*`, { parse_mode: "Markdown" });
      
      const verification = await verifyEmail(account.email);
      if (!verification.valid) {
        await Account.findByIdAndUpdate(accountId, { assigned: false, assignedTo: null, assignedAt: null });
        user.state = null; user.stateMeta = null; await user.save();
        bot.sendMessage(chatId, `❌ *تم رفض الطلب تلقائياً*\n\nالسبب: ${verification.reason}\n\nتأكد من إتمام إنشاء الحساب بالبيانات المعطاة تماماً قبل الضغط على زر (تم).`, { parse_mode: "Markdown", ...MAIN_MENU }); return;
      }
      
      // تغيير الحالة وتصفيرها قبل الـ await لمنع ثغرات التكرار (Race Condition)
      user.state = null; user.stateMeta = null; await user.save();
      
      await Account.findByIdAndUpdate(accountId, { recoveryEmail: RECOVERY_EMAIL });
      const task = await Task.create({ userId: user.telegramId, amount: 0.15, accountEmail: account.email, accountId: account._id, submittedAt: new Date() });
      
      const remainingPending = await Task.countDocuments({ userId: user.telegramId, status: "pending" });
      const canCreateMore = remainingPending < 2;
      bot.sendMessage(chatId,
        `✅ *تم إرسال طلبك بنجاح للتدقيق اليدوي!*\n\n` +
        `📧 الإيميل: \`${account.email}\`\n` +
        `✨ حالة الفحص التلقائي: *موجود على سيرفرات جوجل ومستعد للمراجعة الإدارية*\n` +
        `💵 المبلغ المستحق عند القبول: *$0.15 USDT*\n\n` +
        `⏳ الحساب تحت المراجعة النهائية من الإدارة.\n\n` +
        (canCreateMore ? `💡 يمكنك إنشاء حساب آخر الآن!` : `⚠️ وصلت للحد الأقصى للمراجعات المعلقة (حسابان). انتظر انتهاء المراجعة اليدوية أولاً.`),
        { parse_mode: "Markdown", ...MAIN_MENU }
      );

      bot.sendMessage(ADMIN_ID,
        `📬 *طلب مراجعة Gmail جديد*\n\n` +
        `👤 المستطلع: ${user.firstName} (\`${user.telegramId}\`)\n` +
        `📧 البريد الإلكتروني: \`${account.email}\`\n` +
        `🔑 كلمة المرور: \`${account.password}\`\n` +
        `📅 تاريخ الميلاد: \`${account.birthDate}\`\n` +
        `🔗 إيميل الاستعادة المقيد: \`${RECOVERY_EMAIL}\`\n` +
        `👤 الاسم المسجل: ${account.firstName} ${account.lastName}`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "✅ قبول الحساب", callback_data: `app_task_${task._id}` },
                { text: "❌ رفض وإرجاع", callback_data: `rej_task_${task._id}` }
              ]
            ]
          }
        }
      ).catch(() => {});
      return;
    }

    if (text === "❌ إلغاء إنشاء الحساب") {
      const accountId = user.stateMeta?.accountId;
      if (accountId) await Account.findByIdAndUpdate(accountId, { assigned: false, assignedTo: null, assignedAt: null });
      user.state = null; user.stateMeta = null; await user.save();
      bot.sendMessage(chatId, "🚫 تم إلغاء إنشاء الحساب وإعادته للنظام الجاهز.", MAIN_MENU); return;
    }

    if (text === "📋 حساباتي") {
      const tasks = await Task.find({ userId: user.telegramId }).sort({ createdAt: -1 }).limit(10);
      if (!tasks.length) { bot.sendMessage(chatId, `📋 *لا توجد عمليات مراجعة مسجلة بعد*`, { parse_mode: "Markdown", ...MAIN_MENU }); return; }
      let txt = `📋 *حساباتك الأخيرة*\n\n`;
      for (const t of tasks) {
        const statusEmoji = t.status === "approved" ? "✅" : t.status === "rejected" ? "❌" : "⏳";
        const statusText = t.status === "approved" ? "مقبول ومقيد" : t.status === "rejected" ? "مرفوض" : "قيد المراجعة اليدوية";
        txt += `${statusEmoji} \`${t.accountEmail}\` — $${fmt(t.amount)} — ${statusText}\n`;
      }
      bot.sendMessage(chatId, txt, { parse_mode: "Markdown", ...MAIN_MENU }); return;
    }

    if (text === "💰 الرصيد") {
      const approved = await Task.countDocuments({ userId: user.telegramId, status: "approved" });
      const pending = await Task.countDocuments({ userId: user.telegramId, status: "pending" });
      const pendingAmount = await Task.aggregate([{ $match: { userId: user.telegramId, status: "pending" } }, { $group: { _id: null, total: { $sum: "$amount" } } }]);
      const reserved = pendingAmount[0]?.total || 0;
      bot.sendMessage(chatId,
        `💰 *إحصائيات رصيدك المالي*\n\n━━━━━━━━━━━━━━━━━━\n💵 *الرصيد القابل للسحب:* $${fmt(user.balance)} USDT\n🔒 *المبالغ المحجوزة للمراجعة:* $${fmt(reserved)} USDT\n━━━━━━━━━━━━━━━━━━\n\n✅ حسابات تم قبولها: ${approved}\n⏳ حسابات تنتظر المراجعة: ${pending}\n👥 عدد إحالاتك: ${user.referralCount}\n\n💸 الحد الأدنى لطلب السحب: *0.20 USDT*`,
        { parse_mode: "Markdown", ...BALANCE_MENU }
      ); return;
    }

    if (text === "📝 سجل الرصيد") {
      const tasks = await Task.find({ userId: user.telegramId, status: "approved" }).sort({ createdAt: -1 }).limit(20);
      if (!tasks.length) { bot.sendMessage(chatId, `📝 *لا يوجد أرباح مضافة للسجل بعد*`, { parse_mode: "Markdown" }); return; }
      let txt = `📝 *سجل الأرباح المعتمدة*\n\n`; let total = 0;
      for (const t of tasks) {
        const date = t.createdAt.toLocaleDateString('ar-EG');
        txt += `✅ \`${t.accountEmail}\`\n💵 +$${fmt(t.amount)} | 📅 ${date}\n\n`;
        total += t.amount;
      }
      txt += `━━━━━━━━━━━━━━━━━━\n💵 *إجمالي الأرباح المستلمة:* $${fmt(total)} USDT`;
      bot.sendMessage(chatId, txt, { parse_mode: "Markdown" }); return;
    }

    if (text === "💳 سحب") {
      user.state = "awaiting_withdraw_network"; user.stateMeta = null; await user.save();
      const NETWORK_MENU = { reply_markup: { keyboard: [["💎 Tether (USDT-BEP-20) | 0% +0.03$ | min: 0.20$"]], resize_keyboard: true } };
      bot.sendMessage(chatId, `💸 *اختر شبكة السحب مع مراعاة الرسوم الأمنية*\n\n💰 رصيدك المتاح: *$${fmt(user.balance)} USDT*\n\n⚠️ الحد الأدنى المسموح به: *0.20 USDT*\n\nاختر الشبكة:`, { parse_mode: "Markdown", ...NETWORK_MENU }); return;
    }

    if (user.state === "awaiting_withdraw_network") {
      if (text.includes("Tether") || text.includes("USDT-BEP-20")) {
        const totalNeeded = 0.20 + 0.03; 
        if (user.balance < totalNeeded) {
          bot.sendMessage(chatId, `❌ *عذراً رصيدك لا يغطي العملية*\n\n💰 رصيدك: *$${fmt(user.balance)} USDT*\n📉 الحد الأدنى المطلوب شاملاً الرسوم: *$${fmt(totalNeeded)} USDT*`, { parse_mode: "Markdown", ...MAIN_MENU });
          user.state = null; await user.save(); return;
        }
        user.state = "awaiting_withdraw_amount_network"; 
        user.stateMeta = { network: "USDT-BEP20", fee: 0.03, feeAmount: 0.03 }; 
        await user.save();
        bot.sendMessage(chatId, `💸 *طلب سحب عبر شبكة USDT-BEP20*\n\n💰 رصيدك الحالي: *$${fmt(user.balance)} USDT*\n💸 الرسوم الثابتة: *0.03 USDT*\n\nيرجى كتابة المبلغ المراد سحبه كقيمة رقمية (بحد أدنى 0.20):`, { parse_mode: "Markdown" });
        return;
      } else if (text === "🔙 رجوع") {
        user.state = null; await user.save();
        bot.sendMessage(chatId, `👋 *تمت العودة للقائمة الرئيسية*`, { parse_mode: "Markdown", ...MAIN_MENU });
        return;
      } else {
        bot.sendMessage(chatId, "❌ الرجاء اختيار شبكة صالحة من القائمة السفلية.");
        return;
      }
    }

    if (user.state === "awaiting_withdraw_amount_network") {
      const amount = parseFloat(text.trim());
      const { network, feeAmount } = user.stateMeta || {};
      if (isNaN(amount) || amount < 0.20) { bot.sendMessage(chatId, `❌ القيمة غير صحيحة أو أقل من الحد الأدنى (0.20).`); return; }
      const totalDeduction = amount + feeAmount;
      if (totalDeduction > user.balance) { bot.sendMessage(chatId, `❌ تعذر طلب هذا المبلغ. الإجمالي يتجاوز رصيدك الحالي مع الرسوم.`); return; }
      user.state = "awaiting_withdraw_address_network"; user.stateMeta = { ...user.stateMeta, amount }; await user.save();
      bot.sendMessage(chatId, `📮 أدخل عنوان محفظتك لاستلام عملة *(${network})*:`, { parse_mode: "Markdown" }); return;
    }

    if (user.state === "awaiting_withdraw_address_network") {
      const address = text.trim();
      const { network, feeAmount, amount } = user.stateMeta || {};
      if (!address || address.length < 10) { bot.sendMessage(chatId, "❌ تنسيق العنوان المكتوب غير صحيح. يرجى إعادة المحاولة:"); return; }
      const totalDeduction = amount + feeAmount;
      
      if (totalDeduction > user.balance) { 
        user.state = null; user.stateMeta = null; await user.save(); 
        bot.sendMessage(chatId, `❌ عذراً حدث تغيير في الرصيد.`, { parse_mode: "Markdown", ...MAIN_MENU }); 
        return; 
      }
      
      // خصم الرصيد فوراً لمنع التكرار (Race Condition Vulnerability Fix)
      user.balance -= totalDeduction; 
      user.state = null; 
      user.stateMeta = null; 
      await user.save();
      
      const withdrawal = await Withdrawal.create({ userId: user.telegramId, amount, fee: feeAmount, totalDeduction, address, network, status: "pending" });
      bot.sendMessage(chatId, `✅ *تم تسجيل طلب سحبك بنجاح!*\n\n🌐 الشبكة: *${network}*\n💵 القيمة الصافية: *$${fmt(amount)} USDT*\n📮 العنوان: \`${address}\`\n\n⏳ قيد المراجعة الإدارية خلال 24 ساعة.`, { parse_mode: "Markdown", ...MAIN_MENU });
      
      bot.sendMessage(ADMIN_ID,
        `💸 *إشعار بطلب سحب مالي جديد*\n\n` +
        `👤 العضو: ${user.firstName} (\`${user.telegramId}\`)\n` +
        `🌐 شبكة الاستقبال: *${network}*\n` +
        `💵 المبلغ الصافي: $${fmt(amount)} USDT\n` +
        `💸 الرسوم: $${fmt(feeAmount)} USDT\n` +
        `📮 عنوان العميل: \`${address}\``,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "✅ تأكيد التحويل", callback_data: `app_with_${withdrawal._id}` },
                { text: "❌ رفض وإعادة رصيد", callback_data: `rej_with_${withdrawal._id}` }
              ]
            ]
          }
        }
      ).catch(() => {});
      return;
    }

    if (text === "🔙 رجوع") { bot.sendMessage(chatId, `👋 *تم الرجوع للقائمة الرئيسية*`, { parse_mode: "Markdown", ...MAIN_MENU }); return; }

    if (text === "👥 الإحالات الخاصة بي") {
      const botInfo = await bot.getMe();
      const link = `https://t.me/${botInfo.username}?start=${user.referralCode}`;
      bot.sendMessage(chatId, `👥 *نظام الإحالات التابع لك*\n\n🔗 رابط الدعوة الخاص بك:\n\`${link}\`\n\n👤 عدد المستخدمين المسجلين عبر رابطك: *${user.referralCount}*`, { parse_mode: "Markdown", ...MAIN_MENU }); return;
    }

    if (text === "⚙️ الإعدادات") {
      bot.sendMessage(chatId, `⚙️ *إعدادات الحساب والنظام*\n\n👤 الاسم المسجل: ${user.firstName}\n🆔 معرف تيليجرام: \`${user.telegramId}\`\n💰 الرصيد الحالي: $${fmt(user.balance)}`, { parse_mode: "Markdown", ...MAIN_MENU }); return;
    }

    if (text === "💬 مساعدة") {
      bot.sendMessage(chatId,
        `💬 *مركز الدعم والمساعدة*\n\n❓ *دليل إنشاء الحساب:*\n1. سجل عبر accounts.google.com\n2. أدخل الاسم واللقب وتاريخ الميلاد المعطى لك تماماً\n3. ضع إيميل الاستعادة الإلزامي: *${RECOVERY_EMAIL}*\n4. ارجع للبوت واضغط خيار "تم"\n\nلأي استفسار تواصل مع الدعم الفني: @𝑪𝒍𝒐𝒖دود`,
        { parse_mode: "Markdown", ...MAIN_MENU }
      ); return;
    }

  } finally {
    processingUsers.delete(userId);
  }
});

bot.on("callback_query", async (query) => {
  if (query.from.id !== ADMIN_ID) {
    bot.answerCallbackQuery(query.id, { text: "🚫 أنت لست المسؤول عن هذا البوت!", show_alert: true });
    return;
  }

  const data = query.data;
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;

  if (data.startsWith("app_task_")) {
    const taskId = data.replace("app_task_", "");
    const task = await Task.findById(taskId).catch(() => null);
    if (!task || task.status !== "pending") {
      bot.answerCallbackQuery(query.id, { text: "⚠️ تمت معالجة هذا الطلب مسبقاً." });
      return;
    }
    
    task.status = "approved"; await task.save();
    const user = await User.findOne({ telegramId: task.userId });
    if (user) {
      user.balance += task.amount; await user.save();
      bot.sendMessage(task.userId, `✅ *تمت الموافقة على حسابك!*\n\n📧 \`${task.accountEmail}\`\n💵 +$${task.amount} USDT\n💰 رصيدك الحالي: *$${fmt(user.balance)} USDT*`, { parse_mode: "Markdown" }).catch(() => {});
    }
    bot.editMessageText(query.message.text + "\n\n🟢 *الحالة الإدارية: تم القبول وإضافة الرصيد للمستخدم*", { chat_id: chatId, message_id: messageId, parse_mode: "Markdown" });
    bot.answerCallbackQuery(query.id, { text: "✅ تم قبول الحساب" });
  }

  if (data.startsWith("rej_task_")) {
    const taskId = data.replace("rej_task_", "");
    const task = await Task.findById(taskId).catch(() => null);
    if (!task || task.status !== "pending") {
      bot.answerCallbackQuery(query.id, { text: "⚠️ تمت معالجة هذا الطلب مسبقاً." });
      return;
    }
    task.status = "rejected"; await task.save();
    if (task.accountId) await Account.findByIdAndUpdate(task.accountId, { assigned: false, assignedTo: null, assignedAt: null });
    bot.sendMessage(task.userId, `❌ *تم رفض الحساب بعد التدقيق اليدوي*\n\n📧 \`${task.accountEmail}\``, { parse_mode: "Markdown" }).catch(() => {});
    bot.editMessageText(query.message.text + "\n\n🔴 *الحالة الإدارية: تم الرفض وإعادة الحساب للمستودع*", { chat_id: chatId, message_id: messageId, parse_mode: "Markdown" });
    bot.answerCallbackQuery(query.id, { text: "❌ تم رفض الحساب" });
  }

  if (data.startsWith("app_with_")) {
    const withId = data.replace("app_with_", "");
    const withdrawal = await Withdrawal.findById(withId).catch(() => null);
    if (!withdrawal || withdrawal.status !== "pending") {
      bot.answerCallbackQuery(query.id, { text: "⚠️ تمت معالجة السحب مسبقاً." });
      return;
    }
    withdrawal.status = "approved"; await withdrawal.save();
    bot.sendMessage(withdrawal.userId, `✅ *تمت الموافقة على طلب السحب وحوالتك جاهزة!*\n\n🌐 الشبكة: ${withdrawal.network}\n💵 المبلغ المرسل: $${fmt(withdrawal.amount)} USDT`, { parse_mode: "Markdown" }).catch(() => {});
    bot.editMessageText(query.message.text + "\n\n🟢 *الحالة الإدارية: تم تأكيد الإرسال وتحديث سجل الحوالة*", { chat_id: chatId, message_id: messageId, parse_mode: "Markdown" });
    bot.answerCallbackQuery(query.id, { text: "✅ تم تأكيد السحب" });
  }

  if (data.startsWith("rej_with_")) {
    const withId = data.replace("rej_with_", "");
    const withdrawal = await Withdrawal.findById(withId).catch(() => null);
    if (!withdrawal || withdrawal.status !== "pending") {
      bot.answerCallbackQuery(query.id, { text: "⚠️ تمت معالجة السحب مسبقاً." });
      return;
    }
    withdrawal.status = "rejected"; await withdrawal.save();
    const user = await User.findOne({ telegramId: withdrawal.userId });
    if (user) {
      user.balance += withdrawal.totalDeduction; await user.save();
      bot.sendMessage(withdrawal.userId, `❌ *تم رفض طلب السحب الخاص بك*\n\n💵 تم إعادة رصيدك بالكامل للمحفظة.`, { parse_mode: "Markdown" }).catch(() => {});
    }
    bot.editMessageText(query.message.text + "\n\n🔴 *الحالة الإدارية: تم الرفض وإعادة الرصيد بالكامل للعضو*", { chat_id: chatId, message_id: messageId, parse_mode: "Markdown" });
    bot.answerCallbackQuery(query.id, { text: "❌ تم رفض السحب" });
  }
});

const FIRST_NAMES = ["James","John","Robert","Michael","William","David","Richard","Joseph","Thomas","Charles","Daniel","Matthew","Anthony","Mark","Donald","Steven","Paul","Andrew","Kenneth","Joshua","Kevin","Brian","George","Edward","Ronald","Timothy","Jason","Jeffrey","Ryan","Jacob","Gary","Nicholas","Eric","Jonathan","Stephen","Larry","Justin","Scott","Brandon","Benjamin","Samuel","Gregory","Frank","Alexander","Raymond","Patrick","Jack","Dennis","Jerry","Tyler","Aaron","Jose","Adam","Nathan","Henry","Douglas","Zachary","Peter","Kyle","Ethan","Walter","Noah","Jeremy","Christian","Keith","Roger","Terry","Gerald","Harold","Sean","Austin","Carl","Arthur","Lawrence","Dylan","Jesse","Jordan","Bryan","Billy","Joe","Bruce","Gabriel","Logan","Albert","Willie","Alan","Juan","Wayne","Elijah","Randy","Roy","Vincent","Ralph","Eugene","Russell","Bobby","Mason","Philip","Louis","Mary","Patricia","Jennifer","Linda","Elizabeth","Barbara","Susan","Jessica","Sarah","Karen","Nancy","Lisa","Betty","Margaret","Sandra","Ashley","Kimberly","Emily","Donna","Michelle","Dorothy","Carol","Amanda","Melissa","Deborah","Stephanie","Rebecca","Laura","Sharon","Cynthia","Kathleen","Amy","Shirley","Angela","Helen","Anna","Brenda","Pamela","Nicole","Emma","Samantha","Katherine","Christine","Debra","Rachel","Catherine","Carolyn","Janet","Ruth","Maria","Heather","Diane","Virginia","Julie","Joyce","Victoria","Olivia","Kelly","Christina","Lauren","Joan","Evelyn","Judith","Megan","Cheryl","Andrea","Hannah","Martha","Jacqueline","Frances","Gloria","Ann","Teresa","Kathryn","Sara","Janice","Jean","Alice","Madison","Doris","Abigail","Julia","Judy","Grace","Denise","Amber","Marilyn","Beverly","Danielle","Theresa","Sophia","Marie","Diana","Brittany","Natalie","Isabella","Charlotte","Rose","Alexis","Kayla"];
const LAST_NAMES = ["Smith","Johnson","Williams","Brown","Jones","Garcia","Miller","Davis","Rodriguez","Martinez","Hernandez","Lopez","Gonzalez","Wilson","Anderson","Thomas","Taylor","Moore","Jackson","Martin","Lee","Perez","Thompson","White","Harris","Sanchez","Clark","Ramirez","Lewis","Robinson","Walker","Young","Allen","King","Wright","Scott","Torres","Nguyen","Hill","Flores","Green","Adams","Nelson","Baker","Hall","Rivera","Campbell","Mitchell","Carter","Roberts","Gomez","Phillips","Evans","Turner","Diaz","Parker","Cruz","Edwards","Collins","Reyes","Stewart","Morris","Morales","Murphy","Cook","Rogers","Gutierrez","Ortiz","Morgan","Cooper","Peterson","Bailey","Reed","Kelly","Howard","Ramos","Kim","Cox","Ward","Richardson","Watson","Brooks","Chavez","Wood","James","Bennett","Gray","Mendoza","Ruiz","Hughes","Price","Alvarez","Castillo","Sanders","Patel","Myers","Long","Ross","Foster","Jimenez","Powell","Jenkins","Perry","Russell","Sullivan","Bell","Coleman","Butler","Henderson","Barnes","Gonzales","Fisher","Vasquez","Simpson","Romero","Jordan","Patterson","Alexander","Hamilton","Graham","Reynolds","Griffin","Wallace","Moreno","West","Cole","Hayes","Bryant","Herrera","Gibson","Ellis","Tran","Medina","Aguilar","Stevens","Murray","Ford","Castro","Marshall","Owens","Harrison","Fernandez","Mcdonald","Woods","Washington","Kennedy","Wells","Vargas","Henry","Chen","Freeman","Webb","Tucker","Guzman","Burns","Crawford","Olson","Porter","Hunter","Gordon","Mendez","Silva","Shaw","Snyder","Mason","Dixon","Munoz","Hunt","Hicks","Holmes","Palmer","Wagner","Black","Robertson","Boyd","Rose","Stone","Salazar","Fox","Warren","Mills","Meyer","Rice","Schmidt","Garza","Daniels","Ferguson","Nichols","Stephens","Soto","Weaver","Ryan","Gardner","Payne","Grant","Dunn","Kelley","Spencer","Hawkins","Arnold","Pierce","Vazquez","Hansen","Peters","Santos","Hart","Bradley","Knight","Elliott","Cunningham","Duncan","Armstrong","Hudson","Carroll","Lane","Riley","Andrews","Ray","Delgado","Berry","Perkins","Hoffman","Johnston","Matthews","Pena","Richards","Contreras","Willis","Carpenter","Lawrence","Sandoval","Guerrero","George","Chapman","Rios","Estrada","Ortega","Watkins","Greene","Nunez","Wheeler","Valdez","Harper","Burke","Larson","Santiago","Maldonado","Morrison","Franklin","Carlson","Austin","Dominguez","Carr","Lawson","Jacobs","Obrien","Lynch","Singh","Vega","Bishop","Montgomery","Oliver","Jensen","Harvey","Williamson","Gilbert","Bates","Chambers","Kuhn"];

function getRandomItem(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function generateRandomEmail(firstName, lastName) {
  const randomNum = Math.floor(Math.random() * 9999) + 1;
  const patterns = [
    `${firstName.toLowerCase()}.${lastName.toLowerCase()}${randomNum}`,
    `${firstName.toLowerCase()}${lastName.toLowerCase()}${randomNum}`,
    `${firstName.toLowerCase()}.${lastName.toLowerCase()}.${randomNum}`,
    `${firstName.toLowerCase()[0]}${lastName.toLowerCase()}${randomNum}`,
  ];
  return `${getRandomItem(patterns)}@gmail.com`;
}

function generatePassword() {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*";
  let password = "";
  for (let i = 0; i < 12; i++) password += chars[Math.floor(Math.random() * chars.length)];
  return password;
}

function generateRandomBirthDate() {
  const start = new Date(1990, 0, 1);
  const end = new Date(2007, 11, 31);
  const randomDate = new Date(start.getTime() + Math.random() * (end.getTime() - start.getTime()));
  const year = randomDate.getFullYear();
  const month = String(randomDate.getMonth() + 1).padStart(2, '0');
  const day = String(randomDate.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

bot.onText(/\/generate (\d+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const count = parseInt(match[1]);
  if (isNaN(count) || count < 1 || count > 100) { bot.sendMessage(msg.chat.id, "❌ أدخل رقماً بين 1 و 100."); return; }
  let added = 0, failed = 0;
  for (let i = 0; i < count; i++) {
    const firstName = getRandomItem(FIRST_NAMES);
    const lastName = getRandomItem(LAST_NAMES);
    const email = generateRandomEmail(firstName, lastName);
    const password = generatePassword();
    const birthDate = generateRandomBirthDate();
    try {
      await Account.create({ firstName, lastName, email, password, birthDate, recoveryEmail: RECOVERY_EMAIL });
      added++;
    } catch (err) {
      failed++;
    }
  }
  const totalAvailable = await Account.countDocuments({ assigned: false });
  bot.sendMessage(msg.chat.id, `🎲 *تم توليد الحسابات*\n\n✅ نجح: *${added}*\n❌ فشل: *${failed}*\n📦 المتاح بالمخزن: *${totalAvailable}*`, { parse_mode: "Markdown" });
});

bot.onText(/\/stats/, async (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  const [totalUsers, pendingTasks, availableAccounts] = await Promise.all([User.countDocuments(), Task.countDocuments({ status: "pending" }), Account.countDocuments({ assigned: false })]);
  bot.sendMessage(msg.chat.id, `📊 *الإحصائيات العامة*\n\n👤 المستخدمون: *${totalUsers}*\n📦 الحسابات المتاحة: *${availableAccounts}*\n⏳ طلبات معلقة: *${pendingTasks}*`, { parse_mode: "Markdown" });
});

mongoose.connection.on("connected", () => console.log("✅ MongoDB connected"));
mongoose.connection.on("error", err => console.error("⚠️ MongoDB error:", err.message));

mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 10000 })
  .catch(err => console.error("❌ MongoDB connection failed:", err.message));

console.log("🤖 الآلة الآمنة تعمل ومحمية بالأزرار التفاعلية...");

const PORT = process.env.PORT || 8080;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" }); 
  res.end(JSON.stringify({ status: "safe_mode_active" }));
}).listen(PORT, () => console.log(`🌐 HTTP Webhook active on port ${PORT}`));

bot.on("polling_error", err => console.error("Polling log:", err.message));
