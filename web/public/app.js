(function bootstrapDashboard() {
    const authStatusEl = document.getElementById('authStatus');
    const loginBtn = document.getElementById('loginBtn');
    const logoutBtn = document.getElementById('logoutBtn');
    const guildSelect = document.getElementById('guildSelect');
    const refreshStateBtn = document.getElementById('refreshStateBtn');
    const musicQueryInput = document.getElementById('musicQuery');
    const playBtn = document.getElementById('playBtn');
    const pauseBtn = document.getElementById('pauseBtn');
    const resumeBtn = document.getElementById('resumeBtn');
    const skipBtn = document.getElementById('skipBtn');
    const stopBtn = document.getElementById('stopBtn');
    const repeatBtn = document.getElementById('repeatBtn');
    const volumeInput = document.getElementById('volumeInput');
    const setVolumeBtn = document.getElementById('setVolumeBtn');
    const roleplayInput = document.getElementById('roleplayInput');
    const roleplayBtn = document.getElementById('roleplayBtn');
    const nowPlayingEl = document.getElementById('nowPlaying');
    const queueEl = document.getElementById('queue');
    const roleplayOutput = document.getElementById('roleplayOutput');
    const systemLog = document.getElementById('systemLog');

    const appState = {
        csrfToken: null,
        guildId: null,
        socket: null,
        authenticated: false
    };

    const params = new URLSearchParams(window.location.search);
    const initialGuildId = params.get('guildId');

    function log(message) {
        const line = document.createElement('div');
        line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
        systemLog.appendChild(line);
        systemLog.scrollTop = systemLog.scrollHeight;
    }

    async function requestJson(url, options = {}) {
        const finalOptions = {
            credentials: 'same-origin',
            ...options,
            headers: {
                ...(options.headers || {})
            }
        };

        if (finalOptions.body && typeof finalOptions.body !== 'string') {
            finalOptions.headers['Content-Type'] = 'application/json';
            finalOptions.body = JSON.stringify(finalOptions.body);
        }

        if ((finalOptions.method || 'GET').toUpperCase() !== 'GET' && appState.csrfToken) {
            finalOptions.headers['x-csrf-token'] = appState.csrfToken;
        }

        const response = await fetch(url, finalOptions);
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(data.error || `Request failed: ${response.status}`);
        }
        return data;
    }

    function renderState(payload) {
        const state = payload?.state || {};
        const current = state.nowPlaying;
        nowPlayingEl.textContent = current
            ? `${current.title} (${current.duration || 'Unknown'}) • ${state.paused ? 'Paused' : 'Playing'} • Repeat: ${state.repeatMode || 'off'}`
            : 'No active playback';

        const queue = Array.isArray(state.queue) ? state.queue : [];
        queueEl.innerHTML = '';
        if (!queue.length) {
            const li = document.createElement('li');
            li.textContent = 'Queue is empty.';
            queueEl.appendChild(li);
            return;
        }

        queue.slice(0, 20).forEach((track, index) => {
            const li = document.createElement('li');
            li.textContent = `${index + 1}. ${track.title} (${track.duration || 'Unknown'})`;
            queueEl.appendChild(li);
        });
    }

    async function loadMusicState() {
        if (!appState.guildId) return;
        const data = await requestJson(`/api/music/state?guildId=${encodeURIComponent(appState.guildId)}`);
        renderState(data);
    }

    async function loadGuilds() {
        const data = await requestJson('/api/guilds');
        const guilds = Array.isArray(data.guilds) ? data.guilds : [];
        guildSelect.innerHTML = '';

        if (!guilds.length) {
            appState.guildId = null;
            const option = document.createElement('option');
            option.value = '';
            option.textContent = 'No accessible guild';
            guildSelect.appendChild(option);
            return;
        }

        guilds.forEach(guild => {
            const option = document.createElement('option');
            option.value = guild.id;
            option.textContent = guild.name;
            guildSelect.appendChild(option);
        });

        const preferred = guilds.find(g => g.id === initialGuildId) || guilds[0];
        appState.guildId = preferred.id;
        guildSelect.value = preferred.id;
    }

    function subscribeSocket() {
        if (!appState.authenticated || !appState.guildId) return;

        if (!appState.socket) {
            appState.socket = window.io({
                withCredentials: true
            });
            appState.socket.on('connect', () => log('Socket connected.'));
            appState.socket.on('music:state', payload => renderState(payload));
            appState.socket.on('error:message', payload => log(payload?.message || 'Socket error'));
        }

        appState.socket.emit('guild:subscribe', {
            guildId: appState.guildId
        });
        log(`Subscribed realtime updates for guild ${appState.guildId}.`);
    }

    async function bootAuth() {
        const data = await requestJson('/api/auth/status');
        appState.authenticated = data.authenticated === true;
        appState.csrfToken = data.csrfToken || null;

        if (!appState.authenticated) {
            authStatusEl.textContent = 'Not logged in';
            loginBtn.hidden = false;
            logoutBtn.hidden = true;
            return false;
        }

        const user = data.user || {};
        authStatusEl.textContent = `Logged in as ${user.globalName || user.username || user.id}`;
        loginBtn.hidden = true;
        logoutBtn.hidden = false;
        return true;
    }

    async function start() {
        try {
            const authenticated = await bootAuth();
            if (!authenticated) return;

            await loadGuilds();
            subscribeSocket();
            await loadMusicState();
            log('Dashboard initialized: auth -> guilds -> socket -> API complete.');
        } catch (error) {
            log(error.message);
        }
    }

    guildSelect.addEventListener('change', async () => {
        appState.guildId = guildSelect.value || null;
        subscribeSocket();
        await loadMusicState().catch(error => log(error.message));
    });

    loginBtn.addEventListener('click', () => {
        const redirect = `/dashboard${window.location.search || ''}`;
        window.location.href = `/auth/login?redirect=${encodeURIComponent(redirect)}`;
    });

    logoutBtn.addEventListener('click', async () => {
        try {
            await requestJson('/auth/logout', {
                method: 'POST'
            });
            window.location.reload();
        } catch (error) {
            log(error.message);
        }
    });

    refreshStateBtn.addEventListener('click', () => {
        loadMusicState().catch(error => log(error.message));
    });

    playBtn.addEventListener('click', async () => {
        try {
            const query = musicQueryInput.value.trim();
            if (!query) return;
            const data = await requestJson('/api/music/play', {
                method: 'POST',
                body: {
                    guildId: appState.guildId,
                    query
                }
            });
            renderState(data);
        } catch (error) {
            log(error.message);
        }
    });

    pauseBtn.addEventListener('click', async () => {
        try {
            const data = await requestJson('/api/music/pause', {
                method: 'POST',
                body: { guildId: appState.guildId }
            });
            renderState(data);
        } catch (error) {
            log(error.message);
        }
    });

    resumeBtn.addEventListener('click', async () => {
        try {
            const data = await requestJson('/api/music/resume', {
                method: 'POST',
                body: { guildId: appState.guildId }
            });
            renderState(data);
        } catch (error) {
            log(error.message);
        }
    });

    skipBtn.addEventListener('click', async () => {
        try {
            const data = await requestJson('/api/music/skip', {
                method: 'POST',
                body: { guildId: appState.guildId }
            });
            renderState(data);
        } catch (error) {
            log(error.message);
        }
    });

    stopBtn.addEventListener('click', async () => {
        try {
            const data = await requestJson('/api/music/stop', {
                method: 'POST',
                body: { guildId: appState.guildId }
            });
            renderState(data);
        } catch (error) {
            log(error.message);
        }
    });

    repeatBtn.addEventListener('click', async () => {
        try {
            const data = await requestJson('/api/music/repeat/toggle', {
                method: 'POST',
                body: { guildId: appState.guildId }
            });
            renderState(data);
        } catch (error) {
            log(error.message);
        }
    });

    setVolumeBtn.addEventListener('click', async () => {
        try {
            const volume = Number(volumeInput.value);
            if (!Number.isFinite(volume)) return;
            const data = await requestJson('/api/music/volume', {
                method: 'POST',
                body: {
                    guildId: appState.guildId,
                    volume
                }
            });
            renderState(data);
        } catch (error) {
            log(error.message);
        }
    });

    roleplayBtn.addEventListener('click', async () => {
        try {
            const message = roleplayInput.value.trim();
            if (!message) return;
            const data = await requestJson('/api/roleplay/respond', {
                method: 'POST',
                body: {
                    message
                }
            });
            roleplayOutput.textContent = data.response || '';
        } catch (error) {
            log(error.message);
        }
    });

    start();
})();
