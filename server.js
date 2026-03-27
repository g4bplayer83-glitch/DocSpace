const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const crypto = require('crypto');

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

// === SALONS MULTIPLES (BETA) ===
const AVAILABLE_CHANNELS = ['général', 'présentation', 'jeux', 'musique', 'films', 'random', 'aide', 'ia'];
const VOICE_CHANNELS = ['Vocal Général', 'Vocal Gaming', 'Vocal Musique'];
let voiceRooms = {}; // { roomName: { participants: Map(socketId -> {username, muted, deafened, video, screen}) } }
VOICE_CHANNELS.forEach(vc => {
    voiceRooms[vc] = { participants: new Map() };
});
let channelHistories = {}; // { channelName: [messages] }
let channelReactions = {}; // { channelName: { messageId: {emoji: [usernames]} } }

// Initialiser les historiques par salon
AVAILABLE_CHANNELS.forEach(ch => {
    channelHistories[ch] = [];
    channelReactions[ch] = {};
});

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
const XP_PER_MESSAGE = 15;
const XP_PER_REACTION = 5;
const XP_LEVEL_BASE = 100; // XP for level 1, doubles each level
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
    return Math.floor(data.xp / 10);
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
// Pour render.com: créer un Disk persistant et définir RENDER_DISK_PATH=/var/data
// Sinon utilise le dossier local 'data'
const DATA_DIR = process.env.RENDER_DISK_PATH || path.join(__dirname, 'data');
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

console.log(`📂 Dossier de données: ${DATA_DIR}`);

// Créer le dossier data si nécessaire
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log(`📁 Dossier créé: ${DATA_DIR}`);
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
    } catch (error) {
        console.error('❌ Erreur sauvegarde salons:', error.message);
    }
}

function saveReactions() {
    try {
        fs.writeFileSync(REACTIONS_FILE, JSON.stringify(messageReactions, null, 2));
    } catch (error) {
        console.error('❌ Erreur sauvegarde réactions:', error.message);
    }
}

// === SAUVEGARDE/CHARGEMENT DMs ===
function saveDMs() {
    try {
        fs.writeFileSync(DM_FILE, JSON.stringify(dmHistory, null, 2));
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
loadDMs();

// Charger les données au démarrage
loadPersistedData();
loadPinnedMessages();

// === CHARGEMENT DES NOUVELLES DONNÉES ===
function loadXPData() {
    try {
        if (fs.existsSync(XP_FILE)) {
            userXP = JSON.parse(fs.readFileSync(XP_FILE, 'utf8'));
            console.log(`✅ XP chargé: ${Object.keys(userXP).length} utilisateurs`);
        }
    } catch (e) { console.error('❌ Erreur chargement XP:', e.message); userXP = {}; }
}
function saveXPData() {
    try { fs.writeFileSync(XP_FILE, JSON.stringify(userXP, null, 2)); } catch (e) { console.error('❌ Erreur sauvegarde XP:', e.message); }
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
    try { fs.writeFileSync(FRIENDS_FILE, JSON.stringify(friendships, null, 2)); } catch (e) { console.error('❌ Erreur sauvegarde amitiés:', e.message); }
}

// Envoyer la liste d'amis mise à jour à un utilisateur connecté (par username)
function emitFriendsListTo(username) {
    const data = friendships[username] || { friends: [], pending: [], requests: [] };
    const friendsWithStatus = (data.friends || []).map(f => {
        let online = false;
        for (const [, u] of connectedUsers.entries()) {
            if (u.username === f) { online = true; break; }
        }
        return { username: f, online };
    });
    for (const [sid, u] of connectedUsers.entries()) {
        if (u.username === username) {
            io.to(sid).emit('friends_list', { friends: friendsWithStatus, pending: data.pending, requests: data.requests });
            break;
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
    try { fs.writeFileSync(BOOKMARKS_FILE, JSON.stringify(userBookmarks, null, 2)); } catch (e) { console.error('❌ Erreur sauvegarde bookmarks:', e.message); }
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
    try { fs.writeFileSync(REMINDERS_FILE, JSON.stringify({ reminders, lastId: reminderIdCounter }, null, 2)); } catch (e) { console.error('❌ Erreur sauvegarde rappels:', e.message); }
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
    try { fs.writeFileSync(AUTOMOD_FILE, JSON.stringify(autoModConfig, null, 2)); } catch (e) { console.error('❌ Erreur sauvegarde AutoMod:', e.message); }
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
    try { fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2)); } catch (e) { console.error('❌ Erreur sauvegarde comptes:', e.message); }
}

loadXPData();
loadFriendships();
loadBookmarks();
loadReminders();
loadAutoMod();
loadAccounts();

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
function grantXP(username, amount) {
    if (!userXP[username]) userXP[username] = { xp: 0, level: 0, totalMessages: 0, lastXpGain: 0 };
    
    const now = Date.now();
    // Cooldown: only gain XP once per 30 seconds per message
    if (now - userXP[username].lastXpGain < 30000) return null;
    
    const oldLevel = getLevelFromXP(userXP[username].xp).level;
    userXP[username].xp += amount;
    userXP[username].lastXpGain = now;
    const newLevelData = getLevelFromXP(userXP[username].xp);
    
    if (newLevelData.level > oldLevel) {
        saveXPData();
        return { levelUp: true, newLevel: newLevelData.level, username };
    }
    
    // Save periodically (every 5 XP gains)
    if (userXP[username].xp % (amount * 5) < amount) saveXPData();
    return null;
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
// Définir ADMIN_KEY dans les variables d'environnement de render.com
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

// Route de santé pour Render avec stats détaillées
app.get('/health', (req, res) => {
    const uptime = Math.floor(process.uptime());
    const memUsage = process.memoryUsage();
    
    const healthData = {
        status: 'OK',
        uptime: `${Math.floor(uptime / 60)}min ${uptime % 60}s`,
        users: connectedUsers.size,
        messages: chatHistory.length,
        totalMessages: serverStats.totalMessages,
        totalUploads: serverStats.totalUploads,
        totalConnections: serverStats.totalConnections,
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

// === API STATISTIQUES PUBLIQUES ===
app.get('/api/stats', (req, res) => {
    const uptime = Math.floor(process.uptime());
    const totalChannelMessages = Object.values(channelHistories).reduce((sum, arr) => sum + arr.length, 0);
    
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
        channels: channelStats,
        uptime: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
        activePolls: Object.keys(polls).length,
        dmConversations: Object.keys(dmHistory).length
    });
});

// Gestion des connexions Socket.IO
io.on('connection', (socket) => {
    const clientIp = socket.handshake.address;
    serverStats.totalConnections++;
    
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
        
        if (action === 'add' && userIndex === -1) {
            messageReactions[messageId][emoji].push(username);
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
                
                setTimeout(() => {
                    process.exit(0); // render.com redémarrera automatiquement
                }, 2000);
                break;
            
            case 'get_stats':
                const uptimeSeconds = Math.floor((new Date() - serverStats.startTime) / 1000);
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
            const { username, avatar, accessCode } = userData;
            
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
            
            // Vérifier si le pseudo est déjà pris
            const existingUser = Array.from(connectedUsers.values()).find(user => 
                user.username.toLowerCase() === cleanUsername.toLowerCase()
            );
            
            if (existingUser) {
                logActivity('ERROR', `Tentative d'utilisation d'un pseudo déjà pris`, {
                    socketId: socket.id,
                    username: cleanUsername,
                    ip: clientIp,
                    existingSocketId: existingUser.id
                });
                socket.emit('username_taken', { message: 'Ce pseudo est déjà pris!' });
                return;
            }

            // Ajouter l'utilisateur
            const userInfo = {
                id: socket.id,
                username: cleanUsername,
                avatar: avatar || '',
                joinTime: new Date(),
                ip: clientIp,
                lastActivity: new Date(),
                messagesCount: 0,
                repliesCount: 0
            };
            
            connectedUsers.set(socket.id, userInfo);

            // Sauvegarder le profil
            const existingProfile = userProfiles.get(cleanUsername) || {};
            userProfiles.set(cleanUsername, {
                username: cleanUsername,
                avatar: userInfo.avatar,
                lastSeen: new Date(),
                joinCount: (existingProfile.joinCount || 0) + 1,
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
            
            // Send new feature data
            const xpData = userXP[cleanUsername] || { xp: 0, level: 0, totalMessages: 0 };
            socket.emit('xp_data', { xp: xpData.xp, ...getLevelFromXP(xpData.xp), totalMessages: xpData.totalMessages });
            socket.emit('friends_list', friendships[cleanUsername] || { friends: [], pending: [], requests: [] });
            socket.emit('bookmarks_list', { bookmarks: userBookmarks[cleanUsername] || [] });
            socket.emit('reminders_list', { reminders: (reminders[cleanUsername] || []).filter(r => r.triggerAt > Date.now()) });
            
            // Envoyer l'état des salons vocaux
            for (const [room, data] of Object.entries(voiceRooms)) {
                socket.emit('voice_participants_update', { room, participants: getVoiceParticipants(room) });
            }
            
            logActivity('SYSTEM', `Historique envoyé à ${cleanUsername}`, {
                messagesCount: chatHistory.length,
                reactionsCount: Object.keys(messageReactions).length
            });
            
            // Message de bienvenue (APRES l'historique)
            const joinMessage = {
                type: 'system',
                message: `${cleanUsername} a rejoint le chat`,
                timestamp: new Date(),
                id: messageId++
            };
            
            addToHistory(joinMessage);
            io.emit('system_message', joinMessage);
            
            // Envoyer la liste des utilisateurs connectés
            updateUsersList();
            
            // Notifier les amis que cet utilisateur est en ligne
            notifyFriendsOfStatusChange(cleanUsername);
            
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
                avatar: user.avatar,
                content: messageData.content ? messageData.content.trim().substring(0, 500) : '',
                timestamp: new Date(),
                userId: socket.id,
                replyTo: messageData.replyTo || null,
                attachment: messageData.attachment || null,
                channel: channel // Ajouter le salon au message
            };

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
            if (!userXP[user.username]) userXP[user.username] = { xp: 0, level: 0, totalMessages: 0, lastXpGain: 0 };
            userXP[user.username].totalMessages++;
            const xpResult = grantXP(user.username, XP_PER_MESSAGE);
            if (xpResult && xpResult.levelUp) {
                io.emit('system_message', {
                    type: 'system',
                    message: `🎉 ${user.username} a atteint le niveau ${xpResult.newLevel} !`,
                    timestamp: new Date(),
                    id: messageId++
                });
            }
            
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
        
        const { channel, previousChannel } = data;
        
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
                otherParticipants.push({ socketId: pId, username: pData.username });
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
        io.to(targetId).emit('voice_offer', { fromId: socket.id, fromUsername: user.username, offer });
    });
    
    // Signaling WebRTC - Answer
    socket.on('voice_answer', (data) => {
        const { targetId, answer } = data;
        io.to(targetId).emit('voice_answer', { fromId: socket.id, answer });
    });
    
    // Signaling WebRTC - ICE Candidate
    socket.on('voice_ice_candidate', (data) => {
        const { targetId, candidate } = data;
        io.to(targetId).emit('voice_ice_candidate', { fromId: socket.id, candidate });
    });
    
    // Détection de parole
    socket.on('voice_speaking', (data) => {
        for (const [rName, rData] of Object.entries(voiceRooms)) {
            const participant = rData.participants.get(socket.id);
            if (participant) {
                participant.speaking = !!data.speaking;
                io.emit('voice_participants_update', { room: rName, participants: getVoiceParticipants(rName) });
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
            
            // Retirer de la liste des admins
            const adminIndex = adminUsersList.indexOf(user.username);
            if (adminIndex > -1) {
                adminUsersList.splice(adminIndex, 1);
                io.emit('admin_list_update', { admins: adminUsersList });
            }
            
            // Message de départ
            const leaveMessage = {
                type: 'system',
                message: `${user.username} a quitté le chat`,
                timestamp: new Date(),
                id: messageId++
            };
            
            addToHistory(leaveMessage);
            io.emit('system_message', leaveMessage);
            
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
            updateUsersList();
            
            // Notifier les amis que cet utilisateur est hors ligne
            notifyFriendsOfStatusChange(user.username);
            
            logActivity('DISCONNECTION', `Utilisateur déconnecté`, {
                username: user.username,
                reason: reason,
                sessionDuration: `${Math.floor(sessionDuration / 1000)}s`,
                messagesInSession: user.messagesCount,
                repliesInSession: user.repliesCount,
                remainingUsers: connectedUsers.size
            });
        } else {
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
        
        const profile = {
            username: targetUsername,
            status: status,
            bio: savedProfile.bio || '',
            joinDate: savedProfile.firstJoin || savedProfile.joinedAt,
            messageCount: savedProfile.totalMessages || 0,
            avatar: savedProfile.avatar || (targetUser?.avatar)
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
            initialData = { display, wrong: [], remaining: game.state.maxErrors, wordLength: game.state.word.length };
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
        const data = userXP[user.username] || { xp: 0, level: 0, totalMessages: 0 };
        const levelData = getLevelFromXP(data.xp);
        socket.emit('xp_data', { xp: data.xp, ...levelData, totalMessages: data.totalMessages, bananaPoints: getBananaPoints(user.username) });
    });

    socket.on('get_leaderboard', () => {
        const leaderboard = Object.entries(userXP)
            .map(([username, data]) => ({ username, xp: data.xp, ...getLevelFromXP(data.xp), totalMessages: data.totalMessages, bananaPoints: getBananaPoints(username) }))
            .sort((a, b) => b.xp - a.xp)
            .slice(0, 20);
        socket.emit('leaderboard_data', { leaderboard });
    });

    socket.on('banana_use', (data) => {
        const user = connectedUsers.get(socket.id);
        if (!user) return;

        const costs = { confetti: 5, shake: 3, flash: 3, rain: 8, fireworks: 10 };
        const effect = data.effect;
        const cost = costs[effect];
        if (!cost) {
            socket.emit('banana_error', { message: 'Effet inconnu' });
            return;
        }

        const bananas = getBananaPoints(user.username);
        if (bananas < cost) {
            socket.emit('banana_error', { message: `Pas assez de bananes ! (${bananas}/${cost} 🍌)` });
            return;
        }

        if (!userXP[user.username]) userXP[user.username] = { xp: 0, level: 0, totalMessages: 0, lastXpGain: 0 };
        userXP[user.username].xp = Math.max(0, userXP[user.username].xp - cost * 10);
        saveXP();

        io.emit('banana_effect', { effect, username: user.username });
        socket.emit('banana_updated', { bananaPoints: getBananaPoints(user.username) });
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
        const words = ['JAVASCRIPT','PYTHON','SERVEUR','DISCORD','ORDINATEUR','INTERNET','CLAVIER','ECRAN','PROGRAMME','FONCTION','VARIABLE','TABLEAU','BOUCLE','CONDITION','MUSIQUE','CINEMA','GALAXIE','PLANETE','ETOILE','LICORNE','DRAGON','CHATEAU','PIRATE','ROBOT','ESPACE','AVENTURE'];
        const word = words[Math.floor(Math.random() * words.length)];
        const gameState = {
            word,
            guessed: [],
            wrong: [],
            maxErrors: 6,
            display: word.split('').map(() => '_').join(' ')
        };
        socket.hangmanGame = gameState;
        socket.emit('hangman_state', {
            display: gameState.display,
            wrong: gameState.wrong,
            remaining: gameState.maxErrors - gameState.wrong.length,
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
        
        socket.emit('hangman_state', {
            display,
            wrong: game.wrong,
            remaining: game.maxErrors - game.wrong.length,
            finished: won || lost,
            won,
            word: (won || lost) ? game.word : undefined
        });
        
        if (won) {
            const xpResult = grantXP(user.username, 50);
            if (xpResult && xpResult.levelUp) {
                io.emit('system_message', { type: 'system', message: `🎉 ${user.username} a atteint le niveau ${xpResult.newLevel} !`, timestamp: new Date(), id: messageId++ });
            }
            socket.hangmanGame = null;
        } else if (lost) {
            socket.hangmanGame = null;
        }
    });

    // =========================================
    // === TRIVIA GAME ===
    // =========================================
    socket.on('start_trivia', () => {
        const user = connectedUsers.get(socket.id);
        if (!user) return;
        
        const questions = [
            { q: "Quelle est la capitale de la France ?", a: ["Paris", "Lyon", "Marseille", "Toulouse"], correct: 0 },
            { q: "Combien de continents y a-t-il ?", a: ["5", "6", "7", "8"], correct: 2 },
            { q: "Quel est le plus grand océan ?", a: ["Atlantique", "Pacifique", "Indien", "Arctique"], correct: 1 },
            { q: "En quelle année a été créé Internet ?", a: ["1969", "1983", "1991", "2000"], correct: 0 },
            { q: "Quel langage a créé le Web ?", a: ["Java", "Python", "HTML", "C++"], correct: 2 },
            { q: "Combien de pattes a une araignée ?", a: ["6", "8", "10", "4"], correct: 1 },
            { q: "Quelle planète est la plus proche du Soleil ?", a: ["Vénus", "Mercure", "Mars", "Terre"], correct: 1 },
            { q: "Quel est le plus long fleuve du monde ?", a: ["Amazone", "Nil", "Yangtsé", "Mississippi"], correct: 1 },
            { q: "Qui a peint la Joconde ?", a: ["Michel-Ange", "Raphaël", "Léonard de Vinci", "Botticelli"], correct: 2 },
            { q: "Combien d'os a le corps humain adulte ?", a: ["186", "206", "226", "256"], correct: 1 },
            { q: "Quel animal est le plus rapide ?", a: ["Lion", "Guépard", "Faucon pèlerin", "Lévrier"], correct: 2 },
            { q: "Quelle est la monnaie du Japon ?", a: ["Yuan", "Won", "Yen", "Baht"], correct: 2 },
            { q: "En quelle année le mur de Berlin est-il tombé ?", a: ["1987", "1989", "1991", "1993"], correct: 1 },
            { q: "Quel est le symbole chimique de l'or ?", a: ["Ag", "Au", "Or", "Go"], correct: 1 },
            { q: "Combien de couleurs dans un arc-en-ciel ?", a: ["5", "6", "7", "8"], correct: 2 },
            { q: "Quel est le plus petit pays du monde ?", a: ["Monaco", "Vatican", "Nauru", "San Marino"], correct: 1 },
            { q: "Qui a écrit 'Les Misérables' ?", a: ["Zola", "Hugo", "Balzac", "Dumas"], correct: 1 },
            { q: "Quel gaz les plantes absorbent-elles ?", a: ["Oxygène", "Azote", "CO2", "Hydrogène"], correct: 2 },
            { q: "Combien de touches sur un piano standard ?", a: ["76", "82", "88", "92"], correct: 2 },
            { q: "Quelle est la vitesse de la lumière ?", a: ["150 000 km/s", "300 000 km/s", "500 000 km/s", "1 000 000 km/s"], correct: 1 }
        ];
        
        // Pick 5 random questions
        const shuffled = questions.sort(() => Math.random() - 0.5).slice(0, 5);
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
            socket.emit('trivia_result', {
                correct,
                correctAnswer: q.correct,
                score: game.score,
                total: game.total,
                finished: true,
                xpGained
            });
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
            const triviaQuestions = [
                { q: "Quelle est la capitale de la France ?", a: ["Paris", "Lyon", "Marseille", "Toulouse"], correct: 0 },
                { q: "Combien de continents y a-t-il ?", a: ["5", "6", "7", "8"], correct: 2 },
                { q: "Quel est le plus grand océan ?", a: ["Atlantique", "Pacifique", "Indien", "Arctique"], correct: 1 },
                { q: "En quelle année a été créé Internet ?", a: ["1969", "1983", "1991", "2000"], correct: 0 },
                { q: "Quel langage a créé le Web ?", a: ["Java", "Python", "HTML", "C++"], correct: 2 },
                { q: "Combien de pattes a une araignée ?", a: ["6", "8", "10", "4"], correct: 1 },
                { q: "Quelle planète est la plus proche du Soleil ?", a: ["Vénus", "Mercure", "Mars", "Terre"], correct: 1 },
                { q: "Quel est le plus long fleuve du monde ?", a: ["Amazone", "Nil", "Yangtsé", "Mississippi"], correct: 1 },
                { q: "Qui a peint la Joconde ?", a: ["Michel-Ange", "Raphaël", "Léonard de Vinci", "Botticelli"], correct: 2 },
                { q: "Combien d'os a le corps humain adulte ?", a: ["186", "206", "226", "256"], correct: 1 }
            ];
            const questions = triviaQuestions.sort(() => Math.random() - 0.5).slice(0, 5);
            return { questions, current: 0, scores: [0, 0], answers: [null, null], total: questions.length };
        }
        case 'hangman': {
            const words = ['JAVASCRIPT','PYTHON','SERVEUR','DISCORD','ORDINATEUR','INTERNET','CLAVIER','PROGRAMME','MUSIQUE','GALAXIE','PLANETE','DRAGON','CHATEAU','PIRATE','ROBOT','AVENTURE'];
            const word = words[Math.floor(Math.random() * words.length)];
            return { word, guessed: [], wrong: [], maxErrors: 6, currentGuesser: 0 };
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
                    finished: won || lost,
                    won,
                    word: (won || lost) ? game.state.word : undefined
                }
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
    const usersList = Array.from(connectedUsers.values()).map(user => {
        // Récupérer le statut personnalisé s'il existe
        const savedStatus = userStatuses[user.username] || {};
        return {
            id: user.id,
            username: user.username,
            avatar: user.avatar,
            joinTime: user.joinTime,
            lastActivity: user.lastActivity,
            messagesCount: user.messagesCount,
            repliesCount: user.repliesCount,
            status: savedStatus.status || 'online',
            customStatus: savedStatus.customText || ''
        };
    });
    
    io.emit('users_update', {
        count: connectedUsers.size,
        users: usersList
    });
    
    logActivity('SYSTEM', `Liste des utilisateurs mise à jour`, {
        totalUsers: connectedUsers.size,
        activeUsers: usersList.map(u => u.username)
    });
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

// Nettoyage des fichiers une fois par jour
setInterval(cleanupOldFiles, 24 * 60 * 60 * 1000);

// Affichage des statistiques serveur
setInterval(() => {
    if (connectedUsers.size > 0 || serverStats.totalMessages > 0) {
        const memUsage = process.memoryUsage();
        const uptime = process.uptime();
        
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

// Démarrage du serveur
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

server.listen(PORT, HOST, () => {
    logActivity('SYSTEM', `DocSpace Server v2.3 démarré avec succès !`, {
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
    const finalStats = {
        totalMessages: serverStats.totalMessages,
        totalUploads: serverStats.totalUploads,
        totalConnections: serverStats.totalConnections,
        uptime: process.uptime(),
        shutdownTime: new Date()
    };
    
    logActivity('SYSTEM', `Statistiques finales du serveur`, finalStats);
    
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

// === KEEP-ALIVE AMÉLIORÉ POUR RENDER.COM ===
// Render.com éteint les serveurs inactifs après 15 minutes
// On fait des pings réguliers pour maintenir le serveur actif
const KEEP_ALIVE_INTERVAL = 4 * 60 * 1000; // 4 minutes (plus fréquent)
let keepAliveCount = 0;

// Créer une route /health pour le ping
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'ok',
        uptime: process.uptime(),
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
    
    // Sur Render, utiliser l'URL publique si disponible
    const renderUrl = process.env.RENDER_EXTERNAL_URL;
    if (renderUrl) {
        const protocol = renderUrl.startsWith('https') ? https : require('http');
        protocol.get(`${renderUrl}/health`, (res) => {
            // Ping réussi
        }).on('error', (err) => {
            // Ignorer les erreurs silencieusement
        });
    } else {
        // En local, ping localhost
        const PORT = process.env.PORT || 3000;
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

logActivity('SYSTEM', 'Tous les gestionnaires d\'événements configurés', {
    maxHistoryMessages: MAX_HISTORY,
    uploadDir: uploadDir
});
