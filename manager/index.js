const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Rcon } = require('rcon-client');
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder
} = require('discord.js');

// Configuration
const CONFIG = {
  DATA_DIR: process.env.DATA_DIR || path.join(__dirname, 'data'),
  RCON_HOST: process.env.RCON_HOST || 'minecraft',
  RCON_PORT: parseInt(process.env.RCON_PORT || '25575', 10),
  RCON_PASSWORD: process.env.RCON_PASSWORD || '',
  PANEL_USER: process.env.PANEL_USER || 'admin',
  PANEL_PASSWORD: process.env.PANEL_PASSWORD || '',
  PANEL_PORT: parseInt(process.env.PORT || '3000', 10),
  DISCORD_TOKEN: process.env.DISCORD_TOKEN || '',
  DISCORD_GUILD_ID: process.env.DISCORD_GUILD_ID || '',
  DISCORD_ROLE_ID: process.env.DISCORD_ROLE_ID || '',
};

const LINKS_FILE = path.join(CONFIG.DATA_DIR, 'links.json');
const NAME_REGEX = /^[A-Za-z0-9_]{3,16}$/;

// Ensure data directory exists
if (!fs.existsSync(CONFIG.DATA_DIR)) {
  fs.mkdirSync(CONFIG.DATA_DIR, { recursive: true });
}

// -------------------------------------------------------------
// Links Storage (Atomic write)
// -------------------------------------------------------------
function readLinks() {
  try {
    if (fs.existsSync(LINKS_FILE)) {
      const data = fs.readFileSync(LINKS_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('[Storage] Error reading links file:', err.message);
  }
  return [];
}

function writeLinks(links) {
  const tmpFile = `${LINKS_FILE}.tmp.${Date.now()}`;
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(links, null, 2), 'utf8');
    fs.renameSync(tmpFile, LINKS_FILE);
  } catch (err) {
    console.error('[Storage] Error writing links file:', err.message);
    if (fs.existsSync(tmpFile)) {
      try { fs.unlinkSync(tmpFile); } catch (_) {}
    }
    throw err;
  }
}

function findLinkByDiscordId(discordId) {
  const links = readLinks();
  return links.find(l => l.discordId === discordId) || null;
}

function findLinkByMcName(mcName) {
  const links = readLinks();
  const lower = mcName.toLowerCase();
  return links.find(l => l.mcName.toLowerCase() === lower) || null;
}

function addLink(discordId, mcName) {
  const links = readLinks();
  const existingIndex = links.findIndex(l => l.discordId === discordId);
  const record = { discordId, mcName, linkedAt: new Date().toISOString() };
  if (existingIndex >= 0) {
    links[existingIndex] = record;
  } else {
    links.push(record);
  }
  writeLinks(links);
  return record;
}

function removeLinkByDiscordId(discordId) {
  const links = readLinks();
  const filtered = links.filter(l => l.discordId !== discordId);
  if (filtered.length !== links.length) {
    writeLinks(filtered);
    return true;
  }
  return false;
}

function removeLinkByMcName(mcName) {
  const links = readLinks();
  const lower = mcName.toLowerCase();
  const filtered = links.filter(l => l.mcName.toLowerCase() !== lower);
  if (filtered.length !== links.length) {
    writeLinks(filtered);
    return true;
  }
  return false;
}

// -------------------------------------------------------------
// RCON Client with Safe Retry & Command Execution
// -------------------------------------------------------------
async function executeRconCommand(command) {
  if (!CONFIG.RCON_PASSWORD) {
    throw new Error('RCON_PASSWORD is not configured');
  }

  let rcon = null;
  try {
    rcon = await Rcon.connect({
      host: CONFIG.RCON_HOST,
      port: CONFIG.RCON_PORT,
      password: CONFIG.RCON_PASSWORD,
      timeout: 5000,
    });
    const response = await rcon.send(command);
    return response;
  } catch (err) {
    console.error(`[RCON] Command failed (${command}):`, err.message);
    throw err;
  } finally {
    if (rcon) {
      try {
        await rcon.end();
      } catch (_) {}
    }
  }
}

// Safe RCON retry helper for background reconcile
async function executeRconWithRetry(command, maxRetries = 3, delayMs = 2000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await executeRconCommand(command);
    } catch (err) {
      if (attempt === maxRetries) throw err;
      await new Promise(resolve => setTimeout(resolve, delayMs * attempt));
    }
  }
}

// -------------------------------------------------------------
// Discord Bot Setup
// -------------------------------------------------------------
let discordClient = null;

if (CONFIG.DISCORD_TOKEN && CONFIG.DISCORD_GUILD_ID) {
  discordClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
    ],
  });

  const commands = [
    new SlashCommandBuilder()
      .setName('link')
      .setDescription('Link your Minecraft username to your Discord account')
      .addStringOption(option =>
        option
          .setName('name')
          .setDescription('Your exact Minecraft username (3-16 characters)')
          .setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName('unlink')
      .setDescription('Unlink your Minecraft username from your Discord account'),
    new SlashCommandBuilder()
      .setName('status')
      .setDescription('Check the Minecraft server status and online player count'),
  ];

  async function registerSlashCommands() {
    try {
      console.log('[Discord] Registering guild slash commands...');
      const rest = new REST({ version: '10' }).setToken(CONFIG.DISCORD_TOKEN);
      await rest.put(
        Routes.applicationGuildCommands(discordClient.user.id, CONFIG.DISCORD_GUILD_ID),
        { body: commands.map(c => c.toJSON()) }
      );
      console.log('[Discord] Successfully registered guild slash commands.');
    } catch (err) {
      console.error('[Discord] Failed to register slash commands:', err);
    }
  }

  discordClient.once('clientReady', async () => {
    console.log(`[Discord] Logged in as ${discordClient.user.tag}`);
    await registerSlashCommands();
    // Run initial reconciliation
    reconcileLinks();
  });

  // Handle Slash Commands
  discordClient.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;

    if (commandName === 'link') {
      try {
        // Validate Discord Role
        if (CONFIG.DISCORD_ROLE_ID) {
          const hasRole = interaction.member?.roles?.cache?.has(CONFIG.DISCORD_ROLE_ID);
          if (!hasRole) {
            return interaction.reply({
              content: '❌ You must have the required Minecraft role in this server to link an account.',
              ephemeral: true,
            });
          }
        }

        const rawName = interaction.options.getString('name', true).trim();
        if (!NAME_REGEX.test(rawName)) {
          return interaction.reply({
            content: '❌ Invalid Minecraft username. It must be 3-16 characters long and only contain letters, numbers, and underscores (`A-Z`, `a-z`, `0-9`, `_`).',
            ephemeral: true,
          });
        }

        // Check if user already linked
        const existingUserLink = findLinkByDiscordId(interaction.user.id);
        if (existingUserLink) {
          return interaction.reply({
            content: `❌ You already have a linked Minecraft account: \`${existingUserLink.mcName}\`. Use \`/unlink\` first if you want to change it.`,
            ephemeral: true,
          });
        }

        // Check if name is linked to another user
        const existingNameLink = findLinkByMcName(rawName);
        if (existingNameLink && existingNameLink.discordId !== interaction.user.id) {
          return interaction.reply({
            content: `❌ The username \`${rawName}\` is already linked to another Discord member.`,
            ephemeral: true,
          });
        }

        // Add to whitelist via RCON
        await executeRconCommand(`whitelist add ${rawName}`);
        addLink(interaction.user.id, rawName);

        return interaction.reply({
          content: `✅ Successfully linked and whitelisted **${rawName}**! You can now join \`playmine.hawklab.in\`.`,
          ephemeral: true,
        });
      } catch (err) {
        console.error('[Discord] Error in /link command:', err);
        return interaction.reply({
          content: '❌ Failed to whitelist your account on the Minecraft server. The server might be booting or restarting. Please try again shortly.',
          ephemeral: true,
        });
      }
    }

    if (commandName === 'unlink') {
      try {
        const link = findLinkByDiscordId(interaction.user.id);
        if (!link) {
          return interaction.reply({
            content: "❌ You don't have any linked Minecraft account.",
            ephemeral: true,
          });
        }

        const { mcName } = link;
        try {
          await executeRconCommand(`whitelist remove ${mcName}`);
          await executeRconCommand(`kick ${mcName} Unlinked via Discord`);
        } catch (rconErr) {
          console.warn(`[Discord] RCON unlink error for ${mcName}:`, rconErr.message);
        }

        removeLinkByDiscordId(interaction.user.id);

        return interaction.reply({
          content: `✅ Unlinked and removed **${mcName}** from the server whitelist.`,
          ephemeral: true,
        });
      } catch (err) {
        console.error('[Discord] Error in /unlink command:', err);
        return interaction.reply({
          content: '❌ Failed to process unlink request.',
          ephemeral: true,
        });
      }
    }

    if (commandName === 'status') {
      try {
        const listOutput = await executeRconCommand('list');
        return interaction.reply({
          content: `🟢 **Minecraft Server Online**\n${listOutput}`,
          ephemeral: true,
        });
      } catch (err) {
        return interaction.reply({
          content: '🔴 **Minecraft Server Offline or Starting Up**\nCould not reach RCON.',
          ephemeral: true,
        });
      }
    }
  });

  // Handle member leaving
  discordClient.on('guildMemberRemove', async member => {
    try {
      const link = findLinkByDiscordId(member.id);
      if (link) {
        console.log(`[Discord] Member ${member.user.tag} left the server. Unlinking ${link.mcName}...`);
        try {
          await executeRconCommand(`whitelist remove ${link.mcName}`);
          await executeRconCommand(`kick ${link.mcName} Left Discord Server`);
        } catch (rconErr) {
          console.warn('[Discord] RCON unlink on member remove failed:', rconErr.message);
        }
        removeLinkByDiscordId(member.id);
      }
    } catch (err) {
      console.error('[Discord] guildMemberRemove error:', err.message);
    }
  });

  // Handle role updates
  discordClient.on('guildMemberUpdate', async (oldMember, newMember) => {
    try {
      if (!CONFIG.DISCORD_ROLE_ID) return;
      const hadRole = oldMember.roles.cache.has(CONFIG.DISCORD_ROLE_ID);
      const hasRole = newMember.roles.cache.has(CONFIG.DISCORD_ROLE_ID);

      if (hadRole && !hasRole) {
        const link = findLinkByDiscordId(newMember.id);
        if (link) {
          console.log(`[Discord] Member ${newMember.user.tag} lost Minecraft role. Unlinking ${link.mcName}...`);
          try {
            await executeRconCommand(`whitelist remove ${link.mcName}`);
            await executeRconCommand(`kick ${link.mcName} Lost Discord Minecraft role`);
          } catch (rconErr) {
            console.warn('[Discord] RCON unlink on role remove failed:', rconErr.message);
          }
          removeLinkByDiscordId(newMember.id);
        }
      }
    } catch (err) {
      console.error('[Discord] guildMemberUpdate error:', err.message);
    }
  });

  // Periodic Reconciliation (Startup & every 10 min)
  async function reconcileLinks() {
    try {
      if (!discordClient || !discordClient.isReady()) return;
      const guild = discordClient.guilds.cache.get(CONFIG.DISCORD_GUILD_ID);
      if (!guild) {
        console.warn(`[Reconcile] Guild ${CONFIG.DISCORD_GUILD_ID} not found in client cache.`);
        return;
      }

      console.log('[Reconcile] Starting reconciliation of linked members...');
      const links = readLinks();
      for (const link of links) {
        try {
          const member = await guild.members.fetch(link.discordId).catch(() => null);
          const hasRole = CONFIG.DISCORD_ROLE_ID
            ? member && member.roles.cache.has(CONFIG.DISCORD_ROLE_ID)
            : !!member;

          if (!member || !hasRole) {
            console.log(`[Reconcile] Member ${link.discordId} (${link.mcName}) is missing or lacks role. Removing...`);
            try {
              await executeRconWithRetry(`whitelist remove ${link.mcName}`);
              await executeRconWithRetry(`kick ${link.mcName} Discord membership or role revoked`);
            } catch (rconErr) {
              console.warn(`[Reconcile] Failed RCON command for ${link.mcName}:`, rconErr.message);
            }
            removeLinkByDiscordId(link.discordId);
          }
        } catch (memberErr) {
          console.error(`[Reconcile] Error checking member ${link.discordId}:`, memberErr.message);
        }
      }
      console.log('[Reconcile] Reconciliation cycle completed.');
    } catch (err) {
      console.error('[Reconcile] Unexpected error during reconciliation:', err.message);
    }
  }

  // Schedule every 10 minutes
  setInterval(reconcileLinks, 10 * 60 * 1000);

  // Login
  discordClient.login(CONFIG.DISCORD_TOKEN).catch(err => {
    console.error('[Discord] Login failed:', err.message);
  });
} else {
  console.warn('[Discord] DISCORD_TOKEN or DISCORD_GUILD_ID not set. Whitelist bot disabled.');
}

// -------------------------------------------------------------
// Admin Web Panel (Express with Basic Auth & Rate Limiting)
// -------------------------------------------------------------
const app = express();
app.use(express.json());

// In-Memory Rate Limiter for Authentication Attempts
const authAttempts = new Map();
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

function checkRateLimit(ip) {
  const record = authAttempts.get(ip);
  if (!record) return true;
  if (Date.now() - record.lastAttempt > LOCKOUT_MS) {
    authAttempts.delete(ip);
    return true;
  }
  return record.count < MAX_ATTEMPTS;
}

function recordFailedAttempt(ip) {
  const record = authAttempts.get(ip) || { count: 0, lastAttempt: Date.now() };
  record.count += 1;
  record.lastAttempt = Date.now();
  authAttempts.set(ip, record);
}

function clearRateLimit(ip) {
  authAttempts.delete(ip);
}

// Constant-Time Basic Auth Middleware
function basicAuth(req, res, next) {
  const clientIp = req.ip || req.connection.remoteAddress || 'unknown';

  if (!checkRateLimit(clientIp)) {
    return res.status(429).json({
      error: 'Too many failed authentication attempts. Please try again after 15 minutes.'
    });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Minecraft Admin Panel"');
    return res.status(401).send('Authentication required');
  }

  try {
    const credentials = Buffer.from(authHeader.split(' ')[1], 'base64').toString('utf8');
    const [user, ...passParts] = credentials.split(':');
    const pass = passParts.join(':');

    const expectedUser = CONFIG.PANEL_USER;
    const expectedPass = CONFIG.PANEL_PASSWORD;

    if (!expectedPass) {
      console.warn('[Security] PANEL_PASSWORD is not set. Denying access.');
      return res.status(403).send('PANEL_PASSWORD not configured on server.');
    }

    const userBuffer = Buffer.from(user || '');
    const passBuffer = Buffer.from(pass || '');
    const expectedUserBuffer = Buffer.from(expectedUser);
    const expectedPassBuffer = Buffer.from(expectedPass);

    const userMatches = userBuffer.length === expectedUserBuffer.length &&
      crypto.timingSafeEqual(userBuffer, expectedUserBuffer);
    const passMatches = passBuffer.length === expectedPassBuffer.length &&
      crypto.timingSafeEqual(passBuffer, expectedPassBuffer);

    if (userMatches && passMatches) {
      clearRateLimit(clientIp);
      return next();
    }
  } catch (err) {
    console.error('[Auth] Error verifying credentials:', err.message);
  }

  recordFailedAttempt(clientIp);
  res.setHeader('WWW-Authenticate', 'Basic realm="Minecraft Admin Panel"');
  return res.status(401).send('Invalid credentials');
}

// Protect all routes with Basic Auth
app.use(basicAuth);

// Serve static frontend assets
app.use(express.static(path.join(__dirname, 'public')));

// API Routes
app.get('/api/status', async (req, res) => {
  let online = false;
  let rawList = '';
  let onlineCount = 0;
  let maxCount = 20;
  let playerNames = [];
  let serverVersion = process.env.MC_VERSION || '26.3';

  try {
    rawList = await executeRconCommand('list');
    online = true;

    // Parse Minecraft list output:
    // Format: "There are 2 of a max of 20 players online: Player1, Player2"
    const countMatch = rawList.match(/There are (\d+) of a max of (\d+) players online/i);
    if (countMatch) {
      onlineCount = parseInt(countMatch[1], 10);
      maxCount = parseInt(countMatch[2], 10);
    }
    const colonIndex = rawList.indexOf(':');
    if (colonIndex !== -1) {
      const namesStr = rawList.slice(colonIndex + 1).trim();
      if (namesStr.length > 0) {
        playerNames = namesStr.split(',').map(n => n.trim()).filter(Boolean);
      }
    }
  } catch (err) {
    online = false;
  }

  const links = readLinks();

  return res.json({
    online,
    version: serverVersion,
    rawList,
    players: {
      online: onlineCount,
      max: maxCount,
      list: playerNames,
    },
    links,
  });
});

app.post('/api/kick', async (req, res) => {
  const { name } = req.body;
  if (!name || typeof name !== 'string' || !NAME_REGEX.test(name.trim())) {
    return res.status(400).json({ error: 'Valid player name required (3-16 alphanumeric characters)' });
  }

  try {
    const cleanName = name.trim();
    const result = await executeRconCommand(`kick ${cleanName} Kicked by admin via web panel`);
    return res.json({ success: true, message: result });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to kick player via RCON: ' + err.message });
  }
});

app.post('/api/unlink', async (req, res) => {
  const { name } = req.body;
  if (!name || typeof name !== 'string' || !NAME_REGEX.test(name.trim())) {
    return res.status(400).json({ error: 'Valid player name required' });
  }

  try {
    const cleanName = name.trim();
    try {
      await executeRconCommand(`whitelist remove ${cleanName}`);
      await executeRconCommand(`kick ${cleanName} Unlinked by admin`);
    } catch (rconErr) {
      console.warn(`[Panel] RCON warning while unlinking ${cleanName}:`, rconErr.message);
    }

    const removed = removeLinkByMcName(cleanName);
    return res.json({ success: true, removed });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to unlink account: ' + err.message });
  }
});

app.post('/api/sync', async (req, res) => {
  try {
    const links = readLinks();
    let whitelisted = 0;
    for (const link of links) {
      if (NAME_REGEX.test(link.mcName)) {
        await executeRconCommand(`whitelist add ${link.mcName}`);
        whitelisted++;
      }
    }
    await executeRconCommand('whitelist reload');
    return res.json({ success: true, message: `Synchronized ${whitelisted} linked players to Minecraft whitelist.` });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to sync whitelist: ' + err.message });
  }
});

// Start Express Server
app.listen(CONFIG.PANEL_PORT, '0.0.0.0', () => {
  console.log(`[Panel] Admin web panel listening on port ${CONFIG.PANEL_PORT}`);
});
