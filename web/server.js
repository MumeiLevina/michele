const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const { createServer } = require('node:http');
const { Server } = require('socket.io');

const { hasDjPermission } = require('../utils/music');
const {
    createState,
    play,
    pause,
    resume,
    skip,
    stop,
    seek,
    setVolume,
    toggleTrackRepeat
} = require('../utils/musicControl');
const { hasDashboardAccess } = require('../utils/dashboardAccess');
const { handleGeminiRequest } = require('../utils/geminihandler');
const config = require('../utils/config');
const User = require('../models/user');
const Conversation = require('../models/conversation');

const DEFAULT_WEB_PORT = Number(process.env.WEB_PORT) || 3000;
const DISCORD_OAUTH_AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';
const DISCORD_OAUTH_TOKEN_URL = 'https://discord.com/api/oauth2/token';
const DISCORD_API_BASE_URL = 'https://discord.com/api/v10';
const SESSION_COOKIE_MAX_AGE_MS = 1000 * 60 * 60 * 12;
const MAX_CONVERSATION_MESSAGES = 40;

function ensureSessionCsrf(req) {
    if (!req.session.csrfToken) {
        req.session.csrfToken = crypto.randomBytes(24).toString('hex');
    }
    return req.session.csrfToken;
}

function requireCsrf(req, res, next) {
    const expected = req.session?.csrfToken;
    const provided = req.get('x-csrf-token');

    if (!expected || !provided || expected !== provided) {
        res.status(403).json({ error: 'Invalid CSRF token.' });
        return;
    }

    next();
}

function toSafeUser(user) {
    if (!user) return null;
    return {
        id: user.id,
        username: user.username,
        discriminator: user.discriminator || null,
        globalName: user.global_name || null,
        avatar: user.avatar || null
    };
}

function buildDiscordAvatarUrl(user) {
    if (!user?.id || !user?.avatar) return null;
    return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`;
}

async function exchangeDiscordCodeForToken(code) {
    const clientId = process.env.DISCORD_CLIENT_ID || process.env.CLIENT_ID;
    if (!clientId) {
        throw new Error('Missing DISCORD_CLIENT_ID (or CLIENT_ID).');
    }

    const params = new URLSearchParams({
        client_id: clientId,
        client_secret: process.env.DISCORD_CLIENT_SECRET || '',
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.DISCORD_REDIRECT_URI || '',
        scope: 'identify guilds'
    });

    const response = await fetch(DISCORD_OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params.toString()
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Token exchange failed: ${response.status} ${text}`);
    }

    return response.json();
}

async function fetchDiscordResource(accessToken, endpoint) {
    const response = await fetch(`${DISCORD_API_BASE_URL}${endpoint}`, {
        headers: {
            Authorization: `Bearer ${accessToken}`
        }
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Discord API ${endpoint} failed: ${response.status} ${text}`);
    }

    return response.json();
}

function normalizeGuildRequestId(req) {
    const raw = req.query.guildId || req.body?.guildId;
    if (!raw || typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!/^\d{17,20}$/.test(trimmed)) return null;
    return trimmed;
}

function getSessionUser(req) {
    return req.session?.auth?.user || null;
}

function requireAuthenticated(req, res, next) {
    const user = getSessionUser(req);
    if (!user?.id) {
        res.status(401).json({ error: 'You must login first.' });
        return;
    }
    next();
}

async function buildAccessibleGuilds(client, userId) {
    const guilds = [];
    for (const guild of client.guilds.cache.values()) {
        const member = await guild.members.fetch(userId).catch(() => null);
        if (!member) continue;

        const dj = hasDjPermission(member);
        const hasAccess = dj || await hasDashboardAccess(member, guild.id);
        if (!hasAccess) continue;

        guilds.push({
            id: guild.id,
            name: guild.name,
            icon: guild.icon
                ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=128`
                : null,
            memberCount: guild.memberCount ?? null,
            permissions: {
                isDjOrAdmin: dj
            }
        });
    }
    return guilds;
}

async function resolveGuildContext(client, req) {
    const guildId = normalizeGuildRequestId(req);
    if (!guildId) {
        const error = new Error('Invalid guildId.');
        error.status = 400;
        throw error;
    }

    const sessionUser = getSessionUser(req);
    if (!sessionUser?.id) {
        const error = new Error('Unauthenticated.');
        error.status = 401;
        throw error;
    }

    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
        const error = new Error('Bot is not in this guild.');
        error.status = 404;
        throw error;
    }

    const member = await guild.members.fetch(sessionUser.id).catch(() => null);
    if (!member) {
        const error = new Error('You are not in this guild.');
        error.status = 403;
        throw error;
    }

    const hasAccess = await hasDashboardAccess(member, guild.id);
    if (!hasAccess) {
        const error = new Error('You do not have dashboard access.');
        error.status = 403;
        throw error;
    }

    return { guild, member };
}

function requireMusicControlEligibility({ member, guild }) {
    if (!hasDjPermission(member)) {
        const error = new Error('Bạn cần role DJ/Admin để điều khiển nhạc trên dashboard.');
        error.status = 403;
        throw error;
    }

    const memberVoice = member.voice?.channel;
    const botVoiceId = guild.members.me?.voice?.channelId || null;

    if (!memberVoice) {
        const error = new Error('Bạn cần vào voice channel trước.');
        error.status = 400;
        throw error;
    }

    if (botVoiceId && memberVoice.id !== botVoiceId) {
        const error = new Error('Bạn cần ở cùng voice channel với bot.');
        error.status = 400;
        throw error;
    }

    return memberVoice;
}

function createPlayerBroadcaster(io, client) {
    const emitGuildState = guildId => {
        if (!guildId) return;
        io.to(`guild:${guildId}`).emit('music:state', {
            guildId,
            state: createState(client, guildId)
        });
    };

    client.player.events.on('playerStart', queue => {
        emitGuildState(queue.guild?.id || queue.guildId);
    });
    client.player.events.on('audioTrackAdd', queue => {
        emitGuildState(queue.guild?.id || queue.guildId);
    });
    client.player.events.on('audioTracksAdd', queue => {
        emitGuildState(queue.guild?.id || queue.guildId);
    });
    client.player.events.on('playerSkip', queue => {
        emitGuildState(queue.guild?.id || queue.guildId);
    });
    client.player.events.on('playerPause', queue => {
        emitGuildState(queue.guild?.id || queue.guildId);
    });
    client.player.events.on('playerResume', queue => {
        emitGuildState(queue.guild?.id || queue.guildId);
    });
    client.player.events.on('emptyQueue', queue => {
        emitGuildState(queue.guild?.id || queue.guildId);
    });
    client.player.events.on('disconnect', queue => {
        emitGuildState(queue.guild?.id || queue.guildId);
    });

    return { emitGuildState };
}

function setupWebServer(client) {
    const app = express();
    const httpServer = createServer(app);
    const io = new Server(httpServer, {
        cors: {
            origin: true,
            credentials: true
        }
    });

    const configuredSessionSecret = process.env.WEB_SESSION_SECRET || process.env.SESSION_SECRET || '';
    if (!configuredSessionSecret && process.env.NODE_ENV === 'production') {
        throw new Error('WEB_SESSION_SECRET (or SESSION_SECRET) is required in production.');
    }
    if (!configuredSessionSecret) {
        console.warn(
            'WEB_SESSION_SECRET is not set. Using an ephemeral in-memory secret (development only, single-instance only).'
        );
    }
    const effectiveSessionSecret = configuredSessionSecret || crypto.randomBytes(32).toString('hex');

    const sessionMiddleware = session({
        secret: effectiveSessionSecret,
        resave: false,
        saveUninitialized: false,
        cookie: {
            httpOnly: true,
            sameSite: 'lax',
            secure: process.env.NODE_ENV === 'production',
            maxAge: SESSION_COOKIE_MAX_AGE_MS
        }
    });

    const wrap = middleware => (socket, next) => middleware(socket.request, {}, next);
    const staticAssetLimiter = rateLimit({ windowMs: 60_000, max: 300, standardHeaders: true, legacyHeaders: false });
    const apiLimiter = rateLimit({ windowMs: 60_000, max: 180, standardHeaders: true, legacyHeaders: false });
    const roleplayLimiter = rateLimit({ windowMs: 60_000, max: 40, standardHeaders: true, legacyHeaders: false });

    app.set('trust proxy', 1);
    app.use(express.json({ limit: '256kb' }));
    app.use(sessionMiddleware);
    app.use('/api', apiLimiter);
    app.use('/src', express.static(path.join(__dirname, '..', 'src')));
    app.get('/style.css', staticAssetLimiter, (req, res) => {
        res.sendFile(path.join(__dirname, 'style.css'));
    });
    app.get('/web/app.js', staticAssetLimiter, (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'app.js'));
    });
    app.get('/dashboard', staticAssetLimiter, (req, res) => {
        res.sendFile(path.join(__dirname, 'dashboard.html'));
    });

    const broadcaster = createPlayerBroadcaster(io, client);
    client.webDashboard = {
        emitMusicState: broadcaster.emitGuildState
    };

    const oauthEnabled = Boolean(
        (process.env.DISCORD_CLIENT_ID || process.env.CLIENT_ID)
        && process.env.DISCORD_CLIENT_SECRET
        && process.env.DISCORD_REDIRECT_URI
    );

    app.get('/auth/login', (req, res) => {
        if (!oauthEnabled) {
            const devUserId = process.env.DISCORD_DASHBOARD_DEV_USER_ID;
            if (!devUserId) {
                res.status(503).send('OAuth is not configured yet.');
                return;
            }

            req.session.auth = {
                user: {
                    id: devUserId,
                    username: 'dev-user'
                }
            };
            ensureSessionCsrf(req);
            res.redirect('/dashboard');
            return;
        }

        const state = crypto.randomBytes(18).toString('hex');
        req.session.oauthState = state;

        const url = new URL(DISCORD_OAUTH_AUTHORIZE_URL);
        url.searchParams.set('client_id', process.env.DISCORD_CLIENT_ID || process.env.CLIENT_ID);
        url.searchParams.set('response_type', 'code');
        url.searchParams.set('redirect_uri', process.env.DISCORD_REDIRECT_URI);
        url.searchParams.set('scope', 'identify guilds');
        url.searchParams.set('state', state);

        res.redirect(url.toString());
    });

    app.get('/auth/callback', async (req, res) => {
        try {
            if (!oauthEnabled) {
                res.status(503).send('OAuth is not configured yet.');
                return;
            }

            const { code, state } = req.query;
            if (!code || typeof code !== 'string') {
                res.status(400).send('Missing code.');
                return;
            }
            if (!state || typeof state !== 'string' || state !== req.session.oauthState) {
                res.status(400).send('Invalid OAuth state.');
                return;
            }

            const tokenData = await exchangeDiscordCodeForToken(code);
            const user = await fetchDiscordResource(tokenData.access_token, '/users/@me');

            req.session.auth = {
                user: toSafeUser(user),
                accessToken: tokenData.access_token
            };
            ensureSessionCsrf(req);
            delete req.session.oauthState;

            res.redirect('/dashboard');
        } catch (error) {
            console.error('Discord OAuth callback error:', error);
            res.status(500).send('Login failed.');
        }
    });

    app.post('/auth/logout', requireCsrf, (req, res) => {
        req.session.destroy(() => {
            res.json({ ok: true });
        });
    });

    app.get('/api/auth/status', (req, res) => {
        const user = getSessionUser(req);
        const csrfToken = ensureSessionCsrf(req);
        res.json({
            authenticated: Boolean(user?.id),
            oauthEnabled,
            csrfToken,
            user: user
                ? {
                    ...user,
                    avatarUrl: buildDiscordAvatarUrl(user)
                }
                : null
        });
    });

    app.get('/api/guilds', requireAuthenticated, async (req, res) => {
        try {
            const guilds = await buildAccessibleGuilds(client, getSessionUser(req).id);
            res.json({ guilds });
        } catch (error) {
            console.error('Failed to load guilds:', error);
            res.status(500).json({ error: 'Failed to load guild list.' });
        }
    });

    app.get('/api/music/state', requireAuthenticated, async (req, res) => {
        try {
            const { guild } = await resolveGuildContext(client, req);
            res.json({
                guildId: guild.id,
                state: createState(client, guild.id)
            });
        } catch (error) {
            res.status(error.status || 500).json({ error: error.message || 'Failed to fetch state.' });
        }
    });

    app.post('/api/music/play', requireAuthenticated, requireCsrf, async (req, res) => {
        try {
            const { guild, member } = await resolveGuildContext(client, req);
            const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
            if (!query) {
                res.status(400).json({ error: 'query is required.' });
                return;
            }

            const channel = requireMusicControlEligibility({ member, guild });
            const result = await play({
                client,
                guildId: guild.id,
                query,
                requestedBy: member.user,
                channel,
                metadataChannel: guild.systemChannel || null,
                playNow: req.body?.playNow === true
            });

            broadcaster.emitGuildState(guild.id);
            res.json({
                guildId: guild.id,
                state: result.state
            });
        } catch (error) {
            res.status(error.status || 500).json({ error: error.message || 'Play failed.' });
        }
    });

    app.post('/api/music/pause', requireAuthenticated, requireCsrf, async (req, res) => {
        try {
            const { guild, member } = await resolveGuildContext(client, req);
            requireMusicControlEligibility({ member, guild });
            const state = pause(client, guild.id);
            broadcaster.emitGuildState(guild.id);
            res.json({ guildId: guild.id, state });
        } catch (error) {
            res.status(error.status || 500).json({ error: error.message || 'Pause failed.' });
        }
    });

    app.post('/api/music/resume', requireAuthenticated, requireCsrf, async (req, res) => {
        try {
            const { guild, member } = await resolveGuildContext(client, req);
            requireMusicControlEligibility({ member, guild });
            const state = resume(client, guild.id);
            broadcaster.emitGuildState(guild.id);
            res.json({ guildId: guild.id, state });
        } catch (error) {
            res.status(error.status || 500).json({ error: error.message || 'Resume failed.' });
        }
    });

    app.post('/api/music/skip', requireAuthenticated, requireCsrf, async (req, res) => {
        try {
            const { guild, member } = await resolveGuildContext(client, req);
            requireMusicControlEligibility({ member, guild });
            const state = skip(client, guild.id);
            broadcaster.emitGuildState(guild.id);
            res.json({ guildId: guild.id, state });
        } catch (error) {
            res.status(error.status || 500).json({ error: error.message || 'Skip failed.' });
        }
    });

    app.post('/api/music/stop', requireAuthenticated, requireCsrf, async (req, res) => {
        try {
            const { guild, member } = await resolveGuildContext(client, req);
            requireMusicControlEligibility({ member, guild });
            const state = stop(client, guild.id);
            broadcaster.emitGuildState(guild.id);
            res.json({ guildId: guild.id, state });
        } catch (error) {
            res.status(error.status || 500).json({ error: error.message || 'Stop failed.' });
        }
    });

    app.post('/api/music/seek', requireAuthenticated, requireCsrf, async (req, res) => {
        try {
            const { guild, member } = await resolveGuildContext(client, req);
            requireMusicControlEligibility({ member, guild });
            const seconds = Number(req.body?.seconds);
            if (!Number.isFinite(seconds) || seconds < 0) {
                res.status(400).json({ error: 'seconds must be >= 0.' });
                return;
            }
            const state = seek(client, guild.id, seconds);
            broadcaster.emitGuildState(guild.id);
            res.json({ guildId: guild.id, state });
        } catch (error) {
            res.status(error.status || 500).json({ error: error.message || 'Seek failed.' });
        }
    });

    app.post('/api/music/volume', requireAuthenticated, requireCsrf, async (req, res) => {
        try {
            const { guild, member } = await resolveGuildContext(client, req);
            requireMusicControlEligibility({ member, guild });
            const volume = Number(req.body?.volume);
            if (!Number.isFinite(volume)) {
                res.status(400).json({ error: 'volume must be a number.' });
                return;
            }
            const state = setVolume(client, guild.id, volume);
            broadcaster.emitGuildState(guild.id);
            res.json({ guildId: guild.id, state });
        } catch (error) {
            res.status(error.status || 500).json({ error: error.message || 'Set volume failed.' });
        }
    });

    app.post('/api/music/repeat/toggle', requireAuthenticated, requireCsrf, async (req, res) => {
        try {
            const { guild, member } = await resolveGuildContext(client, req);
            requireMusicControlEligibility({ member, guild });
            const result = toggleTrackRepeat(client, guild.id);
            broadcaster.emitGuildState(guild.id);
            res.json({
                guildId: guild.id,
                repeatEnabled: result.repeatEnabled,
                state: result.state
            });
        } catch (error) {
            res.status(error.status || 500).json({ error: error.message || 'Toggle repeat failed.' });
        }
    });

    app.post('/api/roleplay/respond', requireAuthenticated, requireCsrf, roleplayLimiter, async (req, res) => {
        try {
            const user = getSessionUser(req);
            const prompt = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
            if (!prompt) {
                res.status(400).json({ error: 'message is required.' });
                return;
            }

            const dbUser = await User.findOneAndUpdate(
                { userId: user.id },
                { userId: user.id },
                { upsert: true, new: true }
            );

            let conversation = await Conversation.findOne({
                userId: user.id,
                isActive: true
            });

            if (!conversation) {
                conversation = new Conversation({
                    userId: user.id,
                    characterName: dbUser.defaultCharacterName || config.defaultCharacterName,
                    messages: []
                });
            }

            conversation.messages.push({
                role: 'user',
                content: prompt
            });

            const characterProfile = dbUser.characterProfiles.find(
                profile => profile.name === conversation.characterName
            ) || {
                name: config.defaultCharacterName,
                personality: config.fallbackPersonality,
                appearance: config.appearance.defaultAppearance
            };

            const userPreferences = {
                preferredLanguage: dbUser.preferredLanguage || 'Vietnamese',
                customBotPersonality: dbUser.customBotPersonality || '',
                responseStyle: dbUser.responseStyle || {
                    length: 'poetic',
                    poeticLevel: 5,
                    detailLevel: 5,
                    metaphorUsage: true,
                    paragraphCount: 5
                }
            };

            const aiResponse = await handleGeminiRequest(
                conversation.messages,
                characterProfile,
                userPreferences,
                client.user?.username || null
            );

            conversation.messages.push({
                role: 'assistant',
                content: aiResponse
            });
            if (conversation.messages.length > MAX_CONVERSATION_MESSAGES) {
                conversation.messages = conversation.messages.slice(-MAX_CONVERSATION_MESSAGES);
            }
            await conversation.save();

            res.json({
                characterName: conversation.characterName,
                appearance: characterProfile.appearance || config.appearance.defaultAppearance,
                response: aiResponse
            });
        } catch (error) {
            console.error('Roleplay API error:', error);
            res.status(500).json({ error: 'Failed to process roleplay request.' });
        }
    });

    io.use(wrap(sessionMiddleware));
    io.use((socket, next) => {
        const user = socket.request.session?.auth?.user;
        if (!user?.id) {
            next(new Error('unauthorized'));
            return;
        }
        next();
    });

    io.on('connection', socket => {
        socket.on('guild:subscribe', async payload => {
            const guildId = typeof payload?.guildId === 'string' ? payload.guildId.trim() : '';
            if (!/^\d{17,20}$/.test(guildId)) {
                socket.emit('error:message', { message: 'Invalid guildId.' });
                return;
            }

            const sessionUser = socket.request.session?.auth?.user;
            const guild = client.guilds.cache.get(guildId);
            const member = guild ? await guild.members.fetch(sessionUser.id).catch(() => null) : null;
            if (!guild || !member) {
                socket.emit('error:message', { message: 'Guild access denied.' });
                return;
            }

            const allowed = await hasDashboardAccess(member, guildId);
            if (!allowed) {
                socket.emit('error:message', { message: 'Dashboard access denied.' });
                return;
            }

            const room = `guild:${guildId}`;
            socket.join(room);
            socket.data.guildId = guildId;
            socket.emit('music:state', {
                guildId,
                state: createState(client, guildId)
            });
        });
    });

    httpServer.listen(DEFAULT_WEB_PORT, () => {
        console.log(`Web dashboard listening on port ${DEFAULT_WEB_PORT}`);
    });
}

module.exports = {
    setupWebServer
};
