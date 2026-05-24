
# Read the current file
with open('/mnt/agents/output/bot.js', 'r', encoding='utf-8') as f:
    code = f.read()

# ═══════════════════════════════════════════════════════════════════════════════
# ═══ 🥇 LEVEL SYSTEM + 🥈 COUNTDOWN + 🥉 RATE LIMITING ══════════════════════════
# ═══════════════════════════════════════════════════════════════════════════════

# 1. Add Level System constants at the top (after environment variables)
old_env = '''const MIN_WITHDRAW = 0.20;
const VERIFY_HOURS = 72;
const ASSIGN_EXPIRE_MINUTES = 20;'''

new_env = '''const MIN_WITHDRAW = 0.20;
const VERIFY_HOURS = 72;
const ASSIGN_EXPIRE_MINUTES = 20;

// ─── Level System ────────────────────────────────────────────────────────────
const LEVELS = [
  { name: "🥉 Bronze", minAccounts: 0, price: 0.145, color: "#CD7F32" },
  { name: "🥈 Silver", minAccounts: 10, price: 0.17, color: "#C0C0C0" },
  { name: "🥇 Gold", minAccounts: 50, price: 0.20, color: "#FFD700" },
  { name: "💎 Diamond", minAccounts: 200, price: 0.25, color: "#B9F2FF" },
];

const RATE_LIMIT_SECONDS = 5; // ⏱️ Rate limit between requests

// ─── Rate Limiting Storage ───────────────────────────────────────────────────
global.rateLimits = global.rateLimits || {};'''

code = code.replace(old_env, new_env)

# 2. Add helper functions for levels and rate limiting (before getOrCreateUser)
old_helpers = '''// ─── Helpers ──────────────────────────────────────────────────────────────────
const genReferralCode = (id) => "REF" + id.toString(36).toUpperCase();'''

new_helpers = '''// ─── Level System Helpers ────────────────────────────────────────────────────
function getUserLevel(approvedCount) {
  for (let i = LEVELS.length - 1; i >= 0; i--) {
    if (approvedCount >= LEVELS[i].minAccounts) {
      return LEVELS[i];
    }
  }
  return LEVELS[0];
}

function getUserPrice(approvedCount) {
  return getUserLevel(approvedCount).price;
}

// ─── Rate Limiting Helper ─────────────────────────────────────────────────────
function checkRateLimit(userId) {
  const now = Date.now();
  const lastRequest = global.rateLimits[userId] || 0;
  const diff = (now - lastRequest) / 1000;
  
  if (diff < RATE_LIMIT_SECONDS) {
    const wait = Math.ceil(RATE_LIMIT_SECONDS - diff);
    return { allowed: false, wait };
  }
  
  global.rateLimits[userId] = now;
  return { allowed: true, wait: 0 };
}

// ─── Countdown Helper ────────────────────────────────────────────────────────
function getRemainingTime(assignedAt, expireMinutes) {
  const expireTime = new Date(assignedAt).getTime() + expireMinutes * 60 * 1000;
  const now = Date.now();
  const remaining = Math.max(0, expireTime - now);
  
  const minutes = Math.floor(remaining / 60000);
  const seconds = Math.floor((remaining % 60000) / 1000);
  
  return { minutes, seconds, totalMs: remaining };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const genReferralCode = (id) => "REF" + id.toString(36).toUpperCase();'''

code = code.replace(old_helpers, new_helpers)

# 3. Update the "أنشئ حساب Gmail جديد" section with rate limiting + countdown + dynamic price
old_create = '''    // ── أنشئ حساب Gmail جديد ──────────────────────────────────────────────────
    if (text === "➕ أنشئ حساب Gmail جديد") {
      const account = await Account.findOneAndUpdate(
        { assigned: false },
        { 
          $set: { 
            assigned: true, 
            assignedTo: user.telegramId, 
            assignedAt: new Date() 
          } 
        },
        { new: true }
      );

      if (!account) {
        await bot.sendMessage(chatId,
          `❌ *لا توجد حسابات متاحة حالياً*\n\nيرجى المحاولة لاحقاً أو التواصل مع الإدارة.`,
          { parse_mode: "Markdown" }
        );
        return;
      }

      const confirmKeyboard = {
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ تم", callback_data: `sell_${account.email}` }],
            [{ text: "🚫 إلغاء التسجيل", callback_data: `cancel_${account.email}` }],
            [{ text: "❓ كيفية إنشاء حساب", callback_data: "help_create" }],
          ],
        },
      };

      await bot.sendMessage(chatId,
        `📧 *قم بتسجيل حساب Gmail باستخدام البيانات المحددة، واحصل على $0.145 إلى $0.17*\n\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `👤 الاسم: \`${account.firstName}\`\n` +
        `👤 اللقب: \`${account.lastName}\`\n` +
        `🎂 تاريخ الميلاد: \`${account.birthdate || "01.01.1990"}\`\n` +
        `📧 البريد الإلكتروني: \`${account.email}\`\n` +
        `🔑 كلمة المرور: \`${account.password}\`\n` +
        `📩 إيميل الاستعادة: \`${RECOVERY_EMAIL}\`\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `🔒 *تأكد من استخدام البيانات المحددة وإضافة إيميل الاستعادة، وإلا فلن يتم الدفع مقابل الحساب*`,
        { parse_mode: "Markdown", ...confirmKeyboard }
      );
      return;
    }'''

new_create = '''    // ── أنشئ حساب Gmail جديد ──────────────────────────────────────────────────
    if (text === "➕ أنشئ حساب Gmail جديد") {
      // 🥉 Rate Limiting Check
      const rateCheck = checkRateLimit(user.telegramId);
      if (!rateCheck.allowed) {
        await bot.sendMessage(chatId,
          `⏳ *انتظر ${rateCheck.wait} ثوانٍ*\n\nلا يمكن طلب حساب جديد فوراً.`,
          { parse_mode: "Markdown" }
        );
        return;
      }

      // 🥇 Get user level and price
      const approvedCount = await Task.countDocuments({ 
        userId: user.telegramId, 
        status: "approved" 
      });
      const level = getUserLevel(approvedCount);
      const price = level.price;

      const account = await Account.findOneAndUpdate(
        { assigned: false },
        { 
          $set: { 
            assigned: true, 
            assignedTo: user.telegramId, 
            assignedAt: new Date() 
          } 
        },
        { new: true }
      );

      if (!account) {
        await bot.sendMessage(chatId,
          `❌ *لا توجد حسابات متاحة حالياً*\n\nيرجى المحاولة لاحقاً أو التواصل مع الإدارة.`,
          { parse_mode: "Markdown" }
        );
        return;
      }

      // 🥈 Calculate countdown
      const countdown = getRemainingTime(account.assignedAt, ASSIGN_EXPIRE_MINUTES);

      const confirmKeyboard = {
        reply_markup: {
          inline_keyboard: [
            [{ text: `✅ تم - اربح $${price}`, callback_data: `sell_${account.email}` }],
            [{ text: "🚫 إلغاء التسجيل", callback_data: `cancel_${account.email}` }],
            [{ text: "❓ كيفية إنشاء حساب", callback_data: "help_create" }],
          ],
        },
      };

      await bot.sendMessage(chatId,
        `📧 *قم بتسجيل حساب Gmail واحصل على $${price}*\n\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `👤 الاسم: \`${account.firstName}\`\n` +
        `👤 اللقب: \`${account.lastName}\`\n` +
        `🎂 تاريخ الميلاد: \`${account.birthdate || "01.01.1990"}\`\n` +
        `📧 البريد الإلكتروني: \`${account.email}\`\n` +
        `🔑 كلمة المرور: \`${account.password}\`\n` +
        `📩 إيميل الاستعادة: \`${RECOVERY_EMAIL}\`\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `⏰ *العد التنازلي: ${countdown.minutes}:${String(countdown.seconds).padStart(2, '0')}*\n` +
        `🏆 *مستواك: ${level.name}*\n` +
        `💰 *سعر البيع: $${price}*\n\n` +
        `🔒 *تأكد من استخدام البيانات المحددة وإضافة إيميل الاستعادة*`,
        { parse_mode: "Markdown", ...confirmKeyboard }
      );
      return;
    }'''

code = code.replace(old_create, new_create)

# 4. Update the sell callback to use dynamic price
old_sell = '''    // ── Sell Account ───────────────────────────────────────────────────────────
    if (data.startsWith("sell_")) {
      const email = data.replace("sell_", "");
      
      const account = await Account.findOne({ 
        email: email,
        assignedTo: user.telegramId,
        assigned: true 
      });

      if (!account) {
        await bot.editMessageText(
          `❌ انتهت صلاحية البيانات أو تم البيع مسبقاً. اضغط 'أنشئ حساب Gmail جديد' مجدداً.`,
          { chat_id: chatId, message_id: query.message.message_id, parse_mode: "Markdown" }
        ).catch(() => {});
        return;
      }

      await Account.deleteOne({ _id: account._id });
      
      const task = await Task.create({
        userId: user.telegramId,
        amount: 0.17,
        accountEmail: account.email,
        accountPassword: encrypt(account.password),
        accountFirstName: account.firstName,
        accountLastName: account.lastName,
      });

      await bot.editMessageText(
        `✅ *تم إرسال الطلب بنجاح!*\n\n📧 \`${account.email}\`\n💵 المبلغ: *$0.17 USDT*\n\n⏳ سيتم المراجعة خلال 24 ساعة.\n🔍 بعدها 72 ساعة تحقق.`,
        { chat_id: chatId, message_id: query.message.message_id, parse_mode: "Markdown" }
      ).catch(() => {});

      bot.sendMessage(ADMIN_ID,
        `📬 *طلب Gmail جديد*\n\n` +
        `👤 ${user.firstName} (\`${user.telegramId}\`)\n` +
        `📧 الإيميل: \`${account.email}\`\n` +
        `🔑 كلمة المرور: \`${account.password}\`\n` +
        `👤 الاسم: ${account.firstName} ${account.lastName}\n\n` +
        `✅ /approve ${user.telegramId} ${task._id}\n` +
        `❌ /reject ${user.telegramId} ${task._id}`,
        { parse_mode: "Markdown" }
      ).catch(() => {});
      return;
    }'''

new_sell = '''    // ── Sell Account ───────────────────────────────────────────────────────────
    if (data.startsWith("sell_")) {
      const email = data.replace("sell_", "");
      
      const account = await Account.findOne({ 
        email: email,
        assignedTo: user.telegramId,
        assigned: true 
      });

      if (!account) {
        await bot.editMessageText(
          `❌ انتهت صلاحية البيانات أو تم البيع مسبقاً. اضغط 'أنشئ حساب Gmail جديد' مجدداً.`,
          { chat_id: chatId, message_id: query.message.message_id, parse_mode: "Markdown" }
        ).catch(() => {});
        return;
      }

      // 🥇 Get dynamic price based on user level
      const approvedCount = await Task.countDocuments({ 
        userId: user.telegramId, 
        status: "approved" 
      });
      const level = getUserLevel(approvedCount);
      const price = level.price;

      await Account.deleteOne({ _id: account._id });
      
      const task = await Task.create({
        userId: user.telegramId,
        amount: price,
        accountEmail: account.email,
        accountPassword: encrypt(account.password),
        accountFirstName: account.firstName,
        accountLastName: account.lastName,
      });

      await bot.editMessageText(
        `✅ *تم إرسال الطلب بنجاح!*\n\n` +
        `📧 \`${account.email}\`\n` +
        `💵 المبلغ: *$${price} USDT*\n` +
        `🏆 المستوى: ${level.name}\n\n` +
        `⏳ سيتم المراجعة خلال 24 ساعة.\n` +
        `🔍 بعدها 72 ساعة تحقق.`,
        { chat_id: chatId, message_id: query.message.message_id, parse_mode: "Markdown" }
      ).catch(() => {});

      bot.sendMessage(ADMIN_ID,
        `📬 *طلب Gmail جديد*\n\n` +
        `👤 ${user.firstName} (\`${user.telegramId}\`) - ${level.name}\n` +
        `📧 الإيميل: \`${account.email}\`\n` +
        `🔑 كلمة المرور: \`${account.password}\`\n` +
        `👤 الاسم: ${account.firstName} ${account.lastName}\n` +
        `💰 السعر: $${price}\n\n` +
        `✅ /approve ${user.telegramId} ${task._id}\n` +
        `❌ /reject ${user.telegramId} ${task._id}`,
        { parse_mode: "Markdown" }
      ).catch(() => {});
      return;
    }'''

code = code.replace(old_sell, new_sell)

# 5. Update الرصيد section to show level info
old_balance = '''    // ── الرصيد ────────────────────────────────────────────────────────────────
    if (text === "💰 الرصيد") {
      const [approved, pending, verifying] = await Promise.all([
        Task.countDocuments({ userId: user.telegramId, status: "approved" }),
        Task.countDocuments({ userId: user.telegramId, status: "pending" }),
        Task.countDocuments({ userId: user.telegramId, status: "verifying" })
      ]);
      
      await bot.sendMessage(chatId,
        `💰 *رصيدك*\n\n` +
        `💵 الرصيد: *$${fmt(user.balance)} USDT*\n\n` +
        `✅ حسابات مقبولة: ${approved}\n` +
        `🔍 قيد التحقق (72 ساعة): ${verifying}\n` +
        `⏳ قيد المراجعة: ${pending}\n\n` +
        `💸 الحد الأدنى للسحب: *$${fmt(MIN_WITHDRAW)} USDT*`,
        { parse_mode: "Markdown", ...MAIN_MENU }
      );
      return;
    }'''

new_balance = '''    // ── الرصيد ────────────────────────────────────────────────────────────────
    if (text === "💰 الرصيد") {
      const [approved, pending, verifying] = await Promise.all([
        Task.countDocuments({ userId: user.telegramId, status: "approved" }),
        Task.countDocuments({ userId: user.telegramId, status: "pending" }),
        Task.countDocuments({ userId: user.telegramId, status: "verifying" })
      ]);
      
      // 🥇 Get user level
      const level = getUserLevel(approved);
      const nextLevel = LEVELS.find(l => l.minAccounts > approved);
      const progress = nextLevel 
        ? `${approved}/${nextLevel.minAccounts} → ${nextLevel.name}` 
        : "🎉 أعلى مستوى!";
      
      await bot.sendMessage(chatId,
        `💰 *رصيدك*\n\n` +
        `🏆 *المستوى: ${level.name}*\n` +
        `📈 ${progress}\n\n` +
        `💵 الرصيد: *$${fmt(user.balance)} USDT*\n\n` +
        `✅ حسابات مقبولة: ${approved}\n` +
        `🔍 قيد التحقق (72 ساعة): ${verifying}\n` +
        `⏳ قيد المراجعة: ${pending}\n\n` +
        `💰 *سعر البيع الحالي: $${level.price}*\n` +
        `💸 الحد الأدنى للسحب: *$${fmt(MIN_WITHDRAW)} USDT*`,
        { parse_mode: "Markdown", ...MAIN_MENU }
      );
      return;
    }'''

code = code.replace(old_balance, new_balance)

# 6. Update /start message to mention levels
old_start = '''    await bot.sendMessage(msg.chat.id,
      `👋 *أهلاً ${user.firstName}!*\n\n` +
      `💰 *اكسب من إنشاء حسابات Gmail!*\n\n` +
      `📌 *كيف يعمل البوت:*\n` +
      `1️⃣ اضغط "أنشئ حساب Gmail جديد"\n` +
      `2️⃣ ستحصل على بيانات احترافية جاهزة\n` +
      `3️⃣ *أنشئ الحساب على Gmail* باستخدام البيانات\n` +
      `4️⃣ اضغط "✅ تم" لبيع الحساب لنا\n` +
      `5️⃣ احصل على *$0.17* بعد التحقق (72 ساعة)\n\n` +
      `💵 سعر الشراء لكل حساب: *$0.145 - $0.17*\n\n` +
      `✅ يمكنك إنشاء *عدة حسابات* وبيعها!\n` +
      `🔒 إيميل الاستعادة المطلوب: \`${RECOVERY_EMAIL}\``,
      { parse_mode: "Markdown", ...MAIN_MENU }
    );'''

new_start = '''    await bot.sendMessage(msg.chat.id,
      `👋 *أهلاً ${user.firstName}!*\n\n` +
      `💰 *اكسب من إنشاء حسابات Gmail!*\n\n` +
      `📌 *كيف يعمل البوت:*\n` +
      `1️⃣ اضغط "أنشئ حساب Gmail جديد"\n` +
      `2️⃣ ستحصل على بيانات احترافية جاهزة\n` +
      `3️⃣ *أنشئ الحساب على Gmail* باستخدام البيانات\n` +
      `4️⃣ اضغط "✅ تم" لبيع الحساب لنا\n` +
      `5️⃣ احصل على *$0.145 - $0.25* بعد التحقق\n\n` +
      `🏆 *نظام المستويات:*\n` +
      `🥉 Bronze (0): $0.145\n` +
      `🥈 Silver (10): $0.17\n` +
      `🥇 Gold (50): $0.20\n` +
      `💎 Diamond (200): $0.25\n\n` +
      `✅ يمكنك إنشاء *عدة حسابات* وبيعها!\n` +
      `🔒 إيميل الاستعادة المطلوب: \`${RECOVERY_EMAIL}\``,
      { parse_mode: "Markdown", ...MAIN_MENU }
    );'''

code = code.replace(old_start, new_start)

with open('/mnt/agents/output/bot.js', 'w', encoding='utf-8') as f:
    f.write(code)

print("✅ تم تنفيذ الثلاثة اقتراحات:")
print("  🥇 نظام المستويات (Bronze → Diamond)")
print("  🥈 عداد تنازلي (⏰ 20:00)")
print("  🥉 Rate Limiting (5 ثوانٍ)")
print(f"📊 حجم الملف: {len(code)} حرف")