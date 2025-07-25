const express = require('express');
const { Client, GatewayIntentBits, Partials, EmbedBuilder } = require('discord.js');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;

let client;
let guild;
let statChannelId = null; // tu zapiszemy ID kanału do statystyk

// dane
const voiceTimes = {};  // userId -> sekundy
const voiceJoins = {};  // userId -> timestamp
const raidCounts = {};  // username -> licznik

// zapis statystyk
function saveStatsToFile() {
  try {
    const data = { voiceTimes, raidCounts, updated: new Date().toISOString() };
    fs.writeFileSync('stats.json', JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('❌ Błąd zapisu stats.json', err);
  }
}

// formatowanie czasu
function formatTime(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${h}h ${m}m ${s}s`;
}

// wysyłanie embedów na kanał
async function sendStatsToChannel() {
  if (!client || !client.isReady() || !statChannelId) return;
  try {
    const channel = await client.channels.fetch(statChannelId);
    if (!channel) return;

    const members = await guild.members.fetch();
    const onlineCount = members.filter(m => m.presence?.status === 'online').size;

    const topVoice = Object.entries(voiceTimes)
      .map(([id, time]) => {
        const member = guild.members.cache.get(id);
        return member ? `${member.user.tag}: ${formatTime(time)}` : null;
      })
      .filter(Boolean)
      .slice(0, 5)
      .join('\n') || 'Brak danych';

    const topRaids = Object.entries(raidCounts)
      .map(([username, count]) => `${username}: ${count}`)
      .slice(0, 5)
      .join('\n') || 'Brak danych';

    const embed = new EmbedBuilder()
      .setTitle('📊 Statystyki serwera')
      .setColor('#ff3c3c')
      .addFields(
        { name: 'Online', value: `${onlineCount}/${guild.memberCount}`, inline: true },
        { name: 'Top Voice', value: topVoice, inline: false },
        { name: 'Top Napady', value: topRaids, inline: false },
      )
      .setTimestamp();

    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error('❌ Błąd wysyłania statystyk:', err);
  }
}

// co 10s
setInterval(() => {
  sendStatsToChannel();
  saveStatsToFile();
}, 600000);

// middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// logowanie bota
app.post('/api/connect', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ status: 'error', message: 'Brak tokena' });

  try {
    client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildPresences,
        GatewayIntentBits.GuildVoiceStates,
      ],
      partials: [Partials.GuildMember, Partials.User],
    });

    client.once('ready', async () => {
      guild = client.guilds.cache.first();
      if (!guild) {
        return res.status(400).json({ status: 'error', message: 'Bot nie jest na żadnym serwerze' });
      }
      await guild.members.fetch();
      res.json({ status: 'connected' });
    });

    // śledzenie voice
    client.on('voiceStateUpdate', (oldState, newState) => {
      const userId = newState.id;
      const now = Date.now();

      // opuścił kanał
      if (oldState.channelId && !newState.channelId) {
        if (voiceJoins[userId]) {
          const duration = Math.floor((now - voiceJoins[userId]) / 1000);
          voiceTimes[userId] = (voiceTimes[userId] || 0) + duration;
          delete voiceJoins[userId];
        }
      }

      // zmienił kanał
      if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
        if (voiceJoins[userId]) {
          const duration = Math.floor((now - voiceJoins[userId]) / 1000);
          voiceTimes[userId] = (voiceTimes[userId] || 0) + duration;
        }
        voiceJoins[userId] = now;
      }

      // dołączył
      if (!oldState.channelId && newState.channelId) {
        voiceJoins[userId] = now;
      }
    });

    await client.login(token);
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: 'error', message: 'Błąd logowania do bota' });
  }
});

// ustawienie kanału
app.post('/api/set-channel', (req, res) => {
  const { channelId } = req.body;
  statChannelId = channelId;
  res.json({ status: 'ok', message: `Kanał statystyk ustawiony na ${channelId}` });
});

// dane do panelu
app.get('/api/data', async (req, res) => {
  try {
    if (!client || !client.isReady()) {
      return res.status(400).json({ error: 'Bot nie jest połączony' });
    }

    const members = await guild.members.fetch();

    const memberList = members.map(m => {
      const act = m.presence?.activities?.find(a => a.type === 0);
      return {
        username: m.user.tag,
        status: m.presence?.status || 'offline',
        activity: act ? act.name : ''
      };
    });

    const voiceData = members.map(m => {
      const id = m.user.id;
      let total = voiceTimes[id] || 0; // UŻYWAMY let, bo zmieniamy poniżej
      if (voiceJoins[id]) {
        total += Math.floor((Date.now() - voiceJoins[id]) / 1000);
      }
      return {
        username: m.user.tag,
        formatted: formatTime(total)
      };
    }).filter(v => v.formatted !== '0h 0m 0s');

    const raidsData = Object.entries(raidCounts).map(([username, count]) => ({
      username, count
    }));

    saveStatsToFile();

    res.json({
      members: memberList,
      voiceActivity: voiceData,
      raids: raidsData
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania danych' });
  }
});

// aktualizacja napadów
app.post('/api/raids/update', (req, res) => {
  const { username, action } = req.body;
  if (!username || !['add', 'remove'].includes(action)) {
    return res.status(400).json({ status: 'error', message: 'Nieprawidłowe dane' });
  }
  if (!raidCounts[username]) raidCounts[username] = 0;
  raidCounts[username] += (action === 'add' ? 1 : -1);
  if (raidCounts[username] < 0) raidCounts[username] = 0;
  saveStatsToFile();
  res.json({ status: 'ok', raids: raidCounts });
});

app.listen(PORT, () => console.log(`✅ Server uruchomiony na http://localhost:${PORT}`));
