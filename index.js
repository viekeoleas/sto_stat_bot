require('dotenv').config();
const { Telegraf, Scenes, session, Markup } = require('telegraf');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const creds = require('./google-creds.json');

// --- НАСТРОЙКИ ---
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_TITLE = 'Отчеты';

// --- КЛАВИАТУРЫ ---
const mainMenu = Markup.keyboard([
    ['Добавить заказ', 'Погасить долг'], // Добавили кнопку сюда
    ['Поиск по номеру', 'Отчеты']
]).resize();

const reportsMenu = Markup.keyboard([
    ['За сегодня', 'За неделю'], // Второй уровень
    ['Назад']
]).resize();

// --- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ДЛЯ ДАТ ---

// Превращаем строку "19.12.2025" в настоящий объект даты JavaScript
function parseDate(dateStr) {
    if (!dateStr) return null;
    const [day, month, year] = dateStr.split('.');
    // Месяцы в JS начинаются с 0 (январь - 0)
    return new Date(year, month - 1, day);
}

// Проверка: входит ли дата в текущую неделю (Пн - Вс)
function isThisWeek(dateObj) {
    const now = new Date();
    const currentDay = now.getDay(); // 0 (Вс) ... 6 (Сб)
    
    // Вычисляем понедельник текущей недели
    // Если сегодня Вс (0), то отнимаем 6 дней. Если Пн (1) - 0 дней.
    const distanceToMonday = currentDay === 0 ? 6 : currentDay - 1;
    
    const monday = new Date(now);
    monday.setDate(now.getDate() - distanceToMonday);
    monday.setHours(0, 0, 0, 0); // Обнуляем время

    // Вычисляем конец недели (следующий понедельник)
    const nextMonday = new Date(monday);
    nextMonday.setDate(monday.getDate() + 7);

    // Дата должна быть больше или равна Понедельнику И меньше следующего Понедельника
    return dateObj >= monday && dateObj < nextMonday;
}

// --- ФУНКЦИЯ ЧТЕНИЯ ТАБЛИЦЫ (Общая для всех отчетов) ---
async function getRows() {
    const serviceAccountAuth = new JWT({
        email: creds.client_email,
        key: creds.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle[SHEET_TITLE];
    return await sheet.getRows();
}

// --- ОТЧЕТ ЗА СЕГОДНЯ ---
async function getDailyReport(ctx) {
    await ctx.reply('🔍 Считаю за сегодня...');
    const rows = await getRows();
    const today = new Date().toLocaleDateString('ru-RU');

    // Фильтр
    const filteredRows = rows.filter(row => row.get('Дата') === today);

    sendReport(ctx, filteredRows, `за сегодня (${today})`);
}

// --- ОТЧЕТ ЗА НЕДЕЛЮ ---
async function getWeeklyReport(ctx) {
    await ctx.reply('🔍 Считаю за эту неделю (с понедельника)...');
    const rows = await getRows();

    // Фильтр
    const filteredRows = rows.filter(row => {
        const rowDate = parseDate(row.get('Дата'));
        return rowDate && isThisWeek(rowDate);
    });

    sendReport(ctx, filteredRows, 'за текущую неделю');
}

// --- ОБНОВЛЕННАЯ ФУНКЦИЯ ОТЧЕТА ---
function sendReport(ctx, rows, periodName) {
    if (rows.length === 0) {
        return ctx.reply(`📅 Записей ${periodName} не найдено.`, reportsMenu);
    }

    let totalCash = 0; // Живые деньги
    let totalDebt = 0; // Долги
    let reportText = `📊 **Отчет ${periodName}:**\n\n`;

    rows.forEach((row, index) => {
        const date = row.get('Дата');
        const car = row.get('Марка');
        const price = parseInt(row.get('Цена')) || 0;
        const status = row.get('Статус') || 'Оплачено'; // Если пусто, считаем что оплачено
        
        // Проверяем статус и считаем разные кассы
        let icon = '🟢';
        if (status.toLowerCase().includes('долг')) {
            totalDebt += price;
            icon = '🔴';
        } else {
            totalCash += price;
        }
        
        // Добавляем строчку в отчет
        reportText += `${index + 1}. ${icon} ${date} | ${car} — ${price}\n`;
    });

    // Итоговая статистика
    reportText += `\n💰 **Касса (на руках): ${totalCash} грн**`;
    if (totalDebt > 0) {
        reportText += `\n❗️ **В долг: ${totalDebt} грн**`;
        reportText += `\n🏁 **Всего работ на: ${totalCash + totalDebt} грн**`;
    }

    ctx.reply(reportText, { parse_mode: 'Markdown', ...reportsMenu });
}

// --- ФУНКЦИЯ ЗАПИСИ (из старого кода) ---
async function appendToSheet(data) {
    const serviceAccountAuth = new JWT({
        email: creds.client_email,
        key: creds.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);
    await doc.loadInfo(); 
    const sheet = doc.sheetsByTitle[SHEET_TITLE];
    if (!sheet) throw new Error(`Лист "${SHEET_TITLE}" не найден.`);
    await sheet.addRow(data);
}

// --- СЦЕНА ОПРОСА (ОБНОВЛЕННАЯ) ---
const reportWizard = new Scenes.WizardScene(
    'REPORT_SCENE',

    // ШАГ 1: Марка
    (ctx) => {
        ctx.reply('🚚 Какая машина? (Марка):', Markup.keyboard([['Отмена']]).resize());
        ctx.wizard.state.data = {}; 
        return ctx.wizard.next();
    },

    // ШАГ 2: Номер
    (ctx) => {
        if (ctx.message.text === 'Отмена') return leaveScene(ctx);
        ctx.wizard.state.data.car = ctx.message.text;
        ctx.reply('🔢 Какой гос. номер?');
        return ctx.wizard.next();
    },

    // ШАГ 3: Работа
    (ctx) => {
        if (ctx.message.text === 'Отмена') return leaveScene(ctx);
        ctx.wizard.state.data.number = ctx.message.text;
        ctx.reply('🛠 Что делали? (Кратко):');
        return ctx.wizard.next();
    },

    // ШАГ 4: Цена
    (ctx) => {
        if (ctx.message.text === 'Отмена') return leaveScene(ctx);
        ctx.wizard.state.data.work = ctx.message.text;
        ctx.reply('💰 Сколько денег? (Только цифры):');
        return ctx.wizard.next();
    },

    // --- НОВЫЙ ШАГ 5: Статус оплаты ---
    (ctx) => {
        if (ctx.message.text === 'Отмена') return leaveScene(ctx);
        ctx.wizard.state.data.price = ctx.message.text;
        
        ctx.reply(
            '💳 Оплатили сразу или в долг?', 
            Markup.keyboard([
                ['✅ Оплачено', '❗️ Долг'],
                ['Отмена']
            ]).resize()
        );
        return ctx.wizard.next();
    },

    // ШАГ 6: Финал (Запись)
    async (ctx) => {
        if (ctx.message.text === 'Отмена') return leaveScene(ctx);
        
        // Сохраняем статус (убираем эмодзи для красоты в таблице, если хочешь)
        const statusRaw = ctx.message.text;
        const status = statusRaw.includes('Долг') ? 'Долг' : 'Оплачено';
        
        ctx.wizard.state.data.status = status;
        
        const { car, number, work, price } = ctx.wizard.state.data;
        const date = new Date().toLocaleDateString('ru-RU');

        await ctx.reply('⏳ Записываю...');

        try {
            await appendToSheet({
                'Дата': date,
                'Марка': car,
                'Номер': number,
                'Работа': work,
                'Цена': price,
                'Статус': status // <--- Добавили поле
            });
            
            // Формируем красивый ответ с иконкой статуса
            const statusIcon = status === 'Долг' ? '🔴 ДОЛГ' : '🟢 Оплачено';
            
            await ctx.reply(
                `✅ **Записано!**\n${car} ${number}\n💰 ${price} грн\n${statusIcon}`, 
                { parse_mode: 'Markdown', ...mainMenu } 
            );
        } catch (e) {
            console.error(e);
            await ctx.reply('❌ Ошибка записи.', mainMenu);
        }

        return ctx.scene.leave();
    }
);
// --- СЦЕНА ПОИСКА ---
const searchScene = new Scenes.WizardScene(
    'SEARCH_SCENE',
    
    // Шаг 1: Спрашиваем номер
    (ctx) => {
        ctx.reply('🔍 Введите номер машины (или его часть):', Markup.keyboard([['Отмена']]).resize());
        return ctx.wizard.next();
    },

    // Шаг 2: Ищем и выводим
    async (ctx) => {
        if (ctx.message.text === 'Отмена') return leaveScene(ctx);
        
        const query = ctx.message.text.toLowerCase().trim(); // Приводим к маленьким буквам
        await ctx.reply(`🔎 Ищу записи с номером "${query}"...`);
        
        try {
            const rows = await getRows(); // Берем все записи
            
            // Фильтруем: проверяем, содержит ли номер то, что ввел пользователь
            const results = rows.filter(row => {
                const number = row.get('Номер');
                // Проверка: номер существует И содержит наш запрос
                return number && number.toLowerCase().includes(query);
            });

            if (results.length === 0) {
                await ctx.reply('🤷‍♂️ Ничего не найдено.', mainMenu);
            } else {
                let totalSum = 0;
                let message = `🚙 **История по запросу "${query}":**\n\n`;

                results.forEach((row, index) => {
                    const date = row.get('Дата');
                    const car = row.get('Марка');
                    const work = row.get('Работа');
                    const price = parseInt(row.get('Цена')) || 0;
                    
                    totalSum += price;
                    message += `🔹 **${date}** | ${car}\n🛠 ${work} — ${price} грн\n\n`;
                });

                message += `💰 **Всего потрачено: ${totalSum} грн**`;
                
                // Отправляем (если сообщение очень длинное, телеграм может обрезать, но для начала хватит)
                await ctx.reply(message, { parse_mode: 'Markdown', ...mainMenu });
            }
        } catch (e) {
            console.error(e);
            await ctx.reply('❌ Ошибка при поиске.', mainMenu);
        }
        
        return ctx.scene.leave();
    }
);

// --- СЦЕНА ПОГАШЕНИЯ ДОЛГА ---
const repayScene = new Scenes.WizardScene(
    'REPAY_SCENE',
    
    // ШАГ 1: Показываем список должников
    async (ctx) => {
        await ctx.reply('🔍 Ищу неоплаченные заказы...');
        
        const rows = await getRows(); // Берем все записи
        
        // Ищем строки, где статус "Долг" (или содержит слово Долг)
        // map сохраняет еще и оригинальный номер строки (rowIndex), чтобы мы знали, кого править
        const debts = rows
            .map((row, index) => ({ row, index })) 
            .filter(({ row }) => {
                const status = row.get('Статус');
                return status && status.toLowerCase().includes('долг');
            });

        if (debts.length === 0) {
            await ctx.reply('🎉 Долгов нет! Все оплачено.', mainMenu);
            return ctx.scene.leave();
        }

        // Сохраняем найденные долги в память, чтобы использовать на следующем шаге
        ctx.wizard.state.debts = debts;

        // Создаем кнопки для каждого должника
        const buttons = debts.map(({ row }, i) => {
            const date = row.get('Дата');
            const car = row.get('Марка');
            const price = row.get('Цена');
            return [`${i + 1}. ${date} | ${car} — ${price} грн`]; // Текст кнопки
        });

        buttons.push(['Отмена']); // Кнопка выхода

        await ctx.reply(
            'Выберите, кто вернул долг (нажмите на кнопку):', 
            Markup.keyboard(buttons).oneTime().resize()
        );
        return ctx.wizard.next();
    },

    // ШАГ 2: Обрабатываем нажатие
    async (ctx) => {
        if (ctx.message.text === 'Отмена') return leaveScene(ctx);

        // Пытаемся понять, на какую кнопку нажали (берем номер в начале "1. ...")
        const choiceIndex = parseInt(ctx.message.text.split('.')[0]) - 1;
        const debts = ctx.wizard.state.debts;

        if (isNaN(choiceIndex) || !debts[choiceIndex]) {
            ctx.reply('❌ Не понял, выберите кнопку из меню.');
            return; // Не переходим дальше, ждем правильного нажатия
        }

        const { row } = debts[choiceIndex]; // Берем нужную строку из гугл таблицы

        await ctx.reply('⏳ Отмечаю оплату...');

        try {
            // ОБНОВЛЕНИЕ СТАТУСА
            row.set('Статус', 'Оплачено'); // Меняем значение в памяти
            await row.save(); // Отправляем изменение в Гугл (САМЫЙ ВАЖНЫЙ МОМЕНТ)

            await ctx.reply(
                `✅ **Долг погашен!**\n${row.get('Марка')} — ${row.get('Цена')} грн`, 
                { parse_mode: 'Markdown', ...mainMenu }
            );
        } catch (e) {
            console.error(e);
            await ctx.reply('❌ Ошибка при обновлении таблицы.', mainMenu);
        }

        return ctx.scene.leave();
    }
);

const leaveScene = (ctx) => {
    ctx.reply('❌ Отменено', mainMenu);
    return ctx.scene.leave();
};

// --- ЗАПУСК И ОБРАБОТЧИКИ ---
const bot = new Telegraf(process.env.BOT_TOKEN);
const stage = new Scenes.Stage([reportWizard, searchScene, repayScene]);

bot.use(session());
bot.use(stage.middleware());

bot.command('start', (ctx) => ctx.reply('Главное меню:', mainMenu));

// 1. Обработка Главного меню
bot.hears('Добавить заказ', (ctx) => ctx.scene.enter('REPORT_SCENE'));
bot.hears('Отчеты', (ctx) => ctx.reply('Выберите период:', reportsMenu));

// 2. Обработка Меню отчетов
bot.hears('За сегодня', (ctx) => getDailyReport(ctx));
bot.hears('За неделю', (ctx) => getWeeklyReport(ctx));
bot.hears('Назад', (ctx) => ctx.reply('Главное меню:', mainMenu));
bot.hears('Поиск по номеру', (ctx) => ctx.scene.enter('SEARCH_SCENE'));
bot.hears('Погасить долг', (ctx) => ctx.scene.enter('REPAY_SCENE'));
bot.launch();
console.log('🤖 Бот обновлен и запущен!');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));