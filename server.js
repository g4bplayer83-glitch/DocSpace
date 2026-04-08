const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const crypto = require('crypto');
const PACKAGE_INFO = require('./package.json');
const SERVER_NAME = 'DocSpace Server';
const SERVER_VERSION = PACKAGE_INFO.version || '3.2.8-alpha';

// === FIREBASE REALTIME DATABASE ===
let firebaseDb = null;
let useFirebase = false;

function initFirebase() {
    try {
        const credentialsJson = process.env.FIREBASE_CREDENTIALS;
        if (!credentialsJson) {
            console.log('ℹ️ FIREBASE_CREDENTIALS non défini — mode fichiers locaux');
            return;
        }
        const admin = require('firebase-admin');
        const serviceAccount = JSON.parse(credentialsJson);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: `https://${serviceAccount.project_id}-default-rtdb.firebaseio.com`
        });
        firebaseDb = admin.database();
        useFirebase = true;
        console.log('✅ Firebase Realtime Database connecté');
    } catch (error) {
        console.error('❌ Erreur Firebase init:', error.message);
        console.log('⚠️ Fallback vers fichiers locaux');
        useFirebase = false;
    }
}
initFirebase();

// Firebase helpers — lecture/écriture avec fallback fichiers locaux
async function fbLoad(key) {
    if (!useFirebase || !firebaseDb) return null;
    try {
        const snapshot = await firebaseDb.ref(key).once('value');
        return snapshot.val();
    } catch (e) {
        console.error(`❌ Firebase load [${key}]:`, e.message);
        return null;
    }
}

function fbSave(key, data) {
    if (!useFirebase || !firebaseDb) return;
    firebaseDb.ref(key).set(data).catch(e => {
        console.error(`❌ Firebase save [${key}]:`, e.message);
    });
}

// Debounced Firebase save — prevents flooding the DB
const _fbSaveTimers = {};
function fbSaveDebounced(key, dataFn, delayMs = 2000) {
    if (!useFirebase || !firebaseDb) return;
    if (_fbSaveTimers[key]) clearTimeout(_fbSaveTimers[key]);
    _fbSaveTimers[key] = setTimeout(() => {
        _fbSaveTimers[key] = null;
        fbSave(key, dataFn());
    }, delayMs);
}

function fbSaveImmediate(key, data) {
    if (_fbSaveTimers[key]) {
        clearTimeout(_fbSaveTimers[key]);
        _fbSaveTimers[key] = null;
    }
    fbSave(key, data);
}

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    pingTimeout: 60000,
    pingInterval: 25000
});
global.io = io;

// Configuration multer pour les fichiers
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
        cb(null, uniqueSuffix + '-' + sanitizedName);
    }
});

const fileFilter = (req, file, cb) => {
    // Autoriser tous les types de fichiers
    cb(null, true);
};

const upload = multer({ 
    storage: storage,
    limits: {
        fileSize: 100 * 1024 * 1024, // 100MB max
        files: 1
    },
    fileFilter: fileFilter
});

const avatarUpload = multer({
    storage: storage,
    limits: {
        fileSize: 10 * 1024 * 1024, // 10MB max pour les avatars
        files: 1
    },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Seules les images sont autorisées pour les avatars'), false);
        }
    }
});

// Middleware
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

app.use((req, res, next) => {
    const start = Date.now();
    observability.http.requestsTotal += 1;
    observability.http.byPath[req.path] = (observability.http.byPath[req.path] || 0) + 1;

    res.on('finish', () => {
        const statusKey = String(res.statusCode || 0);
        observability.http.byStatus[statusKey] = (observability.http.byStatus[statusKey] || 0) + 1;

        const latency = Date.now() - start;
        observability.http.samples.push(latency);
        if (observability.http.samples.length > 200) observability.http.samples.shift();

        const samples = observability.http.samples;
        if (samples.length > 0) {
            const avg = samples.reduce((sum, value) => sum + value, 0) / samples.length;
            observability.http.latencyMsAvg = Math.round(avg);

            const sorted = [...samples].sort((a, b) => a - b);
            const p95Index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
            observability.http.latencyMsP95 = sorted[p95Index];
        }
    });

    next();
});

// Servir les fichiers statiques
app.use(express.static(__dirname));
app.use('/uploads', express.static(uploadDir));

// Variables pour stocker les données
let connectedUsers = new Map(); // socketId -> userData
let authenticatedSockets = new Set(); // socketIds that completed account auth
let chatHistory = []; // Historique des messages (général - rétrocompatibilité)
const MAX_HISTORY = 500; // Limite de l'historique (augmentée pour persistance)
let typingUsers = new Map(); // socketId -> {username, timestamp}
let userProfiles = new Map(); // username -> profile data
let messageId = 1; // Compteur pour les IDs de messages
let serverStats = {
    totalMessages: 0,
    totalUploads: 0,
    totalConnections: 0,
    startTime: new Date()
};
const SERVER_SESSION_START_MS = Date.now();
let shutdownInProgress = false;
let runtimeSessionCommitted = false;
let serverRuntimeStats = {
    version: 1,
    accumulatedUptimeSeconds: 0,
    boots: 0,
    lastBootAt: null,
    lastShutdownAt: null,
    updatedAt: null
};

// === 3.2.8-alpha: voix SFU / sync multi-device / observabilite ===
const VOICE_RUNTIME_MODE = String(process.env.DOCSPACE_VOICE_MODE || 'p2p').toLowerCase(); // p2p | sfu
const VOICE_SFU_PROVIDER = String(process.env.DOCSPACE_SFU_PROVIDER || 'mediasoup').toLowerCase();
const VOICE_SFU_SIGNALING_URL = process.env.DOCSPACE_SFU_SIGNALING_URL || '';
const VOICE_SFU_PUBLIC_WS = process.env.DOCSPACE_SFU_PUBLIC_WS || '';

let userSocketIndex = new Map(); // username(lower) -> Set(socketId)
let multiDeviceSyncState = new Map(); // username(lower) -> { updatedAt, byDevice: { deviceId: state } }
let e2eeKeyDirectory = new Map(); // username(lower) -> Map(deviceId -> key metadata)

const observability = {
    startedAt: Date.now(),
    sockets: {
        totalConnections: 0,
        currentTransportConnections: 0,
        currentAuthenticatedUsers: 0,
        disconnections: 0
    },
    http: {
        requestsTotal: 0,
        byStatus: {},
        byPath: {},
        latencyMsAvg: 0,
        latencyMsP95: 0,
        samples: []
    },
    socketEvents: {},
    voice: {
        offers: 0,
        answers: 0,
        iceCandidates: 0,
        reconnectIntents: 0,
        sfuSignals: 0
    },
    runtime: {
        eventLoopLagMs: 0,
        eventLoopLagMsMax: 0
    }
};
let observabilityLastLoopTick = Date.now();

const LIVE_EVENT_DEFAULT_ROTATION_HOURS = 1;
const LIVE_EVENT_DEFAULT_DURATION_MINUTES = 30;
const LIVE_EVENT_MAX_DURATION_MINUTES = 180;
const LIVE_EVENTS_CATALOG = [
    {
        id: 'double_xp_rush',
        icon: '⚡',
        title: 'Double XP Rush',
        description: 'XP des messages x2 pendant une courte periode.',
        messageXpMultiplier: 2
    },
    {
        id: 'night_owl',
        icon: '🌙',
        title: 'Night Owl',
        description: 'Bonus nocturne: XP des messages x1.5.',
        messageXpMultiplier: 1.5
    },
    {
        id: 'creator_spotlight',
        icon: '🎨',
        title: 'Creator Spotlight',
        description: 'Session creative en direct, XP des messages x1.4.',
        messageXpMultiplier: 1.4
    },
    {
        id: 'arcade_frenzy',
        icon: '🕹️',
        title: 'Arcade Frenzy',
        description: 'Ambiance mini-jeux, XP des messages x1.3.',
        messageXpMultiplier: 1.3
    }
];

let liveOpsState = {
    version: 1,
    season: {
        number: 1,
        label: 'Saison 1 - Genesis',
        year: new Date().getFullYear(),
        startedAt: null,
        xpMultiplier: 1
    },
    activeEvent: null,
    autoModeEnabled: true,
    autoRotationHours: LIVE_EVENT_DEFAULT_ROTATION_HOURS,
    bannerDisplayMode: 'dismissible',
    eventRotationMinutes: LIVE_EVENT_DEFAULT_ROTATION_HOURS * 60,
    nextRotationAt: 0,
    updatedAt: null
};

// === SALONS MULTIPLES (BETA) ===
const DEFAULT_CHANNELS = [
    { name: 'général', icon: '#', category: '💬 Discussion' },
    { name: 'présentation', icon: '#', category: '💬 Discussion' },
    { name: 'jeux', icon: '🎮', category: '🎮 Loisirs' },
    { name: 'musique', icon: '🎵', category: '🎮 Loisirs' },
    { name: 'films', icon: '🎬', category: '🎮 Loisirs' },
    { name: 'random', icon: '🎲', category: '💡 Autres' },
    { name: 'aide', icon: '❓', category: '💡 Autres' },
    { name: 'ia', icon: '🤖', category: '🤖 Intelligence Artificielle' }
];
const DEFAULT_VOICE_CHANNELS = [
    { name: 'Vocal Général', icon: '🔊' },
    { name: 'Vocal Gaming', icon: '🎮' },
    { name: 'Vocal Musique', icon: '🎵' }
];

// Channel histories & reactions - initialized after AVAILABLE_CHANNELS (see below)
let channelHistories = {}; // { channelName: [messages] }
let channelReactions = {}; // { channelName: { messageId: {emoji: [usernames]} } }

// Stockage des réactions emoji sur les messages (messageId -> {emoji: [usernames]})
let messageReactions = {};

// Stockage des statuts personnalisés (username -> {status, customText})
let userStatuses = {};

// Liste des admins connectés
let adminUsersList = [];

// === NOUVELLES VARIABLES ADMIN ===
// Configuration du serveur
let serverConfig = {
    isPrivate: false,
    accessCode: '',
    slowMode: 0, // secondes entre les messages (0 = désactivé)
    globalMute: false
};

// === BOOKMARKS (Messages sauvegardés) ===
let userBookmarks = {}; // username -> [{ messageId, content, author, channel, timestamp, savedAt }]

// === FRIEND SYSTEM ===
let friendships = {}; // username -> { friends: [username], pending: [username], requests: [username] }

// === LEVELING / XP SYSTEM ===
let userXP = {}; // username -> { xp, level, totalMessages, lastXpGain }
let miniGameStats = {}; // username -> { points, played, wins, losses, draws, byGame }
const XP_PER_MESSAGE = 18;
const XP_PER_REACTION = 8;
const XP_LEVEL_BASE = 100; // XP for level 1, doubles each level
const DAILY_LOGIN_XP_BONUS = 60;
const DAILY_LOGIN_STREAK_STEP = 15;
const DAILY_LOGIN_STREAK_MAX_BONUS = 90;
const XP_MESSAGE_COOLDOWN_MS = 25000;
const XP_MESSAGE_COOLDOWN_REDUCED_MS = 18000;
const XP_UTILITY_DURATION_MS = 15 * 60 * 1000;
const VOICE_PASSIVE_XP_PER_MINUTE = 5;
const BANANA_XP_RATIO = 11;
const VOICE_SPEAKING_EVENT_THROTTLE_MS = 120;
const UTILITY_PURCHASES_LIMIT_PER_HOUR = 8;
const CLICKER_XP_PER_CLICK = 2;
const CLICKER_TAP_COOLDOWN_MS = 180;
const CLICKER_LUCKY_BANANA_CHANCE = 0.03;
const CLICKER_JACKPOT_CHANCE = 0.004;
const CLICKER_JACKPOT_XP = 50;
const CLICKER_JACKPOT_BANANAS = 5;
const CLICKER_MEGA_JACKPOT_CHANCE = 0.0005;
const CLICKER_MEGA_JACKPOT_XP = 200;
const CLICKER_MEGA_JACKPOT_BANANAS = 20;
const CLICKER_AUTOCLICKER_COST = 1000;
const CLICKER_AUTOCLICKER_INTERVAL_MS = 1000; // 1 click per second
const CLICKER_AUTOCLICKER_XP_PER_TICK = 1; // reduced XP for auto clicks
const NAME_EFFECT_ITEMS = {
    name_glow: { cost: 24, label: 'Halo lumineux' },
    name_gradient: { cost: 29, label: 'Dégradé arc-en-ciel' },
    name_neon: { cost: 34, label: 'Néon vibrant' }
};
const DAILY_MISSIONS = {
    messages: { target: 10, rewardXP: 80, rewardBananas: 3, label: 'Messages du jour' },
    reactions: { target: 5, rewardXP: 60, rewardBananas: 2, label: 'Reactions du jour' },
    voiceMinutes: { target: 10, rewardXP: 100, rewardBananas: 4, label: 'Minutes en vocal' },
    miniGameRounds: { target: 3, rewardXP: 90, rewardBananas: 3, label: 'Mini-jeux du jour' },
    clickerClicks: { target: 100, rewardXP: 120, rewardBananas: 5, label: 'Cookie Clicker' }
};

const SEASONAL_QUEST_ROTATION_DAYS = 7;
const SEASONAL_QUEST_POOL = [
    { id: 'season_messages', metric: 'messages', title: 'Sprint messagerie', label: 'Messages saison', baseTarget: 16, targetGrowthPerSeason: 2, rewardXP: 140, rewardBananas: 6 },
    { id: 'season_reactions', metric: 'reactions', title: 'Amplificateur social', label: 'Reactions saison', baseTarget: 12, targetGrowthPerSeason: 1, rewardXP: 110, rewardBananas: 5 },
    { id: 'season_voice', metric: 'voiceMinutes', title: 'Pulse vocal', label: 'Minutes vocal saison', baseTarget: 20, targetGrowthPerSeason: 2, rewardXP: 170, rewardBananas: 7 },
    { id: 'season_arcade', metric: 'miniGameRounds', title: 'Arcade saisonniere', label: 'Parties mini-jeux saison', baseTarget: 5, targetGrowthPerSeason: 1, rewardXP: 150, rewardBananas: 6 },
    { id: 'season_clicker', metric: 'clickerClicks', title: 'Cookie Marathon', label: 'Clicks saison', baseTarget: 180, targetGrowthPerSeason: 15, rewardXP: 190, rewardBananas: 8 }
];

const XP_ROLES = [
    { minLevel: 50, key: 'eternal', label: 'Éternel', icon: '👑' },
    { minLevel: 40, key: 'diamond', label: 'Diamant', icon: '💎' },
    { minLevel: 30, key: 'platinum', label: 'Platine', icon: '🏛️' },
    { minLevel: 20, key: 'gold', label: 'Or', icon: '🥇' },
    { minLevel: 10, key: 'silver', label: 'Argent', icon: '🥈' },
    { minLevel: 5, key: 'bronze', label: 'Bronze', icon: '🥉' },
    { minLevel: 0, key: 'rookie', label: 'Recrue', icon: '🛡️' }
];

function buildDailyMissionProgressDefaults() {
    const defaults = {};
    Object.keys(DAILY_MISSIONS).forEach((key) => {
        defaults[key] = 0;
    });
    return defaults;
}

function buildDailyMissionCompletedDefaults() {
    const defaults = {};
    Object.keys(DAILY_MISSIONS).forEach((key) => {
        defaults[key] = false;
    });
    return defaults;
}

function getRoleForLevel(level) {
    const safeLevel = Math.max(0, Number(level || 0));
    return XP_ROLES.find((role) => safeLevel >= role.minLevel) || XP_ROLES[XP_ROLES.length - 1];
}
function getXPForLevel(level) { return Math.floor(XP_LEVEL_BASE * Math.pow(1.5, level - 1)); }
function getLevelFromXP(xp) {
    let level = 0;
    let totalNeeded = 0;
    while (totalNeeded + getXPForLevel(level + 1) <= xp) {
        level++;
        totalNeeded += getXPForLevel(level);
    }
    return { level, currentXP: xp - totalNeeded, neededXP: getXPForLevel(level + 1) };
}

function getBananaPoints(username) {
    const data = userXP[username];
    if (!data) return 0;
    return Math.max(0, Math.floor(Number(data.bonusBananas || 0)));
}

function spendBananas(username, cost) {
    const entry = ensureXPEntry(username);
    let remaining = Math.max(0, Math.floor(cost || 0));
    if (remaining <= 0) return true;

    const available = Math.max(0, Number(entry.bonusBananas || 0));
    if (available < remaining) return false;
    entry.bonusBananas = available - remaining;

    return true;
}

function convertXPToBananas(username, bananaAmount) {
    const entry = ensureXPEntry(username);
    const requested = Math.max(0, Math.floor(Number(bananaAmount || 0)));
    if (requested <= 0) {
        return { success: false, message: 'Montant invalide' };
    }

    const xpCost = requested * BANANA_XP_RATIO;
    const currentXP = Math.max(0, Number(entry.xp || 0));
    if (currentXP < xpCost) {
        return {
            success: false,
            message: `XP insuffisante (${currentXP}/${xpCost})`
        };
    }

    entry.xp = currentXP - xpCost;
    entry.level = getLevelFromXP(entry.xp).level;
    entry.bonusBananas = Math.max(0, Number(entry.bonusBananas || 0)) + requested;

    return {
        success: true,
        bananasAdded: requested,
        xpSpent: xpCost,
        bananaPoints: getBananaPoints(username)
    };
}

function sanitizeNameEffect(effect) {
    const safe = String(effect || 'none').toLowerCase();
    if (['name_glow', 'name_gradient', 'name_neon'].includes(safe)) return safe;
    return 'none';
}

function getActiveNameEffect(username) {
    const entry = ensureXPEntry(username);
    const active = sanitizeNameEffect(entry.activeNameEffect || 'none');
    if (active === 'none') return 'none';
    const owned = entry.ownedNameEffects || {};
    return owned[active] ? active : 'none';
}

function mergeXPEntries(baseEntry, incomingEntry) {
    const base = baseEntry || {};
    const incoming = incomingEntry || {};

    base.xp = Math.max(0, Number(base.xp || 0)) + Math.max(0, Number(incoming.xp || 0));
    base.totalMessages = Math.max(0, Number(base.totalMessages || 0)) + Math.max(0, Number(incoming.totalMessages || 0));
    base.bonusBananas = Math.max(0, Number(base.bonusBananas || 0)) + Math.max(0, Number(incoming.bonusBananas || 0));
    base.streakDays = Math.max(Number(base.streakDays || 0), Number(incoming.streakDays || 0));
    base.lastXpGain = Math.max(Number(base.lastXpGain || 0), Number(incoming.lastXpGain || 0));
    base.lastReactionXpAt = Math.max(Number(base.lastReactionXpAt || 0), Number(incoming.lastReactionXpAt || 0));
    base.streakShieldCharges = Math.min(3, Math.max(Number(base.streakShieldCharges || 0), Number(incoming.streakShieldCharges || 0)));
    base.xpBoostUntil = Math.max(Number(base.xpBoostUntil || 0), Number(incoming.xpBoostUntil || 0));
    base.reactionBoostUntil = Math.max(Number(base.reactionBoostUntil || 0), Number(incoming.reactionBoostUntil || 0));
    base.cooldownReducerUntil = Math.max(Number(base.cooldownReducerUntil || 0), Number(incoming.cooldownReducerUntil || 0));
    base.shopWindowStart = Math.max(Number(base.shopWindowStart || 0), Number(incoming.shopWindowStart || 0));
    base.shopWindowCount = Math.max(Number(base.shopWindowCount || 0), Number(incoming.shopWindowCount || 0));

    const owned = { ...(base.ownedNameEffects || {}) };
    const incomingOwned = incoming.ownedNameEffects || {};
    Object.keys(NAME_EFFECT_ITEMS).forEach((k) => {
        owned[k] = !!owned[k] || !!incomingOwned[k];
    });
    base.ownedNameEffects = owned;

    const wanted = sanitizeNameEffect(base.activeNameEffect || incoming.activeNameEffect || 'none');
    base.activeNameEffect = (wanted !== 'none' && owned[wanted]) ? wanted : 'none';

    base.dailyMissionDay = base.dailyMissionDay || incoming.dailyMissionDay || null;
    const progress = {
        ...buildDailyMissionProgressDefaults(),
        ...(base.dailyMissionProgress || {}),
        ...(incoming.dailyMissionProgress || {})
    };
    const completed = {
        ...buildDailyMissionCompletedDefaults(),
        ...(base.dailyMissionCompleted || {}),
        ...(incoming.dailyMissionCompleted || {})
    };
    Object.keys(DAILY_MISSIONS).forEach((key) => {
        progress[key] = Math.max(0, Number(progress[key] || 0));
        completed[key] = !!completed[key];
    });
    base.dailyMissionProgress = progress;
    base.dailyMissionCompleted = completed;

    base.clicker = {
        totalClicks: Math.max(0, Number(base?.clicker?.totalClicks || 0)) + Math.max(0, Number(incoming?.clicker?.totalClicks || 0)),
        sessionClicks: Math.max(0, Number(base?.clicker?.sessionClicks || 0)) + Math.max(0, Number(incoming?.clicker?.sessionClicks || 0)),
        luckyDrops: Math.max(0, Number(base?.clicker?.luckyDrops || 0)) + Math.max(0, Number(incoming?.clicker?.luckyDrops || 0)),
        lastTapAt: Math.max(0, Number(base?.clicker?.lastTapAt || 0), Number(incoming?.clicker?.lastTapAt || 0))
    };

    base.level = getLevelFromXP(base.xp).level;
    return base;
}

function mergeMiniGameStatsEntries(baseEntry, incomingEntry) {
    const base = baseEntry || { points: 0, played: 0, wins: 0, losses: 0, draws: 0, byGame: {} };
    const incoming = incomingEntry || { byGame: {} };

    base.points = Math.max(0, Number(base.points || 0)) + Math.max(0, Number(incoming.points || 0));
    base.played = Math.max(0, Number(base.played || 0)) + Math.max(0, Number(incoming.played || 0));
    base.wins = Math.max(0, Number(base.wins || 0)) + Math.max(0, Number(incoming.wins || 0));
    base.losses = Math.max(0, Number(base.losses || 0)) + Math.max(0, Number(incoming.losses || 0));
    base.draws = Math.max(0, Number(base.draws || 0)) + Math.max(0, Number(incoming.draws || 0));

    base.byGame = base.byGame || {};
    const incomingByGame = incoming.byGame || {};
    Object.entries(incomingByGame).forEach(([gameKey, row]) => {
        const cur = base.byGame[gameKey] || { points: 0, played: 0, wins: 0, losses: 0, draws: 0 };
        cur.points = Math.max(0, Number(cur.points || 0)) + Math.max(0, Number(row.points || 0));
        cur.played = Math.max(0, Number(cur.played || 0)) + Math.max(0, Number(row.played || 0));
        cur.wins = Math.max(0, Number(cur.wins || 0)) + Math.max(0, Number(row.wins || 0));
        cur.losses = Math.max(0, Number(cur.losses || 0)) + Math.max(0, Number(row.losses || 0));
        cur.draws = Math.max(0, Number(cur.draws || 0)) + Math.max(0, Number(row.draws || 0));
        base.byGame[gameKey] = cur;
    });
    base.lastPlayedAt = incoming.lastPlayedAt || base.lastPlayedAt || null;
    return base;
}

function ensureXPEntry(username) {
    if (!userXP[username]) {
        userXP[username] = {
            xp: 0,
            level: 0,
            totalMessages: 0,
            lastXpGain: 0,
            streakDays: 0,
            lastLoginDay: null,
            xpBoostUntil: 0,
            reactionBoostUntil: 0,
            cooldownReducerUntil: 0,
            bonusBananas: 0,
            ownedNameEffects: {},
            activeNameEffect: 'none',
            streakShieldCharges: 0,
            lastReactionXpAt: 0,
            shopWindowStart: 0,
            shopWindowCount: 0,
            dailyMissionDay: null,
            dailyMissionProgress: buildDailyMissionProgressDefaults(),
            dailyMissionCompleted: buildDailyMissionCompletedDefaults(),
            clicker: {
                totalClicks: 0,
                sessionClicks: 0,
                luckyDrops: 0,
                lastTapAt: 0
            }
        };
    }

    if (typeof userXP[username].streakDays !== 'number') userXP[username].streakDays = 0;
    if (typeof userXP[username].lastLoginDay !== 'string') userXP[username].lastLoginDay = null;
    if (typeof userXP[username].xpBoostUntil !== 'number') userXP[username].xpBoostUntil = 0;
    if (typeof userXP[username].reactionBoostUntil !== 'number') userXP[username].reactionBoostUntil = 0;
    if (typeof userXP[username].cooldownReducerUntil !== 'number') userXP[username].cooldownReducerUntil = 0;
    if (typeof userXP[username].bonusBananas !== 'number') userXP[username].bonusBananas = 0;
    if (!userXP[username].ownedNameEffects || typeof userXP[username].ownedNameEffects !== 'object') userXP[username].ownedNameEffects = {};
    userXP[username].activeNameEffect = sanitizeNameEffect(userXP[username].activeNameEffect || 'none');
    if (userXP[username].activeNameEffect !== 'none' && !userXP[username].ownedNameEffects[userXP[username].activeNameEffect]) {
        userXP[username].activeNameEffect = 'none';
    }
    if (typeof userXP[username].streakShieldCharges !== 'number') userXP[username].streakShieldCharges = 0;
    if (typeof userXP[username].lastReactionXpAt !== 'number') userXP[username].lastReactionXpAt = 0;
    if (typeof userXP[username].shopWindowStart !== 'number') userXP[username].shopWindowStart = 0;
    if (typeof userXP[username].shopWindowCount !== 'number') userXP[username].shopWindowCount = 0;
    if (typeof userXP[username].dailyMissionDay !== 'string') userXP[username].dailyMissionDay = null;
    if (!userXP[username].dailyMissionProgress || typeof userXP[username].dailyMissionProgress !== 'object') {
        userXP[username].dailyMissionProgress = buildDailyMissionProgressDefaults();
    }
    if (!userXP[username].dailyMissionCompleted || typeof userXP[username].dailyMissionCompleted !== 'object') {
        userXP[username].dailyMissionCompleted = buildDailyMissionCompletedDefaults();
    }
    Object.keys(DAILY_MISSIONS).forEach((key) => {
        userXP[username].dailyMissionProgress[key] = Math.max(0, Number(userXP[username].dailyMissionProgress[key] || 0));
        userXP[username].dailyMissionCompleted[key] = !!userXP[username].dailyMissionCompleted[key];
    });
    if (!userXP[username].clicker || typeof userXP[username].clicker !== 'object') {
        userXP[username].clicker = { totalClicks: 0, sessionClicks: 0, luckyDrops: 0, lastTapAt: 0 };
    }
    userXP[username].clicker.totalClicks = Math.max(0, Number(userXP[username].clicker.totalClicks || 0));
    userXP[username].clicker.sessionClicks = Math.max(0, Number(userXP[username].clicker.sessionClicks || 0));
    userXP[username].clicker.luckyDrops = Math.max(0, Number(userXP[username].clicker.luckyDrops || 0));
    userXP[username].clicker.lastTapAt = Math.max(0, Number(userXP[username].clicker.lastTapAt || 0));
    return userXP[username];
}

function getDayKey(ts = Date.now()) {
    const d = new Date(ts);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function getPreviousDayKey(ts = Date.now()) {
    return getDayKey(ts - 24 * 60 * 60 * 1000);
}

function buildXPDataPayload(username) {
    const data = ensureXPEntry(username);
    ensureDailyMissionsForEntry(data);
    const levelData = getLevelFromXP(data.xp || 0);
    const role = getRoleForLevel(levelData.level);
    const boostUntil = data.xpBoostUntil || 0;
    const reactionBoostUntil = data.reactionBoostUntil || 0;
    const cooldownReducerUntil = data.cooldownReducerUntil || 0;
    const missionTargets = {};
    const missionRewards = {};
    const missionProgress = {};
    const missionCompleted = {};

    Object.entries(DAILY_MISSIONS).forEach(([key, mission]) => {
        missionTargets[key] = mission.target;
        missionRewards[key] = {
            xp: mission.rewardXP,
            bananas: mission.rewardBananas
        };
        missionProgress[key] = Number(data.dailyMissionProgress?.[key] || 0);
        missionCompleted[key] = !!data.dailyMissionCompleted?.[key];
    });

    return {
        xp: data.xp || 0,
        ...levelData,
        role,
        totalMessages: data.totalMessages || 0,
        bananaPoints: getBananaPoints(username),
        bananaBreakdown: {
            fromWallet: Math.max(0, Number(data.bonusBananas || 0)),
            convertibleFromXP: Math.floor((data.xp || 0) / BANANA_XP_RATIO),
            fromTasks: Math.max(0, Number(data.bonusBananas || 0)),
            ratioXP: BANANA_XP_RATIO
        },
        streakDays: data.streakDays || 0,
        xpBoostUntil: boostUntil,
        xpBoostActive: boostUntil > Date.now(),
        reactionBoostUntil,
        reactionBoostActive: reactionBoostUntil > Date.now(),
        cooldownReducerUntil,
        cooldownReducerActive: cooldownReducerUntil > Date.now(),
        streakShieldCharges: data.streakShieldCharges || 0,
        activeNameEffect: getActiveNameEffect(username),
        ownedNameEffects: {
            name_glow: !!data.ownedNameEffects?.name_glow,
            name_gradient: !!data.ownedNameEffects?.name_gradient,
            name_neon: !!data.ownedNameEffects?.name_neon
        },
        clicker: {
            totalClicks: Number(data.clicker?.totalClicks || 0),
            sessionClicks: Number(data.clicker?.sessionClicks || 0),
            luckyDrops: Number(data.clicker?.luckyDrops || 0),
            cooldownMs: CLICKER_TAP_COOLDOWN_MS
        },
        dailyMissions: {
            dayKey: data.dailyMissionDay || getDayKey(),
            targets: missionTargets,
            rewards: missionRewards,
            progress: missionProgress,
            completed: missionCompleted
        },
        seasonalQuests: buildSeasonalQuestsPayload(username),
        customThemeUnlocked: !!data.customThemeUnlocked,
        customTheme: data.customTheme || null,
        autoClickerUnlocked: !!data.autoClickerUnlocked,
        serverEnv: SERVER_ENV
    };
}

function getMessageCooldownMs(entry) {
    return entry.cooldownReducerUntil && entry.cooldownReducerUntil > Date.now()
        ? XP_MESSAGE_COOLDOWN_REDUCED_MS
        : XP_MESSAGE_COOLDOWN_MS;
}

function ensureDailyMissionsForEntry(entry) {
    const todayKey = getDayKey();
    if (entry.dailyMissionDay !== todayKey) {
        entry.dailyMissionDay = todayKey;
        entry.dailyMissionProgress = buildDailyMissionProgressDefaults();
        entry.dailyMissionCompleted = buildDailyMissionCompletedDefaults();
    } else {
        Object.keys(DAILY_MISSIONS).forEach((key) => {
            entry.dailyMissionProgress[key] = Math.max(0, Number(entry.dailyMissionProgress[key] || 0));
            entry.dailyMissionCompleted[key] = !!entry.dailyMissionCompleted[key];
        });
    }
}

function addRawXP(username, amount) {
    const entry = ensureXPEntry(username);
    const safeAmount = Math.max(0, Math.floor(amount || 0));
    if (safeAmount <= 0) return { gainedXP: 0, levelUp: false, newLevel: getLevelFromXP(entry.xp).level };
    const oldLevel = getLevelFromXP(entry.xp).level;
    entry.xp += safeAmount;
    const newLevelData = getLevelFromXP(entry.xp);
    entry.level = newLevelData.level;
    return {
        gainedXP: safeAmount,
        levelUp: newLevelData.level > oldLevel,
        newLevel: newLevelData.level
    };
}

function applyMissionProgress(username, deltas = {}) {
    const entry = ensureXPEntry(username);
    ensureDailyMissionsForEntry(entry);

    Object.keys(deltas || {}).forEach((key) => {
        if (!Object.prototype.hasOwnProperty.call(DAILY_MISSIONS, key)) return;
        entry.dailyMissionProgress[key] = Math.max(0, Number(entry.dailyMissionProgress[key] || 0) + Number(deltas[key] || 0));
    });

    const rewards = [];
    const keys = Object.keys(DAILY_MISSIONS);
    for (const key of keys) {
        if (entry.dailyMissionCompleted[key]) continue;
        if ((entry.dailyMissionProgress[key] || 0) >= DAILY_MISSIONS[key].target) {
            entry.dailyMissionCompleted[key] = true;
            const rewardXP = DAILY_MISSIONS[key].rewardXP;
            const rewardBananas = Math.max(0, Number(DAILY_MISSIONS[key].rewardBananas || 0));
            const xpResult = addRawXP(username, rewardXP);
            if (rewardBananas > 0) {
                entry.bonusBananas = Math.max(0, Number(entry.bonusBananas || 0)) + rewardBananas;
            }
            rewards.push({
                key,
                label: DAILY_MISSIONS[key].label,
                rewardXP,
                rewardBananas,
                levelUp: xpResult.levelUp,
                newLevel: xpResult.newLevel
            });
        }
    }

    return rewards;
}

function emitMissionRewardsToSocket(targetSocket, username, rewards = [], options = {}) {
    if (!targetSocket || !Array.isArray(rewards) || rewards.length === 0) return;

    rewards.forEach((reward) => {
        targetSocket.emit('daily_mission_reward', {
            missionKey: reward.key,
            missionLabel: reward.label,
            rewardXP: reward.rewardXP,
            rewardBananas: reward.rewardBananas || 0
        });

        if (reward.levelUp) {
            io.emit('system_message', {
                type: 'system',
                message: `🎉 ${username} a atteint le niveau ${reward.newLevel} !`,
                timestamp: new Date(),
                id: messageId++
            });
        }
    });

    if (options.emitXpData) {
        targetSocket.emit('xp_data', buildXPDataPayload(username));
    }
}

// === REMINDERS ===
let reminders = []; // [{ id, username, message, triggerAt, channel, createdAt }]
let reminderIdCounter = 1;

// === AUTO-MODERATION ===
let autoModConfig = {
    enabled: false,
    spamThreshold: 5, // max messages in spamInterval seconds
    spamInterval: 10, // seconds
    linkFilter: false,
    capsFilter: false, // block messages >80% caps
    wordFilter: [], // banned words
    warnThreshold: 3, // warnings before auto-mute
};
let userWarnings = {}; // username -> { count, lastWarning }
let spamTracker = {}; // username -> [timestamps]

// Liste des utilisateurs bannis: { identifier: { username, bannedAt, expiresAt, permanent, ip } }
let bannedUsers = new Map();

// Derniers messages par utilisateur (pour slow mode)
let lastMessageTime = new Map(); // socketId -> timestamp

// === SONDAGES ===
let polls = {}; // pollId -> { id, question, options: [{text, votes}], channel, creator, createdAt }
let pollVotes = {}; // pollId -> { username: optionIndex }
let pollIdCounter = 1;

// === MESSAGES PRIVÉS (DM) ===
let dmHistory = {}; // "user1:user2" (trié) -> [messages]

// === COMPTES UTILISATEURS ===
let accounts = {}; // username_lower -> { username, passwordHash, salt, createdAt, lastLogin }

// === FICHIERS DE SAUVEGARDE POUR PERSISTANCE ===
// Sur Fly.io les données sont persistées via Firebase
// En local, utilise le dossier 'data'
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'chat_history.json');
const REACTIONS_FILE = path.join(DATA_DIR, 'reactions.json');
const CHANNELS_FILE = path.join(DATA_DIR, 'channel_histories.json');
const DM_FILE = path.join(DATA_DIR, 'dm_history.json');
const POLLS_FILE = path.join(DATA_DIR, 'polls.json');
const PINNED_FILE = path.join(DATA_DIR, 'pinned.json');
const XP_FILE = path.join(DATA_DIR, 'user_xp.json');
const FRIENDS_FILE = path.join(DATA_DIR, 'friendships.json');
const BOOKMARKS_FILE = path.join(DATA_DIR, 'bookmarks.json');
const REMINDERS_FILE = path.join(DATA_DIR, 'reminders.json');
const AUTOMOD_FILE = path.join(DATA_DIR, 'automod.json');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const MINIGAMES_FILE = path.join(DATA_DIR, 'mini_games_stats.json');
const CHANNEL_CONFIG_FILE = path.join(DATA_DIR, 'channel_config.json');
const SERVER_RUNTIME_FILE = path.join(DATA_DIR, 'server_runtime_stats.json');
const LIVE_EVENTS_FILE = path.join(DATA_DIR, 'live_events_state.json');
const PROFILES_FILE = path.join(DATA_DIR, 'profiles.json');
const PRESENCE_HISTORY_FILE = path.join(DATA_DIR, 'presence_history.json');

// === PRESENCE HISTORY (join/leave log) ===
let presenceHistory = []; // [{ username, action: 'join'|'leave', timestamp }]
const MAX_PRESENCE_HISTORY = 500;
function loadPresenceHistory() {
    try {
        if (fs.existsSync(PRESENCE_HISTORY_FILE)) {
            presenceHistory = JSON.parse(fs.readFileSync(PRESENCE_HISTORY_FILE, 'utf8'));
            console.log(`✅ Historique de présence chargé: ${presenceHistory.length} entrées`);
        }
    } catch (e) { console.error('❌ Erreur chargement historique présence:', e.message); presenceHistory = []; }
}
async function loadPresenceHistoryFromFirebase() {
    const data = await fbLoad('presenceHistory');
    if (data) { presenceHistory = Array.isArray(data) ? data : []; console.log(`✅ [FB] Présence chargée: ${presenceHistory.length}`); return true; }
    return false;
}
function savePresenceHistory() {
    try { fs.writeFileSync(PRESENCE_HISTORY_FILE, JSON.stringify(presenceHistory, null, 2)); } catch (e) { console.error('❌ Erreur sauvegarde présence:', e.message); }
    fbSaveDebounced('presenceHistory', () => presenceHistory);
}
function addPresenceEntry(username, action) {
    const entry = { username, action, timestamp: new Date().toISOString() };
    presenceHistory.push(entry);
    if (presenceHistory.length > MAX_PRESENCE_HISTORY) {
        presenceHistory = presenceHistory.slice(-MAX_PRESENCE_HISTORY);
    }
    savePresenceHistory();
    io.emit('presence_history_append', entry);
}

// === SERVER ENVIRONMENT DETECTION ===
const IS_FLY = !!(process.env.FLY_APP_NAME || process.env.FLY_REGION);
const IS_RENDER = !!(process.env.RENDER || process.env.RENDER_EXTERNAL_URL);
const IS_CLOUD = IS_FLY || IS_RENDER;
const SERVER_ENV = IS_FLY ? 'fly' : IS_RENDER ? 'render' : 'local';
const PERF_CONFIG = IS_CLOUD ? {
    maxHistory: 800,
    saveDebounceMs: 3000,
    keepAliveIntervalMs: 4 * 60 * 1000,
    maxPresenceHistory: 300,
    pingIntervalMs: 30000,
    pingTimeoutMs: 60000
} : {
    maxHistory: 2000,
    saveDebounceMs: 1200,
    keepAliveIntervalMs: 10 * 60 * 1000,
    maxPresenceHistory: 500,
    pingIntervalMs: 25000,
    pingTimeoutMs: 60000
};

// === SHOP PROMOTIONS ===
let shopPromotion = {
    active: false,
    discount: 0,
    itemFilter: null, // null = all items, or array of item keys
    label: '',
    endsAt: 0,
    autoMode: false,
    autoIntervalMinutes: 120,
    autoDurationMinutes: 30,
    autoDiscountPercent: 20,
    nextAutoAt: 0
};

// Charger ou initialiser la config des salons
let channelConfig = { channels: [...DEFAULT_CHANNELS], voiceChannels: [...DEFAULT_VOICE_CHANNELS], categories: ['💬 Discussion', '🎮 Loisirs', '💡 Autres', '🤖 Intelligence Artificielle'] };
function loadChannelConfig() {
    try {
        if (fs.existsSync(CHANNEL_CONFIG_FILE)) {
            const data = JSON.parse(fs.readFileSync(CHANNEL_CONFIG_FILE, 'utf8'));
            if (data.channels && data.channels.length > 0) channelConfig = data;
            console.log(`✅ Config salons chargée: ${channelConfig.channels.length} text, ${channelConfig.voiceChannels.length} voice`);
        }
    } catch (e) { console.error('❌ Erreur chargement config salons:', e.message); }
}
async function loadChannelConfigFromFirebase() {
    const data = await fbLoad('channelConfig');
    if (data && data.channels && data.channels.length > 0) { channelConfig = data; console.log(`✅ [FB] Config salons chargée: ${channelConfig.channels.length}`); return true; }
    return false;
}
function saveChannelConfig() {
    try { fs.writeFileSync(CHANNEL_CONFIG_FILE, JSON.stringify(channelConfig, null, 2)); } catch (e) { console.error('❌ Erreur sauvegarde config salons:', e.message); }
    fbSave('channelConfig', channelConfig);
}
loadChannelConfig();

// Derive AVAILABLE_CHANNELS and VOICE_CHANNELS from config
let AVAILABLE_CHANNELS = channelConfig.channels.map(c => c.name);
let VOICE_CHANNELS = channelConfig.voiceChannels.map(c => c.name);
let voiceRooms = {};
VOICE_CHANNELS.forEach(vc => {
    voiceRooms[vc] = { participants: new Map() };
});

// Initialiser les historiques par salon
AVAILABLE_CHANNELS.forEach(ch => {
    if (!channelHistories[ch]) channelHistories[ch] = [];
    if (!channelReactions[ch]) channelReactions[ch] = {};
});

console.log(`📂 Dossier de données: ${DATA_DIR}`);

// Créer le dossier data si nécessaire
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log(`📁 Dossier créé: ${DATA_DIR}`);
}

function normalizeRuntimeStats(data = {}) {
    const accumulated = Number(data.accumulatedUptimeSeconds || 0);
    const boots = Number(data.boots || 0);
    return {
        version: 1,
        accumulatedUptimeSeconds: Number.isFinite(accumulated) && accumulated > 0 ? Math.floor(accumulated) : 0,
        boots: Number.isFinite(boots) && boots > 0 ? Math.floor(boots) : 0,
        lastBootAt: data.lastBootAt || null,
        lastShutdownAt: data.lastShutdownAt || null,
        updatedAt: data.updatedAt || null
    };
}

function getSessionUptimeSeconds() {
    return Math.max(0, Math.floor((Date.now() - SERVER_SESSION_START_MS) / 1000));
}

function getTotalUptimeSeconds() {
    return Math.max(0, Math.floor((serverRuntimeStats.accumulatedUptimeSeconds || 0) + getSessionUptimeSeconds()));
}

function formatDurationShort(totalSeconds) {
    const seconds = Math.max(0, Math.floor(totalSeconds || 0));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${hours}h ${minutes}m ${secs}s`;
}

function incrementCounter(bucket, key, amount = 1) {
    if (!bucket || !key) return;
    bucket[key] = (bucket[key] || 0) + amount;
}

function normalizeUsernameKey(username) {
    return String(username || '').trim().toLowerCase();
}

function getSocketsForUsername(username) {
    const key = normalizeUsernameKey(username);
    const set = userSocketIndex.get(key);
    return set ? Array.from(set) : [];
}

function registerUserSocket(username, socketId) {
    const key = normalizeUsernameKey(username);
    if (!key || !socketId) return;
    if (!userSocketIndex.has(key)) userSocketIndex.set(key, new Set());
    userSocketIndex.get(key).add(socketId);
}

function unregisterUserSocket(username, socketId) {
    const key = normalizeUsernameKey(username);
    const set = userSocketIndex.get(key);
    if (!set) return;
    set.delete(socketId);
    if (set.size === 0) {
        userSocketIndex.delete(key);
    }
}

function upsertE2EEPublicKey(username, deviceId, keyData = {}) {
    const userKey = normalizeUsernameKey(username);
    const safeDeviceId = String(deviceId || '').trim().substring(0, 80);
    if (!userKey || !safeDeviceId) return;

    if (!e2eeKeyDirectory.has(userKey)) {
        e2eeKeyDirectory.set(userKey, new Map());
    }

    const bucket = e2eeKeyDirectory.get(userKey);
    bucket.set(safeDeviceId, {
        deviceId: safeDeviceId,
        fingerprint: String(keyData.fingerprint || '').trim().substring(0, 200),
        publicKey: String(keyData.publicKey || '').trim().substring(0, 6000),
        algorithm: String(keyData.algorithm || 'x25519').trim().substring(0, 60),
        updatedAt: Date.now()
    });
}

function removeE2EEPublicKey(username, deviceId) {
    const userKey = normalizeUsernameKey(username);
    const safeDeviceId = String(deviceId || '').trim().substring(0, 80);
    if (!userKey || !safeDeviceId) return;

    const bucket = e2eeKeyDirectory.get(userKey);
    if (!bucket) return;
    bucket.delete(safeDeviceId);
    if (bucket.size === 0) {
        e2eeKeyDirectory.delete(userKey);
    }
}

function getE2EEPublicKeys(username) {
    const userKey = normalizeUsernameKey(username);
    const bucket = e2eeKeyDirectory.get(userKey);
    if (!bucket) return [];
    return Array.from(bucket.values()).map((entry) => ({
        deviceId: entry.deviceId,
        fingerprint: entry.fingerprint,
        publicKey: entry.publicKey,
        algorithm: entry.algorithm,
        updatedAt: entry.updatedAt
    }));
}

function evictSocketConnection(socketId, options = {}) {
    const user = connectedUsers.get(socketId);
    if (!user) return false;

    // Nettoyer la présence vocale de cette socket pour éviter les "ghost users".
    for (const [roomName, roomData] of Object.entries(voiceRooms || {})) {
        if (!roomData || !roomData.participants || !roomData.participants.has(socketId)) continue;
        roomData.participants.delete(socketId);
        io.emit('voice_participants_update', { room: roomName, participants: getVoiceParticipants(roomName) });
        io.to('voice_' + roomName).emit('voice_peer_left', { socketId });
    }

    if (typingUsers.has(socketId)) {
        typingUsers.delete(socketId);
        updateTypingIndicator();
    }

    connectedUsers.delete(socketId);
    authenticatedSockets.delete(socketId);
    unregisterUserSocket(user.username, socketId);
    removeE2EEPublicKey(user.username, user.deviceId);

    const staleSocket = io.sockets.sockets.get(socketId);
    if (staleSocket) {
        staleSocket.disconnect(true);
    }

    if (!options.skipUsersRefresh) {
        updateUsersList();
    }

    return true;
}

function emitMultiDevicePresence(username) {
    const sockets = getSocketsForUsername(username);
    const payload = {
        username,
        activeDevices: sockets.length,
        updatedAt: Date.now()
    };
    sockets.forEach((socketId) => {
        io.to(socketId).emit('multi_device_presence', payload);
    });
}

setInterval(() => {
    const now = Date.now();
    const lag = Math.max(0, now - observabilityLastLoopTick - 10000);
    observability.runtime.eventLoopLagMs = lag;
    observability.runtime.eventLoopLagMsMax = Math.max(observability.runtime.eventLoopLagMsMax, lag);
    observabilityLastLoopTick = now;
}, 10000);

function saveServerRuntimeStats(options = {}) {
    const includeCurrentSession = options.includeCurrentSession !== false;
    try {
        const payload = normalizeRuntimeStats(serverRuntimeStats);
        if (includeCurrentSession && !runtimeSessionCommitted) {
            payload.accumulatedUptimeSeconds += getSessionUptimeSeconds();
        }
        payload.updatedAt = new Date().toISOString();
        fs.writeFileSync(SERVER_RUNTIME_FILE, JSON.stringify(payload, null, 2));
        fbSaveDebounced('serverRuntime', () => payload, 10000);
    } catch (error) {
        console.error('❌ Erreur sauvegarde runtime serveur:', error.message);
    }
}

function commitRuntimeSession() {
    if (runtimeSessionCommitted) return;
    serverRuntimeStats.accumulatedUptimeSeconds += getSessionUptimeSeconds();
    serverRuntimeStats.lastShutdownAt = new Date().toISOString();
    serverRuntimeStats.updatedAt = new Date().toISOString();
    runtimeSessionCommitted = true;
    saveServerRuntimeStats({ includeCurrentSession: false });
}

function loadServerRuntimeStats() {
    try {
        if (fs.existsSync(SERVER_RUNTIME_FILE)) {
            const raw = JSON.parse(fs.readFileSync(SERVER_RUNTIME_FILE, 'utf8'));
            serverRuntimeStats = normalizeRuntimeStats(raw);
        } else {
            serverRuntimeStats = normalizeRuntimeStats({});
        }
    } catch (error) {
        console.error('❌ Erreur chargement runtime serveur:', error.message);
        serverRuntimeStats = normalizeRuntimeStats({});
    }

    serverRuntimeStats.boots += 1;
    serverRuntimeStats.lastBootAt = new Date().toISOString();
    serverRuntimeStats.updatedAt = new Date().toISOString();
    saveServerRuntimeStats({ includeCurrentSession: false });
}

loadServerRuntimeStats();

function findLiveEventById(eventId) {
    const wanted = String(eventId || '').trim().toLowerCase();
    if (!wanted) return null;
    return LIVE_EVENTS_CATALOG.find((event) => String(event.id).toLowerCase() === wanted) || null;
}

function computeNextLiveRotationTs(hours = LIVE_EVENT_DEFAULT_ROTATION_HOURS, fromTs = Date.now()) {
    const safeHours = Math.max(1, Math.min(24, Number(hours) || LIVE_EVENT_DEFAULT_ROTATION_HOURS));
    return Number(fromTs) + safeHours * 60 * 60 * 1000;
}

function createDefaultLiveOpsState() {
    const now = Date.now();
    return {
        version: 1,
        season: {
            number: 1,
            label: 'Saison 1 - Genesis',
            year: new Date(now).getFullYear(),
            startedAt: new Date(now).toISOString(),
            xpMultiplier: 1
        },
        activeEvent: null,
        autoModeEnabled: true,
        autoRotationHours: LIVE_EVENT_DEFAULT_ROTATION_HOURS,
        bannerDisplayMode: 'dismissible',
        eventRotationMinutes: LIVE_EVENT_DEFAULT_ROTATION_HOURS * 60,
        nextRotationAt: computeNextLiveRotationTs(LIVE_EVENT_DEFAULT_ROTATION_HOURS, now),
        updatedAt: new Date(now).toISOString()
    };
}

function normalizeLiveOpsState(raw = {}) {
    const fallback = createDefaultLiveOpsState();

    const seasonRaw = raw.season || {};
    const seasonNumber = parseInt(seasonRaw.number, 10);
    const seasonYear = parseInt(seasonRaw.year, 10);
    const xpMultiplier = Number(seasonRaw.xpMultiplier);
    const eventRotationMinutes = parseInt(raw.eventRotationMinutes, 10);
    const autoRotationHoursRaw = parseInt(raw.autoRotationHours, 10);
    const derivedHoursFromMinutes = Number.isFinite(eventRotationMinutes) && eventRotationMinutes > 0
        ? Math.max(1, Math.min(24, Math.round(eventRotationMinutes / 60)))
        : fallback.autoRotationHours;
    const autoRotationHours = Number.isFinite(autoRotationHoursRaw) && autoRotationHoursRaw > 0
        ? Math.max(1, Math.min(24, autoRotationHoursRaw))
        : derivedHoursFromMinutes;
    const autoModeEnabled = typeof raw.autoModeEnabled === 'boolean' ? raw.autoModeEnabled : true;
    const bannerDisplayMode = String(raw.bannerDisplayMode || fallback.bannerDisplayMode).toLowerCase() === 'always'
        ? 'always'
        : 'dismissible';
    const nextRotationAt = Number(raw.nextRotationAt);
    const activeEventRaw = raw.activeEvent || null;

    let activeEvent = null;
    if (activeEventRaw && activeEventRaw.id) {
        const ref = findLiveEventById(activeEventRaw.id);
        const endsAt = Number(activeEventRaw.endsAt || 0);
        if (ref && Number.isFinite(endsAt) && endsAt > 0) {
            const customEventMultiplier = Number(activeEventRaw.messageXpMultiplier);
            activeEvent = {
                id: ref.id,
                icon: ref.icon,
                title: ref.title,
                description: ref.description,
                messageXpMultiplier: Number.isFinite(customEventMultiplier)
                    ? Math.min(10, Math.max(1, customEventMultiplier))
                    : Number(ref.messageXpMultiplier || 1),
                startsAt: activeEventRaw.startsAt || new Date().toISOString(),
                endsAt,
                activatedBy: String(activeEventRaw.activatedBy || 'system')
            };
        }
    }

    return {
        version: 1,
        season: {
            number: Number.isFinite(seasonNumber) && seasonNumber > 0 ? seasonNumber : fallback.season.number,
            label: String(seasonRaw.label || fallback.season.label).substring(0, 70) || fallback.season.label,
            year: Number.isFinite(seasonYear) && seasonYear >= 2000 && seasonYear <= 2200 ? seasonYear : fallback.season.year,
            startedAt: seasonRaw.startedAt || fallback.season.startedAt,
            xpMultiplier: Number.isFinite(xpMultiplier) ? Math.min(10, Math.max(0.5, xpMultiplier)) : fallback.season.xpMultiplier
        },
        activeEvent,
        autoModeEnabled,
        autoRotationHours,
        bannerDisplayMode,
        eventRotationMinutes: autoRotationHours * 60,
        nextRotationAt: autoModeEnabled
            ? (Number.isFinite(nextRotationAt) && nextRotationAt > 0
                ? nextRotationAt
                : computeNextLiveRotationTs(autoRotationHours))
            : 0,
        updatedAt: raw.updatedAt || fallback.updatedAt
    };
}

function saveLiveOpsState() {
    try {
        liveOpsState.updatedAt = new Date().toISOString();
        fs.writeFileSync(LIVE_EVENTS_FILE, JSON.stringify(liveOpsState, null, 2));
        fbSave('liveOpsState', liveOpsState);
    } catch (error) {
        console.error('❌ Erreur sauvegarde live events:', error.message);
    }
}

function loadLiveOpsState() {
    try {
        if (fs.existsSync(LIVE_EVENTS_FILE)) {
            const raw = JSON.parse(fs.readFileSync(LIVE_EVENTS_FILE, 'utf8'));
            liveOpsState = normalizeLiveOpsState(raw);
        } else {
            liveOpsState = createDefaultLiveOpsState();
            saveLiveOpsState();
        }
        console.log('✅ Live events charges');
    } catch (error) {
        console.error('❌ Erreur chargement live events:', error.message);
        liveOpsState = createDefaultLiveOpsState();
    }
}

function getLiveMessageXpMultiplier() {
    const seasonMultiplier = Math.min(10, Math.max(0.5, Number(liveOpsState?.season?.xpMultiplier || 1)));
    let eventMultiplier = 1;
    const event = liveOpsState.activeEvent;
    if (event && Number(event.endsAt || 0) > Date.now()) {
        eventMultiplier = Math.min(10, Math.max(1, Number(event.messageXpMultiplier || 1)));
    }
    return Math.max(0.5, Math.min(10, Number((seasonMultiplier * eventMultiplier).toFixed(2))));
}

function getLiveOpsPayload() {
    const now = Date.now();
    const payload = {
        season: {
            number: liveOpsState.season.number,
            label: liveOpsState.season.label,
            year: liveOpsState.season.year,
            startedAt: liveOpsState.season.startedAt,
            xpMultiplier: liveOpsState.season.xpMultiplier
        },
        event: null,
        autoModeEnabled: !!liveOpsState.autoModeEnabled,
        autoRotationHours: Math.max(1, Math.min(24, Number(liveOpsState.autoRotationHours || LIVE_EVENT_DEFAULT_ROTATION_HOURS))),
        bannerDisplayMode: liveOpsState.bannerDisplayMode === 'always' ? 'always' : 'dismissible',
        nextRotationAt: liveOpsState.nextRotationAt,
        eventRotationMinutes: liveOpsState.eventRotationMinutes,
        effectiveMessageXpMultiplier: getLiveMessageXpMultiplier(),
        serverTime: now,
        catalog: LIVE_EVENTS_CATALOG.map((event) => ({
            id: event.id,
            icon: event.icon,
            title: event.title,
            description: event.description,
            messageXpMultiplier: event.messageXpMultiplier
        }))
    };

    if (liveOpsState.activeEvent && Number(liveOpsState.activeEvent.endsAt || 0) > now) {
        payload.event = {
            ...liveOpsState.activeEvent,
            remainingMs: Math.max(0, Number(liveOpsState.activeEvent.endsAt || 0) - now)
        };
    }

    return payload;
}

function broadcastLiveOpsState() {
    io.emit('season_event_state', getLiveOpsPayload());
}

function emitLiveOpsSystemMessage(message) {
    const systemMessage = {
        type: 'system',
        message,
        timestamp: new Date(),
        id: messageId++
    };
    addToHistory(systemMessage);
    io.emit('system_message', systemMessage);
}

function activateLiveEvent(eventId, options = {}) {
    const ref = findLiveEventById(eventId);
    if (!ref) return null;

    const now = Date.now();
    const durationRaw = parseInt(options.durationMinutes, 10);
    const durationMinutes = Number.isFinite(durationRaw)
        ? Math.min(LIVE_EVENT_MAX_DURATION_MINUTES, Math.max(5, durationRaw))
        : LIVE_EVENT_DEFAULT_DURATION_MINUTES;
    const customMultiplier = Number(options.messageXpMultiplier);
    const messageXpMultiplier = Number.isFinite(customMultiplier)
        ? Math.min(10, Math.max(1, customMultiplier))
        : Number(ref.messageXpMultiplier || 1);

    liveOpsState.activeEvent = {
        id: ref.id,
        icon: ref.icon,
        title: ref.title,
        description: ref.description,
        messageXpMultiplier,
        startsAt: new Date(now).toISOString(),
        endsAt: now + durationMinutes * 60 * 1000,
        activatedBy: String(options.actor || 'system')
    };
    liveOpsState.nextRotationAt = liveOpsState.autoModeEnabled
        ? computeNextLiveRotationTs(liveOpsState.autoRotationHours, now)
        : 0;
    saveLiveOpsState();
    broadcastLiveOpsState();

    if (options.announce !== false) {
        emitLiveOpsSystemMessage(`${ref.icon} Event live: ${ref.title} (${durationMinutes} min)`);
    }

    return liveOpsState.activeEvent;
}

function endLiveEvent(options = {}) {
    const current = liveOpsState.activeEvent;
    if (!current) return false;

    liveOpsState.activeEvent = null;
    liveOpsState.nextRotationAt = liveOpsState.autoModeEnabled
        ? computeNextLiveRotationTs(liveOpsState.autoRotationHours)
        : 0;
    saveLiveOpsState();
    broadcastLiveOpsState();

    if (options.announce !== false) {
        const actor = options.actor ? ` par ${options.actor}` : '';
        emitLiveOpsSystemMessage(`🧊 Event termine: ${current.title}${actor}`);
    }

    return true;
}

function rotateLiveEvent(options = {}) {
    const currentId = liveOpsState.activeEvent ? liveOpsState.activeEvent.id : null;
    const pool = LIVE_EVENTS_CATALOG.filter((event) => event.id !== currentId);
    const source = pool.length > 0 ? pool : LIVE_EVENTS_CATALOG;
    const selected = source[Math.floor(Math.random() * source.length)] || null;
    if (!selected) return null;
    return activateLiveEvent(selected.id, options);
}

function refreshLiveOpsState() {
    const now = Date.now();
    if (liveOpsState.activeEvent && Number(liveOpsState.activeEvent.endsAt || 0) <= now) {
        endLiveEvent({ actor: 'system', announce: true });
    }

    if (!liveOpsState.autoModeEnabled) return;

    if (!liveOpsState.activeEvent && Number(liveOpsState.nextRotationAt || 0) <= now) {
        rotateLiveEvent({ actor: 'system', announce: true, durationMinutes: LIVE_EVENT_DEFAULT_DURATION_MINUTES });
    }
}

function getSeasonalQuestWeekIndex(now = Date.now()) {
    const seasonStartRaw = liveOpsState?.season?.startedAt;
    const parsedSeasonStart = Date.parse(seasonStartRaw || '');
    const seasonStart = Number.isFinite(parsedSeasonStart) ? parsedSeasonStart : now;
    const elapsedMs = Math.max(0, now - seasonStart);
    return Math.floor(elapsedMs / (SEASONAL_QUEST_ROTATION_DAYS * 24 * 60 * 60 * 1000));
}

function buildSeasonalQuestsPayload(username) {
    const now = Date.now();
    const seasonNumber = Math.max(1, Number(liveOpsState?.season?.number || 1));
    const weekIndex = getSeasonalQuestWeekIndex(now);
    const selectionCount = Math.min(3, SEASONAL_QUEST_POOL.length);
    const selected = [];

    for (let i = 0; i < selectionCount; i += 1) {
        const idx = (weekIndex * 3 + seasonNumber + i * 2) % SEASONAL_QUEST_POOL.length;
        selected.push(SEASONAL_QUEST_POOL[idx]);
    }

    const entry = ensureXPEntry(username);
    ensureDailyMissionsForEntry(entry);
    const eventMultiplier = liveOpsState.activeEvent ? Number(liveOpsState.activeEvent.messageXpMultiplier || 1) : 1;

    const quests = selected.map((template, index) => {
        const progress = Math.max(0, Number(entry.dailyMissionProgress?.[template.metric] || 0));
        const dynamicTarget = Math.max(
            1,
            Math.floor(
                (template.baseTarget + Math.max(0, seasonNumber - 1) * template.targetGrowthPerSeason)
                * (eventMultiplier >= 1.8 ? 0.85 : 1)
            )
        );
        const completed = progress >= dynamicTarget;

        return {
            id: `${template.id}_${seasonNumber}_${weekIndex}_${index}`,
            metric: template.metric,
            title: template.title,
            label: template.label,
            progress,
            target: dynamicTarget,
            completed,
            rewards: {
                xp: template.rewardXP,
                bananas: template.rewardBananas
            }
        };
    });

    const seasonStartRaw = liveOpsState?.season?.startedAt;
    const parsedSeasonStart = Date.parse(seasonStartRaw || '');
    const seasonStart = Number.isFinite(parsedSeasonStart) ? parsedSeasonStart : now;

    return {
        seasonNumber,
        weekIndex,
        rotationDays: SEASONAL_QUEST_ROTATION_DAYS,
        generatedAt: now,
        rotatesAt: seasonStart + (weekIndex + 1) * SEASONAL_QUEST_ROTATION_DAYS * 24 * 60 * 60 * 1000,
        quests
    };
}

function getRecentChannelMapByUser(maxMessagesPerChannel = 120) {
    const usage = new Map();

    Object.entries(channelHistories || {}).forEach(([channelName, messages]) => {
        const recent = Array.isArray(messages) ? messages.slice(-maxMessagesPerChannel) : [];
        recent.forEach((message) => {
            if (message?.type !== 'user' || !message?.username) return;
            const key = normalizeUsernameKey(message.username);
            if (!key) return;
            if (!usage.has(key)) usage.set(key, new Set());
            usage.get(key).add(channelName);
        });
    });

    return usage;
}

function buildSocialRecommendations(username, limit = 5) {
    const safeUsername = String(username || '').trim();
    if (!safeUsername) return [];

    const userKey = normalizeUsernameKey(safeUsername);
    const myData = friendships[safeUsername] || { friends: [], pending: [], requests: [] };
    const blocked = new Set((global.blockedUsers?.[safeUsername] || []).map((u) => normalizeUsernameKey(u)));
    const exclusion = new Set([userKey]);

    (myData.friends || []).forEach((name) => exclusion.add(normalizeUsernameKey(name)));
    (myData.pending || []).forEach((name) => exclusion.add(normalizeUsernameKey(name)));
    (myData.requests || []).forEach((name) => exclusion.add(normalizeUsernameKey(name)));
    blocked.forEach((k) => exclusion.add(k));

    const allCandidates = new Map();
    Object.keys(friendships || {}).forEach((name) => allCandidates.set(normalizeUsernameKey(name), name));
    Array.from(userProfiles.keys()).forEach((name) => allCandidates.set(normalizeUsernameKey(name), name));
    Array.from(connectedUsers.values()).forEach((u) => allCandidates.set(normalizeUsernameKey(u.username), u.username));

    const myFriendsLower = new Set((myData.friends || []).map((name) => normalizeUsernameKey(name)));
    const recentChannels = getRecentChannelMapByUser();
    const myChannels = recentChannels.get(userKey) || new Set();

    const scored = [];
    allCandidates.forEach((candidateName, candidateKey) => {
        if (!candidateKey || exclusion.has(candidateKey)) return;

        const candidateData = friendships[candidateName] || { friends: [] };
        const candidateFriends = new Set((candidateData.friends || []).map((name) => normalizeUsernameKey(name)));
        let mutualFriends = 0;
        myFriendsLower.forEach((friendKey) => {
            if (candidateFriends.has(friendKey)) mutualFriends += 1;
        });

        const candidateChannels = recentChannels.get(candidateKey) || new Set();
        let sharedChannels = 0;
        myChannels.forEach((channelName) => {
            if (candidateChannels.has(channelName)) sharedChannels += 1;
        });

        const isOnline = getSocketsForUsername(candidateName).length > 0;
        const score = mutualFriends * 6 + sharedChannels * 4 + (isOnline ? 2 : 0);
        if (score <= 0) return;

        const reasons = [];
        if (mutualFriends > 0) reasons.push(`${mutualFriends} ami(s) en commun`);
        if (sharedChannels > 0) reasons.push(`${sharedChannels} salon(s) partagé(s)`);
        if (isOnline) reasons.push('en ligne');

        scored.push({
            username: candidateName,
            score,
            mutualFriends,
            sharedChannels,
            online: isOnline,
            reasons
        });
    });

    return scored
        .sort((a, b) => b.score - a.score || a.username.localeCompare(b.username))
        .slice(0, Math.max(1, Math.min(10, Number(limit) || 5)));
}

// === FONCTIONS DE PERSISTANCE ===
// Variable d'environnement: RESET_HISTORY=true pour effacer l'historique au démarrage
const RESET_ON_START = process.env.RESET_HISTORY === 'true';

// Messages épinglés (persistés)
let pinnedMessages = [];

function loadPinnedMessages() {
    try {
        if (fs.existsSync(PINNED_FILE)) {
            const data = fs.readFileSync(PINNED_FILE, 'utf8');
            pinnedMessages = JSON.parse(data) || [];
            console.log(`✅ Messages épinglés chargés: ${pinnedMessages.length}`);
        }
    } catch (error) {
        console.error('❌ Erreur chargement messages épinglés:', error.message);
        pinnedMessages = [];
    }
}

function savePinnedMessages() {
    try {
        fs.writeFileSync(PINNED_FILE, JSON.stringify(pinnedMessages, null, 2));
        fbSave('pinnedMessages', pinnedMessages);
    } catch (error) {
        console.error('❌ Erreur sauvegarde messages épinglés:', error.message);
    }
}

function loadPersistedData() {
    // Si RESET_HISTORY=true, on efface tout au démarrage
    if (RESET_ON_START) {
        console.log('🗑️ RESET_HISTORY activé - Historique effacé');
        chatHistory = [];
        messageReactions = {};
        channelHistories = {};
        AVAILABLE_CHANNELS.forEach(ch => {
            channelHistories[ch] = [];
            channelReactions[ch] = {};
        });
        messageId = 1;
        saveHistory();
        saveReactions();
        saveChannelHistories();
        pinnedMessages = [];
        savePinnedMessages();
        return;
    }
    
    try {
        // Charger l'historique général (rétrocompatibilité)
        if (fs.existsSync(HISTORY_FILE)) {
            const data = fs.readFileSync(HISTORY_FILE, 'utf8');
            const parsed = JSON.parse(data);
            chatHistory = parsed.messages || [];
            messageId = parsed.lastMessageId || 1;
            console.log(`✅ Historique chargé: ${chatHistory.length} messages`);
            
            // Migrer l'ancien historique vers le salon "général" si les salons sont vides
            if (chatHistory.length > 0 && (!channelHistories['général'] || channelHistories['général'].length === 0)) {
                channelHistories['général'] = chatHistory.map(msg => ({...msg, channel: 'général'}));
                console.log(`📦 Migration de ${chatHistory.length} messages vers le salon #général`);
            }
        } else {
            console.log('📝 Pas d\'historique existant - démarrage à zéro');
        }
        
        // Charger les historiques des salons
        if (fs.existsSync(CHANNELS_FILE)) {
            const data = fs.readFileSync(CHANNELS_FILE, 'utf8');
            const parsed = JSON.parse(data);
            if (parsed.histories) {
                channelHistories = parsed.histories;
                // S'assurer que tous les salons existent
                AVAILABLE_CHANNELS.forEach(ch => {
                    if (!channelHistories[ch]) channelHistories[ch] = [];
                });
                const totalMessages = Object.values(channelHistories).reduce((sum, arr) => sum + arr.length, 0);
                console.log(`✅ Historiques salons chargés: ${totalMessages} messages total`);
            }
        }
        
        // Charger les réactions
        if (fs.existsSync(REACTIONS_FILE)) {
            const data = fs.readFileSync(REACTIONS_FILE, 'utf8');
            messageReactions = JSON.parse(data) || {};
            console.log(`✅ Réactions chargées: ${Object.keys(messageReactions).length} messages avec réactions`);
        }
    } catch (error) {
        console.error('❌ Erreur lors du chargement des données:', error.message);
    }
}

function saveHistory() {
    try {
        const data = {
            messages: chatHistory,
            lastMessageId: messageId,
            savedAt: new Date().toISOString()
        };
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2));
        fbSaveDebounced('chatHistory', () => data);
    } catch (error) {
        console.error('❌ Erreur sauvegarde historique:', error.message);
    }
}

function saveChannelHistories() {
    try {
        const data = {
            histories: channelHistories,
            savedAt: new Date().toISOString()
        };
        fs.writeFileSync(CHANNELS_FILE, JSON.stringify(data, null, 2));
        fbSaveDebounced('channelHistories', () => data);
    } catch (error) {
        console.error('❌ Erreur sauvegarde salons:', error.message);
    }
}

function saveReactions() {
    try {
        fs.writeFileSync(REACTIONS_FILE, JSON.stringify(messageReactions, null, 2));
        fbSaveDebounced('messageReactions', () => messageReactions);
    } catch (error) {
        console.error('❌ Erreur sauvegarde réactions:', error.message);
    }
}

// === SAUVEGARDE/CHARGEMENT DMs ===
function saveDMs() {
    try {
        fs.writeFileSync(DM_FILE, JSON.stringify(dmHistory, null, 2));
        fbSaveDebounced('dmHistory', () => dmHistory);
    } catch (error) {
        console.error('❌ Erreur sauvegarde DMs:', error.message);
    }
}

function loadDMs() {
    try {
        if (fs.existsSync(DM_FILE)) {
            const data = fs.readFileSync(DM_FILE, 'utf8');
            dmHistory = JSON.parse(data);
            const convCount = Object.keys(dmHistory).length;
            console.log(`✅ DMs chargés: ${convCount} conversations`);
        }
    } catch (error) {
        console.error('❌ Erreur chargement DMs:', error.message);
        dmHistory = {};
    }
}

// Charger les DMs au démarrage
// (Moved to async loadAllData below)

// Charger les données au démarrage
// (Moved to async loadAllData below)

// === CHARGEMENT DES NOUVELLES DONNÉES ===
function loadXPData() {
    try {
        if (fs.existsSync(XP_FILE)) {
            userXP = JSON.parse(fs.readFileSync(XP_FILE, 'utf8'));
            console.log(`✅ XP chargé: ${Object.keys(userXP).length} utilisateurs`);
        }
    } catch (e) { console.error('❌ Erreur chargement XP:', e.message); userXP = {}; }
}

const XP_SAVE_DEBOUNCE_MS = 1200;
let xpSaveTimer = null;

function writeXPDataNow() {
    try {
        fs.writeFileSync(XP_FILE, JSON.stringify(userXP, null, 2));
        fbSave('userXP', userXP);
    } catch (e) {
        console.error('❌ Erreur sauvegarde XP:', e.message);
    }
}

function saveXPData() {
    if (xpSaveTimer) return;
    xpSaveTimer = setTimeout(() => {
        xpSaveTimer = null;
        writeXPDataNow();
    }, XP_SAVE_DEBOUNCE_MS);
}

function saveXPDataImmediate() {
    if (xpSaveTimer) {
        clearTimeout(xpSaveTimer);
        xpSaveTimer = null;
    }
    writeXPDataNow();
}
function loadFriendships() {
    try {
        if (fs.existsSync(FRIENDS_FILE)) {
            friendships = JSON.parse(fs.readFileSync(FRIENDS_FILE, 'utf8'));
            console.log(`✅ Amitiés chargées: ${Object.keys(friendships).length} utilisateurs`);
        }
    } catch (e) { console.error('❌ Erreur chargement amitiés:', e.message); friendships = {}; }
}
function saveFriendships() {
    try { fs.writeFileSync(FRIENDS_FILE, JSON.stringify(friendships, null, 2)); fbSaveDebounced('friendships', () => friendships); } catch (e) { console.error('❌ Erreur sauvegarde amitiés:', e.message); }
}

// Envoyer la liste d'amis mise à jour à un utilisateur connecté (par username)
function emitFriendsListTo(username) {
    const data = friendships[username] || { friends: [], pending: [], requests: [] };
    const friendsWithStatus = (data.friends || []).map(f => {
        const friendKey = normalizeUsernameKey(f);
        let online = false;
        for (const [, u] of connectedUsers.entries()) {
            if (normalizeUsernameKey(u.username) === friendKey) { online = true; break; }
        }
        return { username: f, online };
    });
    const wantedKey = normalizeUsernameKey(username);
    for (const [sid, u] of connectedUsers.entries()) {
        if (normalizeUsernameKey(u.username) === wantedKey) {
            io.to(sid).emit('friends_list', { friends: friendsWithStatus, pending: data.pending, requests: data.requests });
        }
    }
}

// Notifier les amis d'un changement de statut en ligne
function notifyFriendsOfStatusChange(username) {
    const data = friendships[username];
    if (!data || !data.friends) return;
    data.friends.forEach(friendName => {
        emitFriendsListTo(friendName);
    });
}
function loadBookmarks() {
    try {
        if (fs.existsSync(BOOKMARKS_FILE)) {
            userBookmarks = JSON.parse(fs.readFileSync(BOOKMARKS_FILE, 'utf8'));
            console.log(`✅ Bookmarks chargés: ${Object.keys(userBookmarks).length} utilisateurs`);
        }
    } catch (e) { console.error('❌ Erreur chargement bookmarks:', e.message); userBookmarks = {}; }
}
function saveBookmarks() {
    try { fs.writeFileSync(BOOKMARKS_FILE, JSON.stringify(userBookmarks, null, 2)); fbSaveDebounced('bookmarks', () => userBookmarks); } catch (e) { console.error('❌ Erreur sauvegarde bookmarks:', e.message); }
}
function loadReminders() {
    try {
        if (fs.existsSync(REMINDERS_FILE)) {
            const data = JSON.parse(fs.readFileSync(REMINDERS_FILE, 'utf8'));
            reminders = data.reminders || [];
            reminderIdCounter = data.lastId || 1;
            console.log(`✅ Rappels chargés: ${reminders.length}`);
        }
    } catch (e) { console.error('❌ Erreur chargement rappels:', e.message); reminders = []; }
}
function saveReminders() {
    try { fs.writeFileSync(REMINDERS_FILE, JSON.stringify({ reminders, lastId: reminderIdCounter }, null, 2)); fbSaveDebounced('reminders', () => ({ reminders, lastId: reminderIdCounter })); } catch (e) { console.error('❌ Erreur sauvegarde rappels:', e.message); }
}
function loadAutoMod() {
    try {
        if (fs.existsSync(AUTOMOD_FILE)) {
            autoModConfig = { ...autoModConfig, ...JSON.parse(fs.readFileSync(AUTOMOD_FILE, 'utf8')) };
            console.log(`✅ AutoMod chargé`);
        }
    } catch (e) { console.error('❌ Erreur chargement AutoMod:', e.message); }
}
function saveAutoMod() {
    try { fs.writeFileSync(AUTOMOD_FILE, JSON.stringify(autoModConfig, null, 2)); fbSave('autoModConfig', autoModConfig); } catch (e) { console.error('❌ Erreur sauvegarde AutoMod:', e.message); }
}

// === COMPTES ===
function hashPassword(password, salt) {
    return crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
}
function loadAccounts() {
    try {
        if (fs.existsSync(ACCOUNTS_FILE)) {
            accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
            console.log(`✅ Comptes chargés: ${Object.keys(accounts).length}`);
        }
    } catch (e) { console.error('❌ Erreur chargement comptes:', e.message); accounts = {}; }
}
function saveAccounts() {
    try { fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2)); fbSave('accounts', accounts); } catch (e) { console.error('❌ Erreur sauvegarde comptes:', e.message); }
}

function loadMiniGameStats() {
    try {
        if (fs.existsSync(MINIGAMES_FILE)) {
            miniGameStats = JSON.parse(fs.readFileSync(MINIGAMES_FILE, 'utf8')) || {};
            console.log(`✅ Stats mini-jeux chargées: ${Object.keys(miniGameStats).length} utilisateurs`);
        }
    } catch (e) {
        console.error('❌ Erreur chargement stats mini-jeux:', e.message);
        miniGameStats = {};
    }
}

function saveMiniGameStats() {
    if (saveMiniGameStats._timer) return;
    saveMiniGameStats._timer = setTimeout(() => {
        saveMiniGameStats._timer = null;
        try {
            fs.writeFileSync(MINIGAMES_FILE, JSON.stringify(miniGameStats, null, 2));
            fbSave('miniGameStats', miniGameStats);
        } catch (e) {
            console.error('❌ Erreur sauvegarde stats mini-jeux:', e.message);
        }
    }, 1500);
}

function saveMiniGameStatsImmediate() {
    if (saveMiniGameStats._timer) {
        clearTimeout(saveMiniGameStats._timer);
        saveMiniGameStats._timer = null;
    }
    try {
        fs.writeFileSync(MINIGAMES_FILE, JSON.stringify(miniGameStats, null, 2));
        fbSaveImmediate('miniGameStats', miniGameStats);
    } catch (e) {
        console.error('❌ Erreur sauvegarde stats mini-jeux:', e.message);
    }
}

function loadProfiles() {
    try {
        if (fs.existsSync(PROFILES_FILE)) {
            const data = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8'));
            userProfiles = new Map(Object.entries(data));
            console.log(`✅ Profils chargés: ${userProfiles.size} utilisateurs`);
        }
    } catch (e) { console.error('❌ Erreur chargement profils:', e.message); userProfiles = new Map(); }
}
function saveProfiles() {
    try {
        const obj = Object.fromEntries(userProfiles);
        fs.writeFileSync(PROFILES_FILE, JSON.stringify(obj, null, 2));
        fbSaveDebounced('profiles', () => Object.fromEntries(userProfiles));
    } catch (e) { console.error('❌ Erreur sauvegarde profils:', e.message); }
}

// === CHARGEMENT ASYNC DEPUIS FIREBASE + FALLBACK LOCAL ===
async function loadAllData() {
    console.log('📦 Chargement des données...');
    const fbStart = Date.now();

    if (useFirebase) {
        console.log('☁️ Tentative de chargement depuis Firebase...');
        try {
            // Load all data from Firebase in parallel
            const [
                fbAccounts, fbXP, fbFriends, fbBookmarks, fbReminders,
                fbAutoMod, fbMiniGames, fbProfiles, fbDMs, fbHistory,
                fbChannels, fbReactions, fbPinned, fbPresence, fbChannelCfg
            ] = await Promise.all([
                fbLoad('accounts'),
                fbLoad('userXP'),
                fbLoad('friendships'),
                fbLoad('bookmarks'),
                fbLoad('reminders'),
                fbLoad('autoModConfig'),
                fbLoad('miniGameStats'),
                fbLoad('profiles'),
                fbLoad('dmHistory'),
                fbLoad('chatHistory'),
                fbLoad('channelHistories'),
                fbLoad('messageReactions'),
                fbLoad('pinnedMessages'),
                fbLoad('presenceHistory'),
                fbLoad('channelConfig')
            ]);

            let fbCount = 0;

            if (fbAccounts && Object.keys(fbAccounts).length > 0) { accounts = fbAccounts; fbCount++; console.log(`  ✅ [FB] Comptes: ${Object.keys(accounts).length}`); }
            if (fbXP && Object.keys(fbXP).length > 0) { userXP = fbXP; fbCount++; console.log(`  ✅ [FB] XP: ${Object.keys(userXP).length}`); }
            if (fbFriends && Object.keys(fbFriends).length > 0) { friendships = fbFriends; fbCount++; console.log(`  ✅ [FB] Amitiés: ${Object.keys(friendships).length}`); }
            if (fbBookmarks && Object.keys(fbBookmarks).length > 0) { userBookmarks = fbBookmarks; fbCount++; }
            if (fbReminders) { reminders = fbReminders.reminders || []; reminderIdCounter = fbReminders.lastId || 1; fbCount++; }
            if (fbAutoMod) { autoModConfig = { ...autoModConfig, ...fbAutoMod }; fbCount++; }
            if (fbMiniGames && Object.keys(fbMiniGames).length > 0) { miniGameStats = fbMiniGames; fbCount++; }
            if (fbProfiles && Object.keys(fbProfiles).length > 0) { userProfiles = new Map(Object.entries(fbProfiles)); fbCount++; }
            if (fbDMs && Object.keys(fbDMs).length > 0) { dmHistory = fbDMs; fbCount++; }
            if (fbHistory) {
                chatHistory = fbHistory.messages || [];
                messageId = fbHistory.lastMessageId || 1;
                fbCount++;
                console.log(`  ✅ [FB] Historique: ${chatHistory.length} messages`);
            }
            if (fbChannels && fbChannels.histories) {
                channelHistories = fbChannels.histories;
                AVAILABLE_CHANNELS.forEach(ch => { if (!channelHistories[ch]) channelHistories[ch] = []; });
                fbCount++;
            }
            if (fbReactions && Object.keys(fbReactions).length > 0) { messageReactions = fbReactions; fbCount++; }
            if (fbPinned) { pinnedMessages = Array.isArray(fbPinned) ? fbPinned : []; fbCount++; }
            if (fbPresence) { presenceHistory = Array.isArray(fbPresence) ? fbPresence : []; fbCount++; }
            if (fbChannelCfg && fbChannelCfg.channels && fbChannelCfg.channels.length > 0) { channelConfig = fbChannelCfg; fbCount++; }

            console.log(`☁️ Firebase: ${fbCount}/15 collections chargées en ${Date.now() - fbStart}ms`);

            // If Firebase had data, skip local file loading for loaded collections
            if (fbCount > 5) {
                console.log('☁️ Données Firebase utilisées comme source principale');
                loadLiveOpsState();
                refreshLiveOpsState();
                return;
            }
        } catch (e) {
            console.error('❌ Erreur chargement Firebase, fallback local:', e.message);
        }
    }

    // Fallback: load from local files
    console.log('💾 Chargement depuis fichiers locaux...');
    loadDMs();
    loadPersistedData();
    loadPinnedMessages();
    loadLiveOpsState();
    refreshLiveOpsState();
    loadPresenceHistory();
    loadXPData();
    loadFriendships();
    loadBookmarks();
    loadReminders();
    loadAutoMod();
    loadAccounts();
    loadMiniGameStats();
    loadProfiles();

    // If Firebase is available but had no data, seed it from local files
    if (useFirebase) {
        console.log('☁️ Synchronisation initiale local → Firebase...');
        fbSave('accounts', accounts);
        fbSave('userXP', userXP);
        fbSave('friendships', friendships);
        fbSave('bookmarks', userBookmarks);
        fbSave('reminders', { reminders, lastId: reminderIdCounter });
        fbSave('autoModConfig', autoModConfig);
        fbSave('miniGameStats', miniGameStats);
        fbSave('profiles', Object.fromEntries(userProfiles));
        fbSave('dmHistory', dmHistory);
        fbSave('chatHistory', { messages: chatHistory, lastMessageId: messageId });
        fbSave('channelHistories', { histories: channelHistories });
        fbSave('messageReactions', messageReactions);
        fbSave('pinnedMessages', pinnedMessages);
        fbSave('presenceHistory', presenceHistory);
        fbSave('channelConfig', channelConfig);
        console.log('☁️ Sync initial terminé');
    }
}

// Lancement async du chargement
loadAllData().then(() => {
    console.log('✅ Toutes les données chargées');
}).catch(e => {
    console.error('❌ Erreur fatale chargement données:', e.message);
    // Fallback local d'urgence
    loadDMs(); loadPersistedData(); loadPinnedMessages(); loadLiveOpsState(); refreshLiveOpsState();
    loadPresenceHistory(); loadXPData(); loadFriendships(); loadBookmarks(); loadReminders();
    loadAutoMod(); loadAccounts(); loadMiniGameStats(); loadProfiles();
});

// === REMINDER CHECKER (every 10 seconds) ===
setInterval(() => {
    const now = Date.now();
    const triggered = reminders.filter(r => r.triggerAt <= now);
    if (triggered.length === 0) return;
    
    triggered.forEach(reminder => {
        // Find user socket
        for (const [socketId, userData] of connectedUsers.entries()) {
            if (userData.username === reminder.username) {
                io.to(socketId).emit('reminder_triggered', {
                    id: reminder.id,
                    message: reminder.message,
                    createdAt: reminder.createdAt
                });
                break;
            }
        }
    });
    
    reminders = reminders.filter(r => r.triggerAt > now);
    saveReminders();
}, 10000);

// === AUTO-MODERATION HELPER ===
function checkAutoMod(username, content) {
    if (!autoModConfig.enabled) return { allowed: true };
    if (adminUsersList.includes(username)) return { allowed: true };
    
    // Spam check
    if (!spamTracker[username]) spamTracker[username] = [];
    const now = Date.now();
    spamTracker[username].push(now);
    spamTracker[username] = spamTracker[username].filter(t => now - t < autoModConfig.spamInterval * 1000);
    if (spamTracker[username].length > autoModConfig.spamThreshold) {
        addWarning(username);
        return { allowed: false, reason: '🚫 Spam détecté ! Ralentissez.' };
    }
    
    // Link filter
    if (autoModConfig.linkFilter && /https?:\/\//i.test(content)) {
        addWarning(username);
        return { allowed: false, reason: '🚫 Les liens ne sont pas autorisés.' };
    }
    
    // Caps filter
    if (autoModConfig.capsFilter && content.length > 10) {
        const caps = content.replace(/[^a-zA-Z]/g, '');
        const upperCount = caps.replace(/[^A-Z]/g, '').length;
        if (caps.length > 0 && upperCount / caps.length > 0.8) {
            return { allowed: false, reason: '🚫 Trop de MAJUSCULES !' };
        }
    }
    
    // Word filter
    if (autoModConfig.wordFilter.length > 0) {
        const lowerContent = content.toLowerCase();
        for (const word of autoModConfig.wordFilter) {
            if (lowerContent.includes(word.toLowerCase())) {
                addWarning(username);
                return { allowed: false, reason: '🚫 Message contient un mot interdit.' };
            }
        }
    }
    
    return { allowed: true };
}

function addWarning(username) {
    if (!userWarnings[username]) userWarnings[username] = { count: 0, lastWarning: 0 };
    userWarnings[username].count++;
    userWarnings[username].lastWarning = Date.now();
}

// === XP HELPER ===
function grantXP(username, amount, options = {}) {
    const entry = ensureXPEntry(username);
    const source = options.source || 'message';
    const ignoreCooldown = !!options.ignoreCooldown;
    
    const now = Date.now();
    const cooldownMs = getMessageCooldownMs(entry);
    if (!ignoreCooldown && source === 'message' && (now - entry.lastXpGain < cooldownMs)) return null;

    const xpBoostMultiplier = entry.xpBoostUntil && now < entry.xpBoostUntil ? 2 : 1;
    const customMultiplier = Math.max(1, Number(options.multiplier || 1));
    const multiplier = xpBoostMultiplier * customMultiplier;
    const gainedXP = Math.max(1, Math.floor(amount * multiplier));
    
    const oldLevel = getLevelFromXP(entry.xp).level;
    entry.xp += gainedXP;
    entry.lastXpGain = now;
    const newLevelData = getLevelFromXP(entry.xp);
    entry.level = newLevelData.level;
    
    if (newLevelData.level > oldLevel) {
        saveXPData();
        return { levelUp: true, newLevel: newLevelData.level, username, gainedXP };
    }
    
    // Save periodically (every 5 XP gains)
    if (entry.xp % (gainedXP * 5) < gainedXP) saveXPData();
    return { levelUp: false, username, gainedXP };
}

function ensureMiniGameStatsEntry(username) {
    if (!miniGameStats[username]) {
        miniGameStats[username] = {
            points: 0,
            played: 0,
            wins: 0,
            losses: 0,
            draws: 0,
            byGame: {},
            lastPlayedAt: null
        };
    }
    if (!miniGameStats[username].byGame || typeof miniGameStats[username].byGame !== 'object') {
        miniGameStats[username].byGame = {};
    }
    return miniGameStats[username];
}

function getMiniGameReward(gameType, outcome) {
    const gameBonus = {
        tictactoe: 2,
        connect4: 3,
        rps: 1,
        quiz: 3,
        trivia: 4,
        hangman: 3,
        arena2d: 5,
        memory: 2,
        guess: 2
    };

    const baseByOutcome = {
        win: { points: 12, xp: 35 },
        draw: { points: 7, xp: 20 },
        loss: { points: 4, xp: 12 },
        played: { points: 3, xp: 10 }
    };

    const safeOutcome = baseByOutcome[outcome] ? outcome : 'played';
    const base = baseByOutcome[safeOutcome];
    const bonus = gameBonus[gameType] || 1;
    return {
        points: base.points + bonus,
        xp: base.xp + bonus * 2
    };
}

function recordMiniGameResult(username, gameType, outcome = 'played', extra = {}) {
    const stats = ensureMiniGameStatsEntry(username);
    const gameKey = gameType || 'unknown';
    if (!stats.byGame[gameKey]) {
        stats.byGame[gameKey] = { points: 0, played: 0, wins: 0, losses: 0, draws: 0 };
    }

    const reward = getMiniGameReward(gameKey, outcome);
    const points = Math.max(0, Math.floor((extra.points ?? reward.points) || 0));
    const xp = Math.max(0, Math.floor((extra.xp ?? reward.xp) || 0));

    stats.played += 1;
    stats.points += points;
    if (outcome === 'win') stats.wins += 1;
    else if (outcome === 'draw') stats.draws += 1;
    else if (outcome === 'loss') stats.losses += 1;

    const byGame = stats.byGame[gameKey];
    byGame.played += 1;
    byGame.points += points;
    if (outcome === 'win') byGame.wins += 1;
    else if (outcome === 'draw') byGame.draws += 1;
    else if (outcome === 'loss') byGame.losses += 1;

    stats.lastPlayedAt = new Date().toISOString();
    saveMiniGameStats();

    let xpResult = null;
    let bananas = 0;
    if (outcome === 'win') bananas = 2;
    else if (outcome === 'draw') bananas = 1;

    if (bananas > 0) {
        const xpEntry = ensureXPEntry(username);
        xpEntry.bonusBananas = Math.max(0, Number(xpEntry.bonusBananas || 0)) + bananas;
    }

    if (xp > 0) {
        xpResult = grantXP(username, xp, { ignoreCooldown: true, source: 'minigame' });
        saveXPData();
    }

    const missionRewards = applyMissionProgress(username, { miniGameRounds: 1 });

    return {
        points,
        xp,
        bananas,
        xpResult,
        missionRewards,
        totals: {
            points: stats.points,
            played: stats.played,
            wins: stats.wins,
            losses: stats.losses,
            draws: stats.draws
        }
    };
}

// Fonction de logging améliorée
function logActivity(type, message, data = {}) {
    const timestamp = new Date().toISOString();
    const logColors = {
        'CONNECTION': '\x1b[32m', // Vert
        'DISCONNECTION': '\x1b[31m', // Rouge
        'MESSAGE': '\x1b[36m', // Cyan
        'REPLY': '\x1b[35m', // Magenta
        'UPLOAD': '\x1b[33m', // Jaune
        'SYSTEM': '\x1b[34m', // Bleu
        'ERROR': '\x1b[31m', // Rouge
        'TYPING': '\x1b[90m', // Gris
        'PROFILE': '\x1b[95m' // Rose
    };
    
    const color = logColors[type] || '\x1b[37m';
    const resetColor = '\x1b[0m';
    
    console.log(`${color}[${timestamp}] ${type}:${resetColor} ${message}`);
    
    if (Object.keys(data).length > 0) {
        console.log(`${color}  └─ Données:${resetColor}`, JSON.stringify(data, null, 2));
    }
}

// Fonction utilitaire pour nettoyer les anciens fichiers
function cleanupOldFiles() {
    try {
        const files = fs.readdirSync(uploadDir);
        const now = Date.now();
        const maxAge = 30 * 24 * 60 * 60 * 1000; // 30 jours
        let cleanedCount = 0;
        
        files.forEach(file => {
            const filePath = path.join(uploadDir, file);
            const stats = fs.statSync(filePath);
            
            if (now - stats.mtime.getTime() > maxAge) {
                fs.unlinkSync(filePath);
                cleanedCount++;
            }
        });
        
        if (cleanedCount > 0) {
            logActivity('SYSTEM', `Nettoyage automatique: ${cleanedCount} fichiers supprimés`);
        }
    } catch (error) {
        logActivity('ERROR', 'Erreur lors du nettoyage des fichiers', { error: error.message });
    }
}

// Routes
app.get('/', (req, res) => {
    logActivity('SYSTEM', `Page d'accueil visitée depuis ${req.ip}`);
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Route pour l'upload de fichiers
app.post('/upload', (req, res) => {
    upload.single('file')(req, res, (err) => {
        if (err instanceof multer.MulterError) {
            logActivity('ERROR', 'Erreur Multer lors de l\'upload', { 
                error: err.message, 
                code: err.code,
                ip: req.ip 
            });
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({ error: 'Fichier trop volumineux (max 100MB)' });
            }
            return res.status(400).json({ error: `Erreur d'upload: ${err.message}` });
        } else if (err) {
            logActivity('ERROR', 'Erreur générique lors de l\'upload', { 
                error: err.message,
                ip: req.ip 
            });
            return res.status(400).json({ error: err.message });
        }
        
        if (!req.file) {
            return res.status(400).json({ error: 'Aucun fichier uploadé' });
        }
        
        serverStats.totalUploads++;
        logActivity('UPLOAD', `Fichier uploadé avec succès`, {
            filename: req.file.originalname,
            size: `${Math.round(req.file.size / 1024)}KB`,
            mimetype: req.file.mimetype,
            ip: req.ip,
            totalUploads: serverStats.totalUploads
        });
        
        res.json({
            success: true,
            filename: req.file.filename,
            originalname: req.file.originalname,
            size: req.file.size,
            mimetype: req.file.mimetype,
            path: `/uploads/${req.file.filename}`
        });
    });
});

// Route pour l'upload d'avatars
app.post('/upload-avatar', (req, res) => {
    avatarUpload.single('avatar')(req, res, (err) => {
        if (err instanceof multer.MulterError) {
            logActivity('ERROR', 'Erreur upload avatar', { 
                error: err.message, 
                code: err.code,
                ip: req.ip 
            });
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({ error: 'Image trop volumineuse (max 10MB)' });
            }
            return res.status(400).json({ error: `Erreur d'upload: ${err.message}` });
        } else if (err) {
            logActivity('ERROR', 'Erreur générique upload avatar', { 
                error: err.message,
                ip: req.ip 
            });
            return res.status(400).json({ error: err.message });
        }
        
        if (!req.file) {
            return res.status(400).json({ error: 'Aucune image uploadée' });
        }
        
        logActivity('PROFILE', `Avatar uploadé`, {
            filename: req.file.originalname,
            size: `${Math.round(req.file.size / 1024)}KB`,
            ip: req.ip
        });
        
        res.json({
            success: true,
            filename: req.file.filename,
            path: `/uploads/${req.file.filename}`
        });
    });
});

// Route pour télécharger les fichiers
app.get('/download/:filename', (req, res) => {
    const filename = req.params.filename;
    const filepath = path.join(uploadDir, filename);
    
    if (fs.existsSync(filepath)) {
        logActivity('SYSTEM', `Téléchargement de fichier`, {
            filename: filename,
            ip: req.ip
        });
        res.download(filepath);
    } else {
        logActivity('ERROR', `Tentative de téléchargement de fichier inexistant`, {
            filename: filename,
            ip: req.ip
        });
        res.status(404).json({ error: 'Fichier non trouvé' });
    }
});

// === ROUTE ADMIN POUR RESET L'HISTORIQUE ===
// Utiliser avec: /admin/reset?key=VOTRE_CLE_SECRETE
// Définir ADMIN_KEY dans les variables d'environnement de Fly.io
app.get('/admin/reset', (req, res) => {
    const adminKey = process.env.ADMIN_KEY || 'docspace2024';
    
    if (req.query.key !== adminKey) {
        return res.status(403).json({ error: 'Accès refusé' });
    }
    
    const oldCount = chatHistory.length;
    chatHistory = [];
    messageReactions = {};
    messageId = 1;
    saveHistory();
    saveReactions();
    
    // Notifier tous les clients
    io.emit('system_message', {
        type: 'system',
        message: '🗑️ L\'historique a été effacé par un administrateur',
        timestamp: new Date(),
        id: messageId++
    });
    
    logActivity('ADMIN', 'Historique effacé', { 
        oldMessagesCount: oldCount,
        ip: req.ip 
    });
    
    res.json({ 
        success: true, 
        message: `Historique effacé (${oldCount} messages supprimés)` 
    });
});

// === GEMINI AI API ===
const GEMINI_API_KEY = 'AIzaSyBlf5GI0LHIX82Itz6_18gOFgfIm3_nSqM';
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

app.post('/api/gemini', express.json(), async (req, res) => {
    try {
        const { prompt, history } = req.body;
        
        if (!prompt) {
            return res.status(400).json({ error: 'Prompt requis' });
        }
        
        const systemPrompt = `Tu es GeminiBot, un assistant IA intégré dans DocSpace, une application de chat en temps réel.
    Tu es amical, serviable, et tu peux être taquin de façon légère MAIS toujours respectueux.
    Tu réponds en français, avec un ton naturel et varié.
    Tu peux aider avec des questions générales, donner des conseils, expliquer des concepts, écrire du code, raconter des blagues, etc.
    Quand on te dit "quoi", "pourquoi", "comment", ou des relances similaires, réponds avec une explication claire et courte.
    Refuse poliment toute demande d'insultes, d'harcèlement ou de contenu offensant.
    Garde tes réponses concises (max 300 mots) car c'est un chat.
    Si on te demande qui tu es, dis que tu es GeminiBot, l'IA de DocSpace powered by Google Gemini.
    N'utilise pas de markdown complexe, juste du texte simple avec des emojis.`;
        
        const contents = [];
        
        // Ajouter l'historique si présent
        if (history && Array.isArray(history)) {
            history.slice(-10).forEach(msg => {
                contents.push({
                    role: msg.role,
                    parts: [{ text: msg.text }]
                });
            });
        }
        
        // Ajouter le message actuel
        contents.push({
            role: 'user',
            parts: [{ text: systemPrompt + '\n\nQuestion: ' + prompt }]
        });
        
        const response = await fetch(`${GEMINI_API_URL}?key=${GEMINI_API_KEY}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                contents: contents,
                generationConfig: {
                    temperature: 0.8,
                    topK: 40,
                    topP: 0.95,
                    maxOutputTokens: 1024,
                },
                safetySettings: [
                    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
                    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
                    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
                    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' }
                ]
            })
        });
        
        if (!response.ok) {
            const errorData = await response.json();
            console.error('Gemini API Error:', errorData);
            
            // Vérifier si c'est une erreur de quota
            if (errorData.error && errorData.error.status === 'RESOURCE_EXHAUSTED') {
                return res.status(429).json({ 
                    error: 'Quota dépassé', 
                    message: 'Trop de requêtes, réessaie dans 1 minute !',
                    retryAfter: 60
                });
            }
            
            return res.status(500).json({ error: 'Erreur API Gemini', details: errorData });
        }
        
        const data = await response.json();
        
        if (data.candidates && data.candidates[0] && data.candidates[0].content) {
            const aiResponse = data.candidates[0].content.parts[0].text;
            res.json({ response: aiResponse });
        } else {
            res.status(500).json({ error: 'Format de réponse invalide' });
        }
    } catch (error) {
        console.error('Gemini Server Error:', error);
        res.status(500).json({ error: 'Erreur serveur', message: error.message });
    }
});

app.get('/ADMIN', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/voice/runtime-config', (req, res) => {
    const sfuEnabled = VOICE_RUNTIME_MODE === 'sfu';
    res.json({
        mode: sfuEnabled ? 'sfu' : 'p2p',
        sfuEnabled,
        provider: VOICE_SFU_PROVIDER,
        signalingUrl: VOICE_SFU_SIGNALING_URL,
        publicWsUrl: VOICE_SFU_PUBLIC_WS,
        generatedAt: Date.now()
    });
});

app.get('/api/observability/summary', (req, res) => {
    const mem = process.memoryUsage();
    res.json({
        timestamp: Date.now(),
        uptimeSeconds: getTotalUptimeSeconds(),
        sockets: {
            ...observability.sockets,
            currentTransportConnections: io.engine.clientsCount,
            currentAuthenticatedUsers: connectedUsers.size
        },
        http: {
            requestsTotal: observability.http.requestsTotal,
            latencyMsAvg: observability.http.latencyMsAvg,
            latencyMsP95: observability.http.latencyMsP95,
            byStatus: observability.http.byStatus,
            topPaths: Object.entries(observability.http.byPath)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 10)
                .map(([pathName, count]) => ({ path: pathName, count }))
        },
        voice: observability.voice,
        runtime: {
            ...observability.runtime,
            memory: {
                heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
                heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
                rssMb: Math.round(mem.rss / 1024 / 1024)
            }
        }
    });
});

app.get('/metrics', (req, res) => {
    const lines = [];
    lines.push('# HELP docspace_http_requests_total Total HTTP requests');
    lines.push('# TYPE docspace_http_requests_total counter');
    lines.push(`docspace_http_requests_total ${observability.http.requestsTotal}`);
    lines.push('# HELP docspace_socket_connections_total Total socket transport connections');
    lines.push('# TYPE docspace_socket_connections_total counter');
    lines.push(`docspace_socket_connections_total ${observability.sockets.totalConnections}`);
    lines.push('# HELP docspace_connected_users Current authenticated users');
    lines.push('# TYPE docspace_connected_users gauge');
    lines.push(`docspace_connected_users ${connectedUsers.size}`);
    lines.push('# HELP docspace_event_loop_lag_ms Event loop lag in milliseconds');
    lines.push('# TYPE docspace_event_loop_lag_ms gauge');
    lines.push(`docspace_event_loop_lag_ms ${observability.runtime.eventLoopLagMs}`);
    lines.push('# HELP docspace_voice_offers_total Total WebRTC offers relayed');
    lines.push('# TYPE docspace_voice_offers_total counter');
    lines.push(`docspace_voice_offers_total ${observability.voice.offers}`);
    lines.push('# HELP docspace_voice_answers_total Total WebRTC answers relayed');
    lines.push('# TYPE docspace_voice_answers_total counter');
    lines.push(`docspace_voice_answers_total ${observability.voice.answers}`);
    lines.push('# HELP docspace_voice_ice_candidates_total Total ICE candidates relayed');
    lines.push('# TYPE docspace_voice_ice_candidates_total counter');
    lines.push(`docspace_voice_ice_candidates_total ${observability.voice.iceCandidates}`);

    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(lines.join('\n') + '\n');
});

// Route de santé pour Fly.io avec stats détaillées
app.get('/health', (req, res) => {
    const uptimeSession = getSessionUptimeSeconds();
    const uptimeTotal = getTotalUptimeSeconds();
    const memUsage = process.memoryUsage();
    
    const healthData = {
        status: 'OK',
        uptime: formatDurationShort(uptimeTotal),
        uptimeSession: formatDurationShort(uptimeSession),
        uptimeTotalSeconds: uptimeTotal,
        users: connectedUsers.size,
        messages: chatHistory.length,
        totalMessages: serverStats.totalMessages,
        totalUploads: serverStats.totalUploads,
        totalConnections: serverStats.totalConnections,
        serverName: SERVER_NAME,
        serverVersion: SERVER_VERSION,
        serverEnv: SERVER_ENV,
        perfProfile: IS_CLOUD ? 'cloud-optimized' : 'local-full',
        memory: {
            used: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`,
            total: `${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`
        },
        startTime: serverStats.startTime
    };
    
    logActivity('SYSTEM', `Vérification de santé depuis ${req.ip}`, {
        currentUsers: connectedUsers.size,
        totalMessages: serverStats.totalMessages
    });
    
    res.status(200).json(healthData);
});

// === API CLOUD STATS (Fly.io + Firebase) ===
app.get('/api/cloud-stats', (req, res) => {
    const memUsage = process.memoryUsage();
    const osInfo = {
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        pid: process.pid
    };

    // Fly.io environment info
    const flyInfo = {
        appName: process.env.FLY_APP_NAME || null,
        region: process.env.FLY_REGION || null,
        allocId: process.env.FLY_ALLOC_ID || null,
        machineId: process.env.FLY_MACHINE_ID || null,
        publicIp: process.env.FLY_PUBLIC_IP || null,
        isCloud: IS_CLOUD,
        environment: SERVER_ENV
    };

    // Memory usage
    const memory = {
        heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024 * 100) / 100,
        heapTotalMB: Math.round(memUsage.heapTotal / 1024 / 1024 * 100) / 100,
        rssMB: Math.round(memUsage.rss / 1024 / 1024 * 100) / 100,
        externalMB: Math.round((memUsage.external || 0) / 1024 / 1024 * 100) / 100,
        heapPercent: Math.round(memUsage.heapUsed / memUsage.heapTotal * 100)
    };

    // Firebase status
    const firebase = {
        connected: useFirebase,
        projectId: useFirebase ? ((() => { try { return JSON.parse(process.env.FIREBASE_CREDENTIALS || '{}').project_id; } catch(e) { return null; } })()) : null
    };

    // Data sizes (approximate)
    const dataSizes = {
        accounts: Object.keys(accounts).length,
        users: Object.keys(userXP).length,
        channels: Object.keys(channelHistories).length,
        totalMessages: Object.values(channelHistories).reduce((s, a) => s + a.length, 0),
        dms: Object.keys(dmHistory).length,
        friendships: Object.keys(friendships).length,
        miniGamePlayers: Object.keys(miniGameStats).length,
        profiles: userProfiles.size,
        presenceEntries: presenceHistory.length
    };

    res.json({
        fly: flyInfo,
        memory,
        firebase,
        dataSizes,
        os: osInfo,
        uptime: {
            session: getSessionUptimeSeconds(),
            total: getTotalUptimeSeconds(),
            sessionFormatted: formatDurationShort(getSessionUptimeSeconds()),
            totalFormatted: formatDurationShort(getTotalUptimeSeconds())
        }
    });
});

// === API PING ===
app.get('/api/stats/ping', (req, res) => {
    const start = Date.now();
    res.json({
        serverTime: start,
        processingTime: Date.now() - start
    });
});

// === API STATISTIQUES PUBLIQUES ===
app.get('/api/stats', (req, res) => {
    const uptimeTotal = getTotalUptimeSeconds();
    const totalChannelMessages = Object.values(channelHistories).reduce((sum, arr) => sum + arr.length, 0);
    refreshLiveOpsState();
    const liveOpsPayload = getLiveOpsPayload();
    
    // Top channels by activity
    const channelStats = {};
    AVAILABLE_CHANNELS.forEach(ch => {
        channelStats[ch] = channelHistories[ch] ? channelHistories[ch].length : 0;
    });
    
    res.json({
        online: connectedUsers.size,
        totalMessages: serverStats.totalMessages,
        totalChannelMessages: totalChannelMessages,
        totalUploads: serverStats.totalUploads,
        totalConnectionsEver: serverStats.totalConnections,
        serverName: SERVER_NAME,
        serverVersion: SERVER_VERSION,
        channels: channelStats,
        uptime: `${Math.floor(uptimeTotal / 3600)}h ${Math.floor((uptimeTotal % 3600) / 60)}m`,
        uptimeTotalSeconds: uptimeTotal,
        activePolls: Object.keys(polls).length,
        dmConversations: Object.keys(dmHistory).length,
        season: liveOpsPayload.season,
        activeLiveEvent: liveOpsPayload.event ? {
            id: liveOpsPayload.event.id,
            title: liveOpsPayload.event.title,
            icon: liveOpsPayload.event.icon,
            remainingMs: liveOpsPayload.event.remainingMs,
            messageXpMultiplier: liveOpsPayload.event.messageXpMultiplier
        } : null
    });
});

// === API DASHBOARD POUR OUTILS EXTERNES (ex: interface Python) ===
app.get('/api/server/dashboard', (req, res) => {
    const sessionUptimeSeconds = getSessionUptimeSeconds();
    const uptimeSeconds = getTotalUptimeSeconds();
    refreshLiveOpsState();
    const liveOpsPayload = getLiveOpsPayload();
    const mem = process.memoryUsage();
    const textChannels = Array.isArray(AVAILABLE_CHANNELS) ? AVAILABLE_CHANNELS : [];
    const voiceRoomsSummary = Object.entries(voiceRooms || {}).map(([roomName, roomData]) => ({
        name: roomName,
        participants: roomData?.participants ? roomData.participants.size : 0
    }));

    const channelsByActivity = textChannels.map((ch) => ({
        name: ch,
        messages: Array.isArray(channelHistories[ch]) ? channelHistories[ch].length : 0
    })).sort((a, b) => b.messages - a.messages);

    res.json({
        server: {
            name: SERVER_NAME,
            version: SERVER_VERSION,
            node: process.version,
            uptimeSeconds,
            sessionUptimeSeconds,
            boots: serverRuntimeStats.boots,
            lastBootAt: serverRuntimeStats.lastBootAt
        },
        traffic: {
            onlineUsers: connectedUsers.size,
            totalConnections: serverStats.totalConnections,
            totalMessages: serverStats.totalMessages,
            totalUploads: serverStats.totalUploads
        },
        memory: {
            heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
            heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
            rssMB: Math.round(mem.rss / 1024 / 1024)
        },
        channels: {
            textTotal: textChannels.length,
            voiceTotal: voiceRoomsSummary.length,
            topTextByMessages: channelsByActivity.slice(0, 8),
            voiceRooms: voiceRoomsSummary
        },
        realtime: {
            activeGames: global.activeGames ? global.activeGames.size : 0,
            pendingInvites: global.gameInvites ? global.gameInvites.size : 0,
            typingUsers: typingUsers.size
        },
        liveOps: {
            season: liveOpsPayload.season,
            activeEvent: liveOpsPayload.event,
            effectiveMessageXpMultiplier: liveOpsPayload.effectiveMessageXpMultiplier,
            nextRotationAt: liveOpsPayload.nextRotationAt,
            eventRotationMinutes: liveOpsPayload.eventRotationMinutes
        },
        generatedAt: new Date().toISOString()
    });
});

// Gestion des connexions Socket.IO
io.on('connection', (socket) => {
    const clientIp = socket.handshake.address;
    serverStats.totalConnections++;
    observability.sockets.totalConnections++;
    observability.sockets.currentTransportConnections = io.engine.clientsCount;

    socket.onAny((eventName) => {
        incrementCounter(observability.socketEvents, eventName, 1);
    });
    
    logActivity('CONNECTION', `Nouvelle connexion Socket.IO`, {
        socketId: socket.id,
        ip: clientIp,
        totalConnections: serverStats.totalConnections
    });

    // L'historique sera envoyé après que l'utilisateur se soit identifié (user_join)
    
    // Réactions emoji sur les messages (synchronisées)
    socket.on('reaction', ({ messageId, emoji, action }) => {
        const user = connectedUsers.get(socket.id);
        if (!user || !messageId || !emoji) return;
        
        const username = user.username;
        
        if (!messageReactions[messageId]) {
            messageReactions[messageId] = {};
        }
        if (!messageReactions[messageId][emoji]) {
            messageReactions[messageId][emoji] = [];
        }
        
        const userIndex = messageReactions[messageId][emoji].indexOf(username);
        let addedReaction = false;
        
        if (action === 'add' && userIndex === -1) {
            messageReactions[messageId][emoji].push(username);
            addedReaction = true;
            logActivity('MESSAGE', `Réaction ajoutée`, { messageId, emoji, username });
        } else if (action === 'remove' && userIndex > -1) {
            messageReactions[messageId][emoji].splice(userIndex, 1);
            // Nettoyer si vide
            if (messageReactions[messageId][emoji].length === 0) {
                delete messageReactions[messageId][emoji];
            }
            if (Object.keys(messageReactions[messageId]).length === 0) {
                delete messageReactions[messageId];
            }
            logActivity('MESSAGE', `Réaction retirée`, { messageId, emoji, username });
        }
        
        // Diffuser la mise à jour à tous les clients
        io.emit('reaction_update', { 
            messageId, 
            reactions: messageReactions[messageId] || {} 
        });

        if (addedReaction) {
            const xpEntry = ensureXPEntry(username);
            const now = Date.now();
            if (!xpEntry.lastReactionXpAt || now - xpEntry.lastReactionXpAt >= 5000) {
                const reactionMultiplier = xpEntry.reactionBoostUntil && xpEntry.reactionBoostUntil > now ? 2 : 1;
                const xpResult = grantXP(username, XP_PER_REACTION, {
                    source: 'reaction',
                    ignoreCooldown: true,
                    multiplier: reactionMultiplier
                });
                xpEntry.lastReactionXpAt = now;

                if (xpResult && xpResult.levelUp) {
                    io.emit('system_message', {
                        type: 'system',
                        message: `🎉 ${username} a atteint le niveau ${xpResult.newLevel} !`,
                        timestamp: new Date(),
                        id: messageId++
                    });
                }
            }

            const missionRewards = applyMissionProgress(username, { reactions: 1 });
            for (const reward of missionRewards) {
                socket.emit('daily_mission_reward', {
                    missionKey: reward.key,
                    missionLabel: reward.label,
                    rewardXP: reward.rewardXP,
                    rewardBananas: reward.rewardBananas || 0
                });
                if (reward.levelUp) {
                    io.emit('system_message', {
                        type: 'system',
                        message: `🎉 ${username} a atteint le niveau ${reward.newLevel} !`,
                        timestamp: new Date(),
                        id: messageId++
                    });
                }
            }

            socket.emit('xp_data', buildXPDataPayload(username));
            saveXPData();
        }
        
        // Sauvegarder les réactions
        saveReactions();
    });
    
    // Mise à jour du statut personnalisé
    socket.on('update_status', ({ status, customText }) => {
        const user = connectedUsers.get(socket.id);
        if (!user) return;
        
        const username = user.username;
        
        // Préserver les champs existants quand non fournis (ex: auto-idle)
        const existing = userStatuses[username] || {};
        
        // Sauvegarder le statut
        userStatuses[username] = {
            status: status || 'online',
            customText: (customText !== undefined ? customText : existing.customText || '').toString().substring(0, 50),
            emoji: existing.emoji || '',
            lastUpdate: new Date()
        };
        
        // Mettre à jour les données utilisateur
        user.status = status || 'online';
        user.customStatus = userStatuses[username].customText;
        connectedUsers.set(socket.id, user);
        
        logActivity('PROFILE', `Statut mis à jour`, { 
            username, 
            status, 
            customText: customText || '(vide)' 
        });
        
        // Diffuser la mise à jour à tous les clients
        io.emit('status_update', { 
            username, 
            status: userStatuses[username] 
        });
        
        // Mettre à jour la liste des utilisateurs
        updateUsersList();
    });

    // === CHANGEMENT DE PSEUDO EN TEMPS RÉEL ===
    socket.on('change_username', (data) => {
        try {
            const { newUsername } = data;
            const user = connectedUsers.get(socket.id);
            
            if (!user) {
                socket.emit('username_change_error', { message: 'Utilisateur non connecté' });
                return;
            }
            
            const oldUsername = user.username;
            const cleanNewUsername = (newUsername || '').trim().substring(0, 20);
            
            if (!cleanNewUsername || cleanNewUsername.length < 1) {
                socket.emit('username_change_error', { message: 'Pseudo invalide' });
                return;
            }
            
            // Vérifier si le nouveau pseudo est déjà pris
            const existingUser = Array.from(connectedUsers.values()).find(u => 
                u.username.toLowerCase() === cleanNewUsername.toLowerCase() && u.id !== socket.id
            );
            
            if (existingUser) {
                socket.emit('username_change_error', { message: 'Ce pseudo est déjà pris!' });
                return;
            }
            
            // Mettre à jour le pseudo
            user.username = cleanNewUsername;
            connectedUsers.set(socket.id, user);

            if (oldUsername !== cleanNewUsername) {
                const oldXP = userXP[oldUsername];
                const newXP = userXP[cleanNewUsername];
                if (oldXP && newXP) {
                    userXP[cleanNewUsername] = mergeXPEntries(ensureXPEntry(cleanNewUsername), oldXP);
                    delete userXP[oldUsername];
                    saveXPData();
                } else if (oldXP && !newXP) {
                    userXP[cleanNewUsername] = oldXP;
                    delete userXP[oldUsername];
                    ensureXPEntry(cleanNewUsername);
                    saveXPData();
                }

                const oldMiniGames = miniGameStats[oldUsername];
                const newMiniGames = miniGameStats[cleanNewUsername];
                if (oldMiniGames && newMiniGames) {
                    miniGameStats[cleanNewUsername] = mergeMiniGameStatsEntries(newMiniGames, oldMiniGames);
                    delete miniGameStats[oldUsername];
                    saveMiniGameStats();
                } else if (oldMiniGames && !newMiniGames) {
                    miniGameStats[cleanNewUsername] = oldMiniGames;
                    delete miniGameStats[oldUsername];
                    saveMiniGameStats();
                }

                for (const [, rData] of Object.entries(voiceRooms)) {
                    const participant = rData.participants.get(socket.id);
                    if (participant) participant.username = cleanNewUsername;
                }
            }
            
            // Transférer le statut
            if (userStatuses[oldUsername]) {
                userStatuses[cleanNewUsername] = userStatuses[oldUsername];
                delete userStatuses[oldUsername];
            }
            
            // Mettre à jour le profil
            if (userProfiles.has(oldUsername)) {
                const profile = userProfiles.get(oldUsername);
                profile.username = cleanNewUsername;
                userProfiles.set(cleanNewUsername, profile);
                userProfiles.delete(oldUsername);
            }
            
            logActivity('PROFILE', `Pseudo changé`, { 
                oldUsername, 
                newUsername: cleanNewUsername,
                socketId: socket.id 
            });
            
            // Confirmer au client
            socket.emit('username_changed', { 
                oldUsername, 
                newUsername: cleanNewUsername 
            });
            
            // Annoncer à tous
            const changeMessage = {
                type: 'system',
                message: `${oldUsername} a changé son pseudo en ${cleanNewUsername}`,
                timestamp: new Date(),
                id: messageId++
            };
            
            addToHistory(changeMessage);
            io.emit('system_message', changeMessage);
            
            // Mettre à jour la liste
            updateUsersList();
            
        } catch (error) {
            logActivity('ERROR', 'Erreur changement pseudo', { error: error.message });
            socket.emit('username_change_error', { message: 'Erreur lors du changement' });
        }
    });

    // === ACTIONS ADMIN ===
    socket.on('admin_action', (data) => {
        const { password, action, target, value } = data;
        const adminPassword = process.env.ADMIN_PASSWORD || 'IndieGabVR2024';
        
        if (password !== adminPassword) {
            socket.emit('admin_response', { success: false, message: 'Mot de passe incorrect' });
            return;
        }
        
        const adminUser = connectedUsers.get(socket.id);
        const adminName = adminUser ? adminUser.username : 'Admin';
        const findSocketIdByUsername = (username) => {
            if (!username) return null;
            const targetLower = username.toLowerCase();
            for (const [sid, user] of connectedUsers.entries()) {
                if ((user.username || '').toLowerCase() === targetLower) return sid;
            }
            return null;
        };
        const findVoiceParticipantByUsername = (username) => {
            if (!username) return null;
            const targetLower = username.toLowerCase();
            for (const [roomName, roomData] of Object.entries(voiceRooms)) {
                for (const [sid, participant] of roomData.participants.entries()) {
                    if ((participant.username || '').toLowerCase() === targetLower) {
                        return { roomName, socketId: sid, participant };
                    }
                }
            }
            return null;
        };
        const resolveXPUsername = (username) => {
            if (!username) return null;
            const targetLower = username.toLowerCase();
            for (const [, user] of connectedUsers.entries()) {
                if ((user.username || '').toLowerCase() === targetLower) return user.username;
            }
            for (const key of Object.keys(userXP)) {
                if ((key || '').toLowerCase() === targetLower) return key;
            }
            return username;
        };
        
        logActivity('ADMIN', `Action admin: ${action}`, { admin: adminName, target, value });
        
        switch (action) {
            case 'kick':
                // Trouver et déconnecter l'utilisateur
                let kickedSocket = null;
                connectedUsers.forEach((user, sid) => {
                    if (user.username.toLowerCase() === target.toLowerCase()) {
                        kickedSocket = io.sockets.sockets.get(sid);
                    }
                });
                
                if (kickedSocket) {
                    kickedSocket.emit('kicked', { message: 'Vous avez été expulsé par un administrateur' });
                    kickedSocket.disconnect(true);
                    socket.emit('admin_response', { success: true, message: `${target} a été expulsé` });
                    
                    const kickMsg = {
                        type: 'system',
                        message: `⚠️ ${target} a été expulsé par un administrateur`,
                        timestamp: new Date(),
                        id: messageId++
                    };
                    addToHistory(kickMsg);
                    io.emit('system_message', kickMsg);
                } else {
                    socket.emit('admin_response', { success: false, message: 'Utilisateur non trouvé' });
                }
                break;
                
            case 'ban':
                // Ban avec durée (0 = permanent)
                const banDuration = data.duration || 0; // en minutes
                let bannedSocket = null;
                let bannedUserInfo = null;
                
                connectedUsers.forEach((user, sid) => {
                    if (user.username.toLowerCase() === target.toLowerCase()) {
                        bannedSocket = io.sockets.sockets.get(sid);
                        bannedUserInfo = user;
                    }
                });
                
                if (bannedSocket || target) {
                    // Créer l'entrée de ban
                    const banIdentifier = target.toLowerCase();
                    const banEntry = {
                        username: target,
                        bannedAt: new Date(),
                        expiresAt: banDuration > 0 ? new Date(Date.now() + banDuration * 60 * 1000) : null,
                        permanent: banDuration === 0,
                        ip: bannedSocket ? bannedSocket.handshake.address : null
                    };
                    
                    bannedUsers.set(banIdentifier, banEntry);
                    
                    // Déconnecter l'utilisateur s'il est connecté
                    if (bannedSocket) {
                        const banDurationText = banDuration === 0 ? 'permanent' : `${banDuration} minutes`;
                        bannedSocket.emit('kicked', { message: `Vous avez été banni (${banDurationText})` });
                        bannedSocket.disconnect(true);
                    }
                    
                    const banDurationText = banDuration === 0 ? 'permanentement' : `pour ${banDuration} minutes`;
                    socket.emit('admin_response', { success: true, message: `${target} a été banni ${banDurationText}` });
                    
                    const banMsg = {
                        type: 'system',
                        message: `🚫 ${target} a été banni ${banDurationText}`,
                        timestamp: new Date(),
                        id: messageId++
                    };
                    addToHistory(banMsg);
                    io.emit('system_message', banMsg);
                    
                    logActivity('ADMIN', `Ban: ${target}`, { admin: adminName, duration: banDuration });
                } else {
                    socket.emit('admin_response', { success: false, message: 'Utilisateur non trouvé' });
                }
                break;
                
            case 'rename':
                // Renommer un utilisateur
                let targetSocket = null;
                let targetUser = null;
                connectedUsers.forEach((user, sid) => {
                    if (user.username.toLowerCase() === target.toLowerCase()) {
                        targetSocket = io.sockets.sockets.get(sid);
                        targetUser = user;
                    }
                });
                
                if (targetUser && value) {
                    const oldName = targetUser.username;
                    targetUser.username = value.substring(0, 20);
                    
                    const renameMsg = {
                        type: 'system',
                        message: `👤 ${oldName} a été renommé en ${value} par un administrateur`,
                        timestamp: new Date(),
                        id: messageId++
                    };
                    addToHistory(renameMsg);
                    io.emit('system_message', renameMsg);
                    
                    if (targetSocket) {
                        targetSocket.emit('force_rename', { newUsername: value });
                    }
                    
                    updateUsersList();
                    socket.emit('admin_response', { success: true, message: `${oldName} renommé en ${value}` });
                } else {
                    socket.emit('admin_response', { success: false, message: 'Utilisateur non trouvé ou valeur manquante' });
                }
                break;
                
            case 'clear_history':
                chatHistory.length = 0;
                Object.keys(messageReactions).forEach(k => delete messageReactions[k]);
                saveHistory();
                saveReactions();
                
                const clearMsg = {
                    type: 'system',
                    message: `🗑️ L'historique a été effacé par un administrateur`,
                    timestamp: new Date(),
                    id: messageId++
                };
                io.emit('system_message', clearMsg);
                io.emit('history_cleared');
                
                socket.emit('admin_response', { success: true, message: 'Historique effacé' });
                break;
                
            case 'broadcast':
                if (value) {
                    const broadcastMsg = {
                        type: 'system',
                        message: `📢 [ADMIN] ${value}`,
                        timestamp: new Date(),
                        id: messageId++
                    };
                    addToHistory(broadcastMsg);
                    io.emit('system_message', broadcastMsg);
                    socket.emit('admin_response', { success: true, message: 'Message diffusé' });
                }
                break;

            case 'pin_message':
                if (data.messageId) {
                    const exists = pinnedMessages.find(m => String(m.id) === String(data.messageId));
                    if (!exists) {
                        pinnedMessages.push({
                            id: data.messageId,
                            username: data.username || 'Utilisateur',
                            content: (data.content || '').substring(0, 200),
                            pinnedAt: new Date()
                        });
                        savePinnedMessages();
                    }
                    io.emit('pinned_update', { pinnedMessages });
                    socket.emit('admin_response', { success: true, message: 'Message épinglé' });
                }
                break;

            case 'unpin_message':
                if (data.messageId) {
                    pinnedMessages = pinnedMessages.filter(m => String(m.id) !== String(data.messageId));
                    savePinnedMessages();
                    io.emit('pinned_update', { pinnedMessages });
                    socket.emit('admin_response', { success: true, message: 'Message désépinglé' });
                }
                break;

            case 'voice_kick': {
                const voiceTarget = findVoiceParticipantByUsername(target);
                if (!voiceTarget) {
                    socket.emit('admin_response', { success: false, message: 'Utilisateur non trouvé en vocal' });
                    break;
                }

                const { roomName, socketId: targetSid } = voiceTarget;
                const targetSocket = io.sockets.sockets.get(targetSid);
                voiceRooms[roomName].participants.delete(targetSid);

                if (targetSocket) {
                    targetSocket.leave('voice_' + roomName);
                    targetSocket.emit('voice_forced_disconnect', {
                        room: roomName,
                        message: 'Vous avez été expulsé du vocal par un administrateur'
                    });
                }

                io.to('voice_' + roomName).emit('voice_peer_left', { socketId: targetSid });
                io.emit('voice_participants_update', { room: roomName, participants: getVoiceParticipants(roomName) });

                socket.emit('admin_response', { success: true, message: `${target} a été expulsé du vocal ${roomName}` });
                logActivity('ADMIN', `Expulsion vocale: ${target}`, { admin: adminName, room: roomName });
                break;
            }

            case 'voice_force_status': {
                const voiceTarget = findVoiceParticipantByUsername(target);
                if (!voiceTarget) {
                    socket.emit('admin_response', { success: false, message: 'Utilisateur non trouvé en vocal' });
                    break;
                }

                const { roomName, socketId: targetSid, participant } = voiceTarget;
                const mode = data.mode === 'deafen' ? 'deafen' : 'mute';
                const enabled = !!data.enabled;

                if (mode === 'mute') {
                    participant.muted = enabled;
                    if (!enabled && participant.deafened) participant.deafened = false;
                } else {
                    participant.deafened = enabled;
                    if (enabled) participant.muted = true;
                }

                const targetSocket = io.sockets.sockets.get(targetSid);
                if (targetSocket) {
                    targetSocket.emit('voice_force_status', {
                        muted: !!participant.muted,
                        deafened: !!participant.deafened,
                        message: mode === 'mute'
                            ? (enabled ? 'Un administrateur a coupé votre micro' : 'Un administrateur a réactivé votre micro')
                            : (enabled ? 'Un administrateur vous a passé en sourdine' : 'Un administrateur a retiré votre sourdine')
                    });
                }

                io.emit('voice_participants_update', { room: roomName, participants: getVoiceParticipants(roomName) });
                socket.emit('admin_response', {
                    success: true,
                    message: `${target}: ${mode === 'mute' ? 'micro' : 'sourdine'} ${enabled ? 'activé(e)' : 'désactivé(e)'}`
                });
                logActivity('ADMIN', `Voice status forcé`, {
                    admin: adminName,
                    target,
                    mode,
                    enabled,
                    room: roomName
                });
                break;
            }

            case 'voice_move': {
                const targetRoom = (data.room || value || '').toString().trim();
                if (!targetRoom || !voiceRooms[targetRoom]) {
                    socket.emit('admin_response', { success: false, message: 'Salon vocal cible invalide' });
                    break;
                }

                const voiceTarget = findVoiceParticipantByUsername(target);
                if (!voiceTarget) {
                    socket.emit('admin_response', { success: false, message: 'Utilisateur non trouvé en vocal' });
                    break;
                }

                if (voiceTarget.roomName === targetRoom) {
                    socket.emit('admin_response', { success: true, message: `${target} est déjà dans ${targetRoom}` });
                    break;
                }

                const targetSocket = io.sockets.sockets.get(voiceTarget.socketId);
                if (!targetSocket) {
                    socket.emit('admin_response', { success: false, message: 'Socket utilisateur introuvable' });
                    break;
                }

                targetSocket.emit('voice_force_move', {
                    room: targetRoom,
                    message: `Un administrateur vous a déplacé vers ${targetRoom}`
                });

                socket.emit('admin_response', { success: true, message: `${target} déplacé vers ${targetRoom}` });
                logActivity('ADMIN', `Déplacement vocal`, { admin: adminName, target, from: voiceTarget.roomName, to: targetRoom });
                break;
            }

            case 'xp_add': {
                const xpName = resolveXPUsername(target);
                const amount = parseInt(data.amount, 10);
                if (!xpName || !Number.isFinite(amount) || amount <= 0 || amount > 1000000) {
                    socket.emit('admin_response', { success: false, message: 'Paramètres XP invalides' });
                    break;
                }

                const entry = ensureXPEntry(xpName);
                entry.xp = Math.max(0, (entry.xp || 0) + amount);
                const levelData = getLevelFromXP(entry.xp);
                entry.level = levelData.level;
                saveXPData();

                const targetSid = findSocketIdByUsername(xpName);
                if (targetSid) {
                    io.to(targetSid).emit('xp_data', buildXPDataPayload(xpName));
                }

                socket.emit('admin_response', { success: true, message: `${xpName}: +${amount} XP (total ${entry.xp})` });
                logActivity('ADMIN', 'XP ajouté', { admin: adminName, target: xpName, amount, totalXP: entry.xp });
                break;
            }

            case 'xp_set': {
                const xpName = resolveXPUsername(target);
                const amount = parseInt(data.amount, 10);
                if (!xpName || !Number.isFinite(amount) || amount < 0 || amount > 100000000) {
                    socket.emit('admin_response', { success: false, message: 'Paramètres XP invalides' });
                    break;
                }

                const entry = ensureXPEntry(xpName);
                entry.xp = amount;
                const levelData = getLevelFromXP(entry.xp);
                entry.level = levelData.level;
                saveXPData();

                const targetSid = findSocketIdByUsername(xpName);
                if (targetSid) {
                    io.to(targetSid).emit('xp_data', buildXPDataPayload(xpName));
                }

                socket.emit('admin_response', { success: true, message: `${xpName}: XP défini à ${amount}` });
                logActivity('ADMIN', 'XP défini', { admin: adminName, target: xpName, totalXP: amount });
                break;
            }

            case 'live_ops_get': {
                refreshLiveOpsState();
                socket.emit('season_event_state', getLiveOpsPayload());
                socket.emit('admin_response', { success: true, message: 'Etat saison/event transmis' });
                break;
            }

            case 'season_update': {
                const wantedNumber = parseInt(data.seasonNumber, 10);
                const wantedYear = parseInt(data.seasonYear, 10);
                const wantedLabel = String(data.seasonLabel || '').trim();
                const wantedMultiplier = Number(data.xpMultiplier);

                if (Number.isFinite(wantedNumber) && wantedNumber > 0) {
                    liveOpsState.season.number = Math.min(999, wantedNumber);
                }
                if (wantedLabel) {
                    liveOpsState.season.label = wantedLabel.substring(0, 70);
                }
                if (Number.isFinite(wantedYear) && wantedYear >= 2000 && wantedYear <= 2200) {
                    liveOpsState.season.year = wantedYear;
                }
                if (Number.isFinite(wantedMultiplier)) {
                    liveOpsState.season.xpMultiplier = Math.min(10, Math.max(0.5, wantedMultiplier));
                }
                if (!liveOpsState.season.startedAt) {
                    liveOpsState.season.startedAt = new Date().toISOString();
                }

                saveLiveOpsState();
                broadcastLiveOpsState();
                socket.emit('admin_response', {
                    success: true,
                    message: `Saison ${liveOpsState.season.number} mise a jour (x${liveOpsState.season.xpMultiplier.toFixed(2)})`
                });
                logActivity('ADMIN', 'Saison mise a jour', {
                    admin: adminName,
                    season: liveOpsState.season
                });
                break;
            }

            case 'live_ops_settings_update': {
                const autoModeEnabled = !!data.autoModeEnabled;
                const autoRotationHours = parseInt(data.autoRotationHours, 10);
                const bannerDisplayMode = String(data.bannerDisplayMode || '').toLowerCase() === 'always'
                    ? 'always'
                    : 'dismissible';

                liveOpsState.autoModeEnabled = autoModeEnabled;
                if (Number.isFinite(autoRotationHours) && autoRotationHours > 0) {
                    liveOpsState.autoRotationHours = Math.max(1, Math.min(24, autoRotationHours));
                }
                liveOpsState.eventRotationMinutes = liveOpsState.autoRotationHours * 60;
                liveOpsState.bannerDisplayMode = bannerDisplayMode;
                liveOpsState.nextRotationAt = liveOpsState.autoModeEnabled
                    ? computeNextLiveRotationTs(liveOpsState.autoRotationHours)
                    : 0;

                saveLiveOpsState();
                broadcastLiveOpsState();
                socket.emit('admin_response', {
                    success: true,
                    message: `Live ops: auto ${liveOpsState.autoModeEnabled ? 'active' : 'desactive'} · toutes ${liveOpsState.autoRotationHours}h · banniere ${liveOpsState.bannerDisplayMode === 'always' ? 'toujours visible' : 'fermable'}`
                });
                logActivity('ADMIN', 'Parametres live ops', {
                    admin: adminName,
                    autoModeEnabled: liveOpsState.autoModeEnabled,
                    autoRotationHours: liveOpsState.autoRotationHours,
                    bannerDisplayMode: liveOpsState.bannerDisplayMode
                });
                break;
            }

            case 'live_event_set': {
                const eventId = data.eventId || value;
                const durationMinutes = parseInt(data.duration, 10);
                const messageXpMultiplier = Number(data.messageXpMultiplier);
                const activated = activateLiveEvent(eventId, {
                    actor: adminName,
                    durationMinutes: Number.isFinite(durationMinutes) ? durationMinutes : LIVE_EVENT_DEFAULT_DURATION_MINUTES,
                    messageXpMultiplier: Number.isFinite(messageXpMultiplier) ? messageXpMultiplier : undefined,
                    announce: true
                });
                if (!activated) {
                    socket.emit('admin_response', { success: false, message: 'Event live introuvable' });
                    break;
                }
                socket.emit('admin_response', {
                    success: true,
                    message: `Event live lance: ${activated.title}`
                });
                logActivity('ADMIN', 'Event live lance', {
                    admin: adminName,
                    eventId: activated.id,
                    durationMinutes: Math.round((activated.endsAt - Date.now()) / 60000)
                });
                break;
            }

            case 'live_event_rotate': {
                const rotated = rotateLiveEvent({
                    actor: adminName,
                    announce: true,
                    durationMinutes: LIVE_EVENT_DEFAULT_DURATION_MINUTES
                });
                if (!rotated) {
                    socket.emit('admin_response', { success: false, message: 'Impossible de tourner l\'event live' });
                    break;
                }
                socket.emit('admin_response', { success: true, message: `Event tourne: ${rotated.title}` });
                logActivity('ADMIN', 'Event live tourne', { admin: adminName, eventId: rotated.id });
                break;
            }

            case 'live_event_end': {
                const ended = endLiveEvent({ actor: adminName, announce: true });
                if (!ended) {
                    socket.emit('admin_response', { success: false, message: 'Aucun event live actif' });
                    break;
                }
                socket.emit('admin_response', { success: true, message: 'Event live termine' });
                logActivity('ADMIN', 'Event live termine', { admin: adminName });
                break;
            }

            case 'shop_promotion_set': {
                const promo = value || {};
                shopPromotion.active = true;
                shopPromotion.discount = Math.min(80, Math.max(5, parseInt(promo.discount) || 20));
                shopPromotion.label = String(promo.label || `🔥 Promo -${shopPromotion.discount}%`).slice(0, 100);
                shopPromotion.itemFilter = promo.itemFilter || null;
                shopPromotion.endsAt = Date.now() + (parseInt(promo.durationMinutes) || 30) * 60 * 1000;
                io.emit('shop_promotion_state', shopPromotion);
                socket.emit('admin_response', { success: true, message: `Promo boutique active: -${shopPromotion.discount}% pendant ${promo.durationMinutes || 30} min` });
                logActivity('ADMIN', 'Promotion boutique lancée', { admin: adminName, discount: shopPromotion.discount });
                break;
            }

            case 'shop_promotion_end': {
                shopPromotion.active = false;
                shopPromotion.discount = 0;
                shopPromotion.endsAt = 0;
                shopPromotion.label = '';
                io.emit('shop_promotion_state', shopPromotion);
                socket.emit('admin_response', { success: true, message: 'Promotion boutique terminée' });
                logActivity('ADMIN', 'Promotion boutique terminée', { admin: adminName });
                break;
            }

            case 'shop_promotion_auto': {
                const autoConf = value || {};
                shopPromotion.autoMode = !!autoConf.enabled;
                shopPromotion.autoIntervalMinutes = Math.max(30, parseInt(autoConf.intervalMinutes) || 120);
                shopPromotion.autoDurationMinutes = Math.max(5, parseInt(autoConf.durationMinutes) || 30);
                shopPromotion.autoDiscountPercent = Math.min(80, Math.max(5, parseInt(autoConf.discountPercent) || 20));
                if (shopPromotion.autoMode) {
                    shopPromotion.nextAutoAt = Date.now() + shopPromotion.autoIntervalMinutes * 60 * 1000;
                }
                io.emit('shop_promotion_state', shopPromotion);
                socket.emit('admin_response', { success: true, message: shopPromotion.autoMode ? `Promos auto activées: -${shopPromotion.autoDiscountPercent}% toutes les ${shopPromotion.autoIntervalMinutes}min` : 'Promos auto désactivées' });
                logActivity('ADMIN', `Promo auto: ${shopPromotion.autoMode ? 'ON' : 'OFF'}`, { admin: adminName });
                break;
            }
            
            // === NOUVELLES ACTIONS ADMIN ===
            case 'set_private':
                serverConfig.isPrivate = !!value;
                socket.emit('admin_response', { 
                    success: true, 
                    message: serverConfig.isPrivate ? 'Serveur en mode privé' : 'Serveur en mode public' 
                });
                logActivity('ADMIN', `Mode serveur: ${serverConfig.isPrivate ? 'privé' : 'public'}`, { admin: adminName });
                break;
            
            case 'set_access_code':
                if (value) {
                    serverConfig.accessCode = value;
                    socket.emit('admin_response', { success: true, message: `Code d'accès défini: ${value}` });
                    logActivity('ADMIN', 'Code d\'accès modifié', { admin: adminName });
                }
                break;
            
            case 'slow_mode':
                serverConfig.slowMode = parseInt(value) || 0;
                const slowModeMsg = {
                    type: 'system',
                    message: serverConfig.slowMode > 0 
                        ? `🐢 Mode lent activé (${serverConfig.slowMode}s entre les messages)`
                        : `🐢 Mode lent désactivé`,
                    timestamp: new Date(),
                    id: messageId++
                };
                io.emit('system_message', slowModeMsg);
                socket.emit('admin_response', { success: true, message: `Mode lent: ${serverConfig.slowMode}s` });
                break;
            
            case 'mute_all':
                serverConfig.globalMute = !serverConfig.globalMute;
                const muteMsg = {
                    type: 'system',
                    message: serverConfig.globalMute 
                        ? `🔇 Tous les utilisateurs sont maintenant mutés`
                        : `🔊 Les utilisateurs peuvent parler à nouveau`,
                    timestamp: new Date(),
                    id: messageId++
                };
                io.emit('system_message', muteMsg);
                socket.emit('admin_response', { 
                    success: true, 
                    message: serverConfig.globalMute ? 'Mute global activé' : 'Mute global désactivé' 
                });
                break;

            case 'unmute_all':
                serverConfig.globalMute = false;
                const unmuteMsg = {
                    type: 'system',
                    message: `🔊 Les utilisateurs peuvent parler à nouveau`,
                    timestamp: new Date(),
                    id: messageId++
                };
                io.emit('system_message', unmuteMsg);
                socket.emit('admin_response', { success: true, message: 'Mute global désactivé' });
                break;
            
            case 'kick_all':
                const kickAllMsg = {
                    type: 'system',
                    message: `👢 Tous les utilisateurs ont été expulsés par un administrateur`,
                    timestamp: new Date(),
                    id: messageId++
                };
                io.emit('system_message', kickAllMsg);
                
                // Expulser tout le monde sauf l'admin actuel
                connectedUsers.forEach((user, sid) => {
                    if (sid !== socket.id) {
                        const targetSocket = io.sockets.sockets.get(sid);
                        if (targetSocket) {
                            targetSocket.emit('kicked', { message: 'Tous les utilisateurs ont été expulsés' });
                            targetSocket.disconnect(true);
                        }
                    }
                });
                socket.emit('admin_response', { success: true, message: 'Tout le monde a été expulsé' });
                break;
            
            case 'restart':
                const restartMsg = {
                    type: 'system',
                    message: `🔄 Le serveur va redémarrer...`,
                    timestamp: new Date(),
                    id: messageId++
                };
                io.emit('system_message', restartMsg);
                io.emit('server_restart');
                socket.emit('admin_response', { success: true, message: 'Redémarrage en cours...' });
                
                // Sauvegarder avant de redémarrer
                saveHistory();
                saveReactions();
                commitRuntimeSession();
                
                setTimeout(() => {
                    process.exit(0); // Fly.io redémarrera automatiquement
                }, 2000);
                break;
            
            case 'get_stats':
                const uptimeSeconds = getTotalUptimeSeconds();
                socket.emit('server_stats', {
                    connectedUsers: connectedUsers.size,
                    totalMessages: serverStats.totalMessages,
                    totalUploads: serverStats.totalUploads,
                    uptime: uptimeSeconds,
                    isPrivate: serverConfig.isPrivate,
                    slowMode: serverConfig.slowMode
                });
                break;
            
            case 'get_banned_users':
                // Nettoyer les bans expirés
                const now = new Date();
                bannedUsers.forEach((ban, id) => {
                    if (!ban.permanent && new Date(ban.expiresAt) < now) {
                        bannedUsers.delete(id);
                    }
                });
                
                const bannedList = Array.from(bannedUsers.entries()).map(([id, ban]) => ({
                    identifier: id,
                    username: ban.username,
                    bannedAt: ban.bannedAt,
                    expiresAt: ban.expiresAt,
                    permanent: ban.permanent
                }));
                
                socket.emit('banned_users_list', { bannedUsers: bannedList });
                break;
            
            case 'unban':
                if (target) {
                    bannedUsers.delete(target);
                    socket.emit('admin_response', { success: true, message: `${target} a été débanni` });
                    logActivity('ADMIN', `${target} débanni`, { admin: adminName });
                }
                break;

            case 'screen_broadcast':
                // Broadcast a message on everyone's screen
                const sbText = (data.text || '').substring(0, 200);
                const sbStyle = ['info','warning','success','alert','fun'].includes(data.style) ? data.style : 'info';
                const sbDuration = Math.min(Math.max(parseInt(data.duration) || 5, 1), 30);
                io.emit('screen_broadcast', { text: sbText, style: sbStyle, duration: sbDuration });
                socket.emit('admin_response', { success: true, message: 'Message diffusé sur tous les écrans' });
                logActivity('ADMIN', `Screen broadcast: "${sbText}"`, { admin: adminName, style: sbStyle });
                break;

            case 'trigger_effect':
                // Trigger a visual effect on all clients
                const effect = ['confetti','shake','flash','matrix'].includes(data.effect) ? data.effect : null;
                if (effect) {
                    io.emit('admin_effect', { effect: effect });
                    socket.emit('admin_response', { success: true, message: `Effet "${effect}" déclenché` });
                    logActivity('ADMIN', `Effet visuel: ${effect}`, { admin: adminName });
                } else {
                    socket.emit('admin_response', { success: false, message: 'Effet non reconnu' });
                }
                break;
                
            case 'set_announcement':
                const annText = (data.value || '').substring(0, 500);
                if (annText) {
                    io.emit('server_announcement', { message: annText });
                    socket.emit('admin_response', { success: true, message: 'Annonce épinglée pour tous' });
                    logActivity('ADMIN', `Annonce: "${annText}"`, { admin: adminName });
                } else {
                    socket.emit('admin_response', { success: false, message: 'Texte vide' });
                }
                break;

            case 'clear_announcement':
                io.emit('server_announcement', { message: null });
                socket.emit('admin_response', { success: true, message: 'Annonce supprimée' });
                logActivity('ADMIN', 'Annonce supprimée', { admin: adminName });
                break;

            case 'set_server_name':
                const srvName = (data.value || '').substring(0, 50);
                if (srvName) {
                    io.emit('server_name_update', { name: srvName });
                    socket.emit('admin_response', { success: true, message: `Nom du serveur: ${srvName}` });
                    logActivity('ADMIN', `Nom du serveur changé: ${srvName}`, { admin: adminName });
                } else {
                    socket.emit('admin_response', { success: false, message: 'Nom vide' });
                }
                break;

            case 'set_welcome_message':
                const welcomeMsg = (data.value || '').substring(0, 500);
                io.emit('welcome_message_update', { message: welcomeMsg });
                socket.emit('admin_response', { success: true, message: 'Message de bienvenue mis à jour' });
                logActivity('ADMIN', `Message de bienvenue: "${welcomeMsg}"`, { admin: adminName });
                break;

            default:
                socket.emit('admin_response', { success: false, message: 'Action non reconnue' });
        }
    });

    // === LOGIN ADMIN ===
    socket.on('admin_login', (data) => {
        const { password, username } = data;
        const adminPassword = process.env.ADMIN_PASSWORD || 'IndieGabVR2024';
        
        if (password === adminPassword && username) {
            // Ajouter à la liste des admins
            if (!adminUsersList.includes(username)) {
                adminUsersList.push(username);
                logActivity('ADMIN', `${username} s'est connecté en tant qu'admin`);
            }
            
            // Broadcaster la liste des admins à tout le monde
            io.emit('admin_list_update', { admins: adminUsersList });
        }
    });

    socket.on('admin_logout', (data) => {
        const user = connectedUsers.get(socket.id);
        const username = String(data?.username || user?.username || '').trim();
        if (!username) return;
        const idx = adminUsersList.indexOf(username);
        if (idx > -1) {
            adminUsersList.splice(idx, 1);
            io.emit('admin_list_update', { admins: adminUsersList });
            logActivity('ADMIN', `${username} s'est déconnecté du mode admin`);
        }
    });

    // === ADMIN CHANNEL MANAGEMENT ===
    socket.on('admin_get_channel_config', (data) => {
        const adminPassword = process.env.ADMIN_PASSWORD || 'IndieGabVR2024';
        if (data?.password !== adminPassword) return;
        socket.emit('channel_config', channelConfig);
    });

    socket.on('admin_channel_action', (data) => {
        const adminPassword = process.env.ADMIN_PASSWORD || 'IndieGabVR2024';
        if (data?.password !== adminPassword) {
            socket.emit('admin_response', { success: false, message: 'Non autorisé' });
            return;
        }
        const { action } = data;
        switch (action) {
            case 'create_text': {
                const name = String(data.name || '').trim().toLowerCase();
                const icon = String(data.icon || '#').trim();
                const category = String(data.category || '💬 Discussion').trim();
                if (!name || name.length > 30) { socket.emit('admin_response', { success: false, message: 'Nom invalide (1-30 caractères)' }); return; }
                if (channelConfig.channels.some(c => c.name === name)) { socket.emit('admin_response', { success: false, message: 'Ce salon existe déjà' }); return; }
                channelConfig.channels.push({ name, icon, category });
                if (!channelConfig.categories.includes(category)) channelConfig.categories.push(category);
                AVAILABLE_CHANNELS = channelConfig.channels.map(c => c.name);
                if (!channelHistories[name]) { channelHistories[name] = []; channelReactions[name] = {}; }
                saveChannelConfig(); saveChannelHistories();
                io.emit('channel_config_update', channelConfig);
                socket.emit('admin_response', { success: true, message: `Salon #${name} créé` });
                logActivity('ADMIN', `Salon #${name} créé`, { icon, category });
                break;
            }
            case 'create_voice': {
                const name = String(data.name || '').trim();
                const icon = String(data.icon || '🔊').trim();
                if (!name || name.length > 30) { socket.emit('admin_response', { success: false, message: 'Nom invalide' }); return; }
                if (channelConfig.voiceChannels.some(c => c.name === name)) { socket.emit('admin_response', { success: false, message: 'Ce vocal existe déjà' }); return; }
                channelConfig.voiceChannels.push({ name, icon });
                VOICE_CHANNELS = channelConfig.voiceChannels.map(c => c.name);
                voiceRooms[name] = { participants: new Map() };
                saveChannelConfig();
                io.emit('channel_config_update', channelConfig);
                socket.emit('admin_response', { success: true, message: `Vocal "${name}" créé` });
                logActivity('ADMIN', `Vocal "${name}" créé`);
                break;
            }
            case 'delete_text': {
                const name = String(data.name || '').trim();
                if (name === 'général') { socket.emit('admin_response', { success: false, message: 'Impossible de supprimer #général' }); return; }
                const idx = channelConfig.channels.findIndex(c => c.name === name);
                if (idx === -1) { socket.emit('admin_response', { success: false, message: 'Salon non trouvé' }); return; }
                channelConfig.channels.splice(idx, 1);
                AVAILABLE_CHANNELS = channelConfig.channels.map(c => c.name);
                saveChannelConfig();
                io.emit('channel_config_update', channelConfig);
                socket.emit('admin_response', { success: true, message: `Salon #${name} supprimé` });
                logActivity('ADMIN', `Salon #${name} supprimé`);
                break;
            }
            case 'delete_voice': {
                const name = String(data.name || '').trim();
                const idx = channelConfig.voiceChannels.findIndex(c => c.name === name);
                if (idx === -1) { socket.emit('admin_response', { success: false, message: 'Vocal non trouvé' }); return; }
                // Kick everyone from this voice channel first
                if (voiceRooms[name]) {
                    for (const [sid] of voiceRooms[name].participants) {
                        const s = io.sockets.sockets.get(sid);
                        if (s) s.emit('voice_force_disconnect', { reason: 'Salon vocal supprimé' });
                    }
                    delete voiceRooms[name];
                }
                channelConfig.voiceChannels.splice(idx, 1);
                VOICE_CHANNELS = channelConfig.voiceChannels.map(c => c.name);
                saveChannelConfig();
                io.emit('channel_config_update', channelConfig);
                socket.emit('admin_response', { success: true, message: `Vocal "${name}" supprimé` });
                logActivity('ADMIN', `Vocal "${name}" supprimé`);
                break;
            }
            case 'edit_text': {
                const oldName = String(data.oldName || '').trim();
                const ch = channelConfig.channels.find(c => c.name === oldName);
                if (!ch) { socket.emit('admin_response', { success: false, message: 'Salon non trouvé' }); return; }
                if (data.icon) ch.icon = String(data.icon).trim();
                if (data.category) {
                    ch.category = String(data.category).trim();
                    if (!channelConfig.categories.includes(ch.category)) channelConfig.categories.push(ch.category);
                }
                if (data.newName && data.newName !== oldName) {
                    const newName = String(data.newName).trim().toLowerCase();
                    if (channelConfig.channels.some(c => c.name === newName)) { socket.emit('admin_response', { success: false, message: 'Ce nom existe déjà' }); return; }
                    // Migrate history
                    if (channelHistories[oldName]) { channelHistories[newName] = channelHistories[oldName]; delete channelHistories[oldName]; }
                    if (channelReactions[oldName]) { channelReactions[newName] = channelReactions[oldName]; delete channelReactions[oldName]; }
                    ch.name = newName;
                    AVAILABLE_CHANNELS = channelConfig.channels.map(c => c.name);

                    // Migrate users currently in the old channel to keep server state in sync
                    connectedUsers.forEach((u, sid) => {
                        if (u && u.currentChannel === oldName) {
                            u.currentChannel = newName;
                            connectedUsers.set(sid, u);
                        }
                    });

                    saveChannelHistories();
                    // Migrate users currently in the old channel
                    io.emit('channel_renamed', { oldName, newName });
                }
                saveChannelConfig();
                io.emit('channel_config_update', channelConfig);
                socket.emit('admin_response', { success: true, message: `Salon modifié` });
                logActivity('ADMIN', `Salon modifié: ${oldName}`, data);
                break;
            }
            case 'edit_voice': {
                const oldName = String(data.oldName || '').trim();
                const vc = channelConfig.voiceChannels.find(c => c.name === oldName);
                if (!vc) { socket.emit('admin_response', { success: false, message: 'Vocal non trouvé' }); return; }
                if (data.icon) vc.icon = String(data.icon).trim();
                if (data.newName && data.newName !== oldName) {
                    const newName = String(data.newName).trim();
                    if (channelConfig.voiceChannels.some(c => c.name === newName)) { socket.emit('admin_response', { success: false, message: 'Ce nom existe déjà' }); return; }
                    if (voiceRooms[oldName]) { voiceRooms[newName] = voiceRooms[oldName]; delete voiceRooms[oldName]; }
                    vc.name = newName;
                    VOICE_CHANNELS = channelConfig.voiceChannels.map(c => c.name);
                }
                saveChannelConfig();
                io.emit('channel_config_update', channelConfig);
                socket.emit('admin_response', { success: true, message: `Vocal modifié` });
                logActivity('ADMIN', `Vocal modifié: ${oldName}`, data);
                break;
            }
            case 'reorder': {
                if (Array.isArray(data.channels)) {
                    // Validate all names exist
                    const valid = data.channels.every(n => channelConfig.channels.some(c => c.name === n));
                    if (valid && data.channels.length === channelConfig.channels.length) {
                        const reordered = data.channels.map(n => channelConfig.channels.find(c => c.name === n));
                        channelConfig.channels = reordered;
                        AVAILABLE_CHANNELS = reordered.map(c => c.name);
                        saveChannelConfig();
                        io.emit('channel_config_update', channelConfig);
                        socket.emit('admin_response', { success: true, message: 'Ordre mis à jour' });
                    }
                }
                if (Array.isArray(data.voiceChannels)) {
                    const valid = data.voiceChannels.every(n => channelConfig.voiceChannels.some(c => c.name === n));
                    if (valid && data.voiceChannels.length === channelConfig.voiceChannels.length) {
                        const reordered = data.voiceChannels.map(n => channelConfig.voiceChannels.find(c => c.name === n));
                        channelConfig.voiceChannels = reordered;
                        VOICE_CHANNELS = reordered.map(c => c.name);
                        saveChannelConfig();
                        io.emit('channel_config_update', channelConfig);
                        socket.emit('admin_response', { success: true, message: 'Ordre vocal mis à jour' });
                    }
                }
                break;
            }
            case 'add_category': {
                const cat = String(data.category || '').trim();
                if (!cat) { socket.emit('admin_response', { success: false, message: 'Nom vide' }); return; }
                if (!channelConfig.categories.includes(cat)) {
                    channelConfig.categories.push(cat);
                    saveChannelConfig();
                    io.emit('channel_config_update', channelConfig);
                    socket.emit('admin_response', { success: true, message: `Catégorie "${cat}" ajoutée` });
                }
                break;
            }
            case 'delete_category': {
                const cat = String(data.category || '').trim();
                channelConfig.categories = channelConfig.categories.filter(c => c !== cat);
                // Move orphaned channels to first category
                channelConfig.channels.forEach(ch => { if (ch.category === cat) ch.category = channelConfig.categories[0] || '💬 Discussion'; });
                saveChannelConfig();
                io.emit('channel_config_update', channelConfig);
                socket.emit('admin_response', { success: true, message: `Catégorie supprimée` });
                break;
            }
            default:
                socket.emit('admin_response', { success: false, message: 'Action inconnue' });
        }
    });

    // === SUPPRESSION DE MESSAGE ===
    socket.on('delete_message', (data) => {
        const { messageId, password } = data;
        const user = connectedUsers.get(socket.id);
        if (!user) return;
        
        const adminPassword = process.env.ADMIN_PASSWORD || 'IndieGabVR2024';
        const isAdmin = password === adminPassword;
        
        // Trouver le message dans l'historique
        const msgIndex = chatHistory.findIndex(m => m.id == messageId);
        if (msgIndex === -1) {
            socket.emit('admin_response', { success: false, message: 'Message non trouvé' });
            return;
        }
        
        const msg = chatHistory[msgIndex];
        
        // Vérifier les permissions (admin ou propriétaire du message)
        if (!isAdmin && msg.username !== user.username) {
            socket.emit('admin_response', { success: false, message: 'Pas la permission' });
            return;
        }
        
        // Supprimer le message
        chatHistory.splice(msgIndex, 1);
        
        // Supprimer les réactions associées
        if (messageReactions[messageId]) {
            delete messageReactions[messageId];
        }
        
        saveHistory();
        saveReactions();
        
        logActivity('MESSAGE', `Message supprimé`, { 
            messageId, 
            deletedBy: user.username, 
            isAdmin 
        });
        
        // Notifier tous les clients
        io.emit('message_deleted', { messageId });
    });

    // === ÉDITION DE MESSAGE ===
    socket.on('edit_message', (data) => {
        const { messageId, newContent } = data;
        const user = connectedUsers.get(socket.id);
        if (!user) return;
        
        // Trouver le message dans l'historique
        const msgIndex = chatHistory.findIndex(m => m.id == messageId);
        if (msgIndex === -1) {
            socket.emit('edit_response', { success: false, message: 'Message non trouvé' });
            return;
        }
        
        const msg = chatHistory[msgIndex];
        
        // Vérifier que c'est bien le propriétaire du message
        if (msg.username !== user.username) {
            socket.emit('edit_response', { success: false, message: 'Vous ne pouvez modifier que vos propres messages' });
            return;
        }
        
        // Valider le nouveau contenu
        const cleanContent = (newContent || '').trim().substring(0, 500);
        if (!cleanContent) {
            socket.emit('edit_response', { success: false, message: 'Le message ne peut pas être vide' });
            return;
        }
        
        // Échapper le contenu
        const escapedContent = cleanContent
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
        
        // Sauvegarder l'ancien contenu
        const oldContent = msg.content;
        
        // Mettre à jour le message
        msg.content = escapedContent;
        msg.edited = true;
        msg.editedAt = new Date();
        
        saveHistory();
        
        logActivity('MESSAGE', `Message modifié`, { 
            messageId, 
            username: user.username,
            oldContent: oldContent.substring(0, 50),
            newContent: escapedContent.substring(0, 50)
        });
        
        // Notifier tous les clients
        io.emit('message_edited', { 
            messageId, 
            newContent: escapedContent,
            edited: true,
            editedAt: msg.editedAt
        });
        
        socket.emit('edit_response', { success: true, message: 'Message modifié' });
    });

    // Connexion d'un utilisateur
    socket.on('user_join', (userData) => {
        try {
            const { username, avatar, accessCode, deviceId } = userData;
            
            // Validation
            if (!username || typeof username !== 'string' || username.trim().length === 0) {
                logActivity('ERROR', `Tentative de connexion avec nom invalide`, {
                    socketId: socket.id,
                    ip: clientIp,
                    providedUsername: username
                });
                socket.emit('error', { message: 'Nom d\'utilisateur invalide' });
                return;
            }
            
            const cleanUsername = username.trim().substring(0, 20);
            const safeDeviceId = String(deviceId || '').trim().substring(0, 80) || `device_${socket.id.substring(0, 8)}`;

            const existingSocketSession = connectedUsers.get(socket.id);
            if (existingSocketSession) {
                if (normalizeUsernameKey(existingSocketSession.username) === normalizeUsernameKey(cleanUsername)) {
                    existingSocketSession.avatar = avatar || existingSocketSession.avatar || '';
                    existingSocketSession.lastActivity = new Date();
                    connectedUsers.set(socket.id, existingSocketSession);
                    updateUsersList();
                    return;
                }
                evictSocketConnection(socket.id, { skipUsersRefresh: true });
            }
            
            // === VÉRIFICATION COMPTE PROTÉGÉ ===
            const accountKey = cleanUsername.toLowerCase();
            if (accounts[accountKey] && !authenticatedSockets.has(socket.id)) {
                socket.emit('account_required', { message: 'Ce pseudo est protégé par un mot de passe. Entrez votre mot de passe.' });
                return;
            }
            
            // === VÉRIFICATION DU BAN ===
            const banIdentifier = cleanUsername.toLowerCase();
            if (bannedUsers.has(banIdentifier)) {
                const ban = bannedUsers.get(banIdentifier);
                const now = new Date();
                
                // Vérifier si le ban a expiré
                if (!ban.permanent && new Date(ban.expiresAt) < now) {
                    bannedUsers.delete(banIdentifier);
                } else {
                    const remainingTime = ban.permanent ? 'permanent' : 
                        `expire ${new Date(ban.expiresAt).toLocaleString()}`;
                    socket.emit('kicked', { 
                        message: `Vous êtes banni (${remainingTime})` 
                    });
                    logActivity('BLOCKED', `Utilisateur banni tenté de rejoindre`, {
                        username: cleanUsername,
                        ip: clientIp
                    });
                    socket.disconnect(true);
                    return;
                }
            }
            
            // === VÉRIFICATION DU SERVEUR PRIVÉ ===
            if (serverConfig.isPrivate && serverConfig.accessCode) {
                if (accessCode !== serverConfig.accessCode) {
                    socket.emit('access_denied', { 
                        message: 'Ce serveur est privé. Code d\'accès requis.' 
                    });
                    logActivity('BLOCKED', `Accès refusé - serveur privé`, {
                        username: cleanUsername,
                        ip: clientIp
                    });
                    return;
                }
            }
            
            const allowMultiDevice = !!accounts[accountKey] && authenticatedSockets.has(socket.id);
            const hadPresenceBeforeCleanup = getSocketsForUsername(cleanUsername).length > 0;

            // Reconnexion même compte/même appareil: remplace les sockets obsolètes.
            const staleSocketIds = getSocketsForUsername(cleanUsername).filter((sid) => {
                if (sid === socket.id) return false;
                const existing = connectedUsers.get(sid);
                return !!existing && existing.deviceId === safeDeviceId;
            });
            staleSocketIds.forEach((sid) => {
                evictSocketConnection(sid, { skipUsersRefresh: true });
            });

            const hasAnotherActiveSocket = getSocketsForUsername(cleanUsername).length > 0;
            if (hasAnotherActiveSocket && !allowMultiDevice) {
                logActivity('ERROR', `Tentative d'utilisation d'un pseudo déjà pris`, {
                    socketId: socket.id,
                    username: cleanUsername,
                    ip: clientIp,
                    existingSocketId: getSocketsForUsername(cleanUsername)[0] || null
                });
                socket.emit('username_taken', { message: 'Ce pseudo est déjà pris!' });
                return;
            }

            // Ajouter l'utilisateur
            const userInfo = {
                id: socket.id,
                username: cleanUsername,
                avatar: avatar || '',
                deviceId: safeDeviceId,
                joinTime: new Date(),
                ip: clientIp,
                lastActivity: new Date(),
                messagesCount: 0,
                repliesCount: 0
            };
            
            connectedUsers.set(socket.id, userInfo);
            registerUserSocket(cleanUsername, socket.id);
            emitMultiDevicePresence(cleanUsername);
            observability.sockets.currentAuthenticatedUsers = connectedUsers.size;

            // === DAILY XP BONUS + STREAK (simple progression) ===
            const xpEntry = ensureXPEntry(cleanUsername);
            const todayKey = getDayKey();
            const yesterdayKey = getPreviousDayKey();
            let loginBonusAwarded = null;

            if (xpEntry.lastLoginDay !== todayKey) {
                if (xpEntry.lastLoginDay === yesterdayKey) {
                    xpEntry.streakDays = (xpEntry.streakDays || 0) + 1;
                } else if (xpEntry.streakShieldCharges > 0 && xpEntry.lastLoginDay) {
                    xpEntry.streakShieldCharges -= 1;
                    xpEntry.streakDays = Math.max(1, xpEntry.streakDays || 1);
                    socket.emit('banana_reward', {
                        type: 'streak_shield',
                        title: '🛡️ Protection de série',
                        message: 'Une charge de protection a sauvé votre série quotidienne.'
                    });
                } else {
                    xpEntry.streakDays = 1;
                }
                xpEntry.lastLoginDay = todayKey;
                ensureDailyMissionsForEntry(xpEntry);

                const streakBonus = Math.min((xpEntry.streakDays - 1) * DAILY_LOGIN_STREAK_STEP, DAILY_LOGIN_STREAK_MAX_BONUS);
                const bonusXP = DAILY_LOGIN_XP_BONUS + streakBonus;
                xpEntry.xp = Math.max(0, (xpEntry.xp || 0) + bonusXP);
                xpEntry.level = getLevelFromXP(xpEntry.xp).level;

                loginBonusAwarded = {
                    bonusXP,
                    streakDays: xpEntry.streakDays
                };
                saveXPData();
            }

            // Sauvegarder le profil
            const existingProfile = userProfiles.get(cleanUsername) || {};
            userProfiles.set(cleanUsername, {
                username: cleanUsername,
                avatar: userInfo.avatar,
                lastSeen: new Date(),
                joinCount: (existingProfile.joinCount || 0) + (hadPresenceBeforeCleanup ? 0 : 1),
                totalMessages: existingProfile.totalMessages || 0,
                totalReplies: existingProfile.totalReplies || 0
            });

            // === ENVOYER L'HISTORIQUE AU NOUVEAU CLIENT ===
            // Envoyer TOUT l'historique AVANT le message de bienvenue
            socket.emit('chat_history', chatHistory);
            socket.emit('message_reactions_sync', messageReactions);
            socket.emit('user_statuses_sync', userStatuses);
            socket.emit('admin_list_update', { admins: adminUsersList });
            socket.emit('pinned_update', { pinnedMessages });
            socket.emit('channel_config_update', channelConfig);
            refreshLiveOpsState();
            socket.emit('season_event_state', getLiveOpsPayload());
            socket.emit('voice_runtime_config', {
                mode: VOICE_RUNTIME_MODE === 'sfu' ? 'sfu' : 'p2p',
                sfuEnabled: VOICE_RUNTIME_MODE === 'sfu',
                provider: VOICE_SFU_PROVIDER,
                signalingUrl: VOICE_SFU_SIGNALING_URL,
                publicWsUrl: VOICE_SFU_PUBLIC_WS
            });

            const usernameKey = normalizeUsernameKey(cleanUsername);
            const syncSnapshot = multiDeviceSyncState.get(usernameKey) || null;
            if (syncSnapshot) {
                socket.emit('sync_state_snapshot', {
                    updatedAt: syncSnapshot.updatedAt || Date.now(),
                    byDevice: syncSnapshot.byDevice || {}
                });
            }
            
            // Send new feature data
            socket.emit('xp_data', buildXPDataPayload(cleanUsername));
            emitFriendsListTo(cleanUsername);
            socket.emit('bookmarks_list', { bookmarks: userBookmarks[cleanUsername] || [] });
            socket.emit('reminders_list', { reminders: (reminders[cleanUsername] || []).filter(r => r.triggerAt > Date.now()) });
            socket.emit('seasonal_quests_state', buildSeasonalQuestsPayload(cleanUsername));
            socket.emit('social_recommendations', { recommendations: buildSocialRecommendations(cleanUsername, 6) });
            socket.emit('e2ee_key_directory', { username: cleanUsername, keys: getE2EEPublicKeys(cleanUsername) });

            if (loginBonusAwarded) {
                socket.emit('xp_daily_bonus', loginBonusAwarded);
            }
            
            // Envoyer l'état des salons vocaux
            for (const [room, data] of Object.entries(voiceRooms)) {
                socket.emit('voice_participants_update', { room, participants: getVoiceParticipants(room) });
            }
            
            logActivity('SYSTEM', `Historique envoyé à ${cleanUsername}`, {
                messagesCount: chatHistory.length,
                reactionsCount: Object.keys(messageReactions).length
            });
            
            // Message de présence uniquement à la première connexion active du compte.
            // On enregistre dans l'historique de présence (pas dans le chat).
            if (!hadPresenceBeforeCleanup) {
                addPresenceEntry(cleanUsername, 'join');
            }
            
            // Envoyer l'historique de présence au nouvel utilisateur
            socket.emit('presence_history_sync', presenceHistory);
            
            // Envoyer l'état des promotions shop
            socket.emit('shop_promotion_state', shopPromotion);
            
            // Signal que le join est complet
            socket.emit('user_join_ready', { username: cleanUsername });
            
            // Envoyer la liste des utilisateurs connectés
            updateUsersList();
            
            // Notifier les amis seulement lors d'une vraie transition offline -> online.
            if (!hadPresenceBeforeCleanup) {
                notifyFriendsOfStatusChange(cleanUsername);
            }
            
            logActivity('CONNECTION', `Utilisateur rejoint le chat`, {
                username: cleanUsername,
                socketId: socket.id,
                hasAvatar: !!avatar,
                ip: clientIp,
                totalUsers: connectedUsers.size,
                joinCount: userProfiles.get(cleanUsername).joinCount
            });
            
        } catch (error) {
            logActivity('ERROR', 'Erreur lors de la connexion utilisateur', {
                error: error.message,
                stack: error.stack,
                socketId: socket.id,
                ip: clientIp
            });
            socket.emit('error', { message: 'Erreur lors de la connexion' });
        }
    });

    // === GEMINI BOT RESPONSE ===
    socket.on('gemini_response', (data) => {
        try {
            const user = connectedUsers.get(socket.id);
            if (!user) return;
            
            const channel = data.channel || 'général';
            
            const botMessage = {
                type: 'user',
                id: messageId++,
                username: '🤖 GeminiBot',
                avatar: 'https://www.gstatic.com/lamda/images/gemini_sparkle_v002_d4735304ff6292a690345.svg',
                content: data.content,
                timestamp: new Date(),
                userId: 'gemini-bot',
                replyTo: null,
                attachment: null,
                channel: channel,
                isBot: true
            };
            
            // Sauvegarder dans l'historique du salon
            if (!channelHistories[channel]) {
                channelHistories[channel] = [];
            }
            channelHistories[channel].push(botMessage);
            
            // Limiter l'historique
            if (channelHistories[channel].length > 500) {
                channelHistories[channel] = channelHistories[channel].slice(-500);
            }
            
            // Envoyer à tous les utilisateurs du salon
            io.emit('new_message', botMessage);
            
            logActivity('GEMINI', 'Réponse GeminiBot envoyée', {
                channel: channel,
                contentLength: data.content.length,
                requestedBy: user.username
            });
            
        } catch (error) {
            logActivity('ERROR', 'Erreur GeminiBot', { error: error.message });
        }
    });

    let lastAIResponse = 0;
    async function generateAIResponse(userMessage, username, channel) {
        const now = Date.now();
        if (now - lastAIResponse < 3000) return;
        lastAIResponse = now;

        try {
            const systemPrompt = `Tu es GeminiBot, l'IA de DocSpace. Tu réponds en français de façon naturelle, vivante et conversationnelle.
Tu restes respectueux, utile, et plutôt court (max 200 mots). Tu peux utiliser quelques emojis avec modération.`;

            const response = await fetch(`${GEMINI_API_URL}?key=${GEMINI_API_KEY}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ role: 'user', parts: [{ text: `${systemPrompt}\n\nUtilisateur (${username}) : ${userMessage}` }] }],
                    generationConfig: {
                        temperature: 0.9,
                        topK: 40,
                        topP: 0.95,
                        maxOutputTokens: 512,
                    },
                    safetySettings: [
                        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
                        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
                        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
                        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' }
                    ]
                })
            });

            if (!response.ok) return;
            const data = await response.json();
            const aiText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!aiText) return;

            const botMessage = {
                type: 'user',
                id: messageId++,
                username: '🤖 GeminiBot',
                avatar: 'https://www.gstatic.com/lamda/images/gemini_sparkle_v002_d4735304ff6292a690345.svg',
                content: aiText.substring(0, 500),
                timestamp: new Date(),
                userId: 'gemini-bot',
                replyTo: null,
                attachment: null,
                channel: channel,
                isBot: true
            };

            addToChannelHistory(botMessage, channel);
            addToHistory(botMessage);
            io.emit('new_message', botMessage);
            serverStats.totalMessages++;
            saveHistory();
            saveChannelHistories();
        } catch (error) {
            logActivity('ERROR', 'Erreur auto-réponse IA', { error: error.message });
        }
    }

    // Réception d'un message
    socket.on('send_message', (messageData) => {
        try {
            const user = connectedUsers.get(socket.id);
            if (!user) {
                logActivity('ERROR', `Message reçu d'un utilisateur non connecté`, {
                    socketId: socket.id,
                    ip: clientIp
                });
                socket.emit('error', { message: 'Vous devez d\'abord vous connecter' });
                return;
            }
            
            // === VÉRIFICATION MUTE GLOBAL ===
            if (serverConfig.globalMute && !adminUsersList.includes(user.username)) {
                socket.emit('muted', { message: 'Le chat est actuellement en mode silencieux' });
                return;
            }
            
            // === VÉRIFICATION SLOW MODE ===
            if (serverConfig.slowMode > 0 && !adminUsersList.includes(user.username)) {
                const lastTime = lastMessageTime.get(socket.id) || 0;
                const now = Date.now();
                const timeSinceLastMessage = (now - lastTime) / 1000;
                
                if (timeSinceLastMessage < serverConfig.slowMode) {
                    const remainingTime = Math.ceil(serverConfig.slowMode - timeSinceLastMessage);
                    socket.emit('slow_mode_active', { remainingTime });
                    return;
                }
                
                lastMessageTime.set(socket.id, now);
            }

            // Mettre à jour la dernière activité
            user.lastActivity = new Date();
            user.messagesCount++;

            // === AUTO-MODERATION CHECK ===
            if (messageData.content) {
                const modResult = checkAutoMod(user.username, messageData.content);
                if (!modResult.allowed) {
                    socket.emit('automod_blocked', { reason: modResult.reason });
                    return;
                }
            }

            // === GESTION DES SALONS ===
            const channel = messageData.channel || 'général';
            if (!AVAILABLE_CHANNELS.includes(channel)) {
                socket.emit('error', { message: 'Salon invalide' });
                return;
            }

            const message = {
                type: messageData.type || 'user',
                id: messageId++,
                username: user.username,
                nameEffect: getActiveNameEffect(user.username),
                avatar: user.avatar,
                content: messageData.content ? messageData.content.trim().substring(0, 500) : '',
                timestamp: new Date(),
                userId: socket.id,
                replyTo: messageData.replyTo || null,
                attachment: messageData.attachment || null,
                channel: channel // Ajouter le salon au message
            };

            if (message.attachment && typeof message.attachment === 'object' && message.attachment.isVoiceClip) {
                const clipMime = String(message.attachment.mimetype || '');
                const clipSize = Number(message.attachment.size || 0);
                const clipDuration = Number(message.attachment.duration || 0);
                if (!clipMime.startsWith('audio/')) {
                    socket.emit('error', { message: 'Clip vocal invalide (format)' });
                    return;
                }
                if (!Number.isFinite(clipSize) || clipSize <= 0 || clipSize > 8 * 1024 * 1024) {
                    socket.emit('error', { message: 'Clip vocal invalide (taille max 8MB)' });
                    return;
                }
                if (!Number.isFinite(clipDuration) || clipDuration <= 0 || clipDuration > 25) {
                    socket.emit('error', { message: 'Clip vocal invalide (max 20s)' });
                    return;
                }
                message.attachment.clipLabel = String(message.attachment.clipLabel || '').substring(0, 80);
            }

            // Validation du message
            if (!message.content && !message.attachment) {
                logActivity('ERROR', `Message vide reçu`, {
                    username: user.username,
                    socketId: socket.id
                });
                socket.emit('error', { message: 'Message vide' });
                return;
            }

            // Filtrage basique du contenu
            if (message.content) {
                // Remplacer les caractères potentiellement dangereux
                message.content = message.content
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;');
            }

            // Compter les réponses
            if (message.replyTo) {
                user.repliesCount++;
                const profile = userProfiles.get(user.username);
                if (profile) {
                    profile.totalReplies = (profile.totalReplies || 0) + 1;
                    userProfiles.set(user.username, profile);
                }
                
                logActivity('REPLY', `Réponse envoyée`, {
                    username: user.username,
                    replyToUsername: message.replyTo.username,
                    content: message.content || '[Pièce jointe]',
                    userRepliesCount: user.repliesCount
                });
            } else {
                logActivity('MESSAGE', `Message envoyé`, {
                    username: user.username,
                    content: message.content || '[Pièce jointe]',
                    hasAttachment: !!message.attachment,
                    userMessagesCount: user.messagesCount
                });
            }

            // Mettre à jour les statistiques du profil
            const profile = userProfiles.get(user.username);
            if (profile) {
                profile.totalMessages = (profile.totalMessages || 0) + 1;
                profile.lastActivity = new Date();
                userProfiles.set(user.username, profile);
            }

            // Ajouter à l'historique du salon et diffuser
            addToChannelHistory(message, channel);
            addToHistory(message); // Garder aussi dans l'historique global pour rétrocompatibilité
            io.emit('new_message', message);
            serverStats.totalMessages++;
            
            // === XP SYSTEM ===
            const xpEntry = ensureXPEntry(user.username);
            xpEntry.totalMessages++;
            const xpResult = grantXP(user.username, XP_PER_MESSAGE, {
                source: 'message',
                multiplier: getLiveMessageXpMultiplier()
            });
            if (xpResult && xpResult.levelUp) {
                io.emit('system_message', {
                    type: 'system',
                    message: `🎉 ${user.username} a atteint le niveau ${xpResult.newLevel} !`,
                    timestamp: new Date(),
                    id: messageId++
                });
            }

            const missionRewards = applyMissionProgress(user.username, { messages: 1 });
            for (const reward of missionRewards) {
                socket.emit('daily_mission_reward', {
                    missionKey: reward.key,
                    missionLabel: reward.label,
                    rewardXP: reward.rewardXP,
                    rewardBananas: reward.rewardBananas || 0
                });
                if (reward.levelUp) {
                    io.emit('system_message', {
                        type: 'system',
                        message: `🎉 ${user.username} a atteint le niveau ${reward.newLevel} !`,
                        timestamp: new Date(),
                        id: messageId++
                    });
                }
            }
            socket.emit('xp_data', buildXPDataPayload(user.username));
            saveXPData();
            
            // Sauvegarder l'historique après chaque message
            saveHistory();
            saveChannelHistories();

            if (channel === 'ia' && message.content && !message.content.startsWith('🤖')) {
                setTimeout(() => {
                    generateAIResponse(message.content, user.username, channel);
                }, 500);
            }
            
            // Arrêter l'indicateur de frappe pour cet utilisateur
            if (typingUsers.has(socket.id)) {
                typingUsers.delete(socket.id);
                updateTypingIndicator();
            }
            
        } catch (error) {
            logActivity('ERROR', 'Erreur lors de l\'envoi du message', {
                error: error.message,
                stack: error.stack,
                socketId: socket.id,
                username: connectedUsers.get(socket.id)?.username || 'Inconnu'
            });
            socket.emit('error', { message: 'Erreur lors de l\'envoi du message' });
        }
    });

    // === CHANGEMENT DE SALON ===
    socket.on('switch_channel', (data) => {
        const user = connectedUsers.get(socket.id);
        if (!user) return;

        const channel = typeof data === 'string' ? data : data?.channel;
        const previousChannel = typeof data === 'string' ? user.currentChannel : data?.previousChannel;
        
        if (!AVAILABLE_CHANNELS.includes(channel)) {
            socket.emit('error', { message: 'Salon invalide' });
            return;
        }
        
        // Mettre à jour le salon actuel de l'utilisateur
        user.currentChannel = channel;
        connectedUsers.set(socket.id, user);
        
        // Envoyer l'historique du nouveau salon
        const channelHistory = channelHistories[channel] || [];
        socket.emit('channel_history', { 
            channel: channel,
            messages: channelHistory,
            reactions: messageReactions // Envoyer aussi les réactions
        });
        
        logActivity('SYSTEM', `Changement de salon`, {
            username: user.username,
            from: previousChannel,
            to: channel
        });
    });

    // Indicateur de frappe (avec salon)
    socket.on('typing_start', (data) => {
        const user = connectedUsers.get(socket.id);
        if (user) {
            const channel = data?.channel || user.currentChannel || 'général';
            typingUsers.set(socket.id, {
                username: user.username,
                channel: channel,
                timestamp: Date.now()
            });
            updateTypingIndicator();
            
            // Envoyer la mise à jour du typing par salon à tous
            io.emit('channel_typing_update', getChannelTypingUsers());
        }
    });

    socket.on('typing_stop', () => {
        const user = connectedUsers.get(socket.id);
        if (typingUsers.has(socket.id)) {
            typingUsers.delete(socket.id);
            updateTypingIndicator();
            
            // Envoyer la mise à jour du typing par salon
            io.emit('channel_typing_update', getChannelTypingUsers());
        }
    });

    // Mise à jour du profil utilisateur
    socket.on('update_profile', (profileData) => {
        try {
            const user = connectedUsers.get(socket.id);
            if (!user) return;

            // Mettre à jour l'avatar
            if (profileData.avatar && typeof profileData.avatar === 'string') {
                const oldAvatar = user.avatar;
                user.avatar = profileData.avatar;
                connectedUsers.set(socket.id, user);
                
                // Sauvegarder dans les profils
                const profile = userProfiles.get(user.username) || {};
                profile.avatar = profileData.avatar;
                profile.lastUpdate = new Date();
                userProfiles.set(user.username, profile);
                
                // Notifier tous les clients
                updateUsersList();
                
                socket.emit('profile_updated', { avatar: user.avatar });
                
                logActivity('PROFILE', `Profil mis à jour`, {
                    username: user.username,
                    oldAvatar: oldAvatar ? 'Oui' : 'Non',
                    newAvatar: 'Oui'
                });
            }
        } catch (error) {
            logActivity('ERROR', 'Erreur mise à jour profil', {
                error: error.message,
                socketId: socket.id,
                username: connectedUsers.get(socket.id)?.username || 'Inconnu'
            });
            socket.emit('error', { message: 'Erreur lors de la mise à jour du profil' });
        }
    });

    // Mise à jour de la bio
    socket.on('update_bio', (data) => {
        const user = connectedUsers.get(socket.id);
        if (!user) return;
        const bio = String(data?.bio || '').slice(0, 300).trim();
        const profile = userProfiles.get(user.username) || {};
        profile.bio = bio;
        profile.lastUpdate = new Date();
        userProfiles.set(user.username, profile);
        saveProfiles();
        socket.emit('bio_updated', { bio });
    });

    // Mise à jour couleur/gradient de profil
    socket.on('update_profile_color', (data) => {
        const user = connectedUsers.get(socket.id);
        if (!user) return;
        const xpEntry = ensureXPEntry(user.username);
        const level = getLevelFromXP(xpEntry.xp || 0).level;
        const profile = userProfiles.get(user.username) || {};
        const type = data?.type; // 'solid' or 'gradient'
        if (type === 'gradient') {
            if (level < 10) {
                socket.emit('profile_color_error', { message: 'Niveau 10 requis pour les dégradés' });
                return;
            }
            const color1 = String(data?.color1 || '#5865F2').slice(0, 7);
            const color2 = String(data?.color2 || '#9b59b6').slice(0, 7);
            if (!/^#[0-9a-fA-F]{6}$/.test(color1) || !/^#[0-9a-fA-F]{6}$/.test(color2)) {
                socket.emit('profile_color_error', { message: 'Couleur invalide' });
                return;
            }
            profile.profileGradient = `linear-gradient(135deg, ${color1}, ${color2})`;
            profile.profileColor = null;
        } else {
            const color = String(data?.color || '#5865F2').slice(0, 7);
            if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
                socket.emit('profile_color_error', { message: 'Couleur invalide' });
                return;
            }
            profile.profileColor = color;
            profile.profileGradient = null;
        }
        profile.lastUpdate = new Date();
        userProfiles.set(user.username, profile);
        saveProfiles();
        socket.emit('profile_color_updated', { profileColor: profile.profileColor, profileGradient: profile.profileGradient });
    });

    // Demande de la liste des utilisateurs
    socket.on('get_users', () => {
        const user = connectedUsers.get(socket.id);
        logActivity('SYSTEM', `Liste des utilisateurs demandée`, {
            username: user?.username || 'Inconnu',
            currentUsersCount: connectedUsers.size
        });
        updateUsersList();
    });

    // Ping pour maintenir la connexion active
    socket.on('ping', () => {
        const user = connectedUsers.get(socket.id);
        if (user) {
            user.lastActivity = new Date();
            socket.emit('pong');
            
            // Log uniquement si on veut du debug très détaillé
            // logActivity('SYSTEM', `Ping reçu de ${user.username}`);
        }
    });

    socket.on('sync_state_request', () => {
        const user = connectedUsers.get(socket.id);
        if (!user) return;
        const key = normalizeUsernameKey(user.username);
        const snapshot = multiDeviceSyncState.get(key);
        socket.emit('sync_state_snapshot', {
            updatedAt: snapshot?.updatedAt || Date.now(),
            byDevice: snapshot?.byDevice || {}
        });
    });

    socket.on('sync_state_update', (data) => {
        const user = connectedUsers.get(socket.id);
        if (!user) return;

        const key = normalizeUsernameKey(user.username);
        const safeDeviceId = String(data?.deviceId || user.deviceId || '').trim().substring(0, 80) || `device_${socket.id.substring(0, 8)}`;
        const patch = data?.patch && typeof data.patch === 'object' ? data.patch : {};

        const allowedPatch = {
            activeChannel: typeof patch.activeChannel === 'string' ? patch.activeChannel.substring(0, 64) : undefined,
            voiceRoom: typeof patch.voiceRoom === 'string' ? patch.voiceRoom.substring(0, 64) : (patch.voiceRoom === null ? null : undefined),
            draft: typeof patch.draft === 'string' ? patch.draft.substring(0, 800) : undefined,
            focus: typeof patch.focus === 'string' ? patch.focus.substring(0, 32) : undefined
        };

        const current = multiDeviceSyncState.get(key) || { updatedAt: Date.now(), byDevice: {} };
        const previousDeviceState = current.byDevice[safeDeviceId] || {};
        const nextDeviceState = {
            ...previousDeviceState,
            ...Object.fromEntries(Object.entries(allowedPatch).filter(([, value]) => value !== undefined)),
            updatedAt: Date.now()
        };
        current.byDevice[safeDeviceId] = nextDeviceState;
        current.updatedAt = Date.now();
        multiDeviceSyncState.set(key, current);

        const sockets = getSocketsForUsername(user.username);
        sockets.forEach((targetSocketId) => {
            if (targetSocketId === socket.id) return;
            io.to(targetSocketId).emit('sync_state_remote_update', {
                fromSocketId: socket.id,
                fromDeviceId: safeDeviceId,
                patch: nextDeviceState,
                updatedAt: current.updatedAt
            });
        });
    });

    socket.on('get_seasonal_quests', () => {
        const user = connectedUsers.get(socket.id);
        if (!user) return;
        socket.emit('seasonal_quests_state', buildSeasonalQuestsPayload(user.username));
    });

    socket.on('get_social_recommendations', (data) => {
        const user = connectedUsers.get(socket.id);
        if (!user) return;
        const limit = Math.max(1, Math.min(10, Number(data?.limit) || 6));
        socket.emit('social_recommendations', {
            recommendations: buildSocialRecommendations(user.username, limit)
        });
    });

    // E2EE alpha: le serveur ne voit que des blobs chiffrés et relaie les envelopes.
    socket.on('e2ee_key_publish', (data) => {
        const user = connectedUsers.get(socket.id);
        if (!user) return;

        const safeDeviceId = String(data?.deviceId || user.deviceId || '').trim().substring(0, 80) || `device_${socket.id.substring(0, 8)}`;
        upsertE2EEPublicKey(user.username, safeDeviceId, {
            fingerprint: data?.fingerprint,
            publicKey: data?.publicKey,
            algorithm: data?.algorithm
        });

        socket.emit('e2ee_key_directory', {
            username: user.username,
            keys: getE2EEPublicKeys(user.username)
        });
    });

    socket.on('get_e2ee_keys', (data) => {
        const requester = connectedUsers.get(socket.id);
        if (!requester) return;
        const wantedUsername = String(data?.username || requester.username).trim().substring(0, 40);
        if (!wantedUsername) return;

        socket.emit('e2ee_key_directory', {
            username: wantedUsername,
            keys: getE2EEPublicKeys(wantedUsername)
        });
    });

    socket.on('e2ee_message', (data) => {
        const user = connectedUsers.get(socket.id);
        if (!user) return;

        const targetUsername = String(data?.targetUsername || '').trim().substring(0, 40);
        const room = String(data?.room || '').trim().substring(0, 64);
        const envelope = {
            fromUsername: user.username,
            fromDeviceId: user.deviceId || null,
            targetUsername: targetUsername || null,
            room: room || null,
            algorithm: String(data?.algorithm || 'xchacha20poly1305').trim().substring(0, 64),
            ciphertext: String(data?.ciphertext || '').substring(0, 12000),
            nonce: String(data?.nonce || '').substring(0, 300),
            keyId: String(data?.keyId || '').substring(0, 200),
            metadata: data?.metadata && typeof data.metadata === 'object' ? data.metadata : {},
            sentAt: Date.now()
        };

        if (!envelope.ciphertext) return;

        if (targetUsername) {
            getSocketsForUsername(targetUsername).forEach((targetSocketId) => {
                io.to(targetSocketId).emit('e2ee_message', envelope);
            });
            return;
        }

        if (room && voiceRooms[room]) {
            socket.to('voice_' + room).emit('e2ee_message', envelope);
        }
    });

    socket.on('e2ee_file_manifest', (data) => {
        const user = connectedUsers.get(socket.id);
        if (!user) return;

        const targetUsername = String(data?.targetUsername || '').trim().substring(0, 40);
        if (!targetUsername) return;

        const manifest = {
            fromUsername: user.username,
            fromDeviceId: user.deviceId || null,
            targetUsername,
            fileName: String(data?.fileName || 'encrypted.bin').substring(0, 180),
            cipherBlobPath: String(data?.cipherBlobPath || '').substring(0, 500),
            cipherBlobSha256: String(data?.cipherBlobSha256 || '').substring(0, 128),
            wrappedKey: String(data?.wrappedKey || '').substring(0, 10000),
            nonce: String(data?.nonce || '').substring(0, 300),
            algorithm: String(data?.algorithm || 'xchacha20poly1305').substring(0, 64),
            sentAt: Date.now()
        };

        if (!manifest.cipherBlobPath || !manifest.wrappedKey) return;

        getSocketsForUsername(targetUsername).forEach((targetSocketId) => {
            io.to(targetSocketId).emit('e2ee_file_manifest', manifest);
        });
    });

    socket.on('voice_sfu_signal', (data) => {
        const user = connectedUsers.get(socket.id);
        if (!user) return;
        observability.voice.sfuSignals += 1;

        const targetId = data?.targetId;
        const room = data?.room;
        const payload = {
            fromId: socket.id,
            fromUsername: user.username,
            type: data?.type || 'signal',
            data: data?.data || null,
            room: room || null
        };

        if (targetId) {
            io.to(targetId).emit('voice_sfu_signal', payload);
            return;
        }

        if (room && voiceRooms[room]) {
            socket.to('voice_' + room).emit('voice_sfu_signal', payload);
        }
    });

    socket.on('voice_reconnect_intent', () => {
        observability.voice.reconnectIntents += 1;
    });

    // === VOCAL WebRTC ===
    
    // Rejoindre un salon vocal
    socket.on('voice_join', (data) => {
        const user = connectedUsers.get(socket.id);
        if (!user) return;
        const room = data.room;
        if (!voiceRooms[room]) return;
        
        // Quitter l'ancien salon vocal si nécessaire
        for (const [rName, rData] of Object.entries(voiceRooms)) {
            if (rData.participants.has(socket.id)) {
                rData.participants.delete(socket.id);
                socket.leave('voice_' + rName);
                io.emit('voice_participants_update', { room: rName, participants: getVoiceParticipants(rName) });
            }
        }
        
        // Rejoindre le nouveau salon
        voiceRooms[room].participants.set(socket.id, {
            username: user.username,
            muted: false,
            deafened: false,
            video: false,
            screen: false,
            speaking: false
        });
        socket.join('voice_' + room);
        
        // Notifier les autres participants pour qu'ils créent des connexions WebRTC
        const otherParticipants = [];
        voiceRooms[room].participants.forEach((pData, pId) => {
            if (pId !== socket.id) {
                otherParticipants.push({ socketId: pId, username: pData.username, video: !!pData.video, screen: !!pData.screen });
            }
        });
        
        // Envoyer la liste des participants existants au nouvel arrivant
        socket.emit('voice_joined', { room, participants: otherParticipants });
        
        // Notifier tous les clients de la mise à jour des participants
        io.emit('voice_participants_update', { room, participants: getVoiceParticipants(room) });
        
        logActivity('VOICE', `${user.username} a rejoint ${room}`, { room });
    });
    
    // Quitter le salon vocal
    socket.on('voice_leave', () => {
        const user = connectedUsers.get(socket.id);
        for (const [rName, rData] of Object.entries(voiceRooms)) {
            if (rData.participants.has(socket.id)) {
                rData.participants.delete(socket.id);
                socket.leave('voice_' + rName);
                io.emit('voice_participants_update', { room: rName, participants: getVoiceParticipants(rName) });
                socket.to('voice_' + rName).emit('voice_peer_left', { socketId: socket.id });
                if (user) logActivity('VOICE', `${user.username} a quitté ${rName}`, { room: rName });
            }
        }
    });
    
    // Signaling WebRTC - Offer
    socket.on('voice_offer', (data) => {
        const { targetId, offer } = data;
        const user = connectedUsers.get(socket.id);
        if (!user) return;
        observability.voice.offers += 1;
        io.to(targetId).emit('voice_offer', { fromId: socket.id, fromUsername: user.username, offer });
    });
    
    // Signaling WebRTC - Answer
    socket.on('voice_answer', (data) => {
        const { targetId, answer } = data;
        observability.voice.answers += 1;
        io.to(targetId).emit('voice_answer', { fromId: socket.id, answer });
    });
    
    // Signaling WebRTC - ICE Candidate
    socket.on('voice_ice_candidate', (data) => {
        const { targetId, candidate } = data;
        observability.voice.iceCandidates += 1;
        io.to(targetId).emit('voice_ice_candidate', { fromId: socket.id, candidate });
    });

    // Sonde de latence (ping UI côté client)
    socket.on('voice_ping_probe', (data, ack) => {
        if (typeof ack === 'function') {
            ack({
                serverTime: Date.now(),
                clientSentAt: data && data.sentAt ? data.sentAt : null
            });
        }
    });
    
    // Détection de parole
    socket.on('voice_speaking', (data) => {
        for (const [rName, rData] of Object.entries(voiceRooms)) {
            const participant = rData.participants.get(socket.id);
            if (participant) {
                const speaking = !!data.speaking;
                const now = Date.now();
                const previous = !!participant.speaking;
                const lastEmit = Number(participant.speakingUpdatedAt || 0);
                if (previous !== speaking || now - lastEmit >= VOICE_SPEAKING_EVENT_THROTTLE_MS) {
                    participant.speaking = speaking;
                    participant.speakingUpdatedAt = now;
                    io.emit('voice_speaking_update', {
                        room: rName,
                        socketId: socket.id,
                        speaking
                    });
                }
                break;
            }
        }
    });

    // Mise à jour du statut vocal (mute, deafen, video, screen)
    socket.on('voice_status_update', (data) => {
        for (const [rName, rData] of Object.entries(voiceRooms)) {
            const participant = rData.participants.get(socket.id);
            if (participant) {
                if (data.muted !== undefined) participant.muted = data.muted;
                if (data.deafened !== undefined) participant.deafened = data.deafened;
                if (data.video !== undefined) participant.video = data.video;
                if (data.screen !== undefined) participant.screen = data.screen;
                io.emit('voice_participants_update', { room: rName, participants: getVoiceParticipants(rName) });
                break;
            }
        }
    });

    // Déconnexion
    socket.on('disconnect', (reason) => {
        // Clear auto-clicker interval if active
        if (socket._autoClickerInterval) {
            clearInterval(socket._autoClickerInterval);
            socket._autoClickerInterval = null;
        }
        const user = connectedUsers.get(socket.id);
        if (user) {
            const sessionDuration = Date.now() - user.joinTime.getTime();
            
            // Retirer des salons vocaux
            for (const [rName, rData] of Object.entries(voiceRooms)) {
                if (rData.participants.has(socket.id)) {
                    rData.participants.delete(socket.id);
                    io.emit('voice_participants_update', { room: rName, participants: getVoiceParticipants(rName) });
                    io.to('voice_' + rName).emit('voice_peer_left', { socketId: socket.id });
                }
            }
            
            // Mettre à jour le profil avec la dernière connexion
            const profile = userProfiles.get(user.username);
            if (profile) {
                profile.lastSeen = new Date();
                profile.totalTime = (profile.totalTime || 0) + sessionDuration;
                profile.lastSessionMessages = user.messagesCount;
                profile.lastSessionReplies = user.repliesCount;
                userProfiles.set(user.username, profile);
            }
            
            // Retirer l'utilisateur de la liste de frappe
            if (typingUsers.has(socket.id)) {
                typingUsers.delete(socket.id);
                updateTypingIndicator();
            }
            
            // Nettoyer les invitations de jeu en attente
            if (global.gameInvites) {
                for (const [inviteId, invite] of global.gameInvites) {
                    if (invite.from === user.username) {
                        // L'inviteur se déconnecte → notifier le destinataire
                        const toSocket = findCurrentSocket(invite.to);
                        if (toSocket) {
                            io.to(toSocket).emit('game_invite_cancelled', { inviteId, from: invite.from });
                        }
                        global.gameInvites.delete(inviteId);
                    } else if (invite.to === user.username) {
                        // Le destinataire se déconnecte → notifier l'inviteur
                        const fromSocket = findCurrentSocket(invite.from);
                        if (fromSocket) {
                            io.to(fromSocket).emit('game_declined', { by: user.username, gameType: invite.gameType });
                        }
                        global.gameInvites.delete(inviteId);
                    }
                }
            }
            
            // Nettoyer les parties actives
            if (global.activeGames) {
                for (const [gameId, game] of global.activeGames) {
                    const playerInGame = game.players.find(p => p.username === user.username);
                    if (playerInGame) {
                        game.players.forEach(p => {
                            if (p.username !== user.username) {
                                const opponentSocket = findCurrentSocket(p.username);
                                if (opponentSocket) {
                                    io.to(opponentSocket).emit('game_opponent_quit', {
                                        gameId: gameId,
                                        quitter: user.username
                                    });
                                }
                            }
                        });
                        global.activeGames.delete(gameId);
                    }
                }
            }
            
            // Retirer l'utilisateur
            connectedUsers.delete(socket.id);
            authenticatedSockets.delete(socket.id);
            unregisterUserSocket(user.username, socket.id);
            removeE2EEPublicKey(user.username, user.deviceId);

            const remainingForUser = getSocketsForUsername(user.username).length;
            const isLastConnectionForUser = remainingForUser === 0;

            // Retirer de la liste admin uniquement si c'est la dernière connexion active.
            if (isLastConnectionForUser) {
                const adminIndex = adminUsersList.indexOf(user.username);
                if (adminIndex > -1) {
                    adminUsersList.splice(adminIndex, 1);
                    io.emit('admin_list_update', { admins: adminUsersList });
                }
            }

            emitMultiDevicePresence(user.username);
            observability.sockets.currentAuthenticatedUsers = connectedUsers.size;
            observability.sockets.currentTransportConnections = io.engine.clientsCount;
            observability.sockets.disconnections += 1;
            updateUsersList();

            if (isLastConnectionForUser) {
                addPresenceEntry(user.username, 'leave');

                // Notifier les amis uniquement lors d'une vraie transition online -> offline.
                notifyFriendsOfStatusChange(user.username);
            }
            
            logActivity('DISCONNECTION', `Utilisateur déconnecté`, {
                username: user.username,
                reason: reason,
                sessionDuration: `${Math.floor(sessionDuration / 1000)}s`,
                messagesInSession: user.messagesCount,
                repliesInSession: user.repliesCount,
                remainingUsers: connectedUsers.size,
                remainingSocketsForUser: remainingForUser
            });
        } else {
            observability.sockets.currentTransportConnections = io.engine.clientsCount;
            observability.sockets.disconnections += 1;
            logActivity('DISCONNECTION', `Socket déconnecté sans utilisateur associé`, {
                socketId: socket.id,
                reason: reason
            });
        }
    });

    // Gestion des erreurs de socket
    socket.on('error', (error) => {
        const user = connectedUsers.get(socket.id);
        logActivity('ERROR', `Erreur socket`, {
            socketId: socket.id,
            username: user?.username || 'Inconnu',
            error: error.message,
            ip: clientIp
        });
    });
    
    // === HANDLERS SONDAGES ===
    socket.on('create_poll', (data) => {
        const user = connectedUsers.get(socket.id);
        if (!user) return;
        
        const pollId = 'poll_' + pollIdCounter++;
        const poll = {
            id: pollId,
            question: data.question,
            options: data.options.map(text => ({ text, votes: 0 })),
            channel: data.channel || 'général',
            creator: user.username,
            createdAt: new Date()
        };
        
        polls[pollId] = poll;
        pollVotes[pollId] = {};
        
        // Émettre à tous les utilisateurs du même salon
        io.emit('poll_created', poll);
        
        logActivity('POLL', `Sondage créé`, {
            pollId,
            question: data.question,
            creator: user.username,
            channel: poll.channel
        });
    });
    
    socket.on('vote_poll', (data) => {
        const user = connectedUsers.get(socket.id);
        if (!user) return;
        
        const { pollId, optionIndex } = data;
        const poll = polls[pollId];
        if (!poll) {
            socket.emit('vote_response', { success: false, message: 'Sondage introuvable' });
            return;
        }
        
        // Vérifier si l'utilisateur a déjà voté
        if (pollVotes[pollId] && pollVotes[pollId][user.username] !== undefined) {
            socket.emit('vote_response', { success: false, message: 'Vous avez déjà voté' });
            return;
        }
        
        // Enregistrer le vote
        if (!pollVotes[pollId]) pollVotes[pollId] = {};
        pollVotes[pollId][user.username] = optionIndex;
        poll.options[optionIndex].votes++;
        
        socket.emit('vote_response', { success: true, pollId, optionIndex });
        io.emit('poll_update', poll);
        
        logActivity('POLL', `Vote enregistré`, {
            pollId,
            username: user.username,
            optionIndex
        });
    });
    
    // === HANDLER PROFIL UTILISATEUR ===
    socket.on('get_user_profile', (data) => {
        const targetUsername = data.username;
        
        // Chercher l'utilisateur en ligne
        let targetUser = null;
        let isOnline = false;
        connectedUsers.forEach((u, sid) => {
            if (u.username === targetUsername) {
                targetUser = u;
                isOnline = true;
            }
        });
        
        // Récupérer le profil sauvegardé
        const savedProfile = userProfiles.get(targetUsername) || {};
        
        // Déterminer le statut
        let status = 'offline';
        if (isOnline) {
            status = userStatuses[targetUsername]?.status || 'online';
        }
        
        const xpEntry = userXP[targetUsername] || {};
        const levelData = getLevelFromXP(xpEntry.xp || 0);
        const role = getRoleForLevel(levelData.level);
        const profile = {
            username: targetUsername,
            status: status,
            bio: savedProfile.bio || '',
            joinDate: savedProfile.firstJoin || savedProfile.joinedAt,
            messageCount: savedProfile.totalMessages || 0,
            avatar: savedProfile.avatar || (targetUser?.avatar),
            level: levelData.level,
            xp: xpEntry.xp || 0,
            role: role,
            profileColor: savedProfile.profileColor || null,
            profileGradient: savedProfile.profileGradient || null
        };
        
        socket.emit('user_profile', profile);
    });
    
    // === HANDLERS MESSAGES PRIVÉS (DM) ===
    socket.on('send_dm', (data) => {
        const sender = connectedUsers.get(socket.id);
        if (!sender) return;
        
        const { to, content, attachment } = data;
        if (!to || (!content && !attachment)) return;
        
        // Créer la clé de conversation (triée pour unicité)
        const key = [sender.username, to].sort().join(':');
        
        // Initialiser l'historique si nécessaire
        if (!dmHistory[key]) {
            dmHistory[key] = [];
        }
        
        const message = {
            from: sender.username,
            to: to,
            content: content || '',
            attachment: attachment || null,
            timestamp: new Date()
        };
        
        dmHistory[key].push(message);
        
        // Limiter l'historique DM
        if (dmHistory[key].length > 100) {
            dmHistory[key] = dmHistory[key].slice(-100);
        }
        
        // Trouver le destinataire s'il est connecté
        let recipientSocket = null;
        connectedUsers.forEach((u, sid) => {
            if (u.username === to) {
                recipientSocket = sid;
            }
        });
        
        // Envoyer au destinataire
        if (recipientSocket) {
            io.to(recipientSocket).emit('dm_received', {
                from: sender.username,
                content: content || '',
                attachment: attachment || null,
                timestamp: message.timestamp,
                avatar: sender.avatar
            });
        }
        
        // Sauvegarder les DMs
        saveDMs();
        
        logActivity('DM', `Message privé envoyé`, {
            from: sender.username,
            to: to
        });
    });

    // === INDICATEUR DE FRAPPE DM ===
    socket.on('dm_typing_start', (data) => {
        const sender = connectedUsers.get(socket.id);
        if (!sender) return;
        const { to } = data || {};
        if (!to) return;

        let recipientSocket = null;
        connectedUsers.forEach((u, sid) => {
            if (u.username === to) {
                recipientSocket = sid;
            }
        });

        if (recipientSocket) {
            io.to(recipientSocket).emit('dm_typing', { from: sender.username, isTyping: true });
        }
    });

    socket.on('dm_typing_stop', (data) => {
        const sender = connectedUsers.get(socket.id);
        if (!sender) return;
        const { to } = data || {};
        if (!to) return;

        let recipientSocket = null;
        connectedUsers.forEach((u, sid) => {
            if (u.username === to) {
                recipientSocket = sid;
            }
        });

        if (recipientSocket) {
            io.to(recipientSocket).emit('dm_typing', { from: sender.username, isTyping: false });
        }
    });
    
    // Récupérer la liste des conversations DM de l'utilisateur
    socket.on('get_dm_conversations', () => {
        const user = connectedUsers.get(socket.id);
        if (!user) return;
        
        const conversations = [];
        Object.keys(dmHistory).forEach(key => {
            const users = key.split(':');
            if (users.includes(user.username)) {
                const otherUser = users[0] === user.username ? users[1] : users[0];
                const messages = dmHistory[key];
                const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
                
                conversations.push({
                    username: otherUser,
                    lastMessage: lastMessage ? lastMessage.content.substring(0, 50) : '',
                    lastTimestamp: lastMessage ? lastMessage.timestamp : null,
                    unread: 0 // Pour l'instant pas de système de non-lu
                });
            }
        });
        
        // Trier par date du dernier message
        conversations.sort((a, b) => {
            if (!a.lastTimestamp) return 1;
            if (!b.lastTimestamp) return -1;
            return new Date(b.lastTimestamp) - new Date(a.lastTimestamp);
        });
        
        socket.emit('dm_conversations', conversations);
    });
    
    socket.on('get_dm_history', (data) => {
        const user = connectedUsers.get(socket.id);
        if (!user) return;
        
        const { username } = data;
        const key = [user.username, username].sort().join(':');
        const history = dmHistory[key] || [];
        
        socket.emit('dm_history', {
            username: username,
            messages: history
        });
    });

    // === HANDLERS MINI-JEUX MULTIJOUEURS ===
    
    // Stocker les parties en cours
    if (!global.activeGames) global.activeGames = new Map();
    if (!global.gameInvites) global.gameInvites = new Map();
    
    // Helper: trouver le socket actuel d'un utilisateur par son username
    function findCurrentSocket(username) {
        let sid = null;
        connectedUsers.forEach((u, socketId) => {
            if (u.username === username) sid = socketId;
        });
        return sid;
    }
    
    // Envoyer une invitation de jeu
    socket.on('game_invite', (data) => {
        const sender = connectedUsers.get(socket.id);
        if (!sender) return;
        
        const { to, gameType } = data;
        
        // Trouver le destinataire
        const recipientSocket = findCurrentSocket(to);
        
        if (recipientSocket) {
            const inviteId = `${sender.username}-${to}-${Date.now()}`;
            global.gameInvites.set(inviteId, {
                from: sender.username,
                to: to,
                gameType: gameType,
                timestamp: Date.now()
            });
            
            io.to(recipientSocket).emit('game_invite_received', {
                inviteId: inviteId,
                from: sender.username,
                gameType: gameType
            });
            
            socket.emit('game_invite_sent', { to, gameType });
            
            logActivity('GAME', `Invitation de jeu envoyée`, {
                from: sender.username,
                to: to,
                game: gameType
            });
        }
    });
    
    // Accepter une invitation
    socket.on('game_accept', (data) => {
        const { inviteId } = data;
        const invite = global.gameInvites.get(inviteId);
        
        if (!invite) return;
        
        // Résoudre les sockets ACTUELS par username (pas les anciens stockés)
        const fromSocket = findCurrentSocket(invite.from);
        const toSocket = socket.id; // L'accepteur est le socket actuel
        
        if (!fromSocket) {
            // L'inviteur n'est plus connecté
            socket.emit('game_invite_error', { message: `${invite.from} n'est plus connecté` });
            global.gameInvites.delete(inviteId);
            return;
        }
        
        const gameId = `game-${Date.now()}`;
        const game = {
            id: gameId,
            type: invite.gameType,
            players: [
                { username: invite.from, socket: fromSocket },
                { username: invite.to, socket: toSocket }
            ],
            state: initGameState(invite.gameType),
            currentTurn: 0,
            started: Date.now()
        };
        
        global.activeGames.set(gameId, game);
        global.gameInvites.delete(inviteId);
        
        // Préparer les données initiales selon le type de jeu
        let initialData = {};
        if (invite.gameType === 'quiz' || invite.gameType === 'trivia') {
            const q = game.state.questions[0];
            initialData = {
                question: invite.gameType === 'quiz' ? { q: q.q, a: q.a } : { q: q.q, a: q.a },
                current: 1,
                total: game.state.total
            };
        } else if (invite.gameType === 'rps') {
            initialData = { round: 1, maxRounds: game.state.maxRounds, scores: [0, 0] };
        } else if (invite.gameType === 'hangman') {
            const display = game.state.word.split('').map(() => '_').join(' ');
            const hintState = getHangmanHintState(game.state);
            initialData = {
                display,
                wrong: [],
                remaining: game.state.maxErrors,
                maxErrors: game.state.maxErrors,
                wordLength: game.state.word.length,
                hintVisible: hintState.visible,
                hintText: hintState.text
            };
        } else if (invite.gameType === 'arena2d') {
            initialData = {
                arenaState: game.state,
                targetScore: game.state.targetScore
            };
        }
        
        // Notifier les deux joueurs avec les sockets actuels
        io.to(fromSocket).emit('game_start', {
            gameId: gameId,
            gameType: invite.gameType,
            opponent: invite.to,
            yourTurn: true,
            playerIndex: 0,
            initialData
        });
        
        io.to(toSocket).emit('game_start', {
            gameId: gameId,
            gameType: invite.gameType,
            opponent: invite.from,
            yourTurn: false,
            playerIndex: 1,
            initialData
        });
        
        logActivity('GAME', `Partie commencée`, {
            game: invite.gameType,
            players: [invite.from, invite.to]
        });
    });
    
    // Refuser une invitation
    socket.on('game_decline', (data) => {
        const { inviteId } = data;
        const invite = global.gameInvites.get(inviteId);
        
        if (!invite) return;
        
        // Résoudre le socket actuel de l'inviteur
        const fromSocket = findCurrentSocket(invite.from);
        if (fromSocket) {
            io.to(fromSocket).emit('game_declined', {
                by: invite.to,
                gameType: invite.gameType
            });
        }
        
        global.gameInvites.delete(inviteId);
    });
    
    // Jouer un coup
    socket.on('game_move', (data) => {
        const { gameId, move } = data;
        const game = global.activeGames.get(gameId);
        
        if (!game) return;
        
        const user = connectedUsers.get(socket.id);
        if (!user) return;
        
        // Vérifier que le joueur fait partie de la partie
        const playerIndex = game.players.findIndex(p => p.username === user.username);
        if (playerIndex === -1) return;
        
        // Pour les jeux tour par tour (tictactoe, connect4, hangman), vérifier le tour
        const turnBasedGames = ['tictactoe', 'connect4', 'hangman'];
        if (turnBasedGames.includes(game.type) && playerIndex !== game.currentTurn) return;
        
        // Appliquer le coup selon le type de jeu
        const result = applyGameMove(game, move, playerIndex);
        
        if (result.valid) {
            game.state = result.state;
            if (result.nextTurn !== undefined) game.currentTurn = result.nextTurn;
            
            // Les jeux avec customEmit gèrent leur propre émission
            if (!result.customEmit) {
                game.players.forEach((p, idx) => {
                    const currentSid = findCurrentSocket(p.username);
                    if (currentSid) {
                        io.to(currentSid).emit('game_update', {
                            gameId: gameId,
                            state: game.state,
                            yourTurn: idx === game.currentTurn,
                            lastMove: move,
                            lastMoveBy: user.username,
                            winner: result.winner,
                            draw: result.draw,
                            hangmanState: result.hangmanState || null
                        });
                    }
                });
            }
            
            // Fin de partie
            if ((result.winner || result.draw) && !result.waiting) {
                const playerNames = game.players.map(p => p.username);
                const rewardsByUser = {};

                if (result.draw) {
                    playerNames.forEach((name) => {
                        rewardsByUser[name] = recordMiniGameResult(name, game.type, 'draw');
                    });
                } else if (result.winner === 'COOP_WIN') {
                    playerNames.forEach((name) => {
                        rewardsByUser[name] = recordMiniGameResult(name, game.type, 'win');
                    });
                } else if (result.winner === 'COOP_LOSE') {
                    playerNames.forEach((name) => {
                        rewardsByUser[name] = recordMiniGameResult(name, game.type, 'loss');
                    });
                } else {
                    playerNames.forEach((name) => {
                        const outcome = name === result.winner ? 'win' : 'loss';
                        rewardsByUser[name] = recordMiniGameResult(name, game.type, outcome);
                    });
                }

                game.players.forEach((p) => {
                    const currentSid = findCurrentSocket(p.username);
                    if (!currentSid) return;
                    const outcome = result.draw
                        ? 'draw'
                        : (result.winner === 'COOP_WIN' ? 'win' : (result.winner === 'COOP_LOSE' ? 'loss' : (p.username === result.winner ? 'win' : 'loss')));
                    const reward = rewardsByUser[p.username];
                    if (reward) {
                        io.to(currentSid).emit('minigame_reward', {
                            gameType: game.type,
                            outcome,
                            points: reward.points,
                            xp: reward.xp,
                            bananas: reward.bananas || 0,
                            totalMiniGamePoints: reward.totals.points
                        });
                        emitMissionRewardsToSocket(io.to(currentSid), p.username, reward.missionRewards || []);
                    }
                    io.to(currentSid).emit('xp_data', buildXPDataPayload(p.username));
                });

                global.activeGames.delete(gameId);
                logActivity('GAME', `Partie terminée`, {
                    game: game.type,
                    winner: result.winner || 'Égalité'
                });
            }
        }
    });
    
    // Quitter une partie
    socket.on('game_quit', (data) => {
        const { gameId } = data;
        const game = global.activeGames.get(gameId);
        
        if (!game) return;
        
        const user = connectedUsers.get(socket.id);
        if (!user) return;
        
        // Notifier l'adversaire (résoudre socket actuel)
        game.players.forEach(p => {
            if (p.username !== user.username) {
                const opponentSocket = findCurrentSocket(p.username);
                if (opponentSocket) {
                    io.to(opponentSocket).emit('game_opponent_quit', {
                        gameId: gameId,
                        quitter: user.username
                    });
                }
            }
        });
        
        global.activeGames.delete(gameId);
    });

    // =========================================
    // === ACCOUNT SYSTEM ===
    // =========================================
    socket.on('register_account', (data) => {
        const { username, password } = data;
        if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
            socket.emit('account_error', { message: 'Données invalides' });
            return;
        }
        const cleanName = username.trim().substring(0, 20);
        const key = cleanName.toLowerCase();
        if (password.length < 4) {
            socket.emit('account_error', { message: 'Mot de passe trop court (min 4 caractères)' });
            return;
        }
        if (accounts[key]) {
            socket.emit('account_error', { message: 'Ce pseudo est déjà enregistré. Connectez-vous.' });
            return;
        }
        const salt = crypto.randomBytes(16).toString('hex');
        accounts[key] = {
            username: cleanName,
            passwordHash: hashPassword(password, salt),
            salt,
            createdAt: new Date().toISOString(),
            lastLogin: new Date().toISOString()
        };
        saveAccounts();
        authenticatedSockets.add(socket.id);
        socket.emit('account_registered', { username: cleanName });
    });

    socket.on('login_account', (data) => {
        const { username, password } = data;
        if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
            socket.emit('account_error', { message: 'Données invalides' });
            return;
        }
        const key = username.trim().toLowerCase();
        const account = accounts[key];
        if (!account) {
            socket.emit('account_error', { message: 'Compte inexistant. Créez un compte.' });
            return;
        }
        const hash = hashPassword(password, account.salt);
        if (hash !== account.passwordHash) {
            socket.emit('account_error', { message: 'Mot de passe incorrect' });
            return;
        }
        account.lastLogin = new Date().toISOString();
        saveAccounts();
        authenticatedSockets.add(socket.id);
        socket.emit('account_logged_in', { username: account.username });
    });

    socket.on('check_account', (data) => {
        const { username } = data;
        if (!username) return;
        const key = username.trim().toLowerCase();
        socket.emit('account_check_result', { exists: !!accounts[key] });
    });

    // =========================================
    // === BOOKMARK SYSTEM ===
    // =========================================
    socket.on('bookmark_message', (data) => {
        const user = connectedUsers.get(socket.id);
        if (!user) return;
        const { messageId, content, author, channel, timestamp } = data;
        if (!userBookmarks[user.username]) userBookmarks[user.username] = [];
        // Check if already bookmarked
        if (userBookmarks[user.username].some(b => b.messageId === messageId)) {
            socket.emit('bookmark_error', { message: 'Message déjà sauvegardé' });
            return;
        }
        userBookmarks[user.username].push({ messageId, content: (content || '').substring(0, 500), author, channel, timestamp, savedAt: new Date().toISOString() });
        saveBookmarks();
        socket.emit('bookmark_added', { messageId });
    });

    socket.on('remove_bookmark', (data) => {
        const user = connectedUsers.get(socket.id);
        if (!user) return;
        if (!userBookmarks[user.username]) return;
        userBookmarks[user.username] = userBookmarks[user.username].filter(b => b.messageId !== data.messageId);
        saveBookmarks();
        socket.emit('bookmark_removed', { messageId: data.messageId });
    });

    socket.on('get_bookmarks', () => {
        const user = connectedUsers.get(socket.id);
        if (!user) return;
        socket.emit('bookmarks_list', { bookmarks: userBookmarks[user.username] || [] });
    });

    // =========================================
    // === FRIEND SYSTEM ===
    // =========================================
    socket.on('send_friend_request', (data) => {
        const user = connectedUsers.get(socket.id);
        if (!user) return;
        const target = data.username;
        if (target === user.username) return;
        
        if (!friendships[user.username]) friendships[user.username] = { friends: [], pending: [], requests: [] };
        if (!friendships[target]) friendships[target] = { friends: [], pending: [], requests: [] };
        
        // Already friends?
        if (friendships[user.username].friends.includes(target)) {
            socket.emit('friend_error', { message: 'Déjà amis !' });
            return;
        }
        // Already pending?
        if (friendships[user.username].pending.includes(target)) {
            socket.emit('friend_error', { message: 'Demande déjà envoyée' });
            return;
        }
        
        friendships[user.username].pending.push(target);
        friendships[target].requests.push(user.username);
        saveFriendships();
        
        socket.emit('friend_request_sent', { username: target });
        // Notify target if online
        for (const [sid, u] of connectedUsers.entries()) {
            if (u.username === target) {
                io.to(sid).emit('friend_request_received', { from: user.username, avatar: user.avatar });
                break;
            }
        }
    });

    socket.on('accept_friend', (data) => {
        const user = connectedUsers.get(socket.id);
        if (!user) return;
        const from = data.username;
        if (!friendships[user.username] || !friendships[from]) return;
        
        // Remove from requests/pending
        friendships[user.username].requests = friendships[user.username].requests.filter(u => u !== from);
        friendships[from].pending = friendships[from].pending.filter(u => u !== user.username);
        
        // Add to friends
        if (!friendships[user.username].friends.includes(from)) friendships[user.username].friends.push(from);
        if (!friendships[from].friends.includes(user.username)) friendships[from].friends.push(user.username);
        
        saveFriendships();
        socket.emit('friend_accepted', { username: from });
        // Envoyer listes mises à jour aux deux
        emitFriendsListTo(user.username);
        emitFriendsListTo(from);
        for (const [sid, u] of connectedUsers.entries()) {
            if (u.username === from) {
                io.to(sid).emit('friend_accepted', { username: user.username });
                break;
            }
        }
    });

    socket.on('reject_friend', (data) => {
        const user = connectedUsers.get(socket.id);
        if (!user) return;
        const from = data.username;
        if (!friendships[user.username] || !friendships[from]) return;
        friendships[user.username].requests = friendships[user.username].requests.filter(u => u !== from);
        friendships[from].pending = friendships[from].pending.filter(u => u !== user.username);
        saveFriendships();
        // Envoyer listes mises à jour
        emitFriendsListTo(user.username);
        emitFriendsListTo(from);
    });

    socket.on('remove_friend', (data) => {
        const user = connectedUsers.get(socket.id);
        if (!user) return;
        const target = data.username;
        if (friendships[user.username]) friendships[user.username].friends = friendships[user.username].friends.filter(u => u !== target);
        if (friendships[target]) friendships[target].friends = friendships[target].friends.filter(u => u !== user.username);
        saveFriendships();
        socket.emit('friend_removed', { username: target });
        // Envoyer liste mise à jour à l'autre
        emitFriendsListTo(target);
    });

    socket.on('get_friends', () => {
        const user = connectedUsers.get(socket.id);
        if (!user) return;
        const data = friendships[user.username] || { friends: [], pending: [], requests: [] };
        // Add online status
        const friendsWithStatus = data.friends.map(f => {
            let online = false;
            for (const [, u] of connectedUsers.entries()) {
                if (u.username === f) { online = true; break; }
            }
            return { username: f, online };
        });
        socket.emit('friends_list', { friends: friendsWithStatus, pending: data.pending, requests: data.requests });
    });

    // =========================================
    // === BLOCK USERS ===
    // =========================================
    if (!global.blockedUsers) global.blockedUsers = {};

    socket.on('block_user', (data) => {
        const user = connectedUsers.get(socket.id);
        if (!user) return;
        const target = data.username;
        if (!target || target === user.username) return;

        if (!global.blockedUsers[user.username]) global.blockedUsers[user.username] = [];
        if (!global.blockedUsers[user.username].includes(target)) {
            global.blockedUsers[user.username].push(target);
        }

        // Also remove from friends
        if (friendships[user.username]) {
            friendships[user.username].friends = friendships[user.username].friends.filter(u => u !== target);
        }
        if (friendships[target]) {
            friendships[target].friends = friendships[target].friends.filter(u => u !== user.username);
        }
        saveFriendships();

        socket.emit('user_blocked', { username: target });
        socket.emit('blocked_users_list', { blocked: global.blockedUsers[user.username] || [] });
        emitFriendsListTo(user.username);

        logActivity('BLOCK', `${user.username} a bloqué ${target}`);
    });

    socket.on('unblock_user', (data) => {
        const user = connectedUsers.get(socket.id);
        if (!user) return;
        const target = data.username;

        if (global.blockedUsers[user.username]) {
            global.blockedUsers[user.username] = global.blockedUsers[user.username].filter(u => u !== target);
        }

        socket.emit('user_unblocked', { username: target });
        socket.emit('blocked_users_list', { blocked: global.blockedUsers[user.username] || [] });

        logActivity('UNBLOCK', `${user.username} a débloqué ${target}`);
    });

    socket.on('get_blocked_users', () => {
        const user = connectedUsers.get(socket.id);
        if (!user) return;
        socket.emit('blocked_users_list', { blocked: global.blockedUsers[user.username] || [] });
    });

    // =========================================
    // === XP / LEVELING ===
    // =========================================
    socket.on('get_xp', () => {
        const user = connectedUsers.get(socket.id);
        if (!user) return;
        socket.emit('xp_data', buildXPDataPayload(user.username));
    });

    socket.on('get_clicker_state', () => {
        const user = connectedUsers.get(socket.id);
        if (!user) return;
        const payload = buildXPDataPayload(user.username);
        socket.emit('clicker_state', payload.clicker || { totalClicks: 0, sessionClicks: 0, luckyDrops: 0, cooldownMs: CLICKER_TAP_COOLDOWN_MS });
    });

    socket.on('clicker_tap', () => {
        const user = connectedUsers.get(socket.id);
        if (!user) return;

        const entry = ensureXPEntry(user.username);
        const now = Date.now();
        const lastTap = Number(entry.clicker?.lastTapAt || 0);
        if (now - lastTap < CLICKER_TAP_COOLDOWN_MS) {
            return;
        }

        entry.clicker.lastTapAt = now;
        entry.clicker.totalClicks = Math.max(0, Number(entry.clicker.totalClicks || 0)) + 1;
        entry.clicker.sessionClicks = Math.max(0, Number(entry.clicker.sessionClicks || 0)) + 1;
        const oldLevel = getLevelFromXP(entry.xp || 0).level;

        const milestoneBonus = entry.clicker.totalClicks % 50 === 0 ? 10 : 0;
        let gainedXP = CLICKER_XP_PER_CLICK + milestoneBonus;
        const xpResult = addRawXP(user.username, gainedXP);

        let bananasWon = 0;
        let jackpot = false;

        let megaJackpot = false;
        if (Math.random() < CLICKER_MEGA_JACKPOT_CHANCE) {
            megaJackpot = true;
            jackpot = true;
            bananasWon += CLICKER_MEGA_JACKPOT_BANANAS;
            gainedXP += CLICKER_MEGA_JACKPOT_XP;
            addRawXP(user.username, CLICKER_MEGA_JACKPOT_XP);
        } else if (Math.random() < CLICKER_JACKPOT_CHANCE) {
            jackpot = true;
            bananasWon += CLICKER_JACKPOT_BANANAS;
            gainedXP += CLICKER_JACKPOT_XP;
            addRawXP(user.username, CLICKER_JACKPOT_XP);
        } else if (Math.random() < CLICKER_LUCKY_BANANA_CHANCE) {
            bananasWon += 1;
        }

        if (bananasWon > 0) {
            entry.bonusBananas = Math.max(0, Number(entry.bonusBananas || 0)) + bananasWon;
            entry.clicker.luckyDrops = Math.max(0, Number(entry.clicker.luckyDrops || 0)) + bananasWon;
        }

        const missionRewards = applyMissionProgress(user.username, { clickerClicks: 1 });

        const newLevel = getLevelFromXP(entry.xp || 0).level;
        if (newLevel > oldLevel || xpResult.levelUp) {
            io.emit('system_message', {
                type: 'system',
                message: `🎉 ${user.username} a atteint le niveau ${newLevel} !`,
                timestamp: new Date(),
                id: messageId++
            });
        }

        emitMissionRewardsToSocket(socket, user.username, missionRewards);
        saveXPData();

        socket.emit('clicker_tap_result', {
            gainedXP,
            bananasWon,
            jackpot,
            megaJackpot,
            totalClicks: entry.clicker.totalClicks,
            sessionClicks: entry.clicker.sessionClicks,
            luckyDrops: entry.clicker.luckyDrops,
            bananaPoints: getBananaPoints(user.username)
        });
        socket.emit('xp_data', buildXPDataPayload(user.username));
        if (bananasWon > 0) broadcastLeaderboard();
    });

    socket.on('convert_xp_to_banana', (data) => {
        const user = connectedUsers.get(socket.id);
        if (!user) return;

        const bananas = Math.max(0, Math.floor(Number(data?.bananas || 0)));
        const result = convertXPToBananas(user.username, bananas);
        if (!result.success) {
            socket.emit('banana_error', { message: result.message || 'Conversion impossible' });
            return;
        }

        saveXPData();
        socket.emit('banana_reward', {
            type: 'xp_converter',
            title: '🔁 Conversion XP',
            message: `-${result.xpSpent} XP → +${result.bananasAdded} 🍌`
        });
        socket.emit('banana_updated', { bananaPoints: result.bananaPoints });
        socket.emit('xp_data', buildXPDataPayload(user.username));
        updateUsersList();
        broadcastLeaderboard();
    });

    socket.on('set_name_effect', (data) => {
        const user = connectedUsers.get(socket.id);
        if (!user) return;

        const xpEntry = ensureXPEntry(user.username);
        const requested = sanitizeNameEffect(data?.effect || 'none');
        if (requested !== 'none' && !xpEntry.ownedNameEffects?.[requested]) {
            socket.emit('banana_error', { message: 'Effet non possédé' });
            return;
        }

        xpEntry.activeNameEffect = requested;
        saveXPData();
        socket.emit('xp_data', buildXPDataPayload(user.username));
        updateUsersList();
        for (const [rName, rData] of Object.entries(voiceRooms)) {
            if (rData.participants.has(socket.id)) {
                io.emit('voice_participants_update', { room: rName, participants: getVoiceParticipants(rName) });
            }
        }
    });

    // === ACHAT THÈME CUSTOM (200 bananes) ===
    socket.on('buy_custom_theme', (data) => {
        const user = connectedUsers.get(socket.id);
        if (!user) return;

        const xpEntry = ensureXPEntry(user.username);
        if (xpEntry.customThemeUnlocked) {
            socket.emit('banana_reward', { type: 'custom_theme', title: '🎨 Thème custom', message: 'Déjà débloqué !' });
            return;
        }

        const cost = 200;
        const bananas = getBananaPoints(user.username);
        if (bananas < cost) {
            socket.emit('banana_error', { message: `Pas assez de bananes ! (${bananas}/${cost} 🍌)` });
            return;
        }

        const ok = spendBananas(user.username, cost);
        if (!ok) { socket.emit('banana_error', { message: 'Erreur lors du paiement' }); return; }

        xpEntry.customThemeUnlocked = true;
        xpEntry.customTheme = data?.theme || { colors: ['#5865F2', '#4752C4'], opacity: 0.9 };
        saveXPData();
        socket.emit('banana_reward', { type: 'custom_theme', title: '🎨 Thème custom débloqué !', message: 'Tu peux maintenant créer ton propre thème dégradé !' });
        socket.emit('banana_updated', { bananaPoints: getBananaPoints(user.username) });
        socket.emit('xp_data', buildXPDataPayload(user.username));
        logActivity('SHOP', 'Thème custom acheté', { username: user.username, cost });
    });

    // === ACHAT AUTO-CLICKER (1000 bananes) ===
    socket.on('buy_autoclicker', () => {
        const user = connectedUsers.get(socket.id);
        if (!user) return;

        const xpEntry = ensureXPEntry(user.username);
        if (xpEntry.autoClickerUnlocked) {
            socket.emit('banana_reward', { type: 'autoclicker', title: '🤖 Auto-Clicker', message: 'Déjà débloqué !' });
            return;
        }

        const cost = CLICKER_AUTOCLICKER_COST;
        const bananas = getBananaPoints(user.username);
        if (bananas < cost) {
            socket.emit('banana_error', { message: `Pas assez de bananes ! (${bananas}/${cost} 🍌)` });
            return;
        }

        const ok = spendBananas(user.username, cost);
        if (!ok) { socket.emit('banana_error', { message: 'Erreur lors du paiement' }); return; }

        xpEntry.autoClickerUnlocked = true;
        saveXPData();
        socket.emit('banana_reward', { type: 'autoclicker', title: '🤖 Auto-Clicker débloqué !', message: 'Active-le dans le Cookie Clicker pour gagner du XP automatiquement !' });
        socket.emit('banana_updated', { bananaPoints: getBananaPoints(user.username) });
        socket.emit('xp_data', buildXPDataPayload(user.username));
        logActivity('SHOP', 'Auto-clicker acheté', { username: user.username, cost });
    });

    // === AUTO-CLICKER TOGGLE ===
    socket.on('autoclicker_toggle', (data) => {
        const user = connectedUsers.get(socket.id);
        if (!user) return;

        const xpEntry = ensureXPEntry(user.username);
        if (!xpEntry.autoClickerUnlocked) {
            socket.emit('banana_error', { message: 'Auto-clicker non débloqué' });
            return;
        }

        const enable = !!data?.enable;

        // Clear existing interval if any
        if (socket._autoClickerInterval) {
            clearInterval(socket._autoClickerInterval);
            socket._autoClickerInterval = null;
        }

        if (enable) {
            socket._autoClickerInterval = setInterval(() => {
                const u = connectedUsers.get(socket.id);
                if (!u) { clearInterval(socket._autoClickerInterval); socket._autoClickerInterval = null; return; }

                const entry = ensureXPEntry(u.username);
                entry.clicker.totalClicks = Math.max(0, Number(entry.clicker.totalClicks || 0)) + 1;
                entry.clicker.sessionClicks = Math.max(0, Number(entry.clicker.sessionClicks || 0)) + 1;

                const gainedXP = CLICKER_AUTOCLICKER_XP_PER_TICK;
                addRawXP(u.username, gainedXP);

                // Reduced lucky chance for auto-clicks (halved)
                let bananasWon = 0;
                let jackpot = false;
                let megaJackpot = false;
                if (Math.random() < CLICKER_LUCKY_BANANA_CHANCE * 0.5) {
                    bananasWon = 1;
                }
                if (bananasWon > 0) {
                    entry.bonusBananas = Math.max(0, Number(entry.bonusBananas || 0)) + bananasWon;
                    entry.clicker.luckyDrops = Math.max(0, Number(entry.clicker.luckyDrops || 0)) + bananasWon;
                }

                applyMissionProgress(u.username, { clickerClicks: 1 });

                socket.emit('clicker_tap_result', {
                    gainedXP,
                    bananasWon,
                    jackpot: false,
                    megaJackpot: false,
                    totalClicks: entry.clicker.totalClicks,
                    sessionClicks: entry.clicker.sessionClicks,
                    luckyDrops: entry.clicker.luckyDrops,
                    bananaPoints: getBananaPoints(u.username),
                    autoClick: true
                });
            }, CLICKER_AUTOCLICKER_INTERVAL_MS);
        }

        socket.emit('autoclicker_state', { active: enable, unlocked: true });
    });

    // === SAUVEGARDER THÈME CUSTOM ===
    socket.on('save_custom_theme', (data) => {
        const user = connectedUsers.get(socket.id);
        if (!user) return;

        const xpEntry = ensureXPEntry(user.username);
        if (!xpEntry.customThemeUnlocked) {
            socket.emit('banana_error', { message: 'Thème custom non débloqué' });
            return;
        }

        const colors = Array.isArray(data?.colors) ? data.colors.slice(0, 5).map(c => String(c).slice(0, 9)) : ['#5865F2'];
        const opacity = Math.min(1, Math.max(0.1, parseFloat(data?.opacity) || 0.9));
        xpEntry.customTheme = { colors, opacity };
        saveXPData();
        socket.emit('custom_theme_saved', { colors, opacity });
    });

    socket.on('get_leaderboard', () => {
        const leaderboard = Object.entries(userXP)
            .map(([username, data]) => {
                const levelData = getLevelFromXP(data.xp);
                return {
                    username,
                    xp: data.xp,
                    ...levelData,
                    role: getRoleForLevel(levelData.level),
                    totalMessages: data.totalMessages,
                    bananaPoints: getBananaPoints(username)
                };
            })
            .sort((a, b) => b.xp - a.xp)
            .slice(0, 20);
        socket.emit('leaderboard_data', { leaderboard });
    });

    socket.on('get_minigames_leaderboard', () => {
        const leaderboard = Object.entries(miniGameStats)
            .map(([username, data]) => ({
                username,
                points: Number(data.points || 0),
                played: Number(data.played || 0),
                wins: Number(data.wins || 0),
                losses: Number(data.losses || 0),
                draws: Number(data.draws || 0)
            }))
            .sort((a, b) => b.points - a.points)
            .slice(0, 20);
        socket.emit('minigames_leaderboard_data', { leaderboard });
    });

    socket.on('minigame_result', (data) => {
        const user = connectedUsers.get(socket.id);
        if (!user) return;

        const gameType = String(data?.gameType || '').toLowerCase();
        const outcome = String(data?.outcome || 'played').toLowerCase();
        const allowedGames = ['guess', 'memory', 'quiz', 'arena2d'];
        const allowedOutcomes = ['win', 'draw', 'loss', 'played'];
        if (!allowedGames.includes(gameType) || !allowedOutcomes.includes(outcome)) return;

        const base = getMiniGameReward(gameType, outcome);
        const claimedPoints = Number(data?.points);
        const claimedXP = Number(data?.xp);
        const safePoints = Number.isFinite(claimedPoints) ? Math.max(0, Math.min(base.points + 8, Math.floor(claimedPoints))) : base.points;
        const safeXP = Number.isFinite(claimedXP) ? Math.max(0, Math.min(base.xp + 20, Math.floor(claimedXP))) : base.xp;

        const result = recordMiniGameResult(user.username, gameType, outcome, { points: safePoints, xp: safeXP });
        socket.emit('minigame_reward', {
            gameType,
            outcome,
            points: result.points,
            xp: result.xp,
            bananas: result.bananas,
            totalMiniGamePoints: result.totals.points
        });
        emitMissionRewardsToSocket(socket, user.username, result.missionRewards || []);
        socket.emit('xp_data', buildXPDataPayload(user.username));
    });

    socket.on('banana_use', (data) => {
        const user = connectedUsers.get(socket.id);
        if (!user) return;

        const costs = {
            confetti: 12,
            shake: 9,
            flash: 100,
            rain: 16,
            fireworks: 23,
            xp_boost: 15,
            streak_shield: 18,
            reaction_boost: 13,
            cooldown_reducer: 12,
            name_glow: NAME_EFFECT_ITEMS.name_glow.cost,
            name_gradient: NAME_EFFECT_ITEMS.name_gradient.cost,
            name_neon: NAME_EFFECT_ITEMS.name_neon.cost
        };
        const effect = data.effect;
        let cost = costs[effect];
        if (!cost) {
            socket.emit('banana_error', { message: 'Objet banane inconnu' });
            return;
        }

        // Appliquer la réduction promo si active
        if (shopPromotion.active && shopPromotion.endsAt > Date.now()) {
            const eligible = !shopPromotion.itemFilter || shopPromotion.itemFilter.includes(effect);
            if (eligible && shopPromotion.discount > 0) {
                cost = Math.max(1, Math.round(cost * (1 - shopPromotion.discount / 100)));
            }
        }

        const xpEntry = ensureXPEntry(user.username);
        if (NAME_EFFECT_ITEMS[effect] && xpEntry.ownedNameEffects?.[effect]) {
            xpEntry.activeNameEffect = effect;
            saveXPData();
            socket.emit('banana_reward', {
                type: effect,
                title: '✨ Effet activé',
                message: `${NAME_EFFECT_ITEMS[effect].label} activé sur votre pseudo`
            });
            socket.emit('xp_data', buildXPDataPayload(user.username));
            updateUsersList();
            for (const [rName, rData] of Object.entries(voiceRooms)) {
                if (rData.participants.has(socket.id)) {
                    io.emit('voice_participants_update', { room: rName, participants: getVoiceParticipants(rName) });
                }
            }
            return;
        }

        const bananas = getBananaPoints(user.username);
        if (bananas < cost) {
            socket.emit('banana_error', { message: `Pas assez de bananes ! (${bananas}/${cost} 🍌) · Utilise le convertisseur XP→🍌` });
            return;
        }

        const utilityItems = ['xp_boost', 'streak_shield', 'reaction_boost', 'cooldown_reducer'];
        if (utilityItems.includes(effect)) {
            const now = Date.now();
            if (!xpEntry.shopWindowStart || (now - xpEntry.shopWindowStart) > 60 * 60 * 1000) {
                xpEntry.shopWindowStart = now;
                xpEntry.shopWindowCount = 0;
            }
            if (xpEntry.shopWindowCount >= UTILITY_PURCHASES_LIMIT_PER_HOUR) {
                socket.emit('banana_error', {
                    message: `Limite anti-abus atteinte (${UTILITY_PURCHASES_LIMIT_PER_HOUR} achats utilitaires / heure)`
                });
                return;
            }
            xpEntry.shopWindowCount += 1;
        }

        const spendOk = spendBananas(user.username, cost);
        if (!spendOk) {
            socket.emit('banana_error', { message: 'Impossible de débiter les bananes, réessayez.' });
            return;
        }

        if (effect === 'xp_boost') {
            const now = Date.now();
            const base = xpEntry.xpBoostUntil && xpEntry.xpBoostUntil > now ? xpEntry.xpBoostUntil : now;
            xpEntry.xpBoostUntil = base + 20 * 60 * 1000; // +20 minutes
            socket.emit('banana_reward', {
                type: 'xp_boost',
                title: '🚀 Boost XP',
                message: 'XP x2 active pendant 20 minutes (cumulable)'
            });
        } else if (effect === 'streak_shield') {
            xpEntry.streakShieldCharges = Math.min(3, (xpEntry.streakShieldCharges || 0) + 1);
            socket.emit('banana_reward', {
                type: 'streak_shield',
                title: '🛡️ Protection de série',
                message: `Charge active: ${xpEntry.streakShieldCharges}/3`
            });
        } else if (effect === 'reaction_boost') {
            const now = Date.now();
            const base = xpEntry.reactionBoostUntil && xpEntry.reactionBoostUntil > now ? xpEntry.reactionBoostUntil : now;
            xpEntry.reactionBoostUntil = base + XP_UTILITY_DURATION_MS;
            socket.emit('banana_reward', {
                type: 'reaction_boost',
                title: '✨ Boost réactions',
                message: 'XP des réactions x2 pendant 15 minutes (cumulable)'
            });
        } else if (effect === 'cooldown_reducer') {
            const now = Date.now();
            const base = xpEntry.cooldownReducerUntil && xpEntry.cooldownReducerUntil > now ? xpEntry.cooldownReducerUntil : now;
            xpEntry.cooldownReducerUntil = base + XP_UTILITY_DURATION_MS;
            socket.emit('banana_reward', {
                type: 'cooldown_reducer',
                title: '⚡ Cadence XP',
                message: 'Cooldown XP messages réduit à 20s pendant 15 minutes'
            });
        } else if (NAME_EFFECT_ITEMS[effect]) {
            xpEntry.ownedNameEffects = xpEntry.ownedNameEffects || {};
            xpEntry.ownedNameEffects[effect] = true;
            xpEntry.activeNameEffect = effect;
            socket.emit('banana_reward', {
                type: effect,
                title: '🌈 Effet pseudo débloqué',
                message: `${NAME_EFFECT_ITEMS[effect].label} obtenu en permanent`
            });
        }

        xpEntry.level = getLevelFromXP(xpEntry.xp).level;
        saveXPData();

        if (['confetti', 'shake', 'flash', 'rain', 'fireworks'].includes(effect)) {
            io.emit('banana_effect', { effect, username: user.username });
        }

        socket.emit('banana_updated', { bananaPoints: getBananaPoints(user.username) });
        socket.emit('xp_data', buildXPDataPayload(user.username));
        updateUsersList();
        broadcastLeaderboard();
        for (const [rName, rData] of Object.entries(voiceRooms)) {
            if (rData.participants.has(socket.id)) {
                io.emit('voice_participants_update', { room: rName, participants: getVoiceParticipants(rName) });
            }
        }

        logActivity('ADMIN', 'Achat boutique banane', {
            username: user.username,
            item: effect,
            costBananas: cost,
            bananasAfter: getBananaPoints(user.username),
            utilityPurchasesInHour: xpEntry.shopWindowCount
        });
    });

    // =========================================
    // === REMINDERS ===
    // =========================================
    socket.on('create_reminder', (data) => {
        const user = connectedUsers.get(socket.id);
        if (!user) return;
        const { message, delay } = data; // delay in seconds
        if (!message || !delay || delay < 10 || delay > 86400 * 7) {
            socket.emit('reminder_error', { message: 'Durée invalide (10s - 7 jours)' });
            return;
        }
        const reminder = {
            id: reminderIdCounter++,
            username: user.username,
            message: message.substring(0, 200),
            triggerAt: Date.now() + delay * 1000,
            channel: data.channel || 'général',
            createdAt: new Date().toISOString()
        };
        reminders.push(reminder);
        saveReminders();
        socket.emit('reminder_created', { id: reminder.id, triggerAt: reminder.triggerAt, message: reminder.message });
    });

    socket.on('get_reminders', () => {
        const user = connectedUsers.get(socket.id);
        if (!user) return;
        socket.emit('reminders_list', { reminders: reminders.filter(r => r.username === user.username) });
    });

    socket.on('delete_reminder', (data) => {
        const user = connectedUsers.get(socket.id);
        if (!user) return;
        reminders = reminders.filter(r => !(r.id === data.id && r.username === user.username));
        saveReminders();
        socket.emit('reminder_deleted', { id: data.id });
    });

    // =========================================
    // === AUTOMOD CONFIG (admin only) ===
    // =========================================
    socket.on('get_automod_config', () => {
        const user = connectedUsers.get(socket.id);
        if (!user || !adminUsersList.includes(user.username)) return;
        socket.emit('automod_config', autoModConfig);
    });

    socket.on('update_automod', (data) => {
        const user = connectedUsers.get(socket.id);
        if (!user || !adminUsersList.includes(user.username)) return;
        autoModConfig = { ...autoModConfig, ...data };
        saveAutoMod();
        socket.emit('automod_updated', autoModConfig);
    });

    // =========================================
    // === USER STATUS ===
    // =========================================
    socket.on('set_custom_status', (data) => {
        const user = connectedUsers.get(socket.id);
        if (!user) return;
        const { status, customText, emoji } = data;
        userStatuses[user.username] = {
            status: status || 'online',
            customText: (customText || '').substring(0, 50),
            emoji: emoji || '',
            updatedAt: new Date().toISOString()
        };
        updateUsersList();
        io.emit('user_status_changed', { username: user.username, ...userStatuses[user.username] });
    });

    // =========================================
    // === LINK PREVIEW ===
    // =========================================
    socket.on('request_link_preview', async (data) => {
        const { url } = data;
        if (!url || !/^https?:\/\//i.test(url)) return;
        
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 5000);
            const response = await fetch(url, {
                headers: { 'User-Agent': 'DocSpace-Bot/1.0' },
                signal: controller.signal,
                redirect: 'follow'
            });
            clearTimeout(timeout);
            
            if (!response.ok) return;
            const contentType = response.headers.get('content-type') || '';
            if (!contentType.includes('text/html')) return;
            
            const html = (await response.text()).substring(0, 50000); // Limit to 50KB
            
            const getMetaContent = (name) => {
                const match = html.match(new RegExp(`<meta[^>]*(?:property|name)=["']${name}["'][^>]*content=["']([^"']*)["']`, 'i'))
                    || html.match(new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*(?:property|name)=["']${name}["']`, 'i'));
                return match ? match[1] : '';
            };
            
            const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
            const preview = {
                url,
                title: getMetaContent('og:title') || (titleMatch ? titleMatch[1].trim() : ''),
                description: (getMetaContent('og:description') || getMetaContent('description') || '').substring(0, 200),
                image: getMetaContent('og:image') || '',
                siteName: getMetaContent('og:site_name') || ''
            };
            
            if (preview.title) {
                socket.emit('link_preview_data', preview);
            }
        } catch (e) {
            // Silently fail for link previews
        }
    });

    // =========================================
    // === HANGMAN GAME ===
    // =========================================
    socket.on('start_hangman', () => {
        const user = connectedUsers.get(socket.id);
        if (!user) return;
        const picked = getRandomHangmanWord();
        const word = picked.word;
        const gameState = {
            word,
            hint: picked.hint,
            guessed: [],
            wrong: [],
            maxErrors: 8,
            display: word.split('').map(() => '_').join(' ')
        };
        socket.hangmanGame = gameState;
        const hintState = getHangmanHintState(gameState);
        socket.emit('hangman_state', {
            display: gameState.display,
            wrong: gameState.wrong,
            remaining: gameState.maxErrors - gameState.wrong.length,
            maxErrors: gameState.maxErrors,
            hintVisible: hintState.visible,
            hintText: hintState.text,
            finished: false
        });
    });

    socket.on('hangman_guess', (data) => {
        const user = connectedUsers.get(socket.id);
        if (!user || !socket.hangmanGame) return;
        const game = socket.hangmanGame;
        const letter = (data.letter || '').toUpperCase().charAt(0);
        if (!letter || game.guessed.includes(letter) || game.wrong.includes(letter)) return;
        
        if (game.word.includes(letter)) {
            game.guessed.push(letter);
        } else {
            game.wrong.push(letter);
        }
        
        const display = game.word.split('').map(c => game.guessed.includes(c) ? c : '_').join(' ');
        const won = !display.includes('_');
        const lost = game.wrong.length >= game.maxErrors;
        const hintState = getHangmanHintState(game);
        
        socket.emit('hangman_state', {
            display,
            wrong: game.wrong,
            remaining: game.maxErrors - game.wrong.length,
            maxErrors: game.maxErrors,
            hintVisible: hintState.visible,
            hintText: hintState.text,
            finished: won || lost,
            won,
            word: (won || lost) ? game.word : undefined
        });
        
        if (won) {
            const xpResult = grantXP(user.username, 50);
            const miniReward = recordMiniGameResult(user.username, 'hangman', 'win');
            socket.emit('minigame_reward', {
                gameType: 'hangman',
                outcome: 'win',
                points: miniReward.points,
                xp: miniReward.xp,
                bananas: miniReward.bananas || 0,
                totalMiniGamePoints: miniReward.totals.points
            });
            emitMissionRewardsToSocket(socket, user.username, miniReward.missionRewards || []);
            socket.emit('xp_data', buildXPDataPayload(user.username));
            if (xpResult && xpResult.levelUp) {
                io.emit('system_message', { type: 'system', message: `🎉 ${user.username} a atteint le niveau ${xpResult.newLevel} !`, timestamp: new Date(), id: messageId++ });
            }
            socket.hangmanGame = null;
        } else if (lost) {
            const miniReward = recordMiniGameResult(user.username, 'hangman', 'loss');
            socket.emit('minigame_reward', {
                gameType: 'hangman',
                outcome: 'loss',
                points: miniReward.points,
                xp: miniReward.xp,
                bananas: miniReward.bananas || 0,
                totalMiniGamePoints: miniReward.totals.points
            });
            emitMissionRewardsToSocket(socket, user.username, miniReward.missionRewards || []);
            socket.emit('xp_data', buildXPDataPayload(user.username));
            socket.hangmanGame = null;
        }
    });

    // =========================================
    // === TRIVIA GAME ===
    // =========================================
    socket.on('start_trivia', () => {
        const user = connectedUsers.get(socket.id);
        if (!user) return;
        // 10 questions choisies dans une banque de 50+ questions
        const shuffled = getRandomTriviaQuestions(10);
        socket.triviaGame = { questions: shuffled, current: 0, score: 0, total: shuffled.length };
        
        socket.emit('trivia_question', {
            question: shuffled[0].q,
            answers: shuffled[0].a,
            current: 1,
            total: shuffled.length,
            score: 0
        });
    });

    socket.on('trivia_answer', (data) => {
        const user = connectedUsers.get(socket.id);
        if (!user || !socket.triviaGame) return;
        const game = socket.triviaGame;
        const q = game.questions[game.current];
        const correct = data.answer === q.correct;
        if (correct) game.score++;
        
        game.current++;
        
        if (game.current >= game.total) {
            // Game over
            const xpGained = game.score * 20;
            const xpResult = grantXP(user.username, xpGained);
            const scoreRatio = game.total > 0 ? (game.score / game.total) : 0;
            const outcome = scoreRatio >= 0.7 ? 'win' : (scoreRatio >= 0.4 ? 'draw' : 'loss');
            const miniReward = recordMiniGameResult(user.username, 'trivia', outcome, {
                points: Math.max(4, Math.floor(game.score * 2.5)),
                xp: Math.max(10, Math.floor(game.score * 6))
            });
            socket.emit('trivia_result', {
                correct,
                correctAnswer: q.correct,
                score: game.score,
                total: game.total,
                finished: true,
                xpGained
            });
            socket.emit('minigame_reward', {
                gameType: 'trivia',
                outcome,
                points: miniReward.points,
                xp: miniReward.xp,
                bananas: miniReward.bananas || 0,
                totalMiniGamePoints: miniReward.totals.points
            });
            emitMissionRewardsToSocket(socket, user.username, miniReward.missionRewards || []);
            socket.emit('xp_data', buildXPDataPayload(user.username));
            if (xpResult && xpResult.levelUp) {
                io.emit('system_message', { type: 'system', message: `🎉 ${user.username} a atteint le niveau ${xpResult.newLevel} !`, timestamp: new Date(), id: messageId++ });
            }
            socket.triviaGame = null;
        } else {
            const next = game.questions[game.current];
            socket.emit('trivia_result', {
                correct,
                correctAnswer: q.correct,
                score: game.score,
                total: game.total,
                finished: false,
                nextQuestion: next.q,
                nextAnswers: next.a,
                current: game.current + 1
            });
        }
    });

    // =========================================
    // === SOUNDBOARD ===
    // =========================================
    socket.on('play_sound', (data) => {
        const user = connectedUsers.get(socket.id);
        if (!user) return;
        const allowedSounds = ['applause','airhorn','rimshot','sadtrombone','tada','drumroll','crickets','laugh','wow','bruh'];
        if (!allowedSounds.includes(data.sound)) return;
        // Broadcast to all users in same channel
        io.emit('sound_played', { sound: data.sound, username: user.username, channel: data.channel || 'général' });
    });

    // =========================================
    // === READ RECEIPTS ===
    // =========================================
    socket.on('mark_read', (data) => {
        const user = connectedUsers.get(socket.id);
        if (!user) return;
        const { channel, lastMessageId } = data;
        io.emit('read_receipt', { username: user.username, channel, lastMessageId, timestamp: Date.now() });
    });
});

// Initialiser l'état d'un jeu
function initGameState(gameType) {
    switch (gameType) {
        case 'tictactoe':
            return { board: ['', '', '', '', '', '', '', '', ''] };
        case 'connect4':
            return { board: Array(6).fill(null).map(() => Array(7).fill('')) };
        case 'rps':
            return { choices: [null, null], scores: [0, 0], round: 1, maxRounds: 5 };
        case 'quiz': {
            const allQuestions = [
                { q: "Quelle est la capitale de la France?", a: ["Paris", "Lyon", "Marseille", "Nice"], c: 0 },
                { q: "Combien font 7 × 8?", a: ["54", "56", "58", "64"], c: 1 },
                { q: "Qui a peint La Joconde?", a: ["Picasso", "Van Gogh", "Léonard de Vinci", "Michel-Ange"], c: 2 },
                { q: "Quel est le plus grand océan?", a: ["Atlantique", "Indien", "Pacifique", "Arctique"], c: 2 },
                { q: "En quelle année la Révolution française?", a: ["1789", "1799", "1776", "1815"], c: 0 },
                { q: "Quel gaz les plantes absorbent-elles?", a: ["Oxygène", "Azote", "CO2", "Hydrogène"], c: 2 },
                { q: "Combien de pattes a une araignée?", a: ["6", "8", "10", "4"], c: 1 },
                { q: "Quelle planète est la plus proche du Soleil?", a: ["Vénus", "Mars", "Mercure", "Terre"], c: 2 },
                { q: "Qui a écrit 'Les Misérables'?", a: ["Zola", "Balzac", "Hugo", "Flaubert"], c: 2 },
                { q: "Quelle est la monnaie du Japon?", a: ["Won", "Yuan", "Yen", "Ringgit"], c: 2 }
            ];
            const questions = allQuestions.sort(() => Math.random() - 0.5).slice(0, 5);
            return { questions, current: 0, scores: [0, 0], answers: [null, null], total: questions.length };
        }
        case 'trivia': {
            const questions = getRandomTriviaQuestions(10);
            return { questions, current: 0, scores: [0, 0], answers: [null, null], total: questions.length };
        }
        case 'hangman': {
            const picked = getRandomHangmanWord();
            return { word: picked.word, hint: picked.hint, guessed: [], wrong: [], maxErrors: 8, currentGuesser: 0 };
        }
        case 'arena2d': {
            return buildArenaState();
        }
        default:
            return {};
    }
}

// Appliquer un coup
function applyGameMove(game, move, playerIndex) {
    const symbols = ['X', 'O'];
    const colors = ['red', 'yellow'];
    
    switch (game.type) {
        case 'tictactoe': {
            const { index } = move;
            if (game.state.board[index]) {
                return { valid: false };
            }
            
            game.state.board[index] = symbols[playerIndex];
            
            const winner = checkTTTWinner(game.state.board);
            const draw = !winner && !game.state.board.includes('');
            
            return {
                valid: true,
                state: game.state,
                nextTurn: winner || draw ? -1 : (playerIndex + 1) % 2,
                winner: winner ? game.players[playerIndex].username : null,
                draw: draw
            };
        }
        
        case 'connect4': {
            const { col } = move;
            let row = -1;
            for (let r = 5; r >= 0; r--) {
                if (!game.state.board[r][col]) {
                    row = r;
                    break;
                }
            }
            if (row === -1) return { valid: false };
            
            game.state.board[row][col] = colors[playerIndex];
            
            const winner = checkC4Winner(game.state.board, row, col, colors[playerIndex]);
            const draw = !winner && game.state.board[0].every(cell => cell);
            
            return {
                valid: true,
                state: game.state,
                nextTurn: winner || draw ? -1 : (playerIndex + 1) % 2,
                winner: winner ? game.players[playerIndex].username : null,
                draw: draw
            };
        }
        
        case 'rps': {
            const { choice } = move; // 'rock', 'paper', 'scissors'
            if (!['rock', 'paper', 'scissors'].includes(choice)) return { valid: false };
            if (game.state.choices[playerIndex] !== null) return { valid: false };
            
            game.state.choices[playerIndex] = choice;
            
            // Les deux ont joué ?
            if (game.state.choices[0] !== null && game.state.choices[1] !== null) {
                const c0 = game.state.choices[0];
                const c1 = game.state.choices[1];
                let roundWinner = null;
                
                if (c0 !== c1) {
                    if ((c0 === 'rock' && c1 === 'scissors') || (c0 === 'paper' && c1 === 'rock') || (c0 === 'scissors' && c1 === 'paper')) {
                        game.state.scores[0]++;
                        roundWinner = game.players[0].username;
                    } else {
                        game.state.scores[1]++;
                        roundWinner = game.players[1].username;
                    }
                }
                
                const finished = game.state.round >= game.state.maxRounds;
                const resultState = { ...game.state, roundResult: { choices: [c0, c1], roundWinner } };
                
                if (!finished) {
                    game.state.choices = [null, null];
                    game.state.round++;
                }
                
                let finalWinner = null;
                let finalDraw = false;
                if (finished) {
                    if (game.state.scores[0] > game.state.scores[1]) finalWinner = game.players[0].username;
                    else if (game.state.scores[1] > game.state.scores[0]) finalWinner = game.players[1].username;
                    else finalDraw = true;
                }
                
                // Envoyer individuellement à chaque joueur (ils doivent voir les 2 choix)
                game.players.forEach((p, idx) => {
                    const sid = findCurrentSocketGlobal(p.username);
                    if (sid) {
                        global.io.to(sid).emit('game_update', {
                            gameId: game.id,
                            state: resultState,
                            yourTurn: !finished,
                            lastMove: move,
                            lastMoveBy: null,
                            winner: finalWinner,
                            draw: finalDraw,
                            rpsRound: { choices: [c0, c1], roundWinner, round: resultState.round, scores: resultState.scores, finished }
                        });
                    }
                });
                
                return { valid: true, state: game.state, nextTurn: -1, winner: finalWinner, draw: finalDraw, customEmit: true };
            }
            
            // Seulement 1 joueur a joué, attendre l'autre
            return { valid: true, state: game.state, nextTurn: (playerIndex + 1) % 2, winner: null, draw: false, waiting: true, customEmit: true };
        }
        
        case 'quiz':
        case 'trivia': {
            const { answer } = move;
            if (game.state.answers[playerIndex] !== null) return { valid: false };
            
            game.state.answers[playerIndex] = answer;
            
            // Les deux ont répondu ?
            if (game.state.answers[0] !== null && game.state.answers[1] !== null) {
                const q = game.state.questions[game.state.current];
                const correctIdx = game.type === 'quiz' ? q.c : q.correct;
                
                if (game.state.answers[0] === correctIdx) game.state.scores[0]++;
                if (game.state.answers[1] === correctIdx) game.state.scores[1]++;
                
                const wasLast = game.state.current >= game.state.total - 1;
                
                const resultData = {
                    correctAnswer: correctIdx,
                    playerAnswers: [game.state.answers[0], game.state.answers[1]],
                    scores: [...game.state.scores],
                    current: game.state.current + 1,
                    total: game.state.total,
                    finished: wasLast
                };
                
                let finalWinner = null;
                let finalDraw = false;
                if (wasLast) {
                    if (game.state.scores[0] > game.state.scores[1]) finalWinner = game.players[0].username;
                    else if (game.state.scores[1] > game.state.scores[0]) finalWinner = game.players[1].username;
                    else finalDraw = true;
                } else {
                    // Prochaine question
                    game.state.current++;
                    game.state.answers = [null, null];
                }
                
                // Envoyer à chaque joueur
                game.players.forEach((p, idx) => {
                    const sid = findCurrentSocketGlobal(p.username);
                    if (sid) {
                        const nextQ = !wasLast ? game.state.questions[game.state.current] : null;
                        global.io.to(sid).emit('game_update', {
                            gameId: game.id,
                            state: game.state,
                            yourTurn: !wasLast,
                            winner: finalWinner,
                            draw: finalDraw,
                            quizRound: {
                                ...resultData,
                                nextQuestion: nextQ ? (game.type === 'quiz' ? { q: nextQ.q, a: nextQ.a } : { q: nextQ.q, a: nextQ.a }) : null
                            }
                        });
                    }
                });
                
                return { valid: true, state: game.state, nextTurn: -1, winner: finalWinner, draw: finalDraw, customEmit: true };
            }
            
            // Seulement 1 joueur a répondu
            const sid = findCurrentSocketGlobal(game.players[playerIndex].username);
            if (sid) {
                global.io.to(sid).emit('game_update', {
                    gameId: game.id,
                    state: {},
                    yourTurn: false,
                    quizWaiting: true
                });
            }
            return { valid: true, state: game.state, nextTurn: -1, winner: null, draw: false, customEmit: true };
        }
        
        case 'hangman': {
            const letter = (move.letter || '').toUpperCase().charAt(0);
            if (!letter) return { valid: false };
            if (game.state.guessed.includes(letter) || game.state.wrong.includes(letter)) return { valid: false };
            
            if (game.state.word.includes(letter)) {
                game.state.guessed.push(letter);
            } else {
                game.state.wrong.push(letter);
            }
            
            const display = game.state.word.split('').map(c => game.state.guessed.includes(c) ? c : '_').join(' ');
            const won = !display.includes('_');
            const lost = game.state.wrong.length >= game.state.maxErrors;
            const hintState = getHangmanHintState(game.state);
            
            // Alterner qui devine ou les deux devinent ensemble (co-op style)
            return {
                valid: true,
                state: game.state,
                nextTurn: (won || lost) ? -1 : (playerIndex + 1) % 2,
                winner: won ? 'COOP_WIN' : (lost ? 'COOP_LOSE' : null),
                draw: false,
                hangmanState: {
                    display,
                    wrong: game.state.wrong,
                    remaining: game.state.maxErrors - game.state.wrong.length,
                    maxErrors: game.state.maxErrors,
                    finished: won || lost,
                    won,
                    word: (won || lost) ? game.state.word : undefined,
                    hintVisible: hintState.visible,
                    hintText: hintState.text
                }
            };
        }

        case 'arena2d': {
            const dir = move?.dir;
            if (!['up', 'down', 'left', 'right'].includes(dir)) return { valid: false };

            const now = Date.now();
            const lastMove = game.state.lastMoveAt[playerIndex] || 0;
            if (now - lastMove < game.state.moveCooldownMs) return { valid: false };
            game.state.lastMoveAt[playerIndex] = now;

            const p = game.state.players[playerIndex];
            if (!p) return { valid: false };
            const otherIndex = playerIndex === 0 ? 1 : 0;
            const other = game.state.players[otherIndex];

            const nextX = dir === 'left' ? Math.max(0, p.x - 1)
                : dir === 'right' ? Math.min(game.state.width - 1, p.x + 1)
                : p.x;
            const nextY = dir === 'up' ? Math.max(0, p.y - 1)
                : dir === 'down' ? Math.min(game.state.height - 1, p.y + 1)
                : p.y;

            const wallHit = (game.state.walls || []).some(w => w.x === nextX && w.y === nextY);
            if (!wallHit) {
                p.x = nextX;
                p.y = nextY;
            }

            const jumpPad = (game.state.jumpPads || []).find(j => j.x === p.x && j.y === p.y);
            if (jumpPad) {
                const jx = Math.min(game.state.width - 1, Math.max(0, p.x + (jumpPad.dx || 0)));
                const jy = Math.min(game.state.height - 1, Math.max(0, p.y + (jumpPad.dy || 0)));
                if (!(game.state.walls || []).some(w => w.x === jx && w.y === jy)) {
                    p.x = jx;
                    p.y = jy;
                }
            }

            const pipe = (game.state.pipes || []).find(pp => pp.a.x === p.x && pp.a.y === p.y);
            if (pipe) {
                p.x = pipe.b.x;
                p.y = pipe.b.y;
            } else {
                const pipeRev = (game.state.pipes || []).find(pp => pp.b.x === p.x && pp.b.y === p.y);
                if (pipeRev) {
                    p.x = pipeRev.a.x;
                    p.y = pipeRev.a.y;
                }
            }

            const hazardHit = (game.state.hazards || []).some(h => h.x === p.x && h.y === p.y);
            if (hazardHit) {
                p.score = Math.max(0, p.score - 1);
                const spawn = (game.state.spawns && game.state.spawns[playerIndex]) || { x: playerIndex === 0 ? 2 : game.state.width - 3, y: Math.floor(game.state.height / 2) };
                p.x = spawn.x;
                p.y = spawn.y;
            }

            if (game.state.mode === 'sword_duel' && other && p.x === other.x && p.y === other.y) {
                p.score += 1;
                other.score = Math.max(0, other.score - 1);
                const otherSpawn = (game.state.spawns && game.state.spawns[otherIndex]) || { x: otherIndex === 0 ? 2 : game.state.width - 3, y: Math.floor(game.state.height / 2) };
                other.x = otherSpawn.x;
                other.y = otherSpawn.y;
            }

            const coinIndex = game.state.coins.findIndex(c => c.x === p.x && c.y === p.y);
            if (coinIndex >= 0) {
                game.state.coins.splice(coinIndex, 1);
                p.score += Math.max(1, Number(game.state.coinValue || 1));
                game.state.coins.push(spawnArenaCoin(game.state.width, game.state.height, game.state.players, game.state.coins, getArenaBlockedPositions(game.state)));
            }

            let winner = null;
            if (p.score >= game.state.targetScore) {
                winner = game.players[playerIndex].username;
            }

            return {
                valid: true,
                state: game.state,
                winner,
                draw: false
            };
        }
        
        default:
            return { valid: false };
    }
}

// Helper global pour trouver un socket par username (utilisé par applyGameMove)
function findCurrentSocketGlobal(username) {
    let sid = null;
    connectedUsers.forEach((u, socketId) => {
        if (u.username === username) sid = socketId;
    });
    return sid;
}

function checkTTTWinner(board) {
    const lines = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
    for (const [a, b, c] of lines) {
        if (board[a] && board[a] === board[b] && board[a] === board[c]) {
            return board[a];
        }
    }
    return null;
}

function checkC4Winner(board, row, col, player) {
    const directions = [[0,1], [1,0], [1,1], [1,-1]];
    
    for (const [dr, dc] of directions) {
        let count = 1;
        for (let dir = -1; dir <= 1; dir += 2) {
            for (let i = 1; i < 4; i++) {
                const r = row + dr * i * dir;
                const c = col + dc * i * dir;
                if (r >= 0 && r < 6 && c >= 0 && c < 7 && board[r][c] === player) {
                    count++;
                } else break;
            }
        }
        if (count >= 4) return player;
    }
    return null;
}

// Fonctions utilitaires
function addToHistory(message) {
    chatHistory.push(message);
    // Limiter l'historique
    if (chatHistory.length > MAX_HISTORY) {
        const removed = chatHistory.length - MAX_HISTORY;
        chatHistory = chatHistory.slice(-MAX_HISTORY);
        logActivity('SYSTEM', `Historique tronqué: ${removed} messages supprimés`);
        
        // Nettoyer les réactions pour les messages supprimés de l'historique
        const validIds = new Set(chatHistory.map(m => String(m.id)));
        let reactionsRemoved = 0;
        Object.keys(messageReactions).forEach(mid => { 
            if (!validIds.has(mid) && !validIds.has(String(mid))) {
                delete messageReactions[mid];
                reactionsRemoved++;
            }
        });
        if (reactionsRemoved > 0) {
            saveReactions();
        }
    }
}

// === FONCTION POUR HISTORIQUE PAR SALON ===
function addToChannelHistory(message, channel) {
    if (!channelHistories[channel]) {
        channelHistories[channel] = [];
    }
    channelHistories[channel].push(message);
    
    // Limiter l'historique par salon (200 messages max par salon)
    const MAX_CHANNEL_HISTORY = 200;
    if (channelHistories[channel].length > MAX_CHANNEL_HISTORY) {
        channelHistories[channel] = channelHistories[channel].slice(-MAX_CHANNEL_HISTORY);
    }
}

// === FONCTION POUR PARTICIPANTS VOCAUX ===
function getVoiceParticipants(room) {
    if (!voiceRooms[room]) return [];
    const participants = [];
    voiceRooms[room].participants.forEach((data, socketId) => {
        participants.push({
            socketId,
            username: data.username,
            nameEffect: getActiveNameEffect(data.username),
            muted: data.muted,
            deafened: data.deafened,
            video: data.video,
            screen: data.screen,
            speaking: data.speaking || false
        });
    });
    return participants;
}

// === FONCTION POUR TYPING PAR SALON ===
function getChannelTypingUsers() {
    const now = Date.now();
    const channelTyping = {};
    
    AVAILABLE_CHANNELS.forEach(ch => {
        channelTyping[ch] = [];
    });
    
    typingUsers.forEach((data, socketId) => {
        if (now - data.timestamp < 5000 && connectedUsers.has(socketId)) {
            const channel = data.channel || 'général';
            if (channelTyping[channel]) {
                channelTyping[channel].push(data.username);
            }
        }
    });
    
    return channelTyping;
}

function updateUsersList() {
    const byUsername = new Map();

    Array.from(connectedUsers.values()).forEach((user) => {
        const key = normalizeUsernameKey(user.username);
        if (!key) return;

        const existing = byUsername.get(key);
        if (!existing) {
            byUsername.set(key, {
                id: user.id,
                username: user.username,
                avatar: user.avatar,
                joinTime: user.joinTime,
                lastActivity: user.lastActivity,
                messagesCount: Number(user.messagesCount || 0),
                repliesCount: Number(user.repliesCount || 0),
                activeDevices: 1
            });
            return;
        }

        existing.activeDevices += 1;
        existing.messagesCount += Number(user.messagesCount || 0);
        existing.repliesCount += Number(user.repliesCount || 0);

        if (!existing.avatar && user.avatar) {
            existing.avatar = user.avatar;
        }
        if (new Date(user.joinTime).getTime() < new Date(existing.joinTime).getTime()) {
            existing.joinTime = user.joinTime;
        }
        if (new Date(user.lastActivity).getTime() > new Date(existing.lastActivity).getTime()) {
            existing.lastActivity = user.lastActivity;
            existing.id = user.id;
        }
    });

    const usersList = Array.from(byUsername.values()).map((user) => {
        const savedStatus = userStatuses[user.username] || {};
        const xpEntry = ensureXPEntry(user.username);
        const level = getLevelFromXP(xpEntry.xp || 0).level;
        const role = getRoleForLevel(level);
        return {
            id: user.id,
            username: user.username,
            nameEffect: getActiveNameEffect(user.username),
            level,
            role,
            avatar: user.avatar,
            joinTime: user.joinTime,
            lastActivity: user.lastActivity,
            messagesCount: user.messagesCount,
            repliesCount: user.repliesCount,
            status: savedStatus.status || 'online',
            customStatus: savedStatus.customText || '',
            activeDevices: user.activeDevices
        };
    });
    
    io.emit('users_update', {
        count: usersList.length,
        users: usersList
    });
    
    logActivity('SYSTEM', `Liste des utilisateurs mise à jour`, {
        totalUsers: usersList.length,
        totalSockets: connectedUsers.size,
        activeUsers: usersList.map(u => u.username)
    });
}

function broadcastLeaderboard() {
    const leaderboard = Object.entries(userXP)
        .map(([username, data]) => {
            const levelData = getLevelFromXP(data.xp);
            return {
                username,
                xp: data.xp,
                ...levelData,
                role: getRoleForLevel(levelData.level),
                totalMessages: data.totalMessages,
                bananaPoints: getBananaPoints(username)
            };
        })
        .sort((a, b) => b.xp - a.xp)
        .slice(0, 20);
    io.emit('leaderboard_data', { leaderboard });
}

function updateTypingIndicator() {
    const now = Date.now();
    // Supprimer les utilisateurs qui tapent depuis plus de 5 secondes
    const activeTypers = [];
    
    typingUsers.forEach((data, socketId) => {
        if (now - data.timestamp < 5000 && connectedUsers.has(socketId)) {
            activeTypers.push(data.username);
        } else {
            typingUsers.delete(socketId);
        }
    });
    
    io.emit('typing_update', { users: activeTypers });
    
    if (activeTypers.length > 0) {
        logActivity('TYPING', `Indicateur de frappe mis à jour`, {
            activeTypers: activeTypers
        });
    }
}

const TRIVIA_QUESTION_BANK = [
    { q: "Quelle est la capitale de la France ?", a: ["Paris", "Lyon", "Marseille", "Toulouse"], correct: 0 },
    { q: "Combien de continents y a-t-il ?", a: ["5", "6", "7", "8"], correct: 2 },
    { q: "Quel est le plus grand ocean ?", a: ["Atlantique", "Pacifique", "Indien", "Arctique"], correct: 1 },
    { q: "En quelle annee ARPANET est-il lance ?", a: ["1965", "1969", "1975", "1983"], correct: 1 },
    { q: "Quel element chimique a le symbole Au ?", a: ["Argent", "Or", "Aluminium", "Argon"], correct: 1 },
    { q: "Combien de pattes a une araignee ?", a: ["6", "8", "10", "12"], correct: 1 },
    { q: "Quelle planete est la plus proche du Soleil ?", a: ["Venus", "Mercure", "Terre", "Mars"], correct: 1 },
    { q: "Qui a peint la Joconde ?", a: ["Raphael", "Michel-Ange", "Leonard de Vinci", "Monet"], correct: 2 },
    { q: "Combien d'os a le corps humain adulte ?", a: ["186", "206", "226", "246"], correct: 1 },
    { q: "Quelle est la monnaie du Japon ?", a: ["Yuan", "Won", "Yen", "Dollar"], correct: 2 },
    { q: "En quelle annee le mur de Berlin est-il tombe ?", a: ["1987", "1989", "1991", "1993"], correct: 1 },
    { q: "Combien de couleurs dans un arc-en-ciel ?", a: ["5", "6", "7", "8"], correct: 2 },
    { q: "Quel est le plus petit pays du monde ?", a: ["Monaco", "Vatican", "Malte", "Andorre"], correct: 1 },
    { q: "Qui a ecrit Les Miserables ?", a: ["Zola", "Hugo", "Balzac", "Dumas"], correct: 1 },
    { q: "Quel gaz les plantes absorbent-elles ?", a: ["Oxygene", "Azote", "CO2", "Hydrogene"], correct: 2 },
    { q: "Combien de touches sur un piano standard ?", a: ["76", "82", "88", "96"], correct: 2 },
    { q: "Quelle est la vitesse de la lumiere (approx.) ?", a: ["150 000 km/s", "300 000 km/s", "450 000 km/s", "1 000 000 km/s"], correct: 1 },
    { q: "Quel est l'ocean a l'ouest de l'Europe ?", a: ["Pacifique", "Atlantique", "Indien", "Arctique"], correct: 1 },
    { q: "Combien de joueurs sur le terrain dans une equipe de foot ?", a: ["9", "10", "11", "12"], correct: 2 },
    { q: "Quelle est la capitale de l'Espagne ?", a: ["Barcelone", "Seville", "Madrid", "Valence"], correct: 2 },
    { q: "Quel est le plus grand desert chaud ?", a: ["Sahara", "Gobi", "Kalahari", "Namib"], correct: 0 },
    { q: "Combien de jours dans une annee bissextile ?", a: ["365", "366", "364", "360"], correct: 1 },
    { q: "Quel instrument mesure les seismes ?", a: ["Barometre", "Sismographe", "Anemometre", "Altimetre"], correct: 1 },
    { q: "Qui a formule la theorie de la relativite ?", a: ["Newton", "Einstein", "Galilee", "Tesla"], correct: 1 },
    { q: "Quelle est la capitale de l'Italie ?", a: ["Milan", "Rome", "Naples", "Turin"], correct: 1 },
    { q: "Quel est le plus grand organe du corps humain ?", a: ["Foie", "Peau", "Poumon", "Rein"], correct: 1 },
    { q: "Quel est le symbole chimique du sodium ?", a: ["So", "Sn", "Na", "Sd"], correct: 2 },
    { q: "Combien de faces a un de classique ?", a: ["4", "6", "8", "10"], correct: 1 },
    { q: "Quelle est la langue officielle du Bresil ?", a: ["Espagnol", "Portugais", "Francais", "Anglais"], correct: 1 },
    { q: "Quel est le plus haut sommet du monde ?", a: ["K2", "Everest", "Mont Blanc", "Kilimandjaro"], correct: 1 },
    { q: "Combien de cordes a une guitare standard ?", a: ["4", "5", "6", "7"], correct: 2 },
    { q: "Quel est l'element principal du Soleil ?", a: ["Oxygene", "Hydrogene", "Fer", "Helium"], correct: 1 },
    { q: "Quel continent abrite l'Egypte ?", a: ["Asie", "Afrique", "Europe", "Amerique"], correct: 1 },
    { q: "Quelle est la capitale de l'Allemagne ?", a: ["Munich", "Hambourg", "Berlin", "Francfort"], correct: 2 },
    { q: "Combien de minutes dans 2 heures ?", a: ["90", "100", "110", "120"], correct: 3 },
    { q: "Quel est le plus long fleuve d'Afrique ?", a: ["Niger", "Congo", "Nil", "Zambeze"], correct: 2 },
    { q: "Quel est le nom de la galaxie de la Terre ?", a: ["Andromede", "Voie lactee", "Magellan", "Orion"], correct: 1 },
    { q: "Quel est le contraire de solide ?", a: ["Lisse", "Liquide", "Dur", "Stable"], correct: 1 },
    { q: "Combien y a-t-il de mois dans une annee ?", a: ["10", "11", "12", "13"], correct: 2 },
    { q: "Quel est l'animal terrestre le plus rapide ?", a: ["Lion", "Guepard", "Antilope", "Lievre"], correct: 1 },
    { q: "Quelle est la capitale du Canada ?", a: ["Toronto", "Ottawa", "Vancouver", "Montreal"], correct: 1 },
    { q: "Quel est le resultat de 9 x 9 ?", a: ["72", "81", "90", "99"], correct: 1 },
    { q: "Quel est le metal liquide a temperature ambiante ?", a: ["Mercure", "Aluminium", "Cuivre", "Zinc"], correct: 0 },
    { q: "Combien de cartes dans un jeu standard ?", a: ["32", "40", "52", "54"], correct: 2 },
    { q: "Quel est le principal gaz de l'air ?", a: ["Oxygene", "Dioxyde de carbone", "Azote", "Argon"], correct: 2 },
    { q: "Quel est le pluriel de cheval ?", a: ["Chevals", "Chevaux", "Chevales", "Chevauxs"], correct: 1 },
    { q: "Quelle est la capitale du Portugal ?", a: ["Porto", "Lisbonne", "Braga", "Coimbra"], correct: 1 },
    { q: "Combien de cotes a un hexagone ?", a: ["5", "6", "7", "8"], correct: 1 },
    { q: "Quel instrument a des touches noires et blanches ?", a: ["Violon", "Piano", "Flute", "Batterie"], correct: 1 },
    { q: "Quel est l'etat de l'eau a 0 degre C ?", a: ["Gaz", "Plasma", "Solide ou liquide", "Toujours liquide"], correct: 2 },
    { q: "Quelle est la capitale de la Grece ?", a: ["Athenes", "Sparte", "Patras", "Heraklion"], correct: 0 },
    { q: "Quel est le resultat de 15 + 27 ?", a: ["32", "42", "52", "62"], correct: 1 },
    { q: "Quel est le plus grand mammifere du monde ?", a: ["Elephant", "Baleine bleue", "Requin-baleine", "Girafe"], correct: 1 },
    { q: "Quel est l'organe qui pompe le sang ?", a: ["Foie", "Cerveau", "Coeur", "Estomac"], correct: 2 },
    { q: "Quelle est la capitale de la Belgique ?", a: ["Bruxelles", "Anvers", "Liege", "Gand"], correct: 0 },
    { q: "Quel est le nombre premier parmi ces choix ?", a: ["21", "25", "29", "33"], correct: 2 },
    { q: "Quel est le principal composant du sable ?", a: ["Sel", "Silice", "Charbon", "Calcium"], correct: 1 },
    { q: "Quelle est la capitale de l'Australie ?", a: ["Sydney", "Melbourne", "Canberra", "Perth"], correct: 2 },
    { q: "Quelle unite mesure la frequence ?", a: ["Newton", "Watt", "Hertz", "Pascal"], correct: 2 },
    { q: "Quel est le resultat de 144 / 12 ?", a: ["10", "11", "12", "13"], correct: 2 }
];

const HANGMAN_WORD_BANK = [
    { word: 'JAVASCRIPT', hint: 'Langage web tres populaire' },
    { word: 'PYTHON', hint: 'Langage connu pour sa simplicite' },
    { word: 'SERVEUR', hint: 'Machine qui fournit des services reseau' },
    { word: 'DISCORD', hint: 'Application de chat vocal et texte' },
    { word: 'ORDINATEUR', hint: 'Machine electronique programmable' },
    { word: 'INTERNET', hint: 'Reseau mondial' },
    { word: 'CLAVIER', hint: 'Peripherique pour taper du texte' },
    { word: 'ECRAN', hint: 'Affichage visuel' },
    { word: 'PROGRAMME', hint: 'Suite d instructions executees par une machine' },
    { word: 'FONCTION', hint: 'Bloc de code reutilisable' },
    { word: 'VARIABLE', hint: 'Conteneur de valeur en programmation' },
    { word: 'TABLEAU', hint: 'Structure de donnees indexee' },
    { word: 'BOUCLE', hint: 'Permet de repeter des instructions' },
    { word: 'CONDITION', hint: 'Execute selon vrai ou faux' },
    { word: 'MUSIQUE', hint: 'Art des sons' },
    { word: 'CINEMA', hint: 'Art du film' },
    { word: 'GALAXIE', hint: 'Immense ensemble d etoiles' },
    { word: 'PLANETE', hint: 'Corps celeste en orbite autour d une etoile' },
    { word: 'ETOILE', hint: 'Astre lumineux' },
    { word: 'LICORNE', hint: 'Creature mythique avec une corne' },
    { word: 'DRAGON', hint: 'Creature legendaire souvent cracheuse de feu' },
    { word: 'CHATEAU', hint: 'Grande forteresse medievale' },
    { word: 'PIRATE', hint: 'Marin hors-la-loi' },
    { word: 'ROBOT', hint: 'Machine autonome ou semi-autonome' },
    { word: 'ESPACE', hint: 'Au-dela de l atmosphere terrestre' },
    { word: 'AVENTURE', hint: 'Experience pleine de rebondissements' },
    { word: 'MONTAGNE', hint: 'Relief naturel eleve' },
    { word: 'RIVIERE', hint: 'Cours d eau naturel' },
    { word: 'FORET', hint: 'Zone dense d arbres' },
    { word: 'DESERT', hint: 'Region tres seche' },
    { word: 'ORAGE', hint: 'Pluie, eclairs et tonnerre' },
    { word: 'NUAGE', hint: 'Masse visible de gouttelettes dans le ciel' },
    { word: 'SOLEIL', hint: 'Etoile de notre systeme' },
    { word: 'LUNE', hint: 'Satellite naturel de la Terre' },
    { word: 'COMETE', hint: 'Petit corps celeste a queue lumineuse' },
    { word: 'ASTEROIDE', hint: 'Petit corps rocheux dans l espace' },
    { word: 'SATELLITE', hint: 'Objet en orbite autour d une planete' },
    { word: 'GRAVITE', hint: 'Force qui attire les corps' },
    { word: 'ELECTRON', hint: 'Particule elementaire negative' },
    { word: 'MOLECULE', hint: 'Assemblage d atomes' },
    { word: 'OXYGENE', hint: 'Gaz indispensable a la respiration' },
    { word: 'HYDROGENE', hint: 'Element le plus abondant de l univers' },
    { word: 'BIBLIOTHEQUE', hint: 'Lieu ou l on emprunte des livres' },
    { word: 'ROMAN', hint: 'Recit litteraire long' },
    { word: 'POESIE', hint: 'Art du langage rythme' },
    { word: 'THEATRE', hint: 'Art de la scene' },
    { word: 'PEINTURE', hint: 'Art visuel avec couleurs' },
    { word: 'SCULPTURE', hint: 'Art en volume' },
    { word: 'GUITARE', hint: 'Instrument a cordes' },
    { word: 'PIANO', hint: 'Instrument a clavier' },
    { word: 'TROMPETTE', hint: 'Instrument a vent en cuivre' },
    { word: 'BASKET', hint: 'Sport avec panier' },
    { word: 'FOOTBALL', hint: 'Sport au ballon rond' },
    { word: 'TENNIS', hint: 'Sport de raquette' },
    { word: 'VOLLEY', hint: 'Sport avec filet' },
    { word: 'NATATION', hint: 'Sport aquatique' },
    { word: 'MARATHON', hint: 'Course de longue distance' },
    { word: 'VOITURE', hint: 'Vehicule a moteur' },
    { word: 'AVION', hint: 'Transport aerien' },
    { word: 'BATEAU', hint: 'Transport maritime' },
    { word: 'TRAIN', hint: 'Transport ferroviaire' },
    { word: 'VELO', hint: 'Transport a deux roues sans moteur' },
    { word: 'MOTEUR', hint: 'Piece qui transforme une energie en mouvement' },
    { word: 'BATTERIE', hint: 'Stockage d energie electrique' },
    { word: 'CASQUE', hint: 'Protection de la tete' },
    { word: 'LANTERNE', hint: 'Source de lumiere portable' },
    { word: 'HORIZON', hint: 'Ligne apparente entre ciel et terre' },
    { word: 'PARACHUTE', hint: 'Permet de ralentir une chute' },
    { word: 'BANANE', hint: 'Fruit jaune riche en potassium' },
    { word: 'CERISE', hint: 'Petit fruit rouge a noyau' },
    { word: 'CHOCOLAT', hint: 'Gourmandise issue du cacao' },
    { word: 'FROMAGE', hint: 'Produit laitier affine' },
    { word: 'PATISSERIE', hint: 'Art des desserts' },
    { word: 'CROISSANT', hint: 'Viennoiserie en forme de lune' },
    { word: 'BAGUETTE', hint: 'Pain francais long et fin' },
    { word: 'FESTIVAL', hint: 'Evenement culturel' },
    { word: 'VACANCES', hint: 'Periode de repos' },
    { word: 'VOYAGE', hint: 'Deplacement vers un autre lieu' },
    { word: 'CARTE', hint: 'Representation geographique' },
    { word: 'BOUSSOLE', hint: 'Outil d orientation' },
    { word: 'PHARE', hint: 'Tour lumineuse pour guider les bateaux' },
    { word: 'TRIANGLE', hint: 'Forme a trois cotes' },
    { word: 'RECTANGLE', hint: 'Forme a quatre angles droits' },
    { word: 'CERCLE', hint: 'Forme ronde' },
    { word: 'PYRAMIDE', hint: 'Monument celebre d Egypte' },
    { word: 'SEMAPHORE', hint: 'Signalisation lumineuse routiere' }
];

function getRandomTriviaQuestions(count) {
    return [...TRIVIA_QUESTION_BANK].sort(() => Math.random() - 0.5).slice(0, Math.min(count, TRIVIA_QUESTION_BANK.length));
}

function getRandomHangmanWord() {
    return HANGMAN_WORD_BANK[Math.floor(Math.random() * HANGMAN_WORD_BANK.length)];
}

function getHangmanHintState(game) {
    const wrongCount = game.wrong.length;
    const reveal = wrongCount >= 3;
    let text = '';
    if (reveal) {
        text = game.hint || '';
        if (!text && wrongCount >= 5) {
            text = `Le mot commence par ${game.word.charAt(0)} et contient ${game.word.length} lettres`;
        }
    }
    return { visible: reveal, text };
}

const ARENA2D_MODE_POOL = [
    { key: 'coin_rush', label: 'Coin Rush', coinValue: 1, targetScore: 12, moveCooldownMs: 70, coinCount: 8 },
    { key: 'turbo_rush', label: 'Turbo Rush', coinValue: 2, targetScore: 18, moveCooldownMs: 55, coinCount: 10 },
    { key: 'spike_storm', label: 'Spike Storm', coinValue: 1, targetScore: 11, moveCooldownMs: 72, coinCount: 8, hazardsCount: 20 },
    { key: 'sword_duel', label: 'Sword Duel', coinValue: 1, targetScore: 9, moveCooldownMs: 68, coinCount: 6 },
    { key: 'mario_pipes', label: 'Mario Pipes', coinValue: 1, targetScore: 12, moveCooldownMs: 66, coinCount: 8, pipesPairs: 3, jumpPadsCount: 6, wallsCount: 18 }
];

function pickArena2DMode() {
    const idx = Math.floor(Math.random() * ARENA2D_MODE_POOL.length);
    return { ...ARENA2D_MODE_POOL[idx], modeIndex: idx + 1 };
}

function getArenaBlockedPositions(state) {
    const blocked = [];
    (state.walls || []).forEach((w) => blocked.push({ x: w.x, y: w.y }));
    return blocked;
}

function spawnArenaCell(width, height, used, avoid = []) {
    const localUsed = used || new Set();
    const avoidSet = new Set((avoid || []).map((p) => `${p.x},${p.y}`));
    for (let i = 0; i < 400; i++) {
        const x = Math.floor(Math.random() * width);
        const y = Math.floor(Math.random() * height);
        const key = `${x},${y}`;
        if (!localUsed.has(key) && !avoidSet.has(key)) {
            localUsed.add(key);
            return { x, y };
        }
    }
    return null;
}

function spawnArenaFeatures(width, height, players, mode) {
    const used = new Set(players.map((p) => `${p.x},${p.y}`));
    const hazards = [];
    const walls = [];
    const jumpPads = [];
    const pipes = [];

    const hazardsCount = Number(mode.hazardsCount || 0);
    for (let i = 0; i < hazardsCount; i++) {
        const cell = spawnArenaCell(width, height, used);
        if (!cell) break;
        hazards.push(cell);
    }

    const wallsCount = Number(mode.wallsCount || 0);
    for (let i = 0; i < wallsCount; i++) {
        const cell = spawnArenaCell(width, height, used);
        if (!cell) break;
        walls.push(cell);
    }

    const jumpPadsCount = Number(mode.jumpPadsCount || 0);
    const vectors = [
        { dx: 2, dy: 0 },
        { dx: -2, dy: 0 },
        { dx: 0, dy: 2 },
        { dx: 0, dy: -2 }
    ];
    for (let i = 0; i < jumpPadsCount; i++) {
        const cell = spawnArenaCell(width, height, used);
        if (!cell) break;
        const vec = vectors[Math.floor(Math.random() * vectors.length)];
        jumpPads.push({ ...cell, dx: vec.dx, dy: vec.dy });
    }

    const pipesPairs = Number(mode.pipesPairs || 0);
    for (let i = 0; i < pipesPairs; i++) {
        const a = spawnArenaCell(width, height, used);
        const b = spawnArenaCell(width, height, used);
        if (!a || !b) break;
        pipes.push({ a, b });
    }

    return { hazards, walls, jumpPads, pipes, used };
}

function spawnArenaCoin(width, height, players, existingCoins, blockedPositions = []) {
    const occupied = new Set();
    players.forEach((p) => occupied.add(`${p.x},${p.y}`));
    (existingCoins || []).forEach((c) => occupied.add(`${c.x},${c.y}`));
    (blockedPositions || []).forEach((b) => occupied.add(`${b.x},${b.y}`));
    let tries = 0;
    while (tries < 200) {
        const x = Math.floor(Math.random() * width);
        const y = Math.floor(Math.random() * height);
        const key = `${x},${y}`;
        if (!occupied.has(key)) return { x, y };
        tries += 1;
    }
    return { x: Math.floor(width / 2), y: Math.floor(height / 2) };
}

function buildArenaState() {
    const width = 24;
    const height = 14;
    const mode = pickArena2DMode();
    const spawns = [
        { x: 2, y: Math.floor(height / 2) },
        { x: width - 3, y: Math.floor(height / 2) }
    ];
    const players = [
        { x: spawns[0].x, y: spawns[0].y, score: 0 },
        { x: spawns[1].x, y: spawns[1].y, score: 0 }
    ];
    const features = spawnArenaFeatures(width, height, players, mode);
    const blocked = [...getArenaBlockedPositions({ walls: features.walls })];
    const coins = [];
    for (let i = 0; i < Number(mode.coinCount || 8); i++) {
        const c = spawnArenaCoin(width, height, players, coins, blocked);
        if (c) coins.push(c);
    }
    return {
        width,
        height,
        players,
        coins,
        mode: mode.key,
        modeLabel: mode.label,
        modeIndex: Number(mode.modeIndex || 1),
        coinValue: Number(mode.coinValue || 1),
        targetScore: Number(mode.targetScore || 12),
        moveCooldownMs: Number(mode.moveCooldownMs || 70),
        lastMoveAt: [0, 0],
        spawns,
        hazards: features.hazards,
        walls: features.walls,
        jumpPads: features.jumpPads,
        pipes: features.pipes
    };
}

// Tâches de maintenance périodiques
setInterval(() => {
    // Nettoyer les indicateurs de frappe expirés
    const beforeCount = typingUsers.size;
    updateTypingIndicator();
    const afterCount = typingUsers.size;
    
    if (beforeCount > afterCount) {
        logActivity('SYSTEM', `Nettoyage indicateurs de frappe expirés`, {
            removed: beforeCount - afterCount
        });
    }
    
    // Nettoyer les utilisateurs inactifs (optionnel)
    const now = Date.now();
    const inactiveUsers = [];
    connectedUsers.forEach((user, socketId) => {
        if (now - user.lastActivity.getTime() > 30 * 60 * 1000) { // 30 minutes
            inactiveUsers.push({username: user.username, socketId});
            const socket = io.sockets.sockets.get(socketId);
            if (socket) socket.disconnect(true);
        }
    });
    
    if (inactiveUsers.length > 0) {
        logActivity('SYSTEM', `Utilisateurs inactifs déconnectés`, {
            count: inactiveUsers.length,
            users: inactiveUsers.map(u => u.username)
        });
    }
}, 60000); // Chaque minute

// XP passif vocal + progression mission vocal (1 fois / minute)
setInterval(() => {
    let anyXpChanged = false;
    for (const [roomName, roomData] of Object.entries(voiceRooms)) {
        for (const [socketId, participant] of roomData.participants.entries()) {
            if (!participant || participant.muted || participant.deafened) continue;
            const username = participant.username;
            if (!username) continue;

            const passiveResult = addRawXP(username, VOICE_PASSIVE_XP_PER_MINUTE);
            const missionRewards = applyMissionProgress(username, { voiceMinutes: 1 });

            if (passiveResult.gainedXP > 0 || missionRewards.length > 0) {
                anyXpChanged = true;
                io.to(socketId).emit('xp_data', buildXPDataPayload(username));
            }

            if (passiveResult.levelUp) {
                io.emit('system_message', {
                    type: 'system',
                    message: `🎉 ${username} a atteint le niveau ${passiveResult.newLevel} !`,
                    timestamp: new Date(),
                    id: messageId++
                });
            }

            for (const reward of missionRewards) {
                io.to(socketId).emit('daily_mission_reward', {
                    missionKey: reward.key,
                    missionLabel: reward.label,
                    rewardXP: reward.rewardXP,
                    rewardBananas: reward.rewardBananas || 0
                });
                if (reward.levelUp) {
                    io.emit('system_message', {
                        type: 'system',
                        message: `🎉 ${username} a atteint le niveau ${reward.newLevel} !`,
                        timestamp: new Date(),
                        id: messageId++
                    });
                }
            }
        }
    }

    if (anyXpChanged) saveXPData();
}, 60000);

// Nettoyage des fichiers une fois par jour
setInterval(cleanupOldFiles, 24 * 60 * 60 * 1000);

// Rotation/expiration des evenements live
setInterval(() => {
    refreshLiveOpsState();
}, 10000);

// Affichage des statistiques serveur
setInterval(() => {
    if (connectedUsers.size > 0 || serverStats.totalMessages > 0) {
        const memUsage = process.memoryUsage();
        const uptime = getTotalUptimeSeconds();
        
        logActivity('SYSTEM', `Statistiques serveur`, {
            utilisateursConnectes: connectedUsers.size,
            totalMessages: serverStats.totalMessages,
            totalUploads: serverStats.totalUploads,
            totalConnexions: serverStats.totalConnections,
            memoire: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`,
            uptime: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}min`,
            messagesEnHistorique: chatHistory.length,
            utilisateursEnFrappe: typingUsers.size
        });
    }
}, 300000); // Toutes les 5 minutes

// Sauvegarde régulière du temps serveur cumulé
setInterval(() => {
    saveServerRuntimeStats({ includeCurrentSession: true });
}, 30000);

// Démarrer le serveur
const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';

server.listen(PORT, HOST, () => {
    logActivity('SYSTEM', `${SERVER_NAME} v${SERVER_VERSION} démarré avec succès !`, {
        port: PORT,
        host: HOST,
        uploadsDir: uploadDir,
        environnement: process.env.NODE_ENV || 'development',
        nodeVersion: process.version,
        memoire: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`
    });
    
    // Nettoyage initial des anciens fichiers
    cleanupOldFiles();
});

// Gestion des erreurs serveur
server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
        logActivity('ERROR', `Port ${PORT} déjà utilisé - arrêt du serveur`, {
            port: PORT,
            host: HOST
        });
        process.exit(1);
    } else {
        logActivity('ERROR', 'Erreur serveur critique', {
            error: error.message,
            code: error.code,
            stack: error.stack
        });
    }
});

// Gestion propre de l'arrêt
function gracefulShutdown(signal) {
    if (shutdownInProgress) return;
    shutdownInProgress = true;

    logActivity('SYSTEM', `Signal ${signal} reçu - arrêt propre du serveur`, {
        signal: signal,
        utilisateursConnectes: connectedUsers.size,
        totalMessages: serverStats.totalMessages
    });
    
    // Notifier tous les clients
    io.emit('system_message', {
        type: 'system',
        message: 'Le serveur va redémarrer dans quelques instants...',
        timestamp: new Date(),
        id: messageId++
    });
    
    // Sauvegarder les statistiques finales
    const uptimeSession = getSessionUptimeSeconds();
    commitRuntimeSession();
    const uptimeTotal = Math.max(0, Math.floor(serverRuntimeStats.accumulatedUptimeSeconds || 0));
    const finalStats = {
        totalMessages: serverStats.totalMessages,
        totalUploads: serverStats.totalUploads,
        totalConnections: serverStats.totalConnections,
        uptimeSession,
        uptimeTotal,
        shutdownTime: new Date()
    };
    
    logActivity('SYSTEM', `Statistiques finales du serveur`, finalStats);

    // Flush explicite des buffers de persistance avant fermeture
    saveXPDataImmediate();
    saveMiniGameStatsImmediate();
    
    // Fermer le serveur
    server.close(() => {
        logActivity('SYSTEM', 'Serveur arrêté proprement');
        process.exit(0);
    });
    
    // Forcer l'arrêt après 10 secondes
    setTimeout(() => {
        logActivity('SYSTEM', 'Arrêt forcé du serveur');
        process.exit(1);
    }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Gestion des erreurs non capturées
process.on('uncaughtException', (error) => {
    logActivity('ERROR', 'Erreur non capturée - arrêt critique', {
        error: error.message,
        stack: error.stack
    });
    gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
    logActivity('ERROR', 'Promesse rejetée non gérée', {
        reason: reason,
        promise: promise
    });
    // Ne pas arrêter le serveur pour les promesses rejetées
});

// === NETTOYAGE AUTOMATIQUE DES TYPINGS EXPIRÉS ===
// Vérifie toutes les 2 secondes et nettoie les typings > 5 secondes
setInterval(() => {
    const now = Date.now();
    let hasExpired = false;
    
    typingUsers.forEach((data, socketId) => {
        if (now - data.timestamp > 5000) {
            typingUsers.delete(socketId);
            hasExpired = true;
        }
    });
    
    // Si des typings ont expiré, envoyer la mise à jour
    if (hasExpired) {
        io.emit('channel_typing_update', getChannelTypingUsers());
        updateTypingIndicator();
    }
}, 2000);

// === AUTO PROMOTIONS BOUTIQUE ===
setInterval(() => {
    const now = Date.now();
    // Expirer la promo active
    if (shopPromotion.active && shopPromotion.endsAt > 0 && now >= shopPromotion.endsAt) {
        shopPromotion.active = false;
        shopPromotion.discount = 0;
        shopPromotion.endsAt = 0;
        shopPromotion.label = '';
        io.emit('shop_promotion_state', shopPromotion);
        logActivity('SYSTEM', 'Promotion boutique expirée automatiquement');
    }
    // Lancer une auto-promo si configurée
    if (shopPromotion.autoMode && !shopPromotion.active && shopPromotion.nextAutoAt > 0 && now >= shopPromotion.nextAutoAt) {
        shopPromotion.active = true;
        shopPromotion.discount = shopPromotion.autoDiscountPercent;
        shopPromotion.label = `🔥 Promo auto -${shopPromotion.discount}%`;
        shopPromotion.endsAt = now + shopPromotion.autoDurationMinutes * 60 * 1000;
        shopPromotion.nextAutoAt = shopPromotion.endsAt + shopPromotion.autoIntervalMinutes * 60 * 1000;
        io.emit('shop_promotion_state', shopPromotion);
        logActivity('SYSTEM', `Promotion auto lancée: -${shopPromotion.discount}%`);
    }
}, 30000);

// === KEEP-ALIVE POUR FLY.IO ===
// Fly.io peut arrêter les machines inactives
// On fait des pings réguliers pour maintenir le serveur actif
const KEEP_ALIVE_INTERVAL = PERF_CONFIG.keepAliveIntervalMs;
let keepAliveCount = 0;

// Créer une route /health-lite dédiée au ping interne
app.get('/health-lite', (req, res) => {
    res.status(200).json({
        status: 'ok',
        uptime: getTotalUptimeSeconds(),
        sessionUptime: getSessionUptimeSeconds(),
        timestamp: new Date().toISOString(),
        users: connectedUsers.size,
        keepAliveCount: keepAliveCount
    });
});

// Self-ping pour garder le serveur actif
const https = require('https');
function keepAlive() {
    keepAliveCount++;
    const now = new Date().toLocaleTimeString('fr-FR');
    
    // Log moins verbeux (1 sur 5)
    if (keepAliveCount % 5 === 1) {
        console.log(`[${now}] 💓 Keep-alive #${keepAliveCount} - ${connectedUsers.size} utilisateurs connectés`);
    }
    
    // Sur Fly.io ou Render, utiliser l'URL publique si disponible
    const publicUrl = process.env.FLY_APP_NAME ? `https://${process.env.FLY_APP_NAME}.fly.dev` : process.env.RENDER_EXTERNAL_URL;
    if (publicUrl) {
        const protocol = publicUrl.startsWith('https') ? https : require('http');
        protocol.get(`${publicUrl}/health`, (res) => {
            // Ping réussi
        }).on('error', (err) => {
            // Ignorer les erreurs silencieusement
        });
    } else {
        // En local, ping localhost
        const PORT = process.env.PORT || 8080;
        require('http').get(`http://localhost:${PORT}/health`, (res) => {
            // Ping réussi
        }).on('error', (err) => {
            // Ignorer les erreurs
        });
    }
}

// Démarrer le keep-alive
setInterval(keepAlive, KEEP_ALIVE_INTERVAL);
keepAlive(); // Premier ping immédiat

console.log(`⏰ Keep-alive configuré: ping toutes les 4 minutes`);
console.log(`🌐 Route /health disponible pour monitoring`);
console.log(`🌐 Route /api/server/dashboard disponible pour supervision externe`);

logActivity('SYSTEM', 'Tous les gestionnaires d\'événements configurés', {
    maxHistoryMessages: MAX_HISTORY,
    uploadDir: uploadDir
});
