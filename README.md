# Hawklab Fabric Minecraft Server & Discord Whitelist Manager

A high-performance, automated Fabric Minecraft server stack designed for Oracle Cloud Ampere ARM64 infrastructure, managed and deployed via Coolify.

Includes an automated **Discord Whitelist Bot** with role-gated self-service linking (`/link`), automated membership/role reconciliation, and a lightweight mobile-friendly **Admin Web Panel** (`https://panel.hawklab.in`).

---

## 🌟 Key Architecture & Highlights

- **Server Engine**: Fabric loader on Minecraft `26.3` ("Wilderness Bound") powered by the multi-arch `itzg/minecraft-server:java25` Docker image (optimized for ARM64 & Aikar's JVM flags).
- **Zero Client Overhead**: All mods are strictly **server-side only** (`fabric-api`, `lithium`, `ferrite-core`, `spark`, `bluemap`, `no-chat-reports`). Players connect with a standard vanilla client.
- **Offline & TLauncher Ready**: `ONLINE_MODE=FALSE` with strict whitelisting (`ENABLE_WHITELIST=TRUE`, `ENFORCE_WHITELIST=TRUE`).
- **Discord Bot**: Slash commands (`/link`, `/unlink`, `/status`), automatic unlinking upon role loss or server leave, and 10-minute background reconciler.
- **Secure Admin Panel**: HTTP Basic auth with constant-time comparison (`timingSafeEqual`) and failed attempt rate-limiting. Exposes status, player kick, unlinking, and whitelist sync.
- **Strict Isolation**: RCON port (`25575`) and Manager web port (`3000`) are isolated within internal Docker networking; only Minecraft TCP `25565` is published to the host, and the admin panel is exposed over HTTPS via Coolify's reverse proxy.

---

## 📋 Player Guide

1. **Join the Discord Server**: Make sure you have the designated **Minecraft** role.
2. **Link Your Username**: In any channel, run the slash command:
   ```
   /link name:<your_exact_minecraft_username>
   ```
   *(Usernames must be 3-16 characters and contain only letters, numbers, and underscores).*
3. **Launch Minecraft / TLauncher**:
   - Open TLauncher (or any vanilla Minecraft launcher).
   - Select **Release 26.3** (or the matching server version).
   - No mods, loaders, or special clients are required!
4. **Connect to the Server**:
   - Server Address: `playmine.hawklab.in`

> ⚠️ **Security Notice (Offline Mode Whitelist)**:
> Because `ONLINE_MODE=FALSE` is enabled to allow TLauncher clients without Mojang account authentication, authentication is based solely on username matching the whitelist. Anyone who knows a whitelisted player's username could theoretically connect under that username. Keep your whitelisted names private among trusted friends.

---

## 🤖 Discord Bot Setup (Click-by-Click)

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications).
2. Click **New Application**, enter a name (e.g. `Hawklab Minecraft Bot`), and create it.
3. In the left navigation, click **Bot**:
   - Under **Privileged Gateway Intents**, turn **ON** the **Server Members Intent**.
   - Click **Save Changes**.
   - Under **Token**, click **Reset Token**, copy the token, and keep it safe (add it to Coolify as `DISCORD_TOKEN`).
4. In the left navigation, click **OAuth2** > **OAuth2 URL Generator**:
   - Under **Scopes**, select:
     - `bot`
     - `applications.commands`
   - Under **Bot Permissions**, select:
     - `Send Messages`
     - `Manage Roles` (optional) / `Read Messages/View Channels`
   - Copy the generated URL at the bottom, paste it in your browser, and authorize it to your Discord server.
5. In your Discord server:
   - Go to **User Settings** > **Advanced** > enable **Developer Mode**.
   - Right-click your Discord server name > click **Copy Server ID** (`DISCORD_GUILD_ID`).
   - Go to **Server Settings** > **Roles** > Create a role named `Minecraft`.
   - Right-click the `Minecraft` role > click **Copy Role ID** (`DISCORD_ROLE_ID`).

---

## 🌐 Network & Oracle Cloud Infrastructure

### 1. DNS Configuration (`hawklab.in`)
Add two DNS `A` records pointing to your Oracle Server IP (`80.225.246.132`):

| Type | Name | Target IP | Proxy Status | Description |
|---|---|---|---|---|
| A | `panel` | `80.225.246.132` | **DNS Only (Grey Cloud)** | Coolify HTTPS Admin Panel |
| A | `playmine` | `80.225.246.132` | **DNS Only (Grey Cloud)** | Minecraft TCP Server (25565) |

> ⚠️ **Important Cloudflare Note**: If managing DNS via Cloudflare, **disable proxying (Grey Cloud / DNS Only)** for both records. Cloudflare's free proxy blocks non-HTTP/HTTPS traffic like Minecraft TCP `25565`, and proxying `panel` can cause ACME TLS certificate issuance loops in Coolify.

### 2. Oracle VCN Security List & Ubuntu Firewall
1. **Oracle Cloud Console**:
   - Navigate to **Networking** > **Virtual Cloud Networks** > Your VCN > **Security Lists** > Ingress Rules.
   - Add Ingress Rule:
     - **Stateless**: No
     - **Source CIDR**: `0.0.0.0/0`
     - **IP Protocol**: `TCP`
     - **Destination Port Range**: `25565`
     - **Description**: `Minecraft Java Server TCP`
   - (Ensure ports `80` and `443` are already present for Coolify).
2. **Oracle Linux / Ubuntu Host Firewall (`iptables`)**:
   Oracle Ubuntu images apply restrictive default firewall rules:
   ```bash
   sudo iptables -I INPUT 6 -p tcp --dport 25565 -m state --state NEW,ESTABLISHED -j ACCEPT
   sudo netfilter-persistent save
   ```

---

## ⚙️ Environment Variables Reference

| Variable | Default Value | Description |
|---|---|---|
| `MC_VERSION` | `LATEST` (or `26.3`) | Minecraft version. |
| `MEMORY` | `8G` | RAM dedicated to JVM heap (e.g. `8G`, `12G`). |
| `TZ` | `Asia/Kolkata` | Timezone inside containers. |
| `USE_AIKAR_FLAGS` | `true` | Enables high-performance GC and JVM flags. |
| `MODRINTH_PROJECTS` | `fabric-api, lithium, ferrite-core, spark, bluemap, no-chat-reports` | Comma-separated Modrinth mod slugs. |
| `MODRINTH_DOWNLOAD_DEPENDENCIES` | `required` | Auto-resolves required mod dependencies. |
| `MODRINTH_ALLOWED_VERSION_TYPE` | `release` | Accepts release-channel builds (`release`, `beta`, `alpha`). |
| `ONLINE_MODE` | `FALSE` | Offline mode for TLauncher compatibility. |
| `ENABLE_WHITELIST` | `TRUE` | Server whitelist enabled. |
| `ENFORCE_WHITELIST` | `TRUE` | Server whitelist strictly enforced. |
| `RCON_PASSWORD` | *(Generated secret)* | Secret password for RCON interface. |
| `PANEL_USER` | `admin` | HTTP Basic Auth username for web panel. |
| `PANEL_PASSWORD` | *(Generated secret)* | HTTP Basic Auth password for web panel. |
| `PANEL_DOMAIN` | `panel.hawklab.in` | Domain for Coolify proxy routing. |
| `DISCORD_TOKEN` | *(User secret)* | Discord bot authentication token. |
| `DISCORD_GUILD_ID` | *(User ID)* | Discord server ID. |
| `DISCORD_ROLE_ID` | *(User ID)* | Required Discord role ID for `/link`. |

---

## 🚀 Coolify Deployment Guide

1. In Coolify, open your project (`Game Servicse` / `production`).
2. Add a new **Application** / **Docker Compose Service**:
   - Source: **Public Git Repository**
   - Repository URL: `https://github.com/hawklab-in/minecraft.git`
   - Branch: `main`
   - Build Pack: `Docker Compose`
3. Configure Service Domains & Proxy:
   - For `manager` service, set FQDN to `https://panel.hawklab.in`.
4. Enter Environment Variables:
   - Populate all variables from `.env.example`.
   - Mark `RCON_PASSWORD`, `PANEL_PASSWORD`, and `DISCORD_TOKEN` as **Secret**.
5. Click **Deploy**.
6. Check deployment logs:
   - Wait for `itzg/minecraft-server` to download Fabric, mods, and complete world generation.
   - Verify manager bot logs: `[Discord] Logged in as...` and `[Panel] Admin web panel listening on port 3000`.

---

## 🧩 Managing Mods & Upgrades

### Adding or Removing Mods
1. Edit the `MODRINTH_PROJECTS` environment variable in Coolify.
2. Example: to add `krypton`, change `MODRINTH_PROJECTS` to:
   ```env
   MODRINTH_PROJECTS=fabric-api, lithium, ferrite-core, spark, bluemap, no-chat-reports, krypton
   ```
3. Restart/Redeploy the container. The server will download the mod automatically on startup.
4. *Note on `c2me-fabric`*: `c2me-fabric` only releases on the `alpha` channel on Modrinth. To enable it, either set `MODRINTH_ALLOWED_VERSION_TYPE=alpha` or download its `.jar` manually into `/data/mods`.

### Updating Minecraft Versions
Change `MC_VERSION` in Coolify environment variables (e.g. `MC_VERSION=26.3`). Fabric and compatible mods are verified on startup.

---

## 💾 Backups & Persistence

All persistent data is stored in named Docker volumes:
- `mc-data`: Contains `server.properties`, worlds (`world/`), whitelist (`whitelist.json`), and mods (`mods/`).
- `manager-data`: Contains user link mappings (`links.json`).

### Manual Backup Command
To back up the Minecraft world while running:
```bash
docker run --rm --volumes-from minecraft -v $(pwd):/backup alpine tar czf /backup/mc-data-backup-$(date +%F).tar.gz /data
```

---

## 🔍 Troubleshooting

- **Server says "You are not whitelisted on this server"**:
  - Run `/link <username>` in Discord.
  - Or visit `https://panel.hawklab.in` and click **Re-sync Whitelist**.
- **Discord slash commands not showing up**:
  - Discord guild commands register instantly, but ensure the bot has `applications.commands` OAuth2 scope.
- **RCON connection refused during startup**:
  - Minecraft takes 1-3 minutes to boot on first run while generating terrain. The manager automatically retries RCON commands with backoff.
