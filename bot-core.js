const path = require('path');
// Load bot-local env first (contains Discord TOKEN عادةً), then root env (AI keys, shared vars).
require('dotenv').config();
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });
const fs = require('fs');
const {
    Client,
    GatewayIntentBits,
    PermissionFlagsBits,
    ChannelType,
    ActivityType,
    EmbedBuilder,
    AttachmentBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder
} = require('discord.js');
const { Resvg } = require('@resvg/resvg-js');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const SCHEMA_PATH = path.join(__dirname, 'dashboard-schema.json');
const DATA_PATH = path.join(__dirname, 'data.json');
const BOT_PID_PATH = path.join(__dirname, '.botcore.pid');
const BOT_LOCK_PATH = path.join(__dirname, '.botcore.lock');
const aiConversationMemory = new Map();
const aiChannelContext = new Map();
const pendingAiConfirmations = new Map();
const securityActionCounters = new Map();
let aiCooldownUntil = 0;
let geminiKeyCursor = 0;

const isPidAlive = (pid) => {
    if (!Number.isFinite(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (_) {
        return false;
    }
};
const readPidFile = (filePath) => {
    try {
        if (!fs.existsSync(filePath)) return null;
        const raw = String(fs.readFileSync(filePath, 'utf-8') || '').trim();
        const pid = Number.parseInt(raw, 10);
        return Number.isFinite(pid) && pid > 0 ? pid : null;
    } catch (_) {
        return null;
    }
};
const removeFileIfExists = (filePath) => {
    try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (_) {}
};
const acquireBotInstanceLock = () => {
    const writeOwnPid = () => {
        fs.writeFileSync(BOT_LOCK_PATH, String(process.pid), 'utf-8');
        fs.writeFileSync(BOT_PID_PATH, String(process.pid), 'utf-8');
    };
    try {
        const fd = fs.openSync(BOT_LOCK_PATH, 'wx');
        fs.writeFileSync(fd, String(process.pid), 'utf-8');
        fs.closeSync(fd);
        fs.writeFileSync(BOT_PID_PATH, String(process.pid), 'utf-8');
        return true;
    } catch (err) {
        if (!err || err.code !== 'EEXIST') return false;
        const existingPid = readPidFile(BOT_LOCK_PATH) || readPidFile(BOT_PID_PATH);
        if (existingPid && existingPid !== process.pid && isPidAlive(existingPid)) {
            console.log(`[bot-core] Existing instance detected (pid ${existingPid}), exiting duplicate process.`);
            return false;
        }
        removeFileIfExists(BOT_LOCK_PATH);
        writeOwnPid();
        return true;
    }
};
const releaseBotInstanceLock = () => {
    const lockPid = readPidFile(BOT_LOCK_PATH);
    if (!lockPid || lockPid === process.pid) removeFileIfExists(BOT_LOCK_PATH);
    const pidFilePid = readPidFile(BOT_PID_PATH);
    if (!pidFilePid || pidFilePid === process.pid) removeFileIfExists(BOT_PID_PATH);
};
if (!acquireBotInstanceLock()) {
    process.exit(0);
}
process.on('exit', releaseBotInstanceLock);
process.on('SIGINT', () => { releaseBotInstanceLock(); process.exit(0); });
process.on('SIGTERM', () => { releaseBotInstanceLock(); process.exit(0); });
process.on('uncaughtException', (err) => {
    console.error('[bot-core] uncaughtException:', err);
    releaseBotInstanceLock();
    process.exit(1);
});

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const readJsonSafe = (filePath, fallback) => {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (_) {
        return fallback;
    }
};
const writeJsonSafe = (filePath, data) => fs.writeFileSync(filePath, JSON.stringify(data, null, 4), 'utf-8');
const getSchema = () => readJsonSafe(SCHEMA_PATH, { version: 1, categories: [] });
const getConfig = () => {
    const cfg = readJsonSafe(CONFIG_PATH, {});
    if (!cfg.guilds || typeof cfg.guilds !== 'object') cfg.guilds = {};
    return cfg;
};
const getData = () => {
    const data = readJsonSafe(DATA_PATH, {});
    if (!data.guilds || typeof data.guilds !== 'object') data.guilds = {};
    return data;
};
const buildDefaultGuildConfig = () => ({ categories: JSON.parse(JSON.stringify(getSchema().categories || [])), serverRoles: [], serverChannels: [] });
const mergeGuildWithSchema = (guildConfig) => {
    const schema = getSchema();
    const currentCats = Array.isArray(guildConfig.categories) ? guildConfig.categories : [];
    const mergedCats = (schema.categories || []).map((schemaCat) => {
        const existingCat = currentCats.find((c) => c.id === schemaCat.id) || {};
        const existingSettings = existingCat.settings || {};
        const mergedSettings = {};
        Object.entries(schemaCat.settings || {}).forEach(([key, schemaSetting]) => {
            const existing = existingSettings[key] || {};
            mergedSettings[key] = {
                ...schemaSetting,
                ...existing,
                shortcuts: Array.isArray(existing.shortcuts) ? existing.shortcuts : (schemaSetting.shortcuts || []),
                allowedRoles: Array.isArray(existing.allowedRoles) ? existing.allowedRoles : (schemaSetting.allowedRoles || []),
                allowedChannels: Array.isArray(existing.allowedChannels) ? existing.allowedChannels : (schemaSetting.allowedChannels || [])
            };
        });
        return { ...schemaCat, ...existingCat, settings: mergedSettings };
    });
    return { ...guildConfig, categories: mergedCats };
};

function ensureGuildSetup(guildId) {
    const config = getConfig();
    let changed = false;
    if (!config.guilds[guildId] || !Array.isArray(config.guilds[guildId].categories)) {
        config.guilds[guildId] = buildDefaultGuildConfig();
        changed = true;
    } else {
        const merged = mergeGuildWithSchema(config.guilds[guildId]);
        if (JSON.stringify(merged) !== JSON.stringify(config.guilds[guildId])) {
            config.guilds[guildId] = merged;
            changed = true;
        }
    }
    if (changed) writeJsonSafe(CONFIG_PATH, config);

    const data = getData();
    if (!data.guilds[guildId]) {
        data.guilds[guildId] = { warnings: {}, levels: {}, antiSpam: {} };
        writeJsonSafe(DATA_PATH, data);
    } else if (!data.guilds[guildId].antiSpam) {
        data.guilds[guildId].antiSpam = {};
        writeJsonSafe(DATA_PATH, data);
    }
}

const getGuildConfig = (guildId) => {
    ensureGuildSetup(guildId);
    return getConfig().guilds[guildId];
};
const getSetting = (guildConfig, key) => {
    for (const cat of guildConfig.categories || []) if (cat.settings && cat.settings[key]) return cat.settings[key];
    return null;
};
const getGuildPrefix = (guildConfig) => {
    const raw = String(getSetting(guildConfig, 'bot_prefix')?.value || process.env.PREFIX || '!').trim();
    if (!raw) return '!';
    const compact = raw.replace(/\s+/g, '');
    if (!compact) return '!';
    return compact.slice(0, 4);
};
const resolvePresenceType = (rawType) => {
    const key = String(rawType || 'PLAYING').toUpperCase();
    if (key === 'WATCHING') return ActivityType.Watching;
    if (key === 'LISTENING') return ActivityType.Listening;
    if (key === 'COMPETING') return ActivityType.Competing;
    return ActivityType.Playing;
};
const getGlobalBotSettings = () => {
    try {
        const globalSettingsPath = path.join(__dirname, 'global-settings.json');
        if (fs.existsSync(globalSettingsPath)) {
            return JSON.parse(fs.readFileSync(globalSettingsPath, 'utf-8'));
        }
    } catch (_) {}
    return {
        bot_status_text: 'OnlyGg Pro System',
        bot_status_type: 'PLAYING'
    };
};

const saveGlobalBotSettings = (settings) => {
    try {
        const globalSettingsPath = path.join(__dirname, 'global-settings.json');
        fs.writeFileSync(globalSettingsPath, JSON.stringify(settings, null, 4), 'utf-8');
    } catch (_) {}
};

const applyConfiguredPresence = () => {
    try {
        if (!client.user) return;
        const globalSettings = getGlobalBotSettings();
        const statusText = String(globalSettings.bot_status_text || 'OnlyGg Pro System').trim() || 'OnlyGg Pro System';
        const statusTypeRaw = String(globalSettings.bot_status_type || 'PLAYING').trim();
        client.user.setPresence({
            activities: [{ name: statusText.slice(0, 120), type: resolvePresenceType(statusTypeRaw) }],
            status: 'online'
        });
    } catch (_) {}
};

let lastSettingsUpdateCheck = 0;
const checkForSettingsUpdates = () => {
    const now = Date.now();
    if (now - lastSettingsUpdateCheck < 1000) return; // Check once per second max
    lastSettingsUpdateCheck = now;
    
    try {
        const flagPath = path.join(__dirname, '.settings-update.flag');
        if (!fs.existsSync(flagPath)) return;
        
        const flagData = JSON.parse(fs.readFileSync(flagPath, 'utf-8'));
        const flagTime = flagData.timestamp || 0;
        
        // Remove old flags (older than 10 seconds)
        if (now - flagTime > 10000) {
            fs.unlinkSync(flagPath);
            return;
        }
        
        // Check if this is a global settings update
        if (flagData.global && flagData.settings) {
            console.log(`[Global Settings Update] Detected global bot settings update`);
            
            // Update global settings
            const currentSettings = getGlobalBotSettings();
            const updatedSettings = { ...currentSettings };
            
            if (flagData.settings.includes('bot_status_text') && flagData.bot_status_text !== undefined) {
                updatedSettings.bot_status_text = flagData.bot_status_text;
            }
            if (flagData.settings.includes('bot_status_type') && flagData.bot_status_type !== undefined) {
                updatedSettings.bot_status_type = flagData.bot_status_type;
            }
            if (flagData.settings.includes('bot_prefix') && flagData.bot_prefix !== undefined) {
                updatedSettings.bot_prefix = flagData.bot_prefix;
            }
            
            saveGlobalBotSettings(updatedSettings);
            applyConfiguredPresence();
            
            console.log(`[Global Settings Update] Applied: status="${updatedSettings.bot_status_text}", type="${updatedSettings.bot_status_type}"`);
        } else {
            // Apply regular updates immediately
            console.log(`[Settings Update] Detected settings update for guild ${flagData.guildId}`);
            applyConfiguredPresence();
        }
        
        // Remove flag after processing
        fs.unlinkSync(flagPath);
        
    } catch (err) {
        // Silently ignore errors to avoid spamming logs
    }
};
const setGuildSettingValue = (guildId, key, value) => {
    const config = getConfig();
    const guildCfg = config.guilds[guildId];
    if (!guildCfg || !Array.isArray(guildCfg.categories)) return false;
    for (const cat of guildCfg.categories) {
        if (cat.settings && cat.settings[key]) {
            cat.settings[key].value = value;
            writeJsonSafe(CONFIG_PATH, config);
            return true;
        }
    }
    return false;
};
const getAllSettings = (guildConfig) => {
    const out = {};
    for (const cat of guildConfig.categories || []) {
        const settings = cat && cat.settings ? cat.settings : {};
        for (const key of Object.keys(settings)) out[key] = settings[key];
    }
    return out;
};
const resolveConfiguredCommand = (guildConfig, typedCmd) => {
    const all = getAllSettings(guildConfig);
    const cmd = String(typedCmd || '').toLowerCase();
    for (const [key, setting] of Object.entries(all)) {
        if (!setting || setting.enabled === false) continue;
        const mainValue = String(setting.value || key).toLowerCase();
        const shortcuts = Array.isArray(setting.shortcuts) ? setting.shortcuts.map((s) => String(s).toLowerCase()) : [];
        if (cmd === key.toLowerCase() || cmd === mainValue || shortcuts.includes(cmd)) {
            return { key, setting };
        }
    }
    return null;
};
const resolveShortcutCommand = (guildConfig, typedCmd) => {
    const all = getAllSettings(guildConfig);
    const cmd = String(typedCmd || '').toLowerCase();
    for (const [key, setting] of Object.entries(all)) {
        if (!setting || setting.enabled === false) continue;
        const shortcuts = Array.isArray(setting.shortcuts) ? setting.shortcuts.map((s) => String(s).toLowerCase()) : [];
        if (shortcuts.includes(cmd)) return { key, setting };
    }
    return null;
};
const hasCommandAccess = (message, setting) => {
    if (!setting) return false;
    const roles = Array.isArray(setting.allowedRoles) ? setting.allowedRoles.map((r) => String(r)) : [];
    const channels = Array.isArray(setting.allowedChannels) ? setting.allowedChannels.map((c) => String(c)) : [];
    const roleOk = roles.length === 0 || message.member.roles.cache.some((r) => roles.includes(String(r.id)));
    const channelOk = channels.length === 0 || channels.includes(String(message.channel.id));
    return roleOk && channelOk;
};
const parseDurationToMs = (raw) => {
    const m = String(raw || '').trim().match(/^(\d+)([smhd])$/i);
    if (!m) return null;
    const u = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
    return Number(m[1]) * u[m[2].toLowerCase()];
};
const canUseSetting = (message, setting) => hasCommandAccess(message, setting);
const resolveUtilityCommand = (key) => ['help', 'userinfo', 'serverinfo', 'avatar'].includes(key);
const moderationKeys = ['ban', 'unban', 'kick', 'mute', 'unmute', 'warn', 'warnings', 'unwarn', 'clearwarns', 'clear', 'lock', 'unlock', 'slowmode'];
const commandMeta = {
    ban: { desc: 'حظر عضو من السيرفر.', usage: '/ban @user (السبب)', examples: ['/ban @OnlyGg spam'] },
    unban: { desc: 'فك حظر مستخدم بالـ ID.', usage: '/unban 123456789', examples: ['/unban 1187458801729802330'] },
    kick: { desc: 'طرد عضو من السيرفر.', usage: '/kick @user (السبب)', examples: ['/kick @OnlyGg مخالفة'] },
    mute: { desc: 'تايم أوت لعضو لمدة محددة.', usage: '/mute @user 10m (السبب)', examples: ['/mute @OnlyGg 1h spam'] },
    unmute: { desc: 'فك التايم أوت عن عضو.', usage: '/unmute @user', examples: ['/unmute @OnlyGg'] },
    warn: { desc: 'إضافة تحذير على عضو.', usage: '/warn @user (السبب)', examples: ['/warn @OnlyGg language'] },
    warnings: { desc: 'عرض تحذيرات عضو.', usage: '/warnings (@user)', examples: ['/warnings @OnlyGg'] },
    unwarn: { desc: 'حذف آخر تحذير من عضو.', usage: '/unwarn @user', examples: ['/unwarn @OnlyGg'] },
    clearwarns: { desc: 'مسح كل التحذيرات عن عضو.', usage: '/clearwarns @user', examples: ['/clearwarns @OnlyGg'] },
    clear: { desc: 'حذف عدد رسائل من الروم.', usage: '/clear 20', examples: ['/clear 50'] },
    lock: { desc: 'قفل الروم الحالي.', usage: '/lock', examples: ['/lock'] },
    unlock: { desc: 'فتح الروم الحالي.', usage: '/unlock', examples: ['/unlock'] },
    slowmode: { desc: 'تحديد السلو مود بالثواني.', usage: '/slowmode 10', examples: ['/slowmode 30'] },
    help: { desc: 'عرض لوحة المساعدة.', usage: '/help (command)', examples: ['/help', '/help ban'] },
    userinfo: { desc: 'عرض معلومات عضو.', usage: '/userinfo (@user)', examples: ['/userinfo @OnlyGg'] },
    serverinfo: { desc: 'عرض معلومات السيرفر.', usage: '/serverinfo', examples: ['/serverinfo'] },
    avatar: { desc: 'عرض صورة العضو.', usage: '/avatar (@user)', examples: ['/avatar @OnlyGg'] }
};
const getCommandAliases = (setting) => {
    const aliases = Array.isArray(setting?.shortcuts) ? setting.shortcuts.filter(Boolean) : [];
    return aliases.map((a) => String(a).toLowerCase());
};
const buildCommandCard = (guildConfig, cmdKey, prefix) => {
    const setting = getSetting(guildConfig, cmdKey);
    if (!setting || setting.enabled === false) return null;
    const meta = commandMeta[cmdKey] || { desc: 'أمر قابل للتخصيص من الداشبورد.', usage: `/${cmdKey}`, examples: [`/${cmdKey}`] };
    const commandName = String(setting.value || cmdKey).trim();
    const aliases = getCommandAliases(setting);
    const examples = (meta.examples || []).map((ex) => `\`${String(ex).replace('/', prefix)}\``).join('\n') || '-';
    return new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`Command: ${commandName}`)
        .setDescription(meta.desc)
        .addFields(
            { name: 'Usage', value: `\`${String(meta.usage || `/${commandName}`).replace('/', prefix)}\`` },
            { name: 'Examples', value: examples },
            { name: 'Aliases', value: aliases.length ? aliases.map((a) => `\`${a}\``).join(' , ') : 'No shortcuts' }
        )
        .setFooter({ text: `Prefix: ${prefix}` });
};
const withUsagePrefix = (usage, prefix) => String(usage || '').replace(/\/([a-z0-9_-]+)/ig, (_, name) => `${prefix}${name}`);
const escapeSvg = (value) => String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
const buildRankCardSvg = ({ userTag, username, level, xp, current, needed, rankPos, totalUsers, textXp = 0, voiceXp = 0 }) => {
    const width = 980;
    const height = 320;
    const progress = needed > 0 ? Math.max(0, Math.min(1, current / needed)) : 0;
    const progressW = Math.round(620 * progress);
    const initials = escapeSvg((username || 'U').slice(0, 1).toUpperCase());
    return `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0f1023"/>
      <stop offset="100%" stop-color="#1a1145"/>
    </linearGradient>
    <linearGradient id="bar" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#7c3aed"/>
      <stop offset="100%" stop-color="#22d3ee"/>
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" rx="26" fill="url(#bg)"/>
  <circle cx="110" cy="100" r="58" fill="#15162f" stroke="#7c3aed" stroke-width="4"/>
  <text x="110" y="117" font-size="48" text-anchor="middle" fill="#e5e7eb" font-family="Segoe UI">${initials}</text>
  <text x="200" y="85" font-size="56" fill="#f8fafc" font-family="Segoe UI" font-weight="700">${escapeSvg(username)}</text>
  <text x="200" y="125" font-size="34" fill="#94a3b8" font-family="Segoe UI">@${escapeSvg(userTag)}</text>
  <text x="60" y="205" font-size="30" fill="#cbd5e1" font-family="Segoe UI">LVL</text>
  <text x="130" y="205" font-size="50" fill="#ffffff" font-family="Segoe UI" font-weight="700">${level}</text>
  <text x="200" y="200" font-size="24" fill="#d1d5db" font-family="Segoe UI">Top #${rankPos}</text>
  <rect x="200" y="218" width="620" height="36" rx="18" fill="#0b1021" stroke="#7c3aed"/>
  <rect x="200" y="218" width="${progressW}" height="36" rx="18" fill="url(#bar)"/>
  <text x="510" y="244" font-size="24" text-anchor="middle" fill="#ffffff" font-family="Segoe UI" font-weight="700">${current} / ${needed}</text>
  <text x="840" y="202" font-size="24" fill="#d1d5db" font-family="Segoe UI">Total: #${totalUsers}</text>
  <text x="200" y="286" font-size="21" fill="#cbd5e1" font-family="Segoe UI">Total XP: ${xp}</text>
  <text x="420" y="286" font-size="21" fill="#93c5fd" font-family="Segoe UI">Text: ${textXp}</text>
  <text x="610" y="286" font-size="21" fill="#86efac" font-family="Segoe UI">Voice: ${voiceXp}</text>
</svg>`.trim();
};
const loadUrlAsDataUri = async (url) => {
    const clean = String(url || '').trim();
    if (!clean) return '';
    try {
        const res = await fetch(clean);
        if (!res.ok) return '';
        const ab = await res.arrayBuffer();
        const mime = res.headers.get('content-type') || 'image/png';
        const b64 = Buffer.from(ab).toString('base64');
        return `data:${mime};base64,${b64}`;
    } catch (_) {
        return '';
    }
};
const buildWelcomeCardSvg = ({
    width, height, title, subtext, textX, textY, textSize, textColor, subSize, subColor,
    avatarEnabled, avatarX, avatarY, avatarSize, avatarDataUri, backgroundDataUri
}) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0f172a"/>
      <stop offset="100%" stop-color="#1d4ed8"/>
    </linearGradient>
    <clipPath id="avatarClip">
      <circle cx="${avatarX + (avatarSize / 2)}" cy="${avatarY + (avatarSize / 2)}" r="${avatarSize / 2}" />
    </clipPath>
  </defs>
  <rect width="${width}" height="${height}" rx="20" fill="url(#bg)"/>
  ${backgroundDataUri ? `<image href="${backgroundDataUri}" x="0" y="0" width="${width}" height="${height}" preserveAspectRatio="xMidYMid slice"/>` : ''}
  <rect width="${width}" height="${height}" rx="20" fill="rgba(0,0,0,0.28)"/>
  ${avatarEnabled ? `
    ${avatarDataUri ? `<image href="${avatarDataUri}" x="${avatarX}" y="${avatarY}" width="${avatarSize}" height="${avatarSize}" clip-path="url(#avatarClip)" preserveAspectRatio="xMidYMid slice"/>` : `<circle cx="${avatarX + (avatarSize / 2)}" cy="${avatarY + (avatarSize / 2)}" r="${avatarSize / 2}" fill="#e2e8f0"/>`}
    <circle cx="${avatarX + (avatarSize / 2)}" cy="${avatarY + (avatarSize / 2)}" r="${(avatarSize / 2) - 2}" fill="none" stroke="#22d3ee" stroke-width="4"/>
  ` : ''}
  <text x="${textX}" y="${textY}" fill="${escapeSvg(textColor)}" font-size="${textSize}" font-family="Segoe UI, Arial" font-weight="700">${escapeSvg(title)}</text>
  <text x="${textX}" y="${textY + subSize + 18}" fill="${escapeSvg(subColor)}" font-size="${subSize}" font-family="Segoe UI, Arial" font-weight="600">${escapeSvg(subtext)}</text>
</svg>`.trim();
const replyCommandGuide = (message, guildConfig, cmdKey, prefix, hint = '') => {
    const setting = getSetting(guildConfig, cmdKey) || { value: cmdKey, shortcuts: [] };
    const meta = commandMeta[cmdKey] || { desc: 'طريقة استخدام الأمر' };
    const commandName = String(setting.value || cmdKey).trim();
    const aliases = getCommandAliases(setting);
    const examples = (meta.examples || []).map((ex) => `\`${withUsagePrefix(ex, prefix)}\``).join('\n') || '-';
    const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`Command: ${commandName}`)
        .setDescription(hint || meta.desc || 'تحقق من طريقة كتابة الأمر.')
        .addFields(
            { name: 'Usage', value: `\`${withUsagePrefix(meta.usage || `/${commandName}`, prefix)}\`` },
            { name: 'Examples', value: examples },
            { name: 'Aliases', value: aliases.length ? aliases.map((a) => `\`${a}\``).join(' , ') : 'No shortcuts' }
        );
    return message.reply({ embeds: [embed] });
};
const toBool = (value, fallback = false) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        const v = value.toLowerCase().trim();
        if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
        if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
    }
    return fallback;
};
const parseCsvIds = (value) => String(value || '')
    .split(',')
    .map((x) => x.trim())
    .filter((x) => /^\d{5,25}$/.test(x));
const applyWelcomeTokens = (raw, member) => String(raw || '')
    .replace(/\{user\}/g, `<@${member.id}>`)
    .replace(/\{server\}/g, member.guild.name)
    .replace(/\{count\}/g, String(member.guild.memberCount || 0));
const toLevel = (xp) => {
    let level = 0; let need = 100; let left = xp;
    while (left >= need) { left -= need; level += 1; need = 100 + (level * 35); }
    return { level, current: left, needed: need };
};
const makeEmbed = (type, title, description, fields = []) => {
    const colors = {
        success: 0x22c55e,
        error: 0xef4444,
        info: 0x3b82f6,
        warn: 0xf59e0b
    };
    return new EmbedBuilder()
        .setColor(colors[type] || colors.info)
        .setTitle(title)
        .setDescription(description)
        .addFields(fields)
        .setTimestamp();
};
const replyEmbed = (message, type, title, description, fields = []) => message.reply({ embeds: [makeEmbed(type, title, description, fields)] });
const replyPretty = (message, type, title, description) => {
    const icon = type === 'success' ? '✅' : type === 'error' ? '❌' : type === 'warn' ? '⚠️' : 'ℹ️';
    return message.reply(`${icon} **${title}**\n${description}`);
};
const logsToggleEnabled = (guildConfig, key, fallback = true) => toBool(getSetting(guildConfig, key)?.value, fallback);
const getLogChannelSettingKey = (toggleKey) => {
    const map = {
        log_mod_actions: 'log_mod_actions_channel',
        log_message_delete: 'log_message_delete_channel',
        log_message_edit: 'log_message_edit_channel',
        log_member_join_leave: 'log_member_join_leave_channel',
        log_server_updates: 'log_server_updates_channel',
        log_role_updates: 'log_role_updates_channel',
        log_channel_updates: 'log_channel_updates_channel'
    };
    return map[String(toggleKey || '')] || 'logs_channel';
};
const getLogsChannel = async (guild, guildConfig, toggleKey = '') => {
    if (!logsToggleEnabled(guildConfig, 'logs_enabled', true)) return null;
    const specificKey = getLogChannelSettingKey(toggleKey);
    const channelId = String(getSetting(guildConfig, specificKey)?.value || getSetting(guildConfig, 'logs_channel')?.value || '').trim();
    if (!channelId) return null;
    const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText) return null;
    return channel;
};
const sendLogEvent = async (guild, guildConfig, toggleKey, title, description, fields = [], color = 0x64748b) => {
    if (!logsToggleEnabled(guildConfig, toggleKey, true)) return;
    const channel = await getLogsChannel(guild, guildConfig, toggleKey);
    if (!channel) return;
    const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle(title)
        .setDescription(description)
        .addFields(fields)
        .setTimestamp();
    await channel.send({ embeds: [embed] }).catch(() => {});
};
const isSecurityEnabled = (guildConfig) => toBool(getSetting(guildConfig, 'security_enabled')?.value, false);
const getSecurityWindowSec = (guildConfig) => Math.max(10, Math.min(600, Number(getSetting(guildConfig, 'security_window_sec')?.value) || 60));
const getSecurityActionMax = (guildConfig, actionKey) => {
    const settingKey = `security_${actionKey}_max`;
    return Math.max(1, Math.min(50, Number(getSetting(guildConfig, settingKey)?.value) || 4));
};
const getSecurityActionEnabled = (guildConfig, actionKey) => toBool(getSetting(guildConfig, `security_${actionKey}_protection`)?.value, true);
const isSecurityWhitelisted = (member, guildConfig, actionKey) => {
    if (!member) return true;
    if (member.id === member.guild.ownerId) return true;
    const userId = String(member.id);
    const globalUsers = new Set(parseCsvIds(getSetting(guildConfig, 'security_whitelist_users')?.value));
    const globalRoles = new Set(parseCsvIds(getSetting(guildConfig, 'security_whitelist_roles')?.value));
    const actionUsers = new Set(parseCsvIds(getSetting(guildConfig, `security_${actionKey}_whitelist_users`)?.value));
    const actionRoles = new Set(parseCsvIds(getSetting(guildConfig, `security_${actionKey}_whitelist_roles`)?.value));
    if (globalUsers.has(userId) || actionUsers.has(userId)) return true;
    const roleIds = member.roles?.cache?.map((r) => String(r.id)) || [];
    if (roleIds.some((id) => globalRoles.has(id) || actionRoles.has(id))) return true;
    return false;
};
const markSecurityAction = (guildId, executorId, actionKey, windowSec) => {
    const key = `${guildId}:${executorId}:${actionKey}`;
    const now = Date.now();
    const arr = (securityActionCounters.get(key) || []).filter((ts) => (now - ts) <= (windowSec * 1000));
    arr.push(now);
    securityActionCounters.set(key, arr);
    return arr.length;
};
const applySecurityPunishment = async (guild, member, guildConfig, actionKey, count, maxAllowed) => {
    if (!member) return { ok: false, reason: 'no_member' };
    if (member.user?.bot) return { ok: false, reason: 'executor_is_bot' };
    const ownerExempt = toBool(getSetting(guildConfig, 'security_owner_exempt')?.value, false);
    if (ownerExempt && member.id === guild.ownerId) return { ok: false, reason: 'owner_exempt' };
    const perActionMode = String(getSetting(guildConfig, `security_${actionKey}_action`)?.value || '').toLowerCase().trim();
    const mode = perActionMode || String(getSetting(guildConfig, 'security_punishment')?.value || 'ban').toLowerCase().trim();
    const reason = `Security Protection: ${actionKey} limit ${count}/${maxAllowed}`;
    const botMember = guild.members.me || await guild.members.fetchMe().catch(() => null);
    if (mode === 'remove_roles') {
        const editableRoles = member.roles.cache
            .filter((r) => {
                if (r.name === '@everyone' || r.managed) return false;
                if (!botMember) return !!r.editable;
                return r.position < botMember.roles.highest.position;
            })
            .map((r) => r.id);
        if (editableRoles.length) {
            await member.roles.remove(editableRoles, reason).catch(() => {});
            return { ok: true, reason: 'roles_removed' };
        }
        return { ok: false, reason: 'no_editable_roles' };
    }
    if (mode === 'timeout') {
        if (!member.moderatable) return { ok: false, reason: 'member_not_moderatable' };
        await member.timeout(60 * 60 * 1000, reason).catch(() => {});
        return { ok: true, reason: 'timeout_applied' };
    }
    if (mode === 'kick') {
        if (!member.kickable) return { ok: false, reason: 'member_not_kickable' };
        await member.kick(reason).catch(() => {});
        return { ok: true, reason: 'kick_applied' };
    }
    if (!member.bannable) return { ok: false, reason: 'member_not_bannable' };
    await member.ban({ reason }).catch(() => {});
    return { ok: true, reason: 'ban_applied' };
};
const getAuditExecutor = async (guild, actionType, targetId) => {
    try {
        const fetched = await guild.fetchAuditLogs({ type: actionType, limit: 6 });
        const now = Date.now();
        const entry = fetched.entries.find((e) => {
            const sameTarget = targetId ? String(e.target?.id || '') === String(targetId) : true;
            return sameTarget && (now - e.createdTimestamp) < 15000;
        });
        return entry?.executorId ? await guild.members.fetch(entry.executorId).catch(() => null) : null;
    } catch (_) {
        return null;
    }
};
const processSecurityEvent = async ({ guild, guildConfig, actionKey, executorMember, details = '', color = 0xef4444 }) => {
    if (!guild || !guildConfig) return;
    if (!isSecurityEnabled(guildConfig)) return;
    if (!getSecurityActionEnabled(guildConfig, actionKey)) return;
    if (!executorMember || executorMember.user?.bot) return;
    if (isSecurityWhitelisted(executorMember, guildConfig, actionKey)) return;

    const windowSec = getSecurityWindowSec(guildConfig);
    const maxAllowed = getSecurityActionMax(guildConfig, actionKey);
    const count = markSecurityAction(guild.id, executorMember.id, actionKey, windowSec);
    if (count < maxAllowed) return;

    const punishmentResult = await applySecurityPunishment(guild, executorMember, guildConfig, actionKey, count, maxAllowed);
    const punished = !!punishmentResult?.ok;
    await sendLogEvent(
        guild,
        guildConfig,
        'log_mod_actions',
        '🚨 Security Protection Triggered',
        `المنفذ: <@${executorMember.id}> | الحدث: **${actionKey}**`,
        [
            { name: 'Count / Max', value: `${count} / ${maxAllowed}`, inline: true },
            { name: 'Window', value: `${windowSec}s`, inline: true },
            { name: 'Details', value: String(details || '-').slice(0, 900) },
            { name: 'Punishment Applied', value: punished ? 'Yes' : 'No', inline: true },
            { name: 'Reason', value: String(punishmentResult?.reason || '-'), inline: true }
        ],
        color
    );
};
const parseAiJson = (raw) => {
    const txt = String(raw || '').trim();
    try { return JSON.parse(txt); } catch (_) {}
    const start = txt.indexOf('{');
    const end = txt.lastIndexOf('}');
    if (start >= 0 && end > start) {
        try { return JSON.parse(txt.slice(start, end + 1)); } catch (_) {}
    }
    return null;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fetchWithTimeout = async (url, options = {}, timeoutMs = 12000) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
};
const normalizeAiReplyText = (rawReply) => {
    const raw = String(rawReply || '').trim();
    if (!raw) return '';
    const parsed = parseAiJson(raw);
    if (parsed && typeof parsed === 'object') {
        if (typeof parsed.reply === 'string' && parsed.reply.trim()) return parsed.reply.trim();
        if (typeof parsed.response === 'string' && parsed.response.trim()) return parsed.response.trim();
        if (typeof parsed.message === 'string' && parsed.message.trim()) return parsed.message.trim();
    }
    return raw;
};
const getConversationKey = (message) => `${message.guild?.id || 'dm'}:${message.channel?.id || 'unknown'}`;
const getChannelContext = (message) => aiChannelContext.get(getConversationKey(message)) || {};
const setChannelContext = (message, patch) => {
    const key = getConversationKey(message);
    const prev = aiChannelContext.get(key) || {};
    aiChannelContext.set(key, { ...prev, ...patch, updatedAt: Date.now() });
};
const getAiConversationHistory = (message) => aiConversationMemory.get(getConversationKey(message)) || [];
const pushAiConversationTurn = (message, role, content) => {
    const key = getConversationKey(message);
    const history = aiConversationMemory.get(key) || [];
    history.push({ role, content: String(content || '').slice(0, 1200), at: Date.now() });
    aiConversationMemory.set(key, history.slice(-12));
};
const buildHistoryText = (history) => history
    .map((h) => `${h.role === 'assistant' ? 'Assistant' : 'User'}: ${h.content}`)
    .join('\n');
const buildCompactHistoryText = (history, maxTurns = 4, maxChars = 700) => {
    const recent = Array.isArray(history) ? history.slice(-maxTurns) : [];
    const text = recent
        .map((h) => `${h.role === 'assistant' ? 'Assistant' : 'User'}: ${String(h.content || '').slice(0, 220)}`)
        .join('\n');
    return text.slice(-maxChars);
};
const buildAiExecutionContext = (message) => {
    const guild = message.guild;
    if (!guild) return '';
    const roles = guild.roles.cache
        .filter((r) => r.name !== '@everyone' && !r.managed)
        .sort((a, b) => b.position - a.position)
        .first(40)
        .map((r) => `${r.name} => ${r.id}`)
        .join('\n');
    const members = guild.members.cache
        .filter((m) => !m.user.bot)
        .first(40)
        .map((m) => `${m.displayName || m.user.username} => ${m.id}`)
        .join('\n');
    return [
        `Guild: ${guild.name} (${guild.id})`,
        `Current channel: ${message.channel?.name || 'unknown'} (${message.channel?.id || 'unknown'})`,
        'Available roles (name => id):',
        roles || '-',
        'Known members (display => id):',
        members || '-'
    ].join('\n');
};
const looksLikeAdminExecutionRequest = (text) => /(add|remove|delete|create|ban|kick|mute|timeout|clear|purge|lock|unlock|role|channel|رتبه|رتبة|روم|بان|طرد|كتم|تايم|حذف|امسح|قفل|افتح|انشئ|اعمل|نفذ)/i.test(String(text || ''));
const pickGeminiKey = (keys) => {
    if (!Array.isArray(keys) || keys.length === 0) return '';
    const idx = geminiKeyCursor % keys.length;
    geminiKeyCursor = (geminiKeyCursor + 1) % keys.length;
    return keys[idx];
};
const summarizeAction = (a) => {
    const t = String(a?.type || '');
    if (t === 'add_role') return `إضافة رتبة للمستخدم \`${a.userId || '?'}\``;
    if (t === 'remove_role') return `سحب رتبة من المستخدم \`${a.userId || '?'}\``;
    if (t === 'clear_messages') return `حذف ${a.amount || 0} رسالة`;
    if (t === 'timeout_user') return `تايم أوت للمستخدم \`${a.userId || '?'}\``;
    if (t === 'ban_user') return `حظر المستخدم \`${a.userId || '?'}\``;
    if (t === 'kick_user') return `طرد المستخدم \`${a.userId || '?'}\``;
    if (t === 'lock_channel') return 'قفل الروم الحالي';
    if (t === 'unlock_channel') return 'فتح الروم الحالي';
    if (t === 'create_embed') return 'إنشاء Embed';
    if (t === 'create_buttons') return 'إنشاء أزرار';
    if (t === 'create_select_roles') return 'إنشاء قائمة رتب';
    if (t === 'delete_role') return `حذف رتبة من السيرفر \`${a.roleId || '?'}\``;
    if (t === 'create_role') return `إنشاء رتبة جديدة \`${a.name || '?'}\``;
    if (t === 'send_message') return 'إرسال رسالة';
    return t || 'إجراء';
};
const actionProducesVisibleMessage = (action) => {
    const t = String(action?.type || '').toLowerCase();
    return ['send_message', 'create_embed', 'create_buttons', 'create_select_roles'].includes(t);
};
const isDangerousAiAction = (a) => {
    const t = String(a?.type || '').toLowerCase();
    return ['add_role', 'remove_role', 'clear_messages', 'timeout_user', 'ban_user', 'kick_user', 'delete_role'].includes(t);
};
const requestActionConfirmation = async (message, actions, note = '') => {
    if (!Array.isArray(actions) || actions.length === 0) return false;
    const token = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    pendingAiConfirmations.set(token, {
        requesterId: String(message.author.id),
        guildId: String(message.guild.id),
        channelId: String(message.channel.id),
        actions: actions.slice(0, 10),
        createdAt: Date.now()
    });
    const list = actions.slice(0, 8).map((a, i) => `${i + 1}) ${summarizeAction(a)}`).join('\n');
    const embed = new EmbedBuilder()
        .setColor(0x6366f1)
        .setTitle('تأكيد تنفيذ أوامر AI')
        .setDescription(`${note ? `${note}\n\n` : ''}الأوامر المقترحة:\n${list}\n\nهل تريد التنفيذ؟`)
        .setFooter({ text: 'الأزرار صالحة لمدة 90 ثانية' });
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`ai:confirm:${token}:yes`).setLabel('تنفيذ').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`ai:confirm:${token}:no`).setLabel('إلغاء').setStyle(ButtonStyle.Danger)
    );
    await message.reply({ embeds: [embed], components: [row] });
    setTimeout(() => pendingAiConfirmations.delete(token), 90000);
    return true;
};
const getLastHumanMessageFromChannel = async (message) => {
    try {
        const msgs = await message.channel.messages.fetch({ limit: 25 });
        for (const m of msgs.values()) {
            if (m.id === message.id) continue;
            if (m.author?.bot) continue;
            return m.content || '';
        }
    } catch (_) {}
    return '';
};
const buildLocalConversationalReply = async (message, userText, history = []) => {
    const raw = String(userText || '').replace(/<@!?\d+>/g, ' ').trim();
    const txt = normalizeLoose(raw);
    const userName = message.member?.displayName || message.author?.username || 'صاحبي';
    if (/اسمك اي|اسمك ايه|اسمك|what is your name|who are you|انت مين|من انت/.test(txt)) {
        return `أنا AI Agent الخاص بسيرفر **${message.guild?.name || 'Discord'}**. تقدر تعتبرني مساعدك الذكي يا ${userName} 👋`;
    }
    if (/عامل اي|اخبارك|ازيك|كيف حالك|how are you|hello|hi|hey|اهلا|السلام/.test(txt)) {
        return `تمام يا ${userName} 💙 موجود معاك. قولي عايز سؤال، شرح، ولا تنفيذ أمر في السيرفر؟`;
    }
    if (/تقدر تعمل اي|بتعرف تعمل اي|ايه امكانياتك|help me|ساعدني/.test(txt)) {
        return 'أقدر أعمل 3 حاجات: 1) دردشة وشرح طبيعي، 2) تنفيذ أوامر إدارة (برتبة/تأكيد)، 3) إنشاء Embed/Buttons/Select Menu. قلّي المطلوب مباشرة.';
    }
    if (/اي اخر رساله|اخر رساله|last message|last msg/.test(txt)) {
        const lastUserTurn = [...history].reverse().find((h) => h.role === 'user');
        if (lastUserTurn?.content) {
            return `آخر رسالة قلتها كانت:\n> ${lastUserTurn.content}\n\nحابب أكمل عليها أو تنفذ عليها إجراء معين؟`;
        }
        const lastFromChannel = await getLastHumanMessageFromChannel(message);
        if (lastFromChannel) {
            return `آخر رسالة لقيتها في الروم كانت:\n> ${lastFromChannel}\n\nعايز أكمل عليها بإيه؟`;
        }
        return 'مافيش رسائل محفوظة قبل كده في السياق الحالي. ابعت طلبك وأنا أكمل معاك.';
    }
    if (/مين انت|من انت|who are you/.test(txt)) {
        return 'أنا AI Agent للبوت هنا، بقدر أكمل معاك محادثة عادي وأنفذ أوامر الإدارة والتجهيزات في السيرفر.';
    }
    if (/429|ريت ليمت|rate limit|مش بيرد/.test(txt)) {
        return 'في ضغط مؤقت على مزود الذكاء (Rate Limit). أنا مكمل معاك محليًا دلوقتي، ولو تحب أنفذ أمر مباشر قله بأي صيغة.';
    }
    if (/اسالني|اسئلني|سالني|ask me|question|سؤال|سوال/.test(txt)) {
        const q = [
            'طيب سؤال سريع: لو عندك ميزة واحدة تضيفها للبوت الآن، هتختار إيه وليه؟',
            'سؤال لك: تحب البوت يكون سريع في التنفيذ ولا أدق في الفهم؟',
            'سؤال ممتع: إيه أكتر أمر بتستخدمه يوميًا في السيرفر؟',
            'خلينا نختبر الذكاء: إزاي تفرق بين أمر محتاج تنفيذ فوري وأمر محتاج تأكيد؟'
        ];
        return q[Math.floor(Math.random() * q.length)];
    }
    if (/اكمل|كم(ل|ّل)|continue|نكمل|follow up/.test(txt)) {
        const lastAssistant = [...history].reverse().find((h) => h.role === 'assistant');
        if (lastAssistant?.content) {
            return `تمام، نكمل من آخر نقطة:\n> ${lastAssistant.content.slice(0, 240)}\n\nقولي عايز التطبيـق على أي جزء بالضبط.`;
        }
        return 'تمام نكمل. حدّدلي الجزء اللي نبدأ منه وأنا أكمل معاك خطوة خطوة.';
    }
    if (/مينفعش|مش فاهم|غباء|غبي|مش عاجب/.test(txt)) {
        return 'معاك حق. خليني أصححها عمليًا دلوقتي: اكتبلي الهدف في سطر واحد وأنا أنفذه مباشرة بدون لف.';
    }
    const short = raw.length > 140 ? `${raw.slice(0, 140)}...` : raw;
    return `وصلني طلبك: "${short || '...' }".\nاكتب المطلوب كجملة واحدة وأنا هنفذه/أرد عليه مباشرة.`;
};
const callGeminiNative = async (apiKey, model, systemPrompt, schemaPrompt, userText) => {
    let geminiModel = String(model || 'gemini-2.0-flash').trim();
    if (!/^gemini/i.test(geminiModel)) geminiModel = 'gemini-flash-latest';
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent`;
    let lastStatus = 500;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        if (Date.now() < aiCooldownUntil) {
            await sleep(Math.max(200, aiCooldownUntil - Date.now()));
        }
        const res = await fetchWithTimeout(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-goog-api-key': apiKey
            },
            body: JSON.stringify({
                contents: [{
                    parts: [{
                        text: `${systemPrompt}\n${schemaPrompt}\nUser request:\n${userText}`
                    }]
                }]
            })
        }, 7000);
        lastStatus = res.status;
        if (res.ok) {
            const payload = await res.json();
            const content = payload?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join('\n') || '{}';
            return parseAiJson(content) || { reply: 'تعذر فهم رد Gemini.', actions: [] };
        }
        if (res.status === 429) {
            aiCooldownUntil = Date.now() + 2500 + (attempt * 2000);
            await sleep(900 + (attempt * 700));
            continue;
        }
        break;
    }
    return { reply: `AI error: ${lastStatus}`, actions: [], rateLimited: lastStatus === 429 };
};
const callGeminiNativeText = async (apiKey, model, systemPrompt, userText) => {
    let geminiModel = String(model || 'gemini-2.5-pro').trim();
    if (!/^gemini/i.test(geminiModel)) geminiModel = 'gemini-2.5-pro';
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent`;
    let lastStatus = 500;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        if (Date.now() < aiCooldownUntil) {
            await sleep(Math.max(200, aiCooldownUntil - Date.now()));
        }
        const res = await fetchWithTimeout(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-goog-api-key': apiKey
            },
            body: JSON.stringify({
                contents: [{
                    parts: [{
                        text: `${systemPrompt}\nUser message:\n${userText}`
                    }]
                }]
            })
        }, 8000);
        lastStatus = res.status;
        if (res.ok) {
            const payload = await res.json();
            const text = payload?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join('\n') || '';
            return { reply: text || 'تمام، كمّل وأنا معاك.', actions: [] };
        }
        if (res.status === 429) {
            aiCooldownUntil = Date.now() + 2500 + (attempt * 2000);
            await sleep(900 + (attempt * 700));
            continue;
        }
        break;
    }
    return { reply: `AI error: ${lastStatus}`, actions: [], rateLimited: lastStatus === 429 };
};
const callOpenAiCompat = async ({ baseUrl, apiKey, model, systemPrompt, schemaPrompt, userText, actionMode, extraHeaders = {} }) => {
    const body = {
        model,
        temperature: 0.4,
        messages: actionMode
            ? [{ role: 'system', content: `${systemPrompt}\n${schemaPrompt}` }, { role: 'user', content: userText }]
            : [{ role: 'system', content: systemPrompt }, { role: 'user', content: userText }]
    };
    if (actionMode) body.response_format = { type: 'json_object' };
    const res = await fetchWithTimeout(`${String(baseUrl || '').replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
            ...extraHeaders
        },
        body: JSON.stringify(body)
    }, 8500);
    if (!res.ok) return { reply: `AI error: ${res.status}`, actions: [], rateLimited: res.status === 429 };
    const payload = await res.json();
    const content = payload?.choices?.[0]?.message?.content || '';
    if (actionMode) return parseAiJson(content) || { reply: 'تعذر فهم رد JSON.', actions: [] };
    return { reply: String(content || 'تمام، معاك.'), actions: [] };
};
const callAiModel = async (guildConfig, userText) => {
    const geminiKeysRaw = process.env.AI_API_KEYS || process.env.OPENAI_API_KEY || process.env.AI_API_KEY || '';
    const geminiKeys = String(geminiKeysRaw).split(',').map((k) => k.trim()).filter(Boolean);
    const groqKey = String(process.env.GROQ_API_KEY || '').trim();
    const openRouterKey = String(process.env.OPENROUTER_API_KEY || '').trim();
    if (geminiKeys.length === 0 && !groqKey && !openRouterKey) {
        return { reply: 'لا يوجد أي API key مضبوط للذكاء الاصطناعي.', actions: [] };
    }
    const fastModel = String(getSetting(guildConfig, 'ai_agent_model')?.value || process.env.AI_MODEL_FAST || 'gemini-2.5-flash');
    const smartModel = String(process.env.AI_MODEL_SMART || 'gemini-2.5-pro');
    const textForRouting = String(userText || '').toLowerCase();
    const useSmartModel = textForRouting.length > 220
        || /(اشرح|حلل|قارن|ليه|ازاي|كيف|why|how|analyze|compare|architecture|refactor|strategy|plan)/.test(textForRouting);
    const model = useSmartModel ? smartModel : fastModel;
    const systemPrompt = String(getSetting(guildConfig, 'ai_system_prompt')?.value || 'You are an advanced Discord assistant. Reply naturally in Arabic/English and keep context.');
    // Always request unified JSON so every provider can return executable actions from any phrasing.
    const actionMode = true;
    const schemaPrompt = `
Return JSON only with this shape:
{
  "reply": "string",
  "actions": [
    { "type": "send_message", "channelId": "id", "content": "text" },
    { "type": "create_embed", "channelId": "id", "title": "t", "description": "d", "color": "#5865F2", "fields": [{"name":"n","value":"v","inline":false}] },
    { "type": "add_role", "userId": "id", "roleId": "id" },
    { "type": "remove_role", "userId": "id", "roleId": "id" },
    { "type": "create_role", "name": "Event", "reason": "text" },
    { "type": "delete_role", "roleId": "id", "reason": "text" },
    { "type": "timeout_user", "userId": "id", "durationSec": 600, "reason": "text" },
    { "type": "ban_user", "userId": "id", "reason": "text" },
    { "type": "kick_user", "userId": "id", "reason": "text" },
    { "type": "clear_messages", "channelId": "id", "amount": 10 },
    { "type": "lock_channel", "channelId": "id" },
    { "type": "unlock_channel", "channelId": "id" },
    { "type": "create_buttons", "channelId": "id", "content": "text", "buttons": [{"label":"Give VIP","style":"primary","action":"add_role","roleId":"id","url":""}] },
    { "type": "create_select_roles", "channelId": "id", "content": "text", "placeholder":"Choose role", "mode":"add", "options":[{"label":"VIP","value":"roleId","description":"..."}] }
  ]
}
Rules:
- Understand Arabic and English commands in any wording.
- If the user asks to execute admin/UI action, put it in "actions" with correct IDs when possible.
- Prefer mapping names to IDs using provided context list (members/roles/channels).
- If message sounds like moderation/admin request, return at least one actionable item whenever possible.
- Keep "reply" short and natural (not code or escaped JSON).
- If no execution is needed, return empty actions array.
`;
    const providerOrder = String(process.env.AI_FALLBACK_ORDER || 'gemini,groq,openrouter')
        .split(',')
        .map((p) => p.trim().toLowerCase())
        .filter(Boolean);
    let lastError = { reply: 'AI error: unknown', actions: [] };
    for (const provider of providerOrder) {
        if (provider === 'gemini' && geminiKeys.length > 0) {
            const key = pickGeminiKey(geminiKeys);
            const primary = actionMode
                ? await callGeminiNative(key, model, systemPrompt, schemaPrompt, userText)
                : await callGeminiNativeText(key, model, systemPrompt, userText);
            if (!String(primary.reply || '').startsWith('AI error:')) return primary;
            if (model !== fastModel) {
                const fallback = actionMode
                    ? await callGeminiNative(key, fastModel, systemPrompt, schemaPrompt, userText)
                    : await callGeminiNativeText(key, fastModel, systemPrompt, userText);
                if (!String(fallback.reply || '').startsWith('AI error:')) return fallback;
                lastError = fallback;
            } else {
                lastError = primary;
            }
        } else if (provider === 'groq' && groqKey) {
            const groqFast = String(process.env.AI_MODEL_GROQ_FAST || 'llama-3.1-8b-instant');
            const groqSmart = String(process.env.AI_MODEL_GROQ_SMART || 'llama-3.3-70b-versatile');
            const groqModel = useSmartModel ? groqSmart : groqFast;
            const r = await callOpenAiCompat({
                baseUrl: 'https://api.groq.com/openai/v1',
                apiKey: groqKey,
                model: groqModel,
                systemPrompt,
                schemaPrompt,
                userText,
                actionMode
            });
            if (!String(r.reply || '').startsWith('AI error:')) return r;
            lastError = r;
        } else if (provider === 'openrouter' && openRouterKey) {
            const orFast = String(process.env.AI_MODEL_OPENROUTER_FAST || 'meta-llama/llama-3.1-8b-instruct:free');
            const orSmart = String(process.env.AI_MODEL_OPENROUTER_SMART || 'google/gemini-2.0-flash-exp:free');
            const orModel = useSmartModel ? orSmart : orFast;
            const r = await callOpenAiCompat({
                baseUrl: 'https://openrouter.ai/api/v1',
                apiKey: openRouterKey,
                model: orModel,
                systemPrompt,
                schemaPrompt,
                userText,
                actionMode,
                extraHeaders: { 'X-Title': 'OnlyGg Bot Maker' }
            });
            if (!String(r.reply || '').startsWith('AI error:')) return r;
            lastError = r;
        }
    }
    return lastError;
};
const normalizeLoose = (s) => String(s || '')
    .toLowerCase()
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[^a-z0-9\u0600-\u06FF\s_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const roleWordAliases = {
    'ادمن': ['admin', 'administrator', 'staff'],
    'مشرف': ['mod', 'moderator', 'helper'],
    'في اي بي': ['vip'],
    'فايب': ['vip'],
    'مالك': ['owner', 'founder'],
    'مطور': ['dev', 'developer'],
    'بوت': ['bot'],
    'داعم': ['booster', 'supporter']
};
const genericRoleStopwords = new Set(['server', 'سيرفر', 'guild', 'room', 'channel', 'روم', 'قناه', 'قناة', 'role', 'rank', 'رتبه', 'رتبة']);
const expandRoleAliases = (text) => {
    const clean = normalizeLoose(text);
    let expanded = clean;
    Object.entries(roleWordAliases).forEach(([ar, enList]) => {
        if (clean.includes(ar)) expanded += ` ${enList.join(' ')}`;
    });
    return expanded.trim();
};
const resolveRoleByNameLoose = (guild, text) => {
    const clean = expandRoleAliases(text);
    if (!clean) return null;
    let best = null;
    let bestScore = 0;
    guild.roles.cache
        .filter((r) => r.name !== '@everyone' && !r.managed)
        .forEach((r) => {
            const rn = normalizeLoose(r.name || '');
            let score = 0;
            if (clean.includes(rn)) score += rn.length + 10;
            const tokens = rn.split(/\s+/).filter(Boolean);
            tokens.forEach((t) => { if (t.length >= 2 && clean.includes(t)) score += t.length; });
            if (score > bestScore) {
                bestScore = score;
                best = r;
            }
        });
    if (!best || bestScore < 4) return null;
    const bestName = normalizeLoose(best.name || '');
    if (genericRoleStopwords.has(bestName) && !clean.includes(bestName)) return null;
    return best;
};
const resolveMemberByNameLoose = async (guild, text, excludeId = '') => {
    const clean = String(text || '').replace(/[^\p{L}\p{N}\s_-]/gu, ' ').toLowerCase();
    if (!clean) return null;
    let best = null;
    let bestScore = 0;
    for (const m of guild.members.cache.values()) {
        if (m.user.bot) continue;
        if (excludeId && String(m.id) === String(excludeId)) continue;
        const names = [m.user.username, m.displayName, m.user.globalName].filter(Boolean).map((n) => String(n).toLowerCase());
        let score = 0;
        for (const n of names) {
            if (clean.includes(n)) score += n.length + 8;
            const tokens = n.split(/\s+/).filter(Boolean);
            tokens.forEach((t) => { if (t.length >= 2 && clean.includes(t)) score += t.length; });
        }
        if (score > bestScore) {
            bestScore = score;
            best = m;
        }
    }
    return best;
};
const enrichAiActions = async (message, actions, userText) => {
    const list = Array.isArray(actions) ? actions : [];
    const output = [];
    for (const action of list) {
        const type = String(action?.type || '').toLowerCase();
        if (type === 'add_role' || type === 'remove_role') {
            let userId = String(action.userId || '');
            let roleId = String(action.roleId || '');
            if (!userId) userId = resolveMentionedMemberId(message) || await resolveRepliedMemberId(message);
            if (!roleId) roleId = resolveMentionedRoleId(message);
            if (!userId) {
                const m = await resolveMemberByNameLoose(message.guild, userText, message.author.id);
                if (m) userId = m.id;
            }
            if (!roleId) {
                const r = resolveRoleByNameLoose(message.guild, userText);
                if (r) roleId = r.id;
            }
            output.push({ ...action, userId, roleId });
            continue;
        }
        if (type === 'ban_user' || type === 'kick_user' || type === 'timeout_user') {
            let userId = String(action.userId || '');
            if (!userId) userId = resolveMentionedMemberId(message) || await resolveRepliedMemberId(message);
            if (!userId) {
                const m = await resolveMemberByNameLoose(message.guild, userText, message.author.id);
                if (m) userId = m.id;
            }
            output.push({ ...action, userId });
            continue;
        }
        if (type === 'delete_role') {
            let roleId = String(action.roleId || '');
            if (!roleId) roleId = resolveMentionedRoleId(message);
            if (!roleId) {
                const r = resolveRoleByNameLoose(message.guild, userText);
                if (r) roleId = r.id;
            }
            output.push({ ...action, roleId });
            continue;
        }
        output.push(action);
    }
    return output;
};
const getAiActionColor = (hex) => {
    const clean = String(hex || '').replace('#', '').trim();
    if (!/^[0-9a-fA-F]{6}$/.test(clean)) return 0x5865f2;
    return parseInt(clean, 16);
};
const executeAiAction = async (message, guildConfig, action) => {
    const type = String(action?.type || '').toLowerCase();
    const guild = message.guild;
    if (!guild) return false;
    const botMember = guild.members.me || await guild.members.fetchMe().catch(() => null);
    const failNotice = async (txt) => {
        await message.reply(`❌ ${txt}`).catch(() => {});
        return false;
    };
    if (type === 'send_message') {
        const channelId = String(action.channelId || message.channel.id);
        const ch = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
        if (ch && ch.type === ChannelType.GuildText) {
            await ch.send({ content: String(action.content || '') });
            return true;
        }
        return false;
    }
    if (type === 'create_embed') {
        const channelId = String(action.channelId || message.channel.id);
        const ch = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
        if (!ch || ch.type !== ChannelType.GuildText) return false;
        const embed = new EmbedBuilder()
            .setColor(getAiActionColor(action.color))
            .setTitle(String(action.title || 'AI Embed'))
            .setDescription(String(action.description || ''));
        const fields = Array.isArray(action.fields) ? action.fields.slice(0, 10) : [];
        if (fields.length) {
            embed.addFields(fields.map((f) => ({
                name: String(f.name || 'Field').slice(0, 256),
                value: String(f.value || '-').slice(0, 1024),
                inline: !!f.inline
            })));
        }
        await ch.send({ embeds: [embed] });
        return true;
    }
    if (type === 'add_role' || type === 'remove_role') {
        let targetUserId = String(action.userId || '');
        const mentionedTarget = resolveMentionedMemberId(message);
        if (mentionedTarget && (!targetUserId || targetUserId === String(message.author.id))) {
            targetUserId = mentionedTarget;
        }
        const member = await guild.members.fetch(targetUserId).catch(() => null);
        const role = guild.roles.cache.get(String(action.roleId || '')) || await guild.roles.fetch(String(action.roleId || '')).catch(() => null);
        if (!member) return failNotice('لم أقدر أحدد العضو المستهدف.');
        if (!role) return failNotice('لم أقدر أحدد الرتبة المطلوبة.');
        if (!botMember?.permissions?.has(PermissionFlagsBits.ManageRoles)) {
            return failNotice('البوت لا يملك صلاحية Manage Roles.');
        }
        const botHighest = botMember.roles.highest;
        if (botHighest.position <= role.position) {
            return failNotice(`لا أستطيع تعديل رتبة أعلى/مساوية لرتبتي (${role.name}).`);
        }
        if (member.id === guild.ownerId) {
            return failNotice('لا يمكن تعديل رتب Owner السيرفر.');
        }
        if (member.roles.highest.position >= botHighest.position) {
            return failNotice('لا أستطيع تعديل رتب هذا العضو بسبب ترتيب الرتب.');
        }
        if (type === 'add_role') {
            if (member.roles.cache.has(role.id)) return failNotice(`العضو لديه رتبة ${role.name} بالفعل.`);
            await member.roles.add(role).catch(() => null);
            const refreshed = await guild.members.fetch(member.id).catch(() => null);
            if (!refreshed?.roles?.cache?.has(role.id)) return failNotice('فشلت إضافة الرتبة (تحقق من ترتيب الرتب والصلاحيات).');
        } else {
            if (!member.roles.cache.has(role.id)) return failNotice(`العضو لا يملك رتبة ${role.name}.`);
            await member.roles.remove(role).catch(() => null);
            const refreshed = await guild.members.fetch(member.id).catch(() => null);
            if (refreshed?.roles?.cache?.has(role.id)) return failNotice('فشل سحب الرتبة (تحقق من ترتيب الرتب والصلاحيات).');
        }
        setChannelContext(message, { lastUserId: member.id, lastRoleId: role.id });
        return true;
    }
    if (type === 'delete_role') {
        const role = guild.roles.cache.get(String(action.roleId || '')) || await guild.roles.fetch(String(action.roleId || '')).catch(() => null);
        if (!role || role.name === '@everyone' || role.managed) return false;
        if (!botMember?.permissions?.has(PermissionFlagsBits.ManageRoles)) return false;
        const botHighest = botMember.roles.highest;
        if (botHighest.position <= role.position) return false;
        const roleId = role.id;
        await role.delete(String(action.reason || 'AI Agent delete role')).catch(() => {});
        const stillExists = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
        return !stillExists;
    }
    if (type === 'create_role') {
        if (!botMember?.permissions?.has(PermissionFlagsBits.ManageRoles)) return false;
        const roleName = String(action.name || '').trim().slice(0, 90) || 'New Role';
        const created = await guild.roles.create({ name: roleName, reason: String(action.reason || 'AI Agent create role') }).catch(() => null);
        return !!created?.id;
    }
    if (type === 'timeout_user') {
        const member = await guild.members.fetch(String(action.userId || '')).catch(() => null);
        if (!member || !member.moderatable) return false;
        const durationMs = Math.max(10000, Math.min(2419200000, (Number(action.durationSec) || 60) * 1000));
        await member.timeout(durationMs, String(action.reason || 'AI Agent action')).catch(() => {});
        const refreshed = await guild.members.fetch(member.id).catch(() => null);
        return !!refreshed?.communicationDisabledUntilTimestamp;
    }
    if (type === 'ban_user') {
        const member = await guild.members.fetch(String(action.userId || '')).catch(() => null);
        if (!member || !member.bannable) return false;
        await member.ban({ reason: String(action.reason || 'AI Agent action') }).catch(() => {});
        const ban = await guild.bans.fetch(member.id).catch(() => null);
        return !!ban;
    }
    if (type === 'kick_user') {
        const member = await guild.members.fetch(String(action.userId || '')).catch(() => null);
        if (!member || !member.kickable) return false;
        const memberId = member.id;
        await member.kick(String(action.reason || 'AI Agent action')).catch(() => {});
        const existsAfter = await guild.members.fetch(memberId).then(() => true).catch(() => false);
        return !existsAfter;
    }
    if (type === 'clear_messages') {
        const channelId = String(action.channelId || message.channel.id);
        const ch = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
        if (!ch || ch.type !== ChannelType.GuildText) return false;
        const amount = Math.max(1, Math.min(100, Number(action.amount) || 10));
        await ch.bulkDelete(amount, true).catch(() => {});
        return true;
    }
    if (type === 'lock_channel' || type === 'unlock_channel') {
        const channelId = String(action.channelId || message.channel.id);
        const ch = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
        if (!ch || ch.type !== ChannelType.GuildText) return false;
        if (type === 'lock_channel') {
            await ch.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false }).catch(() => {});
        } else {
            await ch.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: null }).catch(() => {});
        }
        return true;
    }
    if (type === 'create_buttons') {
        const channelId = String(action.channelId || message.channel.id);
        const ch = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
        if (!ch || ch.type !== ChannelType.GuildText) return false;
        const buttons = Array.isArray(action.buttons) ? action.buttons.slice(0, 5) : [];
        const row = new ActionRowBuilder();
        buttons.forEach((b, idx) => {
            const styleMap = { primary: ButtonStyle.Primary, secondary: ButtonStyle.Secondary, success: ButtonStyle.Success, danger: ButtonStyle.Danger, link: ButtonStyle.Link };
            const style = styleMap[String(b.style || 'primary').toLowerCase()] || ButtonStyle.Primary;
            const btn = new ButtonBuilder().setLabel(String(b.label || `Btn ${idx + 1}`).slice(0, 80)).setStyle(style);
            if (style === ButtonStyle.Link) btn.setURL(String(b.url || 'https://discord.com'));
            else if (String(b.action || '').toLowerCase() === 'add_role' && b.roleId) btn.setCustomId(`ai:role:add:${b.roleId}`);
            else if (String(b.action || '').toLowerCase() === 'remove_role' && b.roleId) btn.setCustomId(`ai:role:remove:${b.roleId}`);
            else btn.setCustomId(`ai:noop:${Date.now()}:${idx}`);
            row.addComponents(btn);
        });
        if (row.components.length > 0) {
            await ch.send({ content: String(action.content || 'AI Buttons'), components: [row] });
            return true;
        }
        return false;
    }
    if (type === 'create_select_roles') {
        const channelId = String(action.channelId || message.channel.id);
        const ch = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
        if (!ch || ch.type !== ChannelType.GuildText) return false;
        const mode = String(action.mode || 'add').toLowerCase() === 'remove' ? 'remove' : 'add';
        const select = new StringSelectMenuBuilder()
            .setCustomId(`ai:select-role:${mode}`)
            .setPlaceholder(String(action.placeholder || 'Choose role').slice(0, 100))
            .setMinValues(1)
            .setMaxValues(1);
        const options = Array.isArray(action.options) ? action.options.slice(0, 25) : [];
        select.addOptions(options.map((o) => ({
            label: String(o.label || o.value || 'Role').slice(0, 100),
            value: String(o.value || ''),
            description: String(o.description || '').slice(0, 100)
        })).filter((o) => o.value));
        if (select.options.length === 0) return false;
        const row = new ActionRowBuilder().addComponents(select);
        await ch.send({ content: String(action.content || 'Choose role'), components: [row] });
        return true;
    }
    return false;
};
const buildRoleSelectFallbackAction = (message, userText) => {
    const t = String(userText || '').toLowerCase();
    const wantsSelect = /select|menu|سيلكت|اختيار/.test(t);
    const wantsRole = /role|رتب|رتبة/.test(t);
    if (!wantsSelect || !wantsRole) return null;
    const options = message.guild.roles.cache
        .filter((r) => r.name !== '@everyone' && !r.managed)
        .first(20)
        .map((r) => ({ label: r.name, value: r.id, description: `Role ${r.name}` }));
    if (options.length === 0) return null;
    return {
        type: 'create_select_roles',
        channelId: message.channel.id,
        content: 'اختر الرتبة من القائمة:',
        placeholder: 'اختر رتبة',
        mode: 'add',
        options
    };
};
const buildButtonsFallbackAction = (message, userText) => {
    const t = String(userText || '').toLowerCase();
    const wantsButtons = /button|buttons|زر|ازرار|أزرار/.test(t);
    if (!wantsButtons) return null;
    return {
        type: 'create_buttons',
        channelId: message.channel.id,
        content: 'أزرار تجريبية من AI Agent',
        buttons: [
            { label: 'تأكيد', style: 'success' },
            { label: 'إلغاء', style: 'danger' }
        ]
    };
};
const buildEmbedFallbackAction = (message, userText) => {
    const t = String(userText || '').toLowerCase();
    const wantsEmbed = /embed|ايمبد|إيمبد/.test(t);
    if (!wantsEmbed) return null;
    return {
        type: 'create_embed',
        channelId: message.channel.id,
        title: 'AI Generated Embed',
        description: String(userText || '').slice(0, 300),
        color: '#5865F2',
        fields: [{ name: 'Status', value: 'تم إنشاء الإيمبد بنجاح', inline: false }]
    };
};
const resolveMentionedMemberId = (message) => message.mentions?.members?.first()?.id || '';
const resolveMentionedRoleId = (message) => message.mentions?.roles?.first()?.id || '';
const resolveRepliedMemberId = async (message) => {
    try {
        if (!message.reference?.messageId) return '';
        const replied = await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
        if (!replied?.author?.id || replied.author.bot) return '';
        const member = await message.guild.members.fetch(replied.author.id).catch(() => null);
        return member ? member.id : '';
    } catch (_) {
        return '';
    }
};
const resolveMemberFromText = async (message, text) => {
    const mentioned = resolveMentionedMemberId(message);
    if (mentioned) return mentioned;
    const replied = await resolveRepliedMemberId(message);
    if (replied) return replied;
    const idMatch = String(text || '').match(/\b\d{17,20}\b/);
    if (!idMatch) return '';
    const m = await message.guild.members.fetch(idMatch[0]).catch(() => null);
    return m ? m.id : '';
};
const resolveRoleFromText = async (message, text) => {
    const mentioned = resolveMentionedRoleId(message);
    if (mentioned) return mentioned;
    const loose = resolveRoleByNameLoose(message.guild, text);
    if (loose) return loose.id;
    const raw = String(text || '');
    const clean = raw.replace(/[^\p{L}\p{N}\s_-]/gu, ' ').toLowerCase();
    const byName = message.guild.roles.cache
        .filter((r) => r.name !== '@everyone' && !r.managed)
        .find((r) => clean.includes(String(r.name || '').toLowerCase()));
    if (byName) return byName.id;
    const ids = raw.match(/\b\d{17,20}\b/g) || [];
    for (const id of ids) {
        const role = message.guild.roles.cache.get(id) || await message.guild.roles.fetch(id).catch(() => null);
        if (role && role.name !== '@everyone') return role.id;
    }
    return '';
};
const parseClearAmountFromText = (text) => {
    const t = normalizeLoose(text || '');
    const num = Number(t.match(/\b(\d{1,3})\b/)?.[1] || 0);
    if (num > 0) return Math.max(1, Math.min(100, num));
    if (/رسالتين|last 2|اخر 2|آخر 2|last two|two messages|message two/.test(t)) return 2;
    if (/3|ثلاث/.test(t) && /رسايل|رسائل|messages?/.test(t)) return 3;
    if (/4|اربع/.test(t) && /رسايل|رسائل|messages?/.test(t)) return 4;
    if (/5|خمس/.test(t) && /رسايل|رسائل|messages?/.test(t)) return 5;
    if (/اخر رساله|آخر رسالة|last message/.test(t)) return 1;
    return 20;
};
const detectImmediateModerationAction = async (message, userText) => {
    const t = normalizeLoose(userText || '');
    const wantsDeleteRoleFromServer = /(احذف|امسح|delete|remove).*(رتبه|رتبة|role).*(من السيرفر|من السرفر|from server)/.test(t)
        || ((/(delete|remove)/.test(t) && /(role|رتبه|رتبة)/.test(t)) && /(server|guild|سيرفر|السيرفر)/.test(t));
    const wantsCreateRoleInServer = /(انشئ|اعمل|create|make).*(رتبه|رتبة|role)/.test(t)
        && /(server|guild|سيرفر|السيرفر)/.test(t);
    const wantsGiveRole = /(add|give|assign|ادي|اعطي|اعطى|ضيف|حط|خل(ي|يه)|اديله).*(role|رتب|رتبه|rank)/.test(t) || /(role|رتب|رتبه).*(ادي|اعطي|اعطى|ضيف|give|add)/.test(t);
    const wantsRemoveRole = /remove role|take role|اسحب رتبة|شيل رتبة|احذف رتبة/.test(t);
    const wantsClear = /clear|purge|امسح|حذف رسايل|احذف رسائل/.test(t);
    const wantsBan = /(^|\s)ban(\s|$)|بان|احظر|حظر/.test(t);
    const wantsKick = /(^|\s)kick(\s|$)|اطرد|طرد/.test(t);
    const wantsTimeout = /timeout|mute|كتم|تايم اوت|تايماوت/.test(t);
    const wantsLock = /(^|\\s)lock($|\\s)|قفل/.test(t);
    const wantsUnlock = /(^|\\s)unlock($|\\s)|فتح/.test(t);

    if (wantsDeleteRoleFromServer) {
        const roleId = await resolveRoleFromText(message, userText);
        if (!roleId) return { type: 'send_message', channelId: message.channel.id, content: 'حدد الرتبة المراد حذفها من السيرفر (منشن/اسم/ID واضح).' };
        return { type: 'delete_role', roleId, reason: 'AI immediate moderation' };
    }
    if (wantsCreateRoleInServer) {
        const cleanText = String(userText || '').replace(/[<@#&!>]/g, ' ').trim();
        const roleNameCandidate = cleanText
            .replace(/(انشئ|اعمل|create|make|role|رتبه|رتبة|in|on|the|server|guild|سيرفر|السيرفر)/ig, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        return { type: 'create_role', name: (roleNameCandidate || 'New Role').slice(0, 90), reason: 'AI immediate moderation' };
    }
    if (wantsGiveRole || wantsRemoveRole) {
        const userId = await resolveMemberFromText(message, userText);
        const roleId = await resolveRoleFromText(message, userText);
        const ctx = getChannelContext(message);
        const finalUserId = userId || ctx.lastUserId || '';
        const finalRoleId = roleId || ctx.lastRoleId || '';
        if (finalUserId && finalRoleId) return { type: wantsGiveRole ? 'add_role' : 'remove_role', userId: finalUserId, roleId: finalRoleId };
        return { type: 'send_message', channelId: message.channel.id, content: 'حدد العضو والرتبة بوضوح (منشن العضو + منشن/اسم الرتبة).' };
    }
    if (wantsClear) {
        const amount = parseClearAmountFromText(userText);
        return { type: 'clear_messages', channelId: message.channel.id, amount };
    }
    if (wantsBan || wantsKick || wantsTimeout) {
        const userId = await resolveMemberFromText(message, userText);
        const ctx = getChannelContext(message);
        const finalUserId = userId || ctx.lastUserId || '';
        if (!finalUserId) return { type: 'send_message', channelId: message.channel.id, content: 'حدد العضو المستهدف (منشن/رد/ID/اسم).' };
        if (wantsBan) return { type: 'ban_user', userId: finalUserId, reason: 'AI immediate moderation' };
        if (wantsKick) return { type: 'kick_user', userId: finalUserId, reason: 'AI immediate moderation' };
        const sec = Number(t.match(/\b(\d{1,6})\b/)?.[1] || 600);
        return { type: 'timeout_user', userId: finalUserId, durationSec: Math.max(10, Math.min(2419200, sec)), reason: 'AI immediate moderation' };
    }
    if (wantsLock) return { type: 'lock_channel', channelId: message.channel.id };
    if (wantsUnlock) return { type: 'unlock_channel', channelId: message.channel.id };
    return null;
};
const detectImmediateUiAction = (message, userText) => {
    const t = String(userText || '').toLowerCase();
    const wantsRoleWord = /role|roles|رتبة|رتب/.test(t);
    const wantsMenuWord = /select|menu|dropdown|قائمة|سيلكت|اختيار|اختار|اختر/.test(t);
    const wantsButtonsWord = /button|buttons|زر|ازرار|أزرار/.test(t);
    const wantsEmbedWord = /embed|ايمبد|إيمبد/.test(t);

    if (wantsRoleWord && wantsMenuWord) {
        const options = message.guild.roles.cache
            .filter((r) => r.name !== '@everyone' && !r.managed)
            .map((r) => ({ label: r.name, value: r.id, description: `Role ${r.name}` }))
            .slice(0, 25);
        if (options.length) {
            return {
                type: 'create_select_roles',
                channelId: message.channel.id,
                content: 'اختَر الرتبة من القائمة:',
                placeholder: 'اختيار رتبة',
                mode: 'add',
                options
            };
        }
    }

    if (wantsButtonsWord) {
        return {
            type: 'create_buttons',
            channelId: message.channel.id,
            content: 'تم إنشاء الأزرار المطلوبة:',
            buttons: [
                { label: 'تأكيد', style: 'success' },
                { label: 'إلغاء', style: 'danger' }
            ]
        };
    }

    if (wantsEmbedWord) {
        return {
            type: 'create_embed',
            channelId: message.channel.id,
            title: 'AI Embed',
            description: String(userText || '').slice(0, 300),
            color: '#5865F2',
            fields: [{ name: 'الحالة', value: 'تم إنشاء الإيمبد', inline: false }]
        };
    }

    return null;
};
const handleAiAgentMessage = async (message, guildConfig) => {
    if (!toBool(getSetting(guildConfig, 'ai_agent_enabled')?.value, false)) return false;
    const aiChannelId = String(getSetting(guildConfig, 'ai_agent_channel')?.value || '');
    if (!aiChannelId || String(message.channel.id) !== aiChannelId) return false;
    const controlSetting = getSetting(guildConfig, 'ai_agent_control');
    // Channel already locked to ai_agent_channel above; here we enforce role access only
    const roleOnlySetting = controlSetting ? { ...controlSetting, allowedChannels: [] } : null;
    if (!roleOnlySetting || !hasCommandAccess(message, roleOnlySetting)) {
        await message.reply('ليس لديك صلاحية استخدام AI Agent في هذا الروم.');
        return true;
    }
    pushAiConversationTurn(message, 'user', message.content);
    const instantModAction = await detectImmediateModerationAction(message, message.content);
    if (instantModAction) {
        if (isDangerousAiAction(instantModAction)) {
            await requestActionConfirmation(message, [instantModAction], 'تم فهم طلب إداري مباشر.');
            pushAiConversationTurn(message, 'assistant', 'تم تجهيز أمر إداري وبانتظار التأكيد.');
        } else {
            const ok = await executeAiAction(message, guildConfig, instantModAction);
            const done = ok ? '✅ تم تنفيذ الأمر الإداري مباشرة.' : '❌ تعذر تنفيذ الأمر الإداري.';
            await message.reply(done);
            pushAiConversationTurn(message, 'assistant', done);
        }
        return true;
    }
    const instantUiAction = detectImmediateUiAction(message, message.content);
    if (instantUiAction) {
        const ok = await executeAiAction(message, guildConfig, instantUiAction);
        const done = ok ? '✅ تم التنفيذ فورًا.' : '❌ تعذر تنفيذ الطلب.';
        await message.reply(done);
        pushAiConversationTurn(message, 'assistant', done);
        return true;
    }
    const typing = setInterval(() => message.channel.sendTyping().catch(() => {}), 3500);
    try {
        const history = getAiConversationHistory(message);
        const historyBlock = buildCompactHistoryText(history);
        const executionContext = buildAiExecutionContext(message);
        const aiInput = [
            executionContext ? `Execution context:\n${executionContext}` : '',
            `User message:\n${message.content}`,
            historyBlock ? `Conversation history:\n${historyBlock}` : ''
        ].filter(Boolean).join('\n\n');
        const ai = await callAiModel(guildConfig, aiInput);
        const allowActions = toBool(getSetting(guildConfig, 'ai_agent_allow_actions')?.value, true);
        const maxActions = Math.max(0, Math.min(10, Number(getSetting(guildConfig, 'ai_agent_max_actions')?.value) || 4));
        let executedCount = 0;
        let hasDangerousActions = false;
        let aiActions = await enrichAiActions(message, ai.actions, message.content);
        let candidateActions = [];
        if (allowActions && Array.isArray(aiActions)) {
            candidateActions = aiActions.slice(0, maxActions);
        }
        if (allowActions && candidateActions.length === 0) {
            const fallback = buildRoleSelectFallbackAction(message, message.content)
                || buildButtonsFallbackAction(message, message.content)
                || buildEmbedFallbackAction(message, message.content);
            if (fallback) {
                candidateActions = [fallback];
            }
        }
        if (allowActions && candidateActions.length > 0) {
            const dangerous = candidateActions.filter(isDangerousAiAction);
            const safe = candidateActions.filter((a) => !isDangerousAiAction(a));

            for (const action of safe) {
                const ok = await executeAiAction(message, guildConfig, action);
                if (ok) executedCount += 1;
            }
            if (dangerous.length > 0) {
                hasDangerousActions = true;
                await requestActionConfirmation(message, dangerous, 'تم تجهيز أوامر خطيرة من الذكاء الاصطناعي.');
            }
        }
        if (ai.reply) {
            if (String(ai.reply).startsWith('AI error:')) {
                const fallbackMod = await detectImmediateModerationAction(message, message.content);
                if (fallbackMod) {
                    if (isDangerousAiAction(fallbackMod)) {
                        await requestActionConfirmation(message, [fallbackMod], 'تعذر رد AI الآن، وتم تجهيز أمرك مباشرة.');
                        const pending = 'تم تجهيز الأمر وبانتظار التأكيد.';
                        await message.reply(pending);
                        pushAiConversationTurn(message, 'assistant', pending);
                        return true;
                    }
                    const ok = await executeAiAction(message, guildConfig, fallbackMod);
                    if (ok) {
                        const done = '✅ تم تنفيذ طلبك مباشرة (fallback).';
                        await message.reply(done);
                        pushAiConversationTurn(message, 'assistant', done);
                        return true;
                    }
                }
                const fallbackUi = detectImmediateUiAction(message, message.content);
                if (fallbackUi) {
                    const ok = await executeAiAction(message, guildConfig, fallbackUi);
                    if (ok) {
                        const done = '✅ تم تنفيذ طلب الواجهة مباشرة (fallback).';
                        await message.reply(done);
                        pushAiConversationTurn(message, 'assistant', done);
                        return true;
                    }
                }
            }
            if (String(ai.reply).startsWith('AI error: 429') || ai.rateLimited) {
                const localReply = await buildLocalConversationalReply(message, message.content, history);
                await message.reply(localReply);
                pushAiConversationTurn(message, 'assistant', localReply);
                return true;
            }
            const humanReply = normalizeAiReplyText(ai.reply);
            const adminIntent = looksLikeAdminExecutionRequest(message.content);
            if (adminIntent && executedCount === 0 && !hasDangerousActions) {
                const failText = 'فهمت طلب التنفيذ لكن لم يتم أي إجراء فعلي. اكتب الهدف بشكل أوضح (منشن عضو/اسم رتبة/عدد الرسائل) وأنا أنفذ فورًا.';
                await message.reply(failText);
                pushAiConversationTurn(message, 'assistant', failText);
                return true;
            }
            const suffix = executedCount > 0 ? `\n\n✅ تم تنفيذ ${executedCount} إجراء فعلي.` : '';
            const finalReply = `${String(humanReply || ai.reply).slice(0, 1700)}${suffix}`;
            await message.reply(finalReply);
            pushAiConversationTurn(message, 'assistant', finalReply);
        }
        await sendLogEvent(message.guild, guildConfig, 'log_mod_actions', '🧠 AI Agent Action', `استخدم ${message.author.tag} الـ AI Agent`, [{ name: 'الطلب', value: String(message.content || '').slice(0, 900) }], 0x6366f1);
    } catch (_) {
        await message.reply('حدث خطأ أثناء معالجة طلب الذكاء الاصطناعي.');
    } finally {
        clearInterval(typing);
    }
    return true;
};

async function handleModeration(message, cmd, args, guildConfig, prefix) {
    const setting = getSetting(guildConfig, cmd);
    if (!setting || setting.enabled === false) return;
    if (!hasCommandAccess(message, setting)) return replyPretty(message, 'error', 'صلاحيات غير كافية', 'هذا الأمر غير متاح لك في هذه الرتبة/الروم.');
    const target = message.mentions.members.first();
    if (!target && !['clear', 'lock', 'unlock', 'warnings', 'unban', 'slowmode'].includes(cmd)) return replyCommandGuide(message, guildConfig, cmd, prefix, 'الأمر ناقص: لازم تحدد العضو.');
    if (target && target.id === message.author.id && ['ban', 'kick', 'mute', 'warn'].includes(cmd)) return replyPretty(message, 'error', 'إجراء مرفوض', 'لا يمكنك تنفيذ هذا الإجراء على نفسك.');
    if (target && target.id === message.guild.members.me.id) return replyPretty(message, 'error', 'إجراء مرفوض', 'لا يمكن تنفيذ الإجراء على البوت.');

    if (cmd === 'ban') return target.ban({ reason: args.slice(1).join(' ') || 'No reason' }).then(async () => {
        await sendLogEvent(message.guild, guildConfig, 'log_mod_actions', '🛡️ إجراء إداري: Ban', `تم حظر ${target.user.tag}`, [{ name: 'بواسطة', value: `<@${message.author.id}>`, inline: true }], 0xef4444);
        return replyPretty(message, 'success', 'تم تنفيذ الباند', `تم حظر ${target.user.tag} بنجاح.`);
    }).catch(() => replyPretty(message, 'error', 'فشل التنفيذ', 'تعذر تنفيذ الباند.'));
    if (cmd === 'unban') {
        const userId = String(args[0] || '').replace(/[<@!>]/g, '').trim();
        if (!userId) return replyCommandGuide(message, guildConfig, cmd, prefix, 'الأمر ناقص: اكتب ID المستخدم المراد فك حظره.');
        return message.guild.members.unban(userId).then(async () => {
            await sendLogEvent(message.guild, guildConfig, 'log_mod_actions', '🛡️ إجراء إداري: Unban', `تم فك حظر المستخدم \`${userId}\``, [{ name: 'بواسطة', value: `<@${message.author.id}>`, inline: true }], 0x22c55e);
            return replyPretty(message, 'success', 'تم فك الباند', `تم إلغاء حظر المستخدم \`${userId}\`.`);
        }).catch(() => replyPretty(message, 'error', 'فشل التنفيذ', 'تعذر فك الباند، تأكد أن الـ ID صحيح.'));
    }
    if (cmd === 'kick') return target.kick(args.slice(1).join(' ') || 'No reason').then(async () => {
        await sendLogEvent(message.guild, guildConfig, 'log_mod_actions', '🛡️ إجراء إداري: Kick', `تم طرد ${target.user.tag}`, [{ name: 'بواسطة', value: `<@${message.author.id}>`, inline: true }], 0xf97316);
        return replyPretty(message, 'success', 'تم تنفيذ الطرد', `تم طرد ${target.user.tag} بنجاح.`);
    }).catch(() => replyPretty(message, 'error', 'فشل التنفيذ', 'تعذر طرد العضو.'));
    if (cmd === 'mute') return target.timeout(parseDurationToMs(args[1]) || 600000).then(async () => {
        await sendLogEvent(message.guild, guildConfig, 'log_mod_actions', '🛡️ إجراء إداري: Timeout', `تم كتم ${target.user.tag}`, [{ name: 'بواسطة', value: `<@${message.author.id}>`, inline: true }], 0xf59e0b);
        return replyPretty(message, 'success', 'تم تنفيذ التايم أوت', `تم كتم ${target.user.tag}.`);
    }).catch(() => replyPretty(message, 'error', 'فشل التنفيذ', 'تعذر تنفيذ التايم أوت.'));
    if (cmd === 'unmute') return target.timeout(null).then(async () => {
        await sendLogEvent(message.guild, guildConfig, 'log_mod_actions', '🛡️ إجراء إداري: Remove Timeout', `تم فك الكتم عن ${target.user.tag}`, [{ name: 'بواسطة', value: `<@${message.author.id}>`, inline: true }], 0x22c55e);
        return replyPretty(message, 'success', 'تم فك الكتم', `تم فك التايم أوت عن ${target.user.tag}.`);
    }).catch(() => replyPretty(message, 'error', 'فشل التنفيذ', 'تعذر فك التايم أوت.'));
    if (cmd === 'clear') {
        const amount = Math.min(Number(args[0]) || 0, 100);
        if (!amount) return replyCommandGuide(message, guildConfig, cmd, prefix, 'الأمر ناقص: اكتب عدد الرسائل المراد حذفها.');
        return message.channel.bulkDelete(amount, true).then(async (deleted) => {
            await sendLogEvent(message.guild, guildConfig, 'log_mod_actions', '🛡️ إجراء إداري: Clear', `تم حذف ${deleted.size} رسالة في <#${message.channel.id}>`, [{ name: 'بواسطة', value: `<@${message.author.id}>`, inline: true }], 0x0ea5e9);
            return replyPretty(message, 'success', 'تم تنظيف الرسائل', `تم حذف ${deleted.size} رسالة.`);
        }).catch(() => replyPretty(message, 'error', 'فشل التنفيذ', 'تعذر حذف الرسائل.'));
    }
    if (cmd === 'lock') return message.channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: false }).then(async () => {
        await sendLogEvent(message.guild, guildConfig, 'log_mod_actions', '🛡️ إجراء إداري: Lock', `تم قفل <#${message.channel.id}>`, [{ name: 'بواسطة', value: `<@${message.author.id}>`, inline: true }], 0xf43f5e);
        return replyPretty(message, 'success', 'تم قفل الروم', 'لا يمكن للأعضاء إرسال رسائل الآن.');
    }).catch(() => replyPretty(message, 'error', 'فشل التنفيذ', 'تعذر قفل الروم.'));
    if (cmd === 'unlock') return message.channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: null }).then(async () => {
        await sendLogEvent(message.guild, guildConfig, 'log_mod_actions', '🛡️ إجراء إداري: Unlock', `تم فتح <#${message.channel.id}>`, [{ name: 'بواسطة', value: `<@${message.author.id}>`, inline: true }], 0x22c55e);
        return replyPretty(message, 'success', 'تم فتح الروم', 'أصبح بإمكان الأعضاء الإرسال الآن.');
    }).catch(() => replyPretty(message, 'error', 'فشل التنفيذ', 'تعذر فتح الروم.'));
    if (cmd === 'slowmode') {
        const sec = Math.max(0, Math.min(21600, Number(args[0]) || 0));
        return message.channel.setRateLimitPerUser(sec).then(async () => {
            await sendLogEvent(message.guild, guildConfig, 'log_mod_actions', '🛡️ إجراء إداري: Slowmode', `تم ضبط Slowmode في <#${message.channel.id}> إلى ${sec} ثانية`, [{ name: 'بواسطة', value: `<@${message.author.id}>`, inline: true }], 0x8b5cf6);
            return replyPretty(message, 'info', 'تم ضبط السلو مود', `القيمة الحالية: **${sec}** ثانية.`);
        }).catch(() => replyPretty(message, 'error', 'فشل التنفيذ', 'تعذر ضبط السلو مود.'));
    }

    const data = getData();
    if (cmd === 'warn') {
        const g = data.guilds[message.guild.id];
        if (!g.warnings[target.id]) g.warnings[target.id] = [];
        g.warnings[target.id].push({ by: message.author.id, reason: args.slice(1).join(' ') || 'No reason', at: Date.now() });
        writeJsonSafe(DATA_PATH, data);
        sendLogEvent(message.guild, guildConfig, 'log_mod_actions', '🛡️ إجراء إداري: Warn', `تم تحذير ${target.user.tag}`, [{ name: 'بواسطة', value: `<@${message.author.id}>`, inline: true }], 0xf59e0b);
        return replyPretty(message, 'warn', 'تم إضافة تحذير', `تم تحذير ${target.user.tag}.`);
    }
    if (cmd === 'warnings') {
        const u = message.mentions.members.first() || message.member;
        const list = data.guilds[message.guild.id].warnings[u.id] || [];
        if (list.length === 0) return replyPretty(message, 'info', 'سجل التحذيرات', `لا يوجد تحذيرات على ${u.user.tag}.`);
        const preview = list.slice(-5).map((w, i) => `${i + 1}) ${w.reason}`).join('\n');
        return replyEmbed(message, 'info', 'سجل التحذيرات', `العضو: ${u.user.tag}\nعدد التحذيرات: **${list.length}**`, [{ name: 'آخر التحذيرات', value: preview }]);
    }
    if (cmd === 'unwarn') {
        const u = message.mentions.members.first();
        if (!u) return replyPretty(message, 'error', 'عضو غير محدد', 'منشن العضو أولاً.');
        const list = data.guilds[message.guild.id].warnings[u.id] || [];
        if (list.length === 0) return replyPretty(message, 'info', 'لا يوجد تحذيرات', `لا توجد تحذيرات مسجلة لـ ${u.user.tag}.`);
        list.pop();
        data.guilds[message.guild.id].warnings[u.id] = list;
        writeJsonSafe(DATA_PATH, data);
        sendLogEvent(message.guild, guildConfig, 'log_mod_actions', '🛡️ إجراء إداري: Unwarn', `تم حذف آخر تحذير للعضو ${u.user.tag}`, [{ name: 'بواسطة', value: `<@${message.author.id}>`, inline: true }], 0x22c55e);
        return replyPretty(message, 'success', 'تم حذف التحذير', `تم حذف آخر تحذير للعضو ${u.user.tag}.`);
    }
    if (cmd === 'clearwarns') {
        const u = message.mentions.members.first();
        if (!u) return replyPretty(message, 'error', 'عضو غير محدد', 'منشن العضو أولاً.');
        data.guilds[message.guild.id].warnings[u.id] = [];
        writeJsonSafe(DATA_PATH, data);
        sendLogEvent(message.guild, guildConfig, 'log_mod_actions', '🛡️ إجراء إداري: ClearWarns', `تم مسح كل التحذيرات للعضو ${u.user.tag}`, [{ name: 'بواسطة', value: `<@${message.author.id}>`, inline: true }], 0x22c55e);
        return replyPretty(message, 'success', 'تم مسح التحذيرات', `تم مسح كل تحذيرات ${u.user.tag}.`);
    }
}

async function handleUtility(message, cmd, guildConfig, prefix, args = []) {
    const setting = getSetting(guildConfig, cmd);
    if (!setting || setting.enabled === false) return;
    if (!canUseSetting(message, setting)) return;

    if (cmd === 'help') {
        const ask = String(args[0] || '').toLowerCase().trim();
        if (ask) {
            const all = getAllSettings(guildConfig);
            const matched = Object.keys(all).find((k) => {
                const node = all[k];
                if (!node || node.enabled === false) return false;
                const main = String(node.value || k).toLowerCase();
                const aliases = getCommandAliases(node);
                return ask === k.toLowerCase() || ask === main || aliases.includes(ask);
            });
            if (matched) {
                const card = buildCommandCard(guildConfig, matched, prefix);
                if (card) return message.reply({ embeds: [card] });
            }
        }

        const all = getAllSettings(guildConfig);
        const modCommands = moderationKeys
            .filter((k) => all[k] && all[k].enabled !== false)
            .map((k) => {
                const aliases = getCommandAliases(all[k]);
                const aliasText = aliases.length ? ` | aliases: ${aliases.map((a) => `\`${a}\``).join(', ')}` : '';
                return `\`${prefix}${all[k].value || k}\`${aliasText}`;
            })
            .join(' | ') || '-';
        const utilityKeys = ['help', 'userinfo', 'serverinfo', 'avatar'];
        const utilityCommands = utilityKeys
            .filter((k) => all[k] && all[k].enabled !== false)
            .map((k) => {
                const aliases = getCommandAliases(all[k]);
                const aliasText = aliases.length ? ` | aliases: ${aliases.map((a) => `\`${a}\``).join(', ')}` : '';
                return `\`${prefix}${all[k].value || k}\`${aliasText}`;
            })
            .join(' | ') || '-';
        const embed = new EmbedBuilder()
            .setColor(0x2b8cff)
            .setTitle('لوحة أوامر البوت')
            .setDescription('كل الأوامر أدناه تعمل حسب إعدادات الكونفج والصلاحيات.')
            .addFields(
                { name: '🛡️ أوامر الإدارة', value: modCommands },
                { name: '🧰 أوامر عامة', value: utilityCommands },
                { name: '🏆 أوامر الليفل', value: `\`${prefix}${getSetting(guildConfig, 'rank_command')?.value || 'rank'}\` | \`${prefix}${getSetting(guildConfig, 'top_command')?.value || 'top'}\`` }
            )
            .setFooter({ text: `طلب بواسطة ${message.author.tag}` });
        return message.reply({ embeds: [embed] });
    }

    if (cmd === 'userinfo') {
        const target = message.mentions.users.first() || message.author;
        const member = await message.guild.members.fetch(target.id).catch(() => null);
        const embed = new EmbedBuilder()
            .setColor(0x34d399)
            .setAuthor({ name: target.tag, iconURL: target.displayAvatarURL() })
            .setDescription(`**المعرف:** ${target.id}`)
            .addFields(
                { name: 'تاريخ إنشاء الحساب', value: `<t:${Math.floor(target.createdTimestamp / 1000)}:R>`, inline: true },
                { name: 'تاريخ دخول السيرفر', value: member ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>` : 'غير متاح', inline: true }
            );
        return message.reply({ embeds: [embed] });
    }

    if (cmd === 'serverinfo') {
        const g = message.guild;
        const embed = new EmbedBuilder()
            .setColor(0xf59e0b)
            .setTitle(`معلومات السيرفر: ${g.name}`)
            .setThumbnail(g.iconURL())
            .addFields(
                { name: 'الأعضاء', value: String(g.memberCount || 0), inline: true },
                { name: 'الرتب', value: String(g.roles.cache.size), inline: true },
                { name: 'الرومات', value: String(g.channels.cache.size), inline: true }
            );
        return message.reply({ embeds: [embed] });
    }

    if (cmd === 'avatar') {
        const target = message.mentions.users.first() || message.author;
        const embed = new EmbedBuilder()
            .setColor(0xa78bfa)
            .setTitle(`صورة ${target.tag}`)
            .setImage(target.displayAvatarURL({ size: 1024 }))
            .setURL(target.displayAvatarURL({ size: 1024 }));
        return message.reply({ embeds: [embed] });
    }
}

async function handleAutoMod(message, guildConfig) {
    if (!getSetting(guildConfig, 'automod_enabled')?.value) return;
    if (message.member.permissions.has(PermissionFlagsBits.ManageMessages)) return;
    const txt = message.content || '';
    const lowerTxt = txt.toLowerCase();
    if (getSetting(guildConfig, 'block_links')?.value && /(https?:\/\/|discord\.gg\/)/i.test(txt)) return message.delete().catch(() => {});
    if (getSetting(guildConfig, 'anti_mentions')?.value) {
        const max = Number(getSetting(guildConfig, 'max_mentions')?.value) || 5;
        if (message.mentions.users.size > max) return message.delete().catch(() => {});
    }
    const bannedWords = String(getSetting(guildConfig, 'banned_words')?.value || '').split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
    if (bannedWords.length && bannedWords.some((w) => lowerTxt.includes(w))) return message.delete().catch(() => {});

    if (getSetting(guildConfig, 'anti_spam')?.value) {
        const data = getData();
        const g = data.guilds[message.guild.id];
        const windowSec = Number(getSetting(guildConfig, 'anti_spam_window_sec')?.value) || 6;
        const maxMsgs = Number(getSetting(guildConfig, 'anti_spam_messages')?.value) || 5;
        const timeoutSec = Number(getSetting(guildConfig, 'anti_spam_timeout_sec')?.value) || 60;
        const rec = g.antiSpam[message.author.id] || { count: 0, ts: Date.now() };
        if (Date.now() - rec.ts > windowSec * 1000) {
            rec.count = 0;
            rec.ts = Date.now();
        }
        rec.count += 1;
        g.antiSpam[message.author.id] = rec;
        writeJsonSafe(DATA_PATH, data);
        if (rec.count > maxMsgs) {
            await message.delete().catch(() => {});
            if (message.member.moderatable) await message.member.timeout(timeoutSec * 1000, 'Anti-spam').catch(() => {});
        }
    }
}

function handleLevels(message, guildConfig) {
    if (!getSetting(guildConfig, 'levels_enabled')?.value) return;
    const data = getData(); const g = data.guilds[message.guild.id];
    if (!g.levels[message.author.id]) g.levels[message.author.id] = { xp: 0, textXp: 0, voiceXp: 0, last: 0 };
    const cooldown = (Number(getSetting(guildConfig, 'xp_cooldown_sec')?.value) || 20) * 1000;
    if (Date.now() - g.levels[message.author.id].last < cooldown) return;
    const min = Number(getSetting(guildConfig, 'xp_min')?.value) || 10;
    const max = Number(getSetting(guildConfig, 'xp_max')?.value) || 20;
    const gain = Math.floor(Math.random() * (Math.max(max, min) - min + 1)) + min;
    g.levels[message.author.id].xp += gain;
    g.levels[message.author.id].textXp = Number(g.levels[message.author.id].textXp || 0) + gain;
    g.levels[message.author.id].last = Date.now();
    writeJsonSafe(DATA_PATH, data);
}

function awardVoiceXpTick() {
    try {
        const data = getData();
        let changed = false;
        for (const guild of client.guilds.cache.values()) {
            ensureGuildSetup(guild.id);
            const guildConfig = getGuildConfig(guild.id);
            if (!toBool(getSetting(guildConfig, 'levels_enabled')?.value, true)) continue;
            if (!toBool(getSetting(guildConfig, 'voice_xp_enabled')?.value, true)) continue;
            const voiceXp = Math.max(1, Number(getSetting(guildConfig, 'voice_xp_per_min')?.value) || 8);
            const minUsers = Math.max(1, Number(getSetting(guildConfig, 'voice_xp_min_users')?.value) || 2);
            const g = data.guilds[guild.id];
            if (!g) continue;

            for (const channel of guild.channels.cache.values()) {
                if (channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildStageVoice) continue;
                if (guild.afkChannelId && String(channel.id) === String(guild.afkChannelId)) continue;

                const humanMembers = channel.members.filter((m) => !m.user.bot);
                if (humanMembers.size < minUsers) continue;

                for (const member of humanMembers.values()) {
                    if (member.voice.selfDeaf || member.voice.serverDeaf) continue;
                    if (!g.levels[member.id]) g.levels[member.id] = { xp: 0, textXp: 0, voiceXp: 0, last: 0 };
                    g.levels[member.id].xp += voiceXp;
                    g.levels[member.id].voiceXp = Number(g.levels[member.id].voiceXp || 0) + voiceXp;
                    changed = true;
                }
            }
        }
        if (changed) writeJsonSafe(DATA_PATH, data);
    } catch (_) {}
}

client.once('ready', () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    applyConfiguredPresence();
    for (const g of client.guilds.cache.values()) ensureGuildSetup(g.id);
    setInterval(awardVoiceXpTick, 60000);
    setInterval(applyConfiguredPresence, 30000);
    setInterval(checkForSettingsUpdates, 1000); // Check every second for settings updates
});
client.on('guildCreate', (guild) => ensureGuildSetup(guild.id));
client.on('guildMemberRemove', async (member) => {
    ensureGuildSetup(member.guild.id);
    const guildConfig = getGuildConfig(member.guild.id);
    const executor = await getAuditExecutor(member.guild, 20, member.id); // MEMBER_KICK
    await sendLogEvent(
        member.guild,
        guildConfig,
        'log_member_join_leave',
        '👋 Member Leave',
        `خرج العضو **${member.user.tag}** من السيرفر.`,
        [
            { name: 'User ID', value: member.id, inline: true },
            { name: 'By', value: executor ? `<@${executor.id}>` : 'Unknown/Left by self', inline: true }
        ],
        0xef4444
    );
    if (executor && String(executor.id) !== String(member.id)) {
        await processSecurityEvent({
            guild: member.guild,
            guildConfig,
            actionKey: 'kick',
            executorMember: executor,
            details: `Target: ${member.user.tag} (${member.id})`
        });
    }
});
client.on('guildMemberAdd', async (member) => {
    ensureGuildSetup(member.guild.id);
    const guildConfig = getGuildConfig(member.guild.id);
    const enabled = toBool(getSetting(guildConfig, 'welcome_enabled')?.value, false);
    if (!enabled) return;

    const fallbackChannelId = String(getSetting(guildConfig, 'welcome_channel')?.value || '');
    const sendText = toBool(getSetting(guildConfig, 'welcome_send_text')?.value, true);
    const sendImage = toBool(getSetting(guildConfig, 'welcome_send_image')?.value, true);
    const textChannelId = String(getSetting(guildConfig, 'welcome_text_channel')?.value || fallbackChannelId);
    const imageChannelId = String(getSetting(guildConfig, 'welcome_image_channel')?.value || fallbackChannelId);
    const rawMsg = String(getSetting(guildConfig, 'welcome_message')?.value || 'Welcome {user} to {server}!');
    const rawCaption = String(getSetting(guildConfig, 'welcome_image_caption')?.value || 'نورت السيرفر يا {user} 💙');
    const text = applyWelcomeTokens(rawMsg, member);
    const caption = applyWelcomeTokens(rawCaption, member);
    const bgUrl = String(getSetting(guildConfig, 'welcome_bg_url')?.value || '').trim();
    await sendLogEvent(member.guild, guildConfig, 'log_member_join_leave', '✅ Member Join', `دخل العضو **${member.user.tag}** إلى السيرفر.`, [{ name: 'User ID', value: member.id, inline: true }], 0x22c55e);

    if (sendText && textChannelId) {
        const textChannel = member.guild.channels.cache.get(textChannelId) || await member.guild.channels.fetch(textChannelId).catch(() => null);
        if (textChannel && textChannel.type === ChannelType.GuildText) {
            await textChannel.send({ content: text }).catch(() => {});
        }
    }

    if (sendImage && imageChannelId) {
        const imageChannel = member.guild.channels.cache.get(imageChannelId) || await member.guild.channels.fetch(imageChannelId).catch(() => null);
        if (imageChannel && imageChannel.type === ChannelType.GuildText) {
            const width = Math.max(400, Number(getSetting(guildConfig, 'welcome_canvas_width')?.value) || 1000);
            const height = Math.max(180, Number(getSetting(guildConfig, 'welcome_canvas_height')?.value) || 360);
            const textX = Number(getSetting(guildConfig, 'welcome_text_x')?.value) || 320;
            const textY = Number(getSetting(guildConfig, 'welcome_text_y')?.value) || 170;
            const textSize = Number(getSetting(guildConfig, 'welcome_text_size')?.value) || 46;
            const textColor = String(getSetting(guildConfig, 'welcome_text_color')?.value || '#ffffff');
            const subtext = String(getSetting(guildConfig, 'welcome_subtext')?.value || 'Member #{count}')
                .replace(/\{count\}/g, String(member.guild.memberCount || 0))
                .replace(/\{user\}/g, member.user.username)
                .replace(/\{server\}/g, member.guild.name);
            const subSize = Number(getSetting(guildConfig, 'welcome_subtext_size')?.value) || 28;
            const subColor = String(getSetting(guildConfig, 'welcome_subtext_color')?.value || '#cfd8ff');
            const avatarEnabled = toBool(getSetting(guildConfig, 'welcome_avatar_enabled')?.value, true);
            const avatarX = Number(getSetting(guildConfig, 'welcome_avatar_x')?.value) || 120;
            const avatarY = Number(getSetting(guildConfig, 'welcome_avatar_y')?.value) || 100;
            const avatarSize = Number(getSetting(guildConfig, 'welcome_avatar_size')?.value) || 140;
            const title = String(rawMsg || 'Welcome {user} to {server}!')
                .replace(/\{user\}/g, member.user.username)
                .replace(/\{server\}/g, member.guild.name)
                .replace(/\{count\}/g, String(member.guild.memberCount || 0));

            const avatarDataUri = await loadUrlAsDataUri(member.user.displayAvatarURL({ extension: 'png', size: 512 }));
            const backgroundDataUri = await loadUrlAsDataUri(bgUrl);
            const svg = buildWelcomeCardSvg({
                width, height, title, subtext, textX, textY, textSize, textColor, subSize, subColor,
                avatarEnabled, avatarX, avatarY, avatarSize, avatarDataUri, backgroundDataUri
            });
            const rendered = new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render().asPng();
            const file = new AttachmentBuilder(rendered, { name: `welcome-${member.id}.png` });
            await imageChannel.send({ content: caption, files: [file] }).catch(() => {});
        }
    }
});

client.on('messageDelete', async (message) => {
    if (!message.guild || message.author?.bot) return;
    ensureGuildSetup(message.guild.id);
    const guildConfig = getGuildConfig(message.guild.id);
    const content = String(message.content || '').slice(0, 900) || '(empty)';
    const executor = await getAuditExecutor(message.guild, 72, message.author?.id || ''); // MESSAGE_DELETE
    await sendLogEvent(message.guild, guildConfig, 'log_message_delete', '🗑️ Message Deleted', `تم حذف رسالة في <#${message.channel.id}>`, [
        { name: 'المرسل', value: message.author ? `${message.author.tag} (${message.author.id})` : 'Unknown' },
        { name: 'الحاذف', value: executor ? `${executor.user?.tag || executor.id} (${executor.id})` : 'Unknown', inline: false },
        { name: 'المحتوى', value: content }
    ], 0xef4444);
});
client.on('guildBanAdd', async (ban) => {
    ensureGuildSetup(ban.guild.id);
    const guildConfig = getGuildConfig(ban.guild.id);
    const executor = await getAuditExecutor(ban.guild, 22, ban.user.id); // MEMBER_BAN_ADD
    await sendLogEvent(
        ban.guild,
        guildConfig,
        'log_mod_actions',
        '🔨 Member Banned',
        `تم حظر **${ban.user.tag}**`,
        [{ name: 'User ID', value: ban.user.id, inline: true }, { name: 'By', value: executor ? `<@${executor.id}>` : 'Unknown', inline: true }],
        0xef4444
    );
    if (executor) {
        await processSecurityEvent({
            guild: ban.guild,
            guildConfig,
            actionKey: 'ban',
            executorMember: executor,
            details: `Target: ${ban.user.tag} (${ban.user.id})`
        });
    }
});

client.on('messageUpdate', async (oldMessage, newMessage) => {
    if (!newMessage.guild || newMessage.author?.bot) return;
    const before = String(oldMessage.content || '').trim();
    const after = String(newMessage.content || '').trim();
    if (!before || !after || before === after) return;
    ensureGuildSetup(newMessage.guild.id);
    const guildConfig = getGuildConfig(newMessage.guild.id);
    await sendLogEvent(newMessage.guild, guildConfig, 'log_message_edit', '✏️ Message Edited', `تم تعديل رسالة في <#${newMessage.channel.id}>`, [
        { name: 'المرسل', value: `${newMessage.author.tag} (${newMessage.author.id})` },
        { name: 'المعدل', value: `${newMessage.author.tag} (${newMessage.author.id})` },
        { name: 'قبل', value: before.slice(0, 900) },
        { name: 'بعد', value: after.slice(0, 900) }
    ], 0xf59e0b);
});

client.on('guildUpdate', async (oldGuild, newGuild) => {
    ensureGuildSetup(newGuild.id);
    const guildConfig = getGuildConfig(newGuild.id);
    const changes = [];
    if (oldGuild.name !== newGuild.name) changes.push(`الاسم: **${oldGuild.name}** → **${newGuild.name}**`);
    if (String(oldGuild.afkChannelId || '') !== String(newGuild.afkChannelId || '')) changes.push('تم تحديث AFK Channel');
    if (changes.length === 0) return;
    const executor = await getAuditExecutor(newGuild, 1, newGuild.id); // GUILD_UPDATE
    await sendLogEvent(
        newGuild,
        guildConfig,
        'log_server_updates',
        '🏠 Server Updated',
        changes.join('\n'),
        [{ name: 'By', value: executor ? `<@${executor.id}>` : 'Unknown', inline: true }],
        0x3b82f6
    );
});

client.on('roleCreate', async (role) => {
    ensureGuildSetup(role.guild.id);
    const guildConfig = getGuildConfig(role.guild.id);
    const executor = await getAuditExecutor(role.guild, 30, role.id); // ROLE_CREATE
    await sendLogEvent(
        role.guild,
        guildConfig,
        'log_role_updates',
        '🆕 Role Created',
        `تم إنشاء رتبة **${role.name}**`,
        [
            { name: 'Role ID', value: role.id, inline: true },
            { name: 'By', value: executor ? `<@${executor.id}>` : 'Unknown', inline: true }
        ],
        0x22c55e
    );
    if (executor) {
        await processSecurityEvent({
            guild: role.guild,
            guildConfig,
            actionKey: 'role_create',
            executorMember: executor,
            details: `Role: ${role.name} (${role.id})`,
            color: 0xf59e0b
        });
    }
});
client.on('roleDelete', async (role) => {
    ensureGuildSetup(role.guild.id);
    const guildConfig = getGuildConfig(role.guild.id);
    const executor = await getAuditExecutor(role.guild, 32, role.id); // ROLE_DELETE
    await sendLogEvent(
        role.guild,
        guildConfig,
        'log_role_updates',
        '🗑️ Role Deleted',
        `تم حذف رتبة **${role.name}**`,
        [
            { name: 'Role ID', value: role.id, inline: true },
            { name: 'By', value: executor ? `<@${executor.id}>` : 'Unknown', inline: true }
        ],
        0xef4444
    );
    if (executor) {
        await processSecurityEvent({
            guild: role.guild,
            guildConfig,
            actionKey: 'role_delete',
            executorMember: executor,
            details: `Role: ${role.name} (${role.id})`
        });
    }
});
client.on('roleUpdate', async (oldRole, newRole) => {
    ensureGuildSetup(newRole.guild.id);
    const guildConfig = getGuildConfig(newRole.guild.id);
    if (oldRole.name === newRole.name) return;
    const executor = await getAuditExecutor(newRole.guild, 31, newRole.id); // ROLE_UPDATE
    await sendLogEvent(
        newRole.guild,
        guildConfig,
        'log_role_updates',
        '✏️ Role Updated',
        `تم تعديل اسم الرتبة: **${oldRole.name}** → **${newRole.name}**`,
        [
            { name: 'Role ID', value: newRole.id, inline: true },
            { name: 'By', value: executor ? `<@${executor.id}>` : 'Unknown', inline: true }
        ],
        0xf59e0b
    );
});

client.on('channelCreate', async (channel) => {
    if (!channel.guild) return;
    ensureGuildSetup(channel.guild.id);
    const guildConfig = getGuildConfig(channel.guild.id);
    const executor = await getAuditExecutor(channel.guild, 10, channel.id); // CHANNEL_CREATE
    await sendLogEvent(
        channel.guild,
        guildConfig,
        'log_channel_updates',
        '🆕 Channel Created',
        `تم إنشاء روم **${channel.name}**`,
        [
            { name: 'Channel ID', value: channel.id, inline: true },
            { name: 'By', value: executor ? `<@${executor.id}>` : 'Unknown', inline: true }
        ],
        0x22c55e
    );
    if (executor) {
        await processSecurityEvent({
            guild: channel.guild,
            guildConfig,
            actionKey: 'channel_create',
            executorMember: executor,
            details: `Channel: ${channel.name} (${channel.id})`,
            color: 0xf59e0b
        });
    }
});
client.on('channelDelete', async (channel) => {
    if (!channel.guild) return;
    ensureGuildSetup(channel.guild.id);
    const guildConfig = getGuildConfig(channel.guild.id);
    const executor = await getAuditExecutor(channel.guild, 12, channel.id); // CHANNEL_DELETE
    await sendLogEvent(
        channel.guild,
        guildConfig,
        'log_channel_updates',
        '🗑️ Channel Deleted',
        `تم حذف روم **${channel.name}**`,
        [
            { name: 'Channel ID', value: channel.id, inline: true },
            { name: 'By', value: executor ? `<@${executor.id}>` : 'Unknown', inline: true }
        ],
        0xef4444
    );
    if (executor) {
        await processSecurityEvent({
            guild: channel.guild,
            guildConfig,
            actionKey: 'channel_delete',
            executorMember: executor,
            details: `Channel: ${channel.name} (${channel.id})`
        });
    }
});
client.on('channelUpdate', async (oldChannel, newChannel) => {
    if (!newChannel.guild) return;
    ensureGuildSetup(newChannel.guild.id);
    const guildConfig = getGuildConfig(newChannel.guild.id);
    if (oldChannel.name === newChannel.name) return;
    const executor = await getAuditExecutor(newChannel.guild, 11, newChannel.id); // CHANNEL_UPDATE
    await sendLogEvent(
        newChannel.guild,
        guildConfig,
        'log_channel_updates',
        '✏️ Channel Updated',
        `تم تعديل اسم الروم: **${oldChannel.name}** → **${newChannel.name}**`,
        [
            { name: 'Channel ID', value: newChannel.id, inline: true },
            { name: 'By', value: executor ? `<@${executor.id}>` : 'Unknown', inline: true }
        ],
        0xf59e0b
    );
});

client.on('messageCreate', async (message) => {
    if (!message.guild || message.author.bot) return;
    ensureGuildSetup(message.guild.id);
    const guildConfig = getGuildConfig(message.guild.id);
    await handleAutoMod(message, guildConfig);
    handleLevels(message, guildConfig);
    const aiHandled = await handleAiAgentMessage(message, guildConfig);
    if (aiHandled) return;

    const prefix = getGuildPrefix(guildConfig);
    const raw = String(message.content || '').trim();
    const usedPrefix = raw.startsWith(prefix);
    if (!usedPrefix && raw.length === 0) return;
    const payload = usedPrefix ? raw.slice(prefix.length).trim() : raw;
    if (!payload) return;
    const parts = payload.split(/\s+/);
    const cmd = (parts.shift() || '').toLowerCase();
    const args = parts;
    if (usedPrefix && cmd === 'ping') return replyEmbed(message, 'info', 'البوت شغال ✅', `البريفكس الحالي: \`${prefix}\``);
    if (usedPrefix) {
        const secSetting = getSetting(guildConfig, 'security_command');
        const secCmd = String(secSetting?.value || 'security').toLowerCase().trim();
        const secAliases = Array.isArray(secSetting?.shortcuts) ? secSetting.shortcuts.map((s) => String(s).toLowerCase()) : [];
        if (cmd === secCmd || secAliases.includes(cmd)) {
            if (!hasCommandAccess(message, secSetting || {})) return replyEmbed(message, 'error', 'صلاحيات غير كافية', 'ليس لديك صلاحية لأمر الحماية.');
            const botMember = message.guild.members.me || await message.guild.members.fetchMe().catch(() => null);
            const isOwner = String(message.author.id) === String(message.guild.ownerId);
            const aboveBot = !!botMember && message.member.roles.highest.position > botMember.roles.highest.position;
            if (!isOwner && !aboveBot) {
                return replyPretty(message, 'error', 'صلاحيات غير كافية', 'تغيير إعدادات الحماية متاح فقط لمالك السيرفر أو رتبة أعلى من البوت.');
            }
            const sub = String(args[0] || 'status').toLowerCase();
            if (['on', 'enable', 'start', 'تشغيل', 'فتح'].includes(sub)) {
                setGuildSettingValue(message.guild.id, 'security_enabled', true);
                return replyPretty(message, 'success', 'Security Enabled', 'تم تشغيل نظام الحماية للسيرفر.');
            }
            if (['off', 'disable', 'stop', 'ايقاف', 'اغلاق', 'قفل'].includes(sub)) {
                setGuildSettingValue(message.guild.id, 'security_enabled', false);
                return replyPretty(message, 'warn', 'Security Disabled', 'تم إيقاف نظام الحماية للسيرفر.');
            }
            const enabledNow = isSecurityEnabled(getGuildConfig(message.guild.id));
            return replyPretty(message, 'info', 'Security Status', `الحماية الآن: **${enabledNow ? 'ON' : 'OFF'}**\nالاستخدام: \`${prefix}${secCmd} on\` أو \`${prefix}${secCmd} off\``);
        }
    }

    const resolved = usedPrefix
        ? resolveConfiguredCommand(guildConfig, cmd)
        : resolveShortcutCommand(guildConfig, cmd);
    if (!usedPrefix && !resolved) return;
    if (resolved && moderationKeys.includes(resolved.key)) {
        return handleModeration(message, resolved.key, args, guildConfig, prefix);
    }
    if (resolved && resolveUtilityCommand(resolved.key)) {
        return handleUtility(message, resolved.key, guildConfig, prefix, args);
    }
    if (usedPrefix && cmd === 'modhelp') {
        const ask = String(args[0] || '').toLowerCase().trim();
        if (ask) {
            const all = getAllSettings(guildConfig);
            const matched = moderationKeys.find((k) => {
                const node = all[k];
                if (!node || node.enabled === false) return false;
                const main = String(node.value || k).toLowerCase();
                const aliases = getCommandAliases(node);
                return ask === k.toLowerCase() || ask === main || aliases.includes(ask);
            });
            if (matched) {
                const card = buildCommandCard(guildConfig, matched, prefix);
                if (card) return message.reply({ embeds: [card] });
            }
        }
        const all = getAllSettings(guildConfig);
        const rendered = moderationKeys
            .filter((k) => all[k] && all[k].enabled !== false)
            .map((k) => {
                const aliases = getCommandAliases(all[k]);
                const aliasText = aliases.length ? ` | aliases: ${aliases.map((a) => `\`${a}\``).join(', ')}` : '';
                return `\`${prefix}${all[k].value || k}\`${aliasText}`;
            })
            .join(' | ');
        return replyEmbed(message, 'info', 'أوامر المودريشن', rendered || '-');
    }

    if (!usedPrefix) return;

    const rankCmd = (getSetting(guildConfig, 'rank_command')?.value || 'rank').toLowerCase();
    const topCmd = (getSetting(guildConfig, 'top_command')?.value || 'top').toLowerCase();
    const data = getData(); const store = data.guilds[message.guild.id];
    if (cmd === rankCmd) {
        const target = message.mentions.users.first() || message.author;
        const xp = Number(store.levels[target.id]?.xp || 0);
        const textXp = Number(store.levels[target.id]?.textXp || 0);
        const voiceXp = Number(store.levels[target.id]?.voiceXp || 0);
        const lvl = toLevel(xp);
        const rows = Object.entries(store.levels || {}).sort((a, b) => (b[1].xp || 0) - (a[1].xp || 0));
        const rankPos = Math.max(1, rows.findIndex(([uid]) => String(uid) === String(target.id)) + 1 || rows.length + 1);
        const svg = buildRankCardSvg({
            userTag: target.username,
            username: target.globalName || target.username,
            level: lvl.level,
            xp,
            current: lvl.current,
            needed: lvl.needed,
            rankPos,
            totalUsers: rows.length || 1,
            textXp,
            voiceXp
        });
        const resvg = new Resvg(svg, {
            fitTo: { mode: 'width', value: 980 }
        });
        const pngBuffer = resvg.render().asPng();
        const file = new AttachmentBuilder(pngBuffer, { name: 'rank-card.png' });
        return message.reply({ files: [file] });
    }
    if (cmd === topCmd) {
        const rows = Object.entries(store.levels || {}).sort((a, b) => (b[1].xp || 0) - (a[1].xp || 0)).slice(0, 10);
        if (rows.length === 0) return replyEmbed(message, 'info', 'لوحة المتصدرين', 'لا يوجد بيانات لفلز بعد.');
        const medals = ['🥇', '🥈', '🥉'];
        const text = rows.map(([uid, info], i) => `${medals[i] || '🏅'} **${i + 1}.** <@${uid}> — **${info.xp || 0} XP** (T:${info.textXp || 0} | V:${info.voiceXp || 0})`).join('\n');
        const embed = new EmbedBuilder()
            .setColor(0xfbbf24)
            .setTitle('🏆 لوحة المتصدرين')
            .setDescription(text)
            .setFooter({ text: `المجموعة: ${message.guild.name}` });
        return message.reply({ embeds: [embed] });
    }
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.inGuild()) return;
    if (interaction.isButton()) {
        const id = String(interaction.customId || '');
        if (!id.startsWith('ai:')) return;
        const parts = id.split(':');
        if (parts[1] === 'confirm') {
            const token = parts[2];
            const decision = parts[3];
            const pending = pendingAiConfirmations.get(token);
            if (!pending) return interaction.reply({ content: 'انتهت صلاحية التأكيد أو غير موجود.', ephemeral: true });
            if (String(interaction.user.id) !== String(pending.requesterId)) {
                return interaction.reply({ content: 'فقط صاحب الطلب يقدر يأكد التنفيذ.', ephemeral: true });
            }
            pendingAiConfirmations.delete(token);
            if (decision === 'no') {
                return interaction.reply({ content: 'تم إلغاء التنفيذ.', ephemeral: true });
            }
            await interaction.deferReply({ ephemeral: true });
            const guildConfig = getGuildConfig(interaction.guild.id);
            const fakeMessage = {
                guild: interaction.guild,
                channel: interaction.channel,
                author: interaction.user,
                mentions: { members: { first: () => null }, roles: { first: () => null } },
                reply: async (txt) => interaction.followUp(typeof txt === 'string' ? { content: txt } : txt)
            };
            let done = 0;
            for (const action of pending.actions || []) {
                const ok = await executeAiAction(fakeMessage, guildConfig, action);
                if (ok) done += 1;
            }
            return interaction.editReply({ content: `✅ تم تنفيذ ${done} إجراء.` });
        }
        if (parts[1] === 'role' && (parts[2] === 'add' || parts[2] === 'remove')) {
            const roleId = parts[3];
            const role = interaction.guild.roles.cache.get(roleId) || await interaction.guild.roles.fetch(roleId).catch(() => null);
            if (!role) return interaction.reply({ content: 'الرُتبة غير موجودة.', ephemeral: true });
            if (parts[2] === 'add') await interaction.member.roles.add(role).catch(() => {});
            else await interaction.member.roles.remove(role).catch(() => {});
            return interaction.reply({ content: parts[2] === 'add' ? `تم إعطاؤك رتبة ${role.name}` : `تم سحب رتبة ${role.name}`, ephemeral: true });
        }
        return interaction.reply({ content: 'تم استلام الزر.', ephemeral: true });
    }
    if (interaction.isStringSelectMenu()) {
        const id = String(interaction.customId || '');
        if (!id.startsWith('ai:select-role:')) return;
        const mode = id.endsWith(':remove') ? 'remove' : 'add';
        const roleId = interaction.values?.[0];
        const role = interaction.guild.roles.cache.get(roleId) || await interaction.guild.roles.fetch(roleId).catch(() => null);
        if (!role) return interaction.reply({ content: 'الرُتبة غير موجودة.', ephemeral: true });
        if (mode === 'add') await interaction.member.roles.add(role).catch(() => {});
        else await interaction.member.roles.remove(role).catch(() => {});
        return interaction.reply({ content: mode === 'add' ? `تم إعطاؤك رتبة ${role.name}` : `تم سحب رتبة ${role.name}`, ephemeral: true });
    }
});

client.login(process.env.TOKEN).catch((err) => console.error('Error logging in:', err));
