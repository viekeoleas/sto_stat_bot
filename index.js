require('dotenv').config();
const { Telegraf, Scenes, session, Markup } = require('telegraf');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const creds = require('./google-creds.json');

// --- НАЛАШТУВАННЯ ---
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_TITLE = 'Звіти'; // ВАЖЛИВО: Назва аркуша в таблиці має бути такою ж!

// --- КЛАВІАТУРИ ---
const mainMenu = Markup.keyboard([
    ['Додати замовлення', 'Погасити борг'],
    ['Пошук за номером', 'Звіти']
]).resize();

const reportsMenu = Markup.keyboard([
    ['За сьогодні', 'За тиждень'],
    ['Назад']
]).resize();

// --- ДОПОМІЖНІ ФУНКЦІЇ ДЛЯ ДАТ ---

// Перетворюємо рядок "19.12.2025" на справжній об'єкт дати JavaScript
function parseDate(dateStr) {
    if (!dateStr) return null;
    const [day, month, year] = dateStr.split('.');
    // Місяці в JS починаються з 0 (січень - 0)
    return new Date(year, month - 1, day);
}

// Перевірка: чи входить дата в поточний тиждень (Пн - Нд)
function isThisWeek(dateObj) {
    const now = new Date();
    const currentDay = now.getDay(); // 0 (Нд) ... 6 (Сб)
    
    // Обчислюємо понеділок поточного тижня
    const distanceToMonday = currentDay === 0 ? 6 : currentDay - 1;
    
    const monday = new Date(now);
    monday.setDate(now.getDate() - distanceToMonday);
    monday.setHours(0, 0, 0, 0); // Обнуляємо час

    // Обчислюємо кінець тижня (наступний понеділок)
    const nextMonday = new Date(monday);
    nextMonday.setDate(monday.getDate() + 7);

    // Дата має бути більша або дорівнювати Понеділку І менша за наступний Понеділок
    return dateObj >= monday && dateObj < nextMonday;
}

// --- ФУНКЦІЯ ЧИТАННЯ ТАБЛИЦІ (Спільна для всіх звітів) ---
async function getRows() {
    const serviceAccountAuth = new JWT({
        email: creds.client_email,
        key: creds.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle[SHEET_TITLE];
    if (!sheet) throw new Error(`Аркуш "${SHEET_TITLE}" не знайдено. Перевір назву в таблиці!`);
    return await sheet.getRows();
}

// --- ЗВІТ ЗА СЬОГОДНІ ---
async function getDailyReport(ctx) {
    await ctx.reply('🔍 Рахую за сьогодні...');
    const rows = await getRows();
    const today = new Date().toLocaleDateString('uk-UA'); // Український формат дати

    // Фільтр
    const filteredRows = rows.filter(row => row.get('Дата') === today);

    sendReport(ctx, filteredRows, `за сьогодні (${today})`);
}

// --- ЗВІТ ЗА ТИЖДЕНЬ ---
async function getWeeklyReport(ctx) {
    await ctx.reply('🔍 Рахую за цей тиждень (з понеділка)...');
    const rows = await getRows();

    // Фільтр
    const filteredRows = rows.filter(row => {
        const rowDate = parseDate(row.get('Дата'));
        return rowDate && isThisWeek(rowDate);
    });

    sendReport(ctx, filteredRows, 'за поточний тиждень');
}

// --- ФУНКЦІЯ ВІДПРАВКИ ЗВІТУ ---
function sendReport(ctx, rows, periodName) {
    if (rows.length === 0) {
        return ctx.reply(`📅 Записів ${periodName} не знайдено.`, reportsMenu);
    }

    let totalCash = 0; // Живі гроші
    let totalDebt = 0; // Борги
    let reportText = `📊 **Звіт ${periodName}:**\n\n`;

    rows.forEach((row, index) => {
        const date = row.get('Дата');
        const car = row.get('Марка');
        const price = parseInt(row.get('Ціна')) || 0; // Зверни увагу: поле 'Ціна'
        const status = row.get('Статус') || 'Оплачено';
        
        // Перевіряємо статус і рахуємо різні каси
        let icon = '🟢';
        if (status.toLowerCase().includes('борг')) {
            totalDebt += price;
            icon = '🔴';
        } else {
            totalCash += price;
        }
        
        // Додаємо рядок у звіт
        reportText += `${index + 1}. ${icon} ${date} | ${car} — ${price}\n`;
    });

    // Підсумкова статистика
    reportText += `\n💰 **Каса (на руках): ${totalCash} грн**`;
    if (totalDebt > 0) {
        reportText += `\n❗️ **В борг: ${totalDebt} грн**`;
        reportText += `\n🏁 **Всього робіт на: ${totalCash + totalDebt} грн**`;
    }

    ctx.reply(reportText, { parse_mode: 'Markdown', ...reportsMenu });
}

// --- ФУНКЦІЯ ЗАПИСУ ---
async function appendToSheet(data) {
    const serviceAccountAuth = new JWT({
        email: creds.client_email,
        key: creds.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);
    await doc.loadInfo(); 
    const sheet = doc.sheetsByTitle[SHEET_TITLE];
    if (!sheet) throw new Error(`Аркуш "${SHEET_TITLE}" не знайдено.`);
    await sheet.addRow(data);
}

// --- СЦЕНА ОПИТУВАННЯ ---
const reportWizard = new Scenes.WizardScene(
    'REPORT_SCENE',

    // КРОК 1: Марка
    (ctx) => {
        ctx.reply('🚚 Яка машина? (Марка):', Markup.keyboard([['Скасувати']]).resize());
        ctx.wizard.state.data = {}; 
        return ctx.wizard.next();
    },

    // КРОК 2: Номер
    (ctx) => {
        if (ctx.message.text === 'Скасувати') return leaveScene(ctx);
        ctx.wizard.state.data.car = ctx.message.text;
        ctx.reply('🔢 Який держ. номер?');
        return ctx.wizard.next();
    },

    // КРОК 3: Робота
    (ctx) => {
        if (ctx.message.text === 'Скасувати') return leaveScene(ctx);
        ctx.wizard.state.data.number = ctx.message.text;
        ctx.reply('🛠 Що робили? (Коротко):');
        return ctx.wizard.next();
    },

    // КРОК 4: Ціна
    (ctx) => {
        if (ctx.message.text === 'Скасувати') return leaveScene(ctx);
        ctx.wizard.state.data.work = ctx.message.text;
        ctx.reply('💰 Скільки грошей? (Тільки цифри):');
        return ctx.wizard.next();
    },

    // КРОК 5: Статус оплати
    (ctx) => {
        if (ctx.message.text === 'Скасувати') return leaveScene(ctx);
        ctx.wizard.state.data.price = ctx.message.text;
        
        ctx.reply(
            '💳 Оплатили відразу чи в борг?', 
            Markup.keyboard([
                ['✅ Оплачено', '❗️ Борг'],
                ['Скасувати']
            ]).resize()
        );
        return ctx.wizard.next();
    },

    // КРОК 6: Фінал (Запис)
    async (ctx) => {
        if (ctx.message.text === 'Скасувати') return leaveScene(ctx);
        
        const statusRaw = ctx.message.text;
        // Перевіряємо, чи є слово "Борг" у відповіді
        const status = statusRaw.includes('Борг') ? 'Борг' : 'Оплачено';
        
        ctx.wizard.state.data.status = status;
        
        const { car, number, work, price } = ctx.wizard.state.data;
        const date = new Date().toLocaleDateString('uk-UA');

        await ctx.reply('⏳ Записую...');

        try {
            await appendToSheet({
                'Дата': date,
                'Марка': car,
                'Номер': number,
                'Робота': work,  // Змінив ключ на український
                'Ціна': price,   // Змінив ключ на український
                'Статус': status
            });
            
            const statusIcon = status === 'Борг' ? '🔴 БОРГ' : '🟢 Оплачено';
            
            await ctx.reply(
                `✅ **Записано!**\n${car} ${number}\n💰 ${price} грн\n${statusIcon}`, 
                { parse_mode: 'Markdown', ...mainMenu } 
            );
        } catch (e) {
            console.error(e);
            await ctx.reply('❌ Помилка запису.', mainMenu);
        }

        return ctx.scene.leave();
    }
);

// --- СЦЕНА ПОШУКУ ---
const searchScene = new Scenes.WizardScene(
    'SEARCH_SCENE',
    
    // Крок 1: Питаємо номер
    (ctx) => {
        ctx.reply('🔍 Введіть номер машини (або частину):', Markup.keyboard([['Скасувати']]).resize());
        return ctx.wizard.next();
    },

    // Крок 2: Шукаємо
    async (ctx) => {
        if (ctx.message.text === 'Скасувати') return leaveScene(ctx);
        
        const query = ctx.message.text.toLowerCase().trim();
        await ctx.reply(`🔎 Шукаю записи з номером "${query}"...`);
        
        try {
            const rows = await getRows();
            
            const results = rows.filter(row => {
                const number = row.get('Номер');
                return number && number.toLowerCase().includes(query);
            });

            if (results.length === 0) {
                await ctx.reply('🤷‍♂️ Нічого не знайдено.', mainMenu);
            } else {
                let totalSum = 0;
                let message = `🚙 **Історія за запитом "${query}":**\n\n`;

                results.forEach((row, index) => {
                    const date = row.get('Дата');
                    const car = row.get('Марка');
                    const work = row.get('Робота'); // Ключ укр.
                    const price = parseInt(row.get('Ціна')) || 0; // Ключ укр.
                    
                    totalSum += price;
                    message += `🔹 **${date}** | ${car}\n🛠 ${work} — ${price} грн\n\n`;
                });

                message += `💰 **Всього витрачено: ${totalSum} грн**`;
                
                await ctx.reply(message, { parse_mode: 'Markdown', ...mainMenu });
            }
        } catch (e) {
            console.error(e);
            await ctx.reply('❌ Помилка при пошуку.', mainMenu);
        }
        
        return ctx.scene.leave();
    }
);

// --- СЦЕНА ПОГАШЕННЯ БОРГУ ---
const repayScene = new Scenes.WizardScene(
    'REPAY_SCENE',
    
    // Крок 1: Показуємо боржників
    async (ctx) => {
        await ctx.reply('🔍 Шукаю неоплачені замовлення...');
        
        const rows = await getRows();
        
        const debts = rows
            .map((row, index) => ({ row, index })) 
            .filter(({ row }) => {
                const status = row.get('Статус');
                // Шукаємо слово "борг" (маленькими літерами)
                return status && status.toLowerCase().includes('борг');
            });

        if (debts.length === 0) {
            await ctx.reply('🎉 Боргів немає! Все оплачено.', mainMenu);
            return ctx.scene.leave();
        }

        ctx.wizard.state.debts = debts;

        const buttons = debts.map(({ row }, i) => {
            const date = row.get('Дата');
            const car = row.get('Марка');
            const price = row.get('Ціна');
            return [`${i + 1}. ${date} | ${car} — ${price} грн`];
        });

        buttons.push(['Скасувати']);

        await ctx.reply(
            'Виберіть, хто повернув борг (натисніть кнопку):', 
            Markup.keyboard(buttons).oneTime().resize()
        );
        return ctx.wizard.next();
    },

    // Крок 2: Обробка вибору
    async (ctx) => {
        if (ctx.message.text === 'Скасувати') return leaveScene(ctx);

        const choiceIndex = parseInt(ctx.message.text.split('.')[0]) - 1;
        const debts = ctx.wizard.state.debts;

        if (isNaN(choiceIndex) || !debts[choiceIndex]) {
            ctx.reply('❌ Не зрозумів, виберіть кнопку з меню.');
            return;
        }

        const { row } = debts[choiceIndex];

        await ctx.reply('⏳ Відмічаю оплату...');

        try {
            row.set('Статус', 'Оплачено');
            await row.save();

            await ctx.reply(
                `✅ **Борг погашено!**\n${row.get('Марка')} — ${row.get('Ціна')} грн`, 
                { parse_mode: 'Markdown', ...mainMenu }
            );
        } catch (e) {
            console.error(e);
            await ctx.reply('❌ Помилка при оновленні таблиці.', mainMenu);
        }

        return ctx.scene.leave();
    }
);

const leaveScene = (ctx) => {
    ctx.reply('❌ Скасовано', mainMenu);
    return ctx.scene.leave();
};

// --- ЗАПУСК ТА ОБРОБНИКИ ---
const bot = new Telegraf(process.env.BOT_TOKEN);
const stage = new Scenes.Stage([reportWizard, searchScene, repayScene]);

bot.use(session());
bot.use(stage.middleware());

bot.command('start', (ctx) => ctx.reply('Головне меню:', mainMenu));

// 1. Головне меню (українською)
bot.hears('Додати замовлення', (ctx) => ctx.scene.enter('REPORT_SCENE'));
bot.hears('Звіти', (ctx) => ctx.reply('Оберіть період:', reportsMenu));
bot.hears('Пошук за номером', (ctx) => ctx.scene.enter('SEARCH_SCENE'));
bot.hears('Погасити борг', (ctx) => ctx.scene.enter('REPAY_SCENE'));

// 2. Меню звітів (українською)
bot.hears('За сьогодні', (ctx) => getDailyReport(ctx));
bot.hears('За тиждень', (ctx) => getWeeklyReport(ctx));
bot.hears('Назад', (ctx) => ctx.reply('Головне меню:', mainMenu));

// ... тут твій старий код ...
bot.launch();
console.log('🤖 Бот оновлений та запущений (UA)!');

// --- ДОДАЙ ЦЕЙ БЛОК ДЛЯ RENDER ---
const http = require('http');
const PORT = process.env.PORT || 3000; // Render сам дасть нам порт
http.createServer((req, res) => {
    res.write('Bot is running!'); // Просто пишемо, що бот живий
    res.end();
}).listen(PORT, () => {
    console.log(`Server is listening on port ${PORT}`);
});
// ---------------------------------

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));