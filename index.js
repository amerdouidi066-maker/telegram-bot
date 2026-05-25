const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose");
const http = require("http");
const dns = require("dns").promises;

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_ID = parseInt(process.env.ADMIN_ID, 10);

if (!BOT_TOKEN) throw new Error("BOT_TOKEN مطلوب");
if (!MONGODB_URI) throw new Error("MONGODB_URI مطلوب");
if (!ADMIN_ID || isNaN(ADMIN_ID)) throw new Error("ADMIN_ID مطلوب في متغيرات البيئة");

// ─── قفل مضاد للـ Race Condition ─────────────────────────────────────────────
const processingUsers = new Set();

// ─── Models ───────────────────────────────────────────────────────────────────

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
  autoChecked: { type: Boolean, default: false },
  checkResult: { type: String, default: null },
  submittedAt: { type: Date, default: Date.now },
}, { timestamps: true });

const withdrawSchema = new mongoose.Schema({
  userId: { type: Number, required: true },
  amount: { type: Number, required: true },
  address: { type: String, required: true },
  status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },
}, { timestamps: true });

const User = mongoose.model("User", userSchema);
const Account = mongoose.model("Account", accountSchema);
const Task = mongoose.model("Task", taskSchema);
const Withdrawal = mongoose.model("Withdrawal", withdrawSchema);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function genReferralCode(id) {
  return "REF" + id.toString(36).toUpperCase();
}

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

// ─── تنظيف الحسابات المعلقة (أكثر من 2 ساعة بدون تأكيد) ─────────────────────
async function cleanupStaleSessions() {
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const stuckUsers = await User.find({
    state: "awaiting_confirmation",
    updatedAt: { $lte: twoHoursAgo },
  });

  for (const user of stuckUsers) {
    const accountId = user.stateMeta?.accountId;
    if (accountId) {
      await Account.findByIdAndUpdate(accountId, {
        assigned: false,
        assignedTo: null,
        assignedAt: null,
      });
    }
    user.state = null;
    user.stateMeta = null;
    await user.save();
  }

  if (stuckUsers.length > 0) {
    console.log(`🧹 تم تنظيف ${stuckUsers.length} جلسة معلقة`);
  }
}

// ─── التحقق من الإيميل ────────────────────────────────────────────────────────

async function verifyEmail(email) {
  try {
    const emailRegex = /^[a-zA-Z0-9._%+-]+@gmail\.com$/;
    if (!emailRegex.test(email)) {
      return { valid: false, reason: "صيغة الإيميل غير صحيحة" };
    }
    const mxRecords = await dns.resolveMx("gmail.com");
    if (!mxRecords || mxRecords.length === 0) {
      return { valid: false, reason: "تعذر التحقق من النطاق" };
    }
    const existingTask = await Task.findOne({
      accountEmail: email,
      status: { $in: ["pending", "approved"] },
    });
    if (existingTask) {
      return { valid: false, reason: "هذا الإيميل مستخدم بالفعل في النظام" };
    }
    return { valid: true, reason: "الإيميل صحيح" };
  } catch (err) {
    return { valid: false, reason: "خطأ في التحقق" };
  }
}

// ─── المراجعة التلقائية بعد 72 ساعة ─────────────────────────────────────────

async function autoReviewTasks() {
  const seventyTwoHoursAgo = new Date(Date.now() - 72 * 60 * 60 * 1000);
  const expiredTasks = await Task.find({
    status: "pending",
    submittedAt: { $lte: seventyTwoHoursAgo },
    autoChecked: false,
  });

  for (const task of expiredTasks) {
    const result = await verifyEmail(task.accountEmail);
    task.autoChecked = true;
    task.checkResult = result.reason;

    if (result.valid) {
      task.status = "approved";
      await task.save();
      const user = await User.findOne({ telegramId: task.userId });
      if (user) {
        user.balance += task.amount;
        await user.save();
        bot.sendMessage(task.userId,
          `✅ *تمت الموافقة على حسابك تلقائياً!*\n\n` +
          `📧 الإيميل: \`${task.accountEmail}\`\n` +
          `💵 تم إضافة *$${task.amount} USDT* لرصيدك!\n` +
          `💰 رصيدك الحالي: *$${fmt(user.balance)} USDT*`,
          { parse_mode: "Markdown", ...MAIN_MENU }
        ).catch(() => {});
      }
      bot.sendMessage(ADMIN_ID,
        `✅ *موافقة تلقائية*\n\n📧 \`${task.accountEmail}\`\n👤 \`${task.userId}\`\n💵 $${task.amount} USDT`,
        { parse_mode: "Markdown" }
      ).catch(() => {});
    } else {
      task.status = "rejected";
      await task.save();
      if (task.accountId) {
        await Account.findByIdAndUpdate(task.accountId, {
          assigned: false, assignedTo: null, assignedAt: null,
        });
      }
      const user = await User.findOne({ telegramId: task.userId });
      if (user) {
        bot.sendMessage(task.userId,
          `❌ *تم رفض حسابك تلقائياً*\n\n📧 \`${task.accountEmail}\`\nالسبب: ${result.reason}\n\nيمكنك المحاولة مرة أخرى.`,
          { parse_mode: "Markdown", ...MAIN_MENU }
        ).catch(() => {});
      }
      bot.sendMessage(ADMIN_ID,
        `❌ *رفض تلقائي*\n\n📧 \`${task.accountEmail}\`\n👤 \`${task.userId}\`\nالسبب: ${result.reason}`,
        { parse_mode: "Markdown" }
      ).catch(() => {});
    }
  }
}

setInterval(autoReviewTasks, 60 * 60 * 1000);
setInterval(cleanupStaleSessions, 30 * 60 * 1000);

// ─── Keyboards ────────────────────────────────────────────────────────────────

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
    keyboard: [
      ["✅ تم"],
      ["❌ إلغاء إنشاء الحساب"],
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
  },
};

// ─── Bot ──────────────────────────────────────────────────────────────────────

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ─── /start ───────────────────────────────────────────────────────────────────
bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  const user = await getOrCreateUser(msg);
  const refCode = match && match[1] ? match[1].trim() : null;

  // إعادة تعيين الحالة عند /start لتجنب التعليق
  if (user.state === "awaiting_confirmation") {
    const accountId = user.stateMeta?.accountId;
    if (accountId) {
      await Account.findByIdAndUpdate(accountId, {
        assigned: false, assignedTo: null, assignedAt: null,
      });
    }
    user.state = null;
    user.stateMeta = null;
  } else if (user.state) {
    user.state = null;
    user.stateMeta = null;
  }
  await user.save();

  if (refCode && !user.referredBy) {
    const referrer = await User.findOne({ referralCode: refCode });
    if (referrer && referrer.telegramId !== user.telegramId) {
      user.referredBy = referrer.telegramId;
      await user.save();
      referrer.referralCount += 1;
      await referrer.save();
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
    `4️⃣ اضغط "تم" واحصل على $0.17\n\n` +
    `💵 السعر لكل حساب: *$0.145 - $0.17*`,
    { parse_mode: "Markdown", ...MAIN_MENU }
  );
});

// ─── Messages ─────────────────────────────────────────────────────────────────
bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  // قفل مضاد للـ Race Condition
  if (processingUsers.has(userId)) return;
  processingUsers.add(userId);

  try {
    const user = await getOrCreateUser(msg);

    if (user.banned) {
      bot.sendMessage(chatId, "🚫 تم حظرك من استخدام البوت.");
      return;
    }

    const text = msg.text;

    // ─── أنشئ حساب Gmail جديد ───────────────────────────────────────────────
    if (text === "➕ أنشئ حساب Gmail جديد") {
      const pendingTasks = await Task.find({ userId: user.telegramId, status: "pending" });
      if (pendingTasks.length >= 2) {
        let replyMsg = `⏳ *لديك حسابان قيد المراجعة*\n\n`;
        pendingTasks.forEach((t, i) => {
          replyMsg += `📧 الحساب ${i + 1}: \`${t.accountEmail}\`\n`;
        });
        replyMsg += `\n⚠️ لا يمكنك إنشاء حساب جديد حتى تنتهي مراجعة حساباتك الحالية.`;
        bot.sendMessage(chatId, replyMsg, { parse_mode: "Markdown" });
        return;
      }

      if (user.state === "awaiting_confirmation") {
        bot.sendMessage(chatId,
          `⚠️ *لديك حساب قيد الإنشاء حالياً*\n\nاضغط ✅ *تم* بعد إنشاء الحساب\nأو ❌ *إلغاء إنشاء الحساب* للإلغاء.`,
          { parse_mode: "Markdown", ...CONFIRM_MENU }
        );
        return;
      }

      const account = await Account.findOneAndUpdate(
        { assigned: false },
        { assigned: true, assignedTo: user.telegramId, assignedAt: new Date() },
        { new: true }
      );

      if (!account) {
        bot.sendMessage(chatId,
          `❌ *لا توجد حسابات متاحة حالياً*\n\nيرجى المحاولة لاحقاً.`,
          { parse_mode: "Markdown" }
        );
        return;
      }

      user.state = "awaiting_confirmation";
      user.stateMeta = { accountId: account._id.toString() };
      await user.save();

      bot.sendMessage(chatId,
        `📧 *قم بتسجيل حساب Gmail باستخدام البيانات المحددة*\n\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `👤 الاسم: \`${account.firstName}\`\n` +
        `👤 اللقب: \`${account.lastName}\`\n` +
        `📧 البريد الإلكتروني: \`${account.email}\`\n` +
        `🔑 كلمة المرور: \`${account.password}\`\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `🔒 *تأكد من استخدام البيانات المحددة*\n\n` +
        `بعد إنشاء الحساب اضغط ✅ *تم*`,
        { parse_mode: "Markdown", ...CONFIRM_MENU }
      );
      return;
    }

    // ─── زر تم ──────────────────────────────────────────────────────────────
    if (text === "✅ تم") {
      if (user.state !== "awaiting_confirmation") {
        bot.sendMessage(chatId, "❌ لا يوجد حساب نشط.", MAIN_MENU);
        return;
      }

      const accountId = user.stateMeta?.accountId;
      const account = await Account.findById(accountId);

      if (!account) {
        user.state = null; user.stateMeta = null;
        await user.save();
        bot.sendMessage(chatId, "❌ حدث خطأ. حاول مرة أخرى.", MAIN_MENU);
        return;
      }

      bot.sendMessage(chatId, `🔍 *جاري التحقق من الإيميل...*`, { parse_mode: "Markdown" });

      const verification = await verifyEmail(account.email);

      if (!verification.valid) {
        await Account.findByIdAndUpdate(accountId, {
          assigned: false, assignedTo: null, assignedAt: null,
        });
        user.state = null; user.stateMeta = null;
        await user.save();
        bot.sendMessage(chatId,
          `❌ *تم رفض الحساب تلقائياً*\n\nالسبب: ${verification.reason}\n\nيمكنك المحاولة مرة أخرى.`,
          { parse_mode: "Markdown", ...MAIN_MENU }
        );
        return;
      }

      const task = await Task.create({
        userId: user.telegramId,
        amount: 0.17,
        accountEmail: account.email,
        accountId: account._id,
        submittedAt: new Date(),
      });

      user.state = null; user.stateMeta = null;
      await user.save();

      const remainingPending = await Task.countDocuments({ userId: user.telegramId, status: "pending" });
      const canCreateMore = remainingPending < 2;

      bot.sendMessage(chatId,
        `✅ *تم إرسال طلبك بنجاح!*\n\n` +
        `📧 الإيميل: \`${account.email}\`\n` +
        `💵 المبلغ: *$0.17 USDT*\n\n` +
        `⏳ سيتم المراجعة تلقائياً\n` +
        `ستصلك رسالة عند اكتمال المراجعة.\n\n` +
        (canCreateMore
          ? `💡 يمكنك إنشاء حساب آخر الآن!`
          : `⚠️ وصلت للحد الأقصى (حسابان). انتظر انتهاء المراجعة.`),
        { parse_mode: "Markdown", ...MAIN_MENU }
      );

      // ✅ إشعار الأدمن مع ID المهمة بدل الـ index
      bot.sendMessage(ADMIN_ID,
        `📬 *طلب Gmail جديد*\n\n` +
        `👤 ${user.firstName} (\`${user.telegramId}\`)\n` +
        `📧 الإيميل: \`${account.email}\`\n` +
        `🔑 كلمة المرور: \`${account.password}\`\n` +
        `👤 الاسم: ${account.firstName} ${account.lastName}\n\n` +
        `للموافقة: /approve ${task._id}\n` +
        `للرفض: /reject ${task._id}`,
        { parse_mode: "Markdown" }
      ).catch(() => {});
      return;
    }

    // ─── إلغاء إنشاء الحساب ─────────────────────────────────────────────────
    if (text === "❌ إلغاء إنشاء الحساب") {
      const accountId = user.stateMeta?.accountId;
      if (accountId) {
        await Account.findByIdAndUpdate(accountId, {
          assigned: false, assignedTo: null, assignedAt: null,
        });
      }
      user.state = null; user.stateMeta = null;
      await user.save();
      bot.sendMessage(chatId, "🚫 تم إلغاء إنشاء الحساب.", MAIN_MENU);
      return;
    }

    // ─── حساباتي ────────────────────────────────────────────────────────────
    if (text === "📋 حساباتي") {
      const tasks = await Task.find({ userId: user.telegramId }).sort({ createdAt: -1 }).limit(10);
      if (!tasks.length) {
        bot.sendMessage(chatId, `📋 *لا توجد حسابات بعد*\n\nاضغط "أنشئ حساب Gmail جديد" للبدء!`, { parse_mode: "Markdown", ...MAIN_MENU });
        return;
      }
      let txt = `📋 *حساباتك*\n\n`;
      for (const t of tasks) {
        const statusEmoji = t.status === "approved" ? "✅" : t.status === "rejected" ? "❌" : "⏳";
        const statusText = t.status === "approved" ? "مقبول" : t.status === "rejected" ? "مرفوض" : "قيد المراجعة";
        txt += `${statusEmoji} \`${t.accountEmail}\` — $${fmt(t.amount)} — ${statusText}\n`;
      }
      bot.sendMessage(chatId, txt, { parse_mode: "Markdown", ...MAIN_MENU });
      return;
    }

    // ─── الرصيد ──────────────────────────────────────────────────────────────
    if (text === "💰 الرصيد") {
      const approved = await Task.countDocuments({ userId: user.telegramId, status: "approved" });
      const pending = await Task.countDocuments({ userId: user.telegramId, status: "pending" });
      bot.sendMessage(chatId,
        `💰 *رصيدك*\n\n` +
        `💵 الرصيد: *$${fmt(user.balance)} USDT*\n\n` +
        `✅ حسابات مقبولة: ${approved}\n` +
        `⏳ قيد المراجعة: ${pending}\n` +
        `👥 الإحالات: ${user.referralCount}\n\n` +
        `💸 الحد الأدنى للسحب: *$0.20 USDT*`,
        { parse_mode: "Markdown", ...MAIN_MENU }
      );
      return;
    }

    // ─── الإحالات ────────────────────────────────────────────────────────────
    if (text === "👥 الإحالات الخاصة بي") {
      const botInfo = await bot.getMe();
      const link = `https://t.me/${botInfo.username}?start=${user.referralCode}`;
      bot.sendMessage(chatId,
        `👥 *الإحالات الخاصة بك*\n\n` +
        `🔗 رابطك:\n\`${link}\`\n\n` +
        `👤 إجمالي الإحالات: *${user.referralCount}*`,
        { parse_mode: "Markdown", ...MAIN_MENU }
      );
      return;
    }

    // ─── الإعدادات ───────────────────────────────────────────────────────────
    if (text === "⚙️ الإعدادات") {
      bot.sendMessage(chatId,
        `⚙️ *الإعدادات*\n\n` +
        `👤 الاسم: ${user.firstName}\n` +
        `🆔 ID: \`${user.telegramId}\`\n` +
        `💰 الرصيد: $${fmt(user.balance)}\n\n` +
        `للسحب أرسل: /withdraw`,
        { parse_mode: "Markdown", ...MAIN_MENU }
      );
      return;
    }

    // ─── المساعدة ────────────────────────────────────────────────────────────
    if (text === "💬 مساعدة") {
      bot.sendMessage(chatId,
        `💬 *المساعدة*\n\n` +
        `❓ *كيف أنشئ حساب Gmail؟*\n` +
        `1. افتح accounts.google.com\n` +
        `2. اضغط "إنشاء حساب"\n` +
        `3. أدخل البيانات المعطاة بالضبط\n` +
        `4. أكمل التحقق برقم الهاتف\n` +
        `5. ارجع للبوت واضغط "تم"\n\n` +
        `⚠️ *تنبيهات:*\n` +
        `• استخدم البيانات المحددة فقط\n` +
        `• الحسابات المكررة ستُرفض\n` +
        `• لا تغير كلمة المرور\n\n` +
        `للتواصل مع الدعم: @admin`,
        { parse_mode: "Markdown", ...MAIN_MENU }
      );
      return;
    }

    // ─── السحب: إدخال المبلغ ─────────────────────────────────────────────────
    if (user.state === "awaiting_withdraw_amount") {
      const amount = parseFloat(text.trim());
      if (isNaN(amount) || amount < 0.20) {
        bot.sendMessage(chatId, "❌ الحد الأدنى $0.20. أدخل مبلغاً صحيحاً:");
        return;
      }
      if (amount > user.balance) {
        bot.sendMessage(chatId, `❌ رصيدك *$${fmt(user.balance)}* غير كافٍ.`, { parse_mode: "Markdown" });
        return;
      }
      user.state = "awaiting_withdraw_address";
      user.stateMeta = { amount };
      await user.save();
      bot.sendMessage(chatId, `📮 أدخل عنوان محفظتك *(USDT TRC20)*:`, { parse_mode: "Markdown" });
      return;
    }

    // ─── السحب: إدخال العنوان ────────────────────────────────────────────────
    if (user.state === "awaiting_withdraw_address") {
      const address = text.trim();
      const amount = user.stateMeta?.amount;

      if (!address || address.length < 10) {
        bot.sendMessage(chatId, "❌ عنوان غير صحيح. حاول مرة أخرى:");
        return;
      }

      // التحقق من الرصيد مرة أخرى قبل الخصم
      if (amount > user.balance) {
        user.state = null; user.stateMeta = null;
        await user.save();
        bot.sendMessage(chatId, `❌ رصيدك *$${fmt(user.balance)}* غير كافٍ.`, { parse_mode: "Markdown", ...MAIN_MENU });
        return;
      }

      // ✅ خصم الرصيد وحفظ طلب السحب بصيغة pending (يُعالَج لاحقاً)
      user.balance -= amount;
      user.state = null; user.stateMeta = null;
      await user.save();

      const withdrawal = await Withdrawal.create({
        userId: user.telegramId,
        amount,
        address,
        status: "pending",
      });

      bot.sendMessage(chatId,
        `✅ *تم إرسال طلب السحب!*\n\n` +
        `💵 المبلغ: *$${fmt(amount)} USDT*\n` +
        `📮 العنوان: \`${address}\`\n\n` +
        `⏳ سيتم المعالجة خلال 24 ساعة.`,
        { parse_mode: "Markdown", ...MAIN_MENU }
      );

      bot.sendMessage(ADMIN_ID,
        `💸 *طلب سحب جديد*\n\n` +
        `👤 ${user.firstName} (\`${user.telegramId}\`)\n` +
        `💵 $${fmt(amount)} USDT\n` +
        `📮 \`${address}\`\n\n` +
        `للموافقة: /approvew ${withdrawal._id}\n` +
        `للرفض: /rejectw ${withdrawal._id}`,
        { parse_mode: "Markdown" }
      ).catch(() => {});
      return;
    }

  } finally {
    processingUsers.delete(userId);
  }
});

// ─── أوامر الأدمن ─────────────────────────────────────────────────────────────

// إضافة حساب
bot.onText(/\/addaccount (\S+) (\S+) (\S+) (\S+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const [, firstName, lastName, email, password] = match;
  try {
    await Account.create({ firstName, lastName, email, password });
    const total = await Account.countDocuments({ assigned: false });
    bot.sendMessage(msg.chat.id,
      `✅ *تم إضافة الحساب*\n\n👤 ${firstName} ${lastName}\n📧 \`${email}\`\n🔑 \`${password}\`\n\n📦 الحسابات المتاحة: *${total}*`,
      { parse_mode: "Markdown" }
    );
  } catch {
    bot.sendMessage(msg.chat.id, "❌ الإيميل موجود بالفعل.");
  }
});

// إضافة حسابات بالجملة: /addaccounts firstName lastName email password\nfirstName2 ...
bot.onText(/\/addaccounts (.+)/s, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const lines = match[1].trim().split("\n").filter(l => l.trim());
  let added = 0, failed = 0;
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) { failed++; continue; }
    const [firstName, lastName, email, password] = parts;
    try {
      await Account.create({ firstName, lastName, email, password });
      added++;
    } catch { failed++; }
  }
  const total = await Account.countDocuments({ assigned: false });
  bot.sendMessage(msg.chat.id,
    `📦 *تم إضافة الحسابات*\n\n✅ مضاف: ${added}\n❌ فشل/مكرر: ${failed}\n📦 المتاح الآن: ${total}`,
    { parse_mode: "Markdown" }
  );
});

// ✅ الموافقة على مهمة Gmail بالـ ID
bot.onText(/\/approve (\w+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const task = await Task.findById(match[1]).catch(() => null);
  if (!task) { bot.sendMessage(msg.chat.id, "❌ المهمة غير موجودة."); return; }
  if (task.status !== "pending") { bot.sendMessage(msg.chat.id, `⚠️ تمت معالجتها (${task.status}).`); return; }

  task.status = "approved";
  await task.save();

  const user = await User.findOne({ telegramId: task.userId });
  if (user) {
    user.balance += task.amount;
    await user.save();
    bot.sendMessage(task.userId,
      `✅ *تمت الموافقة على حسابك!*\n\n📧 \`${task.accountEmail}\`\n💵 تم إضافة *$${task.amount} USDT*!\n💰 رصيدك: *$${fmt(user.balance)} USDT*`,
      { parse_mode: "Markdown", ...MAIN_MENU }
    ).catch(() => {});
  }
  bot.sendMessage(msg.chat.id, `✅ تمت الموافقة وإضافة $${task.amount} للمستخدم.`);
});

// ❌ رفض مهمة Gmail بالـ ID
bot.onText(/\/reject (\w+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const task = await Task.findById(match[1]).catch(() => null);
  if (!task) { bot.sendMessage(msg.chat.id, "❌ المهمة غير موجودة."); return; }
  if (task.status !== "pending") { bot.sendMessage(msg.chat.id, `⚠️ تمت معالجتها (${task.status}).`); return; }

  task.status = "rejected";
  await task.save();

  if (task.accountId) {
    await Account.findByIdAndUpdate(task.accountId, {
      assigned: false, assignedTo: null, assignedAt: null,
    });
  }

  const user = await User.findOne({ telegramId: task.userId });
  if (user) {
    bot.sendMessage(task.userId,
      `❌ *تم رفض الحساب*\n\n📧 \`${task.accountEmail}\`\n\nيمكنك المحاولة مرة أخرى.`,
      { parse_mode: "Markdown", ...MAIN_MENU }
    ).catch(() => {});
  }
  bot.sendMessage(msg.chat.id, `❌ تم الرفض وإعادة الحساب للمتاح.`);
});

// ✅ الموافقة على طلب سحب
bot.onText(/\/approvew (\w+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const withdrawal = await Withdrawal.findById(match[1]).catch(() => null);
  if (!withdrawal) { bot.sendMessage(msg.chat.id, "❌ طلب السحب غير موجود."); return; }
  if (withdrawal.status !== "pending") { bot.sendMessage(msg.chat.id, `⚠️ تمت معالجته (${withdrawal.status}).`); return; }

  withdrawal.status = "approved";
  await withdrawal.save();

  const user = await User.findOne({ telegramId: withdrawal.userId });
  if (user) {
    bot.sendMessage(withdrawal.userId,
      `✅ *تمت الموافقة على طلب السحب!*\n\n💵 $${fmt(withdrawal.amount)} USDT\n📮 \`${withdrawal.address}\``,
      { parse_mode: "Markdown", ...MAIN_MENU }
    ).catch(() => {});
  }
  bot.sendMessage(msg.chat.id, `✅ تمت الموافقة على طلب السحب.`);
});

// ❌ رفض طلب سحب (مع إعادة الرصيد)
bot.onText(/\/rejectw (\w+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const withdrawal = await Withdrawal.findById(match[1]).catch(() => null);
  if (!withdrawal) { bot.sendMessage(msg.chat.id, "❌ طلب السحب غير موجود."); return; }
  if (withdrawal.status !== "pending") { bot.sendMessage(msg.chat.id, `⚠️ تمت معالجته (${withdrawal.status}).`); return; }

  withdrawal.status = "rejected";
  await withdrawal.save();

  // إعادة الرصيد للمستخدم عند الرفض
  const user = await User.findOne({ telegramId: withdrawal.userId });
  if (user) {
    user.balance += withdrawal.amount;
    await user.save();
    bot.sendMessage(withdrawal.userId,
      `❌ *تم رفض طلب السحب*\n\n💵 تم إعادة $${fmt(withdrawal.amount)} USDT لرصيدك.\n💰 رصيدك الآن: $${fmt(user.balance)} USDT`,
      { parse_mode: "Markdown", ...MAIN_MENU }
    ).catch(() => {});
  }
  bot.sendMessage(msg.chat.id, `❌ تم رفض السحب وإعادة الرصيد للمستخدم.`);
});

// الطلبات المعلقة
bot.onText(/\/pending/, async (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  const tasks = await Task.find({ status: "pending" }).sort({ createdAt: 1 }).limit(20);
  if (!tasks.length) { bot.sendMessage(msg.chat.id, "✅ لا توجد طلبات معلقة."); return; }

  // جلب البيانات بكفاءة
  const userIds = [...new Set(tasks.map(t => t.userId))];
  const accountIds = tasks.map(t => t.accountId).filter(Boolean);
  const [users, accounts] = await Promise.all([
    User.find({ telegramId: { $in: userIds } }, "firstName telegramId"),
    Account.find({ _id: { $in: accountIds } }, "password"),
  ]);
  const userMap = Object.fromEntries(users.map(u => [u.telegramId, u]));
  const accountMap = Object.fromEntries(accounts.map(a => [a._id.toString(), a]));

  let text = `⏳ *الطلبات المعلقة (${tasks.length})*\n\n`;
  for (const t of tasks) {
    const u = userMap[t.userId];
    const acc = accountMap[t.accountId?.toString()];
    const timeLeft = Math.ceil((t.submittedAt.getTime() + 72 * 60 * 60 * 1000 - Date.now()) / (60 * 60 * 1000));
    text += `📧 \`${t.accountEmail}\`\n🔑 \`${acc?.password || "غير متاح"}\`\n👤 ${u?.firstName || "؟"} (\`${t.userId}\`)\n⏰ متبقي: ${timeLeft > 0 ? timeLeft : 0} ساعة\n✅ /approve ${t._id}  ❌ /reject ${t._id}\n\n`;
  }
  bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
});

// إحصائيات الحسابات
bot.onText(/\/accounts/, async (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  const available = await Account.countDocuments({ assigned: false });
  const assigned = await Account.countDocuments({ assigned: true });
  bot.sendMessage(msg.chat.id,
    `📦 *الحسابات*\n\n✅ متاح: *${available}*\n🔒 مُعيَّن: *${assigned}*\n📊 الإجمالي: *${available + assigned}*`,
    { parse_mode: "Markdown" }
  );
});

// إضافة رصيد
bot.onText(/\/addbalance (\d+) ([\d.]+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const user = await User.findOne({ telegramId: parseInt(match[1]) });
  if (!user) { bot.sendMessage(msg.chat.id, "❌ المستخدم غير موجود."); return; }
  user.balance += parseFloat(match[2]);
  await user.save();
  bot.sendMessage(msg.chat.id, `✅ تم. الرصيد الجديد: $${fmt(user.balance)}`);
  bot.sendMessage(user.telegramId, `🎁 تم إضافة $${match[2]} لرصيدك!\nرصيدك: $${fmt(user.balance)}`, MAIN_MENU).catch(() => {});
});

// حظر
bot.onText(/\/ban (\d+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const user = await User.findOne({ telegramId: parseInt(match[1]) });
  if (!user) { bot.sendMessage(msg.chat.id, "❌ غير موجود."); return; }
  user.banned = true; await user.save();
  bot.sendMessage(msg.chat.id, `🚫 تم حظر ${user.firstName}.`);
  bot.sendMessage(user.telegramId, "🚫 تم حظرك.").catch(() => {});
});

// رفع الحظر
bot.onText(/\/unban (\d+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const user = await User.findOne({ telegramId: parseInt(match[1]) });
  if (!user) { bot.sendMessage(msg.chat.id, "❌ غير موجود."); return; }
  user.banned = false; await user.save();
  bot.sendMessage(msg.chat.id, `✅ تم رفع الحظر عن ${user.firstName}.`);
  bot.sendMessage(user.telegramId, "✅ تم رفع الحظر!", MAIN_MENU).catch(() => {});
});

// قائمة المستخدمين
bot.onText(/\/users/, async (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  const users = await User.find().sort({ createdAt: -1 }).limit(20);
  let text = `👥 *المستخدمون*\n\n`;
  users.forEach((u, i) => {
    text += `${i + 1}. ${u.firstName}${u.banned ? " 🚫" : ""} | $${fmt(u.balance)} | \`${u.telegramId}\`\n`;
  });
  bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
});

// الإحصائيات
bot.onText(/\/stats/, async (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  const [totalUsers, pendingTasks, approvedTasks, availableAccounts, pendingWithdrawals, paid] = await Promise.all([
    User.countDocuments(),
    Task.countDocuments({ status: "pending" }),
    Task.countDocuments({ status: "approved" }),
    Account.countDocuments({ assigned: false }),
    Withdrawal.countDocuments({ status: "pending" }),
    Task.aggregate([{ $match: { status: "approved" } }, { $group: { _id: null, total: { $sum: "$amount" } } }]),
  ]);
  bot.sendMessage(msg.chat.id,
    `📊 *الإحصائيات*\n\n` +
    `👤 المستخدمون: *${totalUsers}*\n` +
    `📦 الحسابات المتاحة: *${availableAccounts}*\n` +
    `✅ طلبات مقبولة: *${approvedTasks}*\n` +
    `⏳ قيد المراجعة: *${pendingTasks}*\n` +
    `💸 طلبات سحب معلقة: *${pendingWithdrawals}*\n` +
    `💵 إجمالي المدفوع: *$${fmt(paid[0]?.total || 0)} USDT*`,
    { parse_mode: "Markdown" }
  );
});

// بث رسالة
bot.onText(/\/broadcast (.+)/s, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const users = await User.find({}, "telegramId");
  let sent = 0, failed = 0;
  for (const u of users) {
    try {
      await bot.sendMessage(u.telegramId, `📢 *رسالة من الإدارة*\n\n${match[1]}`, { parse_mode: "Markdown" });
      sent++;
    } catch { failed++; }
  }
  bot.sendMessage(msg.chat.id, `📢 ✅ ${sent} نجح | ❌ ${failed} فشل`);
});

// طلبات السحب المعلقة
bot.onText(/\/withdrawals/, async (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  const wds = await Withdrawal.find({ status: "pending" }).limit(20);
  if (!wds.length) { bot.sendMessage(msg.chat.id, "✅ لا توجد طلبات سحب."); return; }

  const userIds = [...new Set(wds.map(w => w.userId))];
  const users = await User.find({ telegramId: { $in: userIds } }, "firstName telegramId");
  const userMap = Object.fromEntries(users.map(u => [u.telegramId, u]));

  let text = `💸 *طلبات السحب المعلقة (${wds.length})*\n\n`;
  for (const w of wds) {
    const u = userMap[w.userId];
    text += `👤 ${u?.firstName || "؟"} (\`${w.userId}\`)\n💵 $${fmt(w.amount)}\n📮 \`${w.address}\`\n✅ /approvew ${w._id}  ❌ /rejectw ${w._id}\n\n`;
  }
  bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
});

// /withdraw
bot.onText(/\/withdraw/, async (msg) => {
  const user = await getOrCreateUser(msg);
  if (user.balance < 0.20) {
    bot.sendMessage(msg.chat.id, `❌ رصيدك *$${fmt(user.balance)}* أقل من الحد الأدنى $0.20`, { parse_mode: "Markdown" });
    return;
  }
  user.state = "awaiting_withdraw_amount";
  user.stateMeta = null;
  await user.save();
  bot.sendMessage(msg.chat.id, `💸 *طلب سحب*\n\nرصيدك: *$${fmt(user.balance)} USDT*\nأدخل المبلغ:`, { parse_mode: "Markdown" });
});

// ─── الاتصال بقاعدة البيانات ──────────────────────────────────────────────────

mongoose.connection.on("connected", () => console.log("✅ MongoDB connected"));
mongoose.connection.on("error", err => console.error("⚠️ MongoDB error:", err.message));
mongoose.connection.on("disconnected", () => console.warn("⚠️ MongoDB disconnected"));

mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 10000 })
  .catch(err => console.error("❌ MongoDB connection failed:", err.message));

console.log("🤖 Bot is running...");

const PORT = process.env.PORT || 8080;
http.createServer((req, res) => {
  res.writeHead(200); res.end(JSON.stringify({ status: "ok" }));
}).listen(PORT, () => console.log(`🌐 HTTP server on port ${PORT}`));

bot.on("polling_error", err => console.error("Polling error:", err.message));
process.on("SIGTERM", async () => {
  await bot.stopPolling();
  await mongoose.disconnect();
  process.exit(0);
});
