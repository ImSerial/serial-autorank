// -------------------------------------------------------------
// IMPORTS
// -------------------------------------------------------------
import {
    Client,
    GatewayIntentBits,
    Partials,
    REST,
    Routes,
    SlashCommandBuilder,
    ActivityType,
    PermissionFlagsBits,
    EmbedBuilder,
    ChannelType
} from "discord.js";

import dotenv from "dotenv";
import sqlite3 from "sqlite3";

dotenv.config();

// -------------------------------------------------------------
// CONFIG
// -------------------------------------------------------------
const TOKEN = process.env.TOKEN;
const OWNERS = process.env.OWNERS?.split(",") || [];
const GUILD_ID = process.env.GUILD_ID;
const TWITCH_URL = process.env.TWITCH_URL || "https://www.twitch.tv";
const PASTEBIN_API_KEY = process.env.PASTEBIN_API_KEY;

// -------------------------------------------------------------
// SQLITE
// -------------------------------------------------------------
const db = new sqlite3.Database("./bot.db");

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
    )`);
});

function getSetting(key) {
    return new Promise((resolve) => {
        db.get(`SELECT value FROM settings WHERE key = ?`, [key], (err, row) => {
            if (err || !row) return resolve(null);
            resolve(row.value);
        });
    });
}

function setSetting(key, value) {
    db.run(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [key, value]
    );
}

// -------------------------------------------------------------
// HELPERS
// -------------------------------------------------------------
const resolveName = (m) =>
    m.displayName ||
    m.nickname ||
    m.user.globalName ||
    m.user.username;

function createDjibrilEmbed(desc) {
    return new EmbedBuilder().setColor("#2F3136").setDescription(desc);
}

function isOwner(id) {
    return OWNERS.includes(id);
}

// LOG attribution
async function sendLogRoleGiven(guild, member, role, element) {
    const chanId = await getSetting("logsChannelId");
    if (!chanId) return;

    const channel = guild.channels.cache.get(chanId);
    if (!channel) return;

    const embed = createDjibrilEmbed(
        [
            "``💊`` Nouveau rôle attribué",
            "",
            `Utilisateur : <@${member.id}>`,
            `Rôle : \`${role.name}\``,
            `Élément détecté : \`${element}\``,
            `Pseudo : \`${resolveName(member)}\``
        ].join("\n")
    );

    channel.send({ embeds: [embed] }).catch(() => {});
}

// LOG retrait
async function sendLogRoleRemoved(guild, member, role, element, oldName, newName) {
    const chanId = await getSetting("logsChannelId");
    if (!chanId) return;

    const channel = guild.channels.cache.get(chanId);
    if (!channel) return;

    const embed = createDjibrilEmbed(
        [
            "``💊`` Rôle retiré automatiquement",
            "",
            `Utilisateur : <@${member.id}>`,
            `Rôle retiré : \`${role.name}\``,
            `Raison : élément \`${element}\` manquant`,
            "",
            `Ancien pseudo : \`${oldName}\``,
            `Nouveau pseudo : \`${newName}\``
        ].join("\n")
    );

    channel.send({ embeds: [embed] }).catch(() => {});
}

// -------------------------------------------------------------
// DISCORD CLIENT
// -------------------------------------------------------------
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Channel, Partials.GuildMember, Partials.User]
});

// -------------------------------------------------------------
// SLASH COMMANDS
// -------------------------------------------------------------
const commands = [

    // /setrole
    new SlashCommandBuilder()
        .setName("setrole")
        .setDescription("Définir le rôle et l’élément à détecter.")
        .addRoleOption(o =>
            o.setName("role").setDescription("Rôle attribué").setRequired(true)
        )
        .addStringOption(o =>
            o.setName("element").setDescription("Emoji ou mot à détecter").setRequired(true)
        ),

    // /setlogs
    new SlashCommandBuilder()
        .setName("setlogs")
        .setDescription("Définir le salon des logs.")
        .addChannelOption(o =>
            o.setName("salon")
                .setDescription("Salon de logs")
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(true)
        ),

    // /bot-name
    new SlashCommandBuilder()
        .setName("bot-name")
        .setDescription("Changer le pseudo du bot.")
        .addStringOption(o =>
            o.setName("name").setDescription("Nouveau pseudo").setRequired(true)
        ),

    // /bot-avatar
    new SlashCommandBuilder()
        .setName("bot-avatar")
        .setDescription("Changer l’avatar du bot.")
        .addAttachmentOption(o =>
            o.setName("image").setDescription("Nouvel avatar").setRequired(true)
        ),

    // /bot-status
    new SlashCommandBuilder()
        .setName("bot-status")
        .setDescription("Changer le status du bot.")
        .addStringOption(o =>
            o.setName("type")
                .setDescription("Status")
                .setRequired(true)
                .addChoices(
                    { name: "online", value: "online" },
                    { name: "dnd", value: "dnd" },
                    { name: "idle", value: "idle" },
                    { name: "invisible", value: "invisible" }
                )
        ),

    // /bot-activities
    new SlashCommandBuilder()
        .setName("bot-activities")
        .setDescription("Changer l’activité du bot.")
        .addStringOption(o =>
            o.setName("type")
                .setDescription("Type d'activité")
                .setRequired(true)
                .addChoices(
                    { name: "playing", value: "playing" },
                    { name: "watching", value: "watching" },
                    { name: "streaming", value: "streaming" },
                    { name: "competing", value: "competing" }
                )
        )
        .addStringOption(o =>
            o.setName("description")
                .setDescription("Texte de l'activité")
                .setRequired(true)
        ),

    // /analyse
    new SlashCommandBuilder()
        .setName("analyse")
        .setDescription("Analyse les rôles dangereux (Pastebin PUBLIC).")
];

const rest = new REST({ version: "10" }).setToken(TOKEN);

// -------------------------------------------------------------
// READY
// -------------------------------------------------------------
client.on("ready", async () => {
    console.log(`${client.user.tag} connecté`);
    if (GUILD_ID)
        await rest.put(
            Routes.applicationGuildCommands(client.user.id, GUILD_ID),
            { body: commands.map(c => c.toJSON()) }
        );
});

// -------------------------------------------------------------
// DONNER LE RÔLE LORS DU PING
// -------------------------------------------------------------
client.on("messageCreate", async msg => {
    if (msg.author.bot) return;
    if (!msg.mentions.has(client.user.id)) return;

    const element = await getSetting("element");
    const roleId = await getSetting("roleId");

    // Pas configuré
    if (!element || !roleId)
        return msg.reply("Aucun rôle n’a été configuré. Utilisez `/setrole`.");

    const member = msg.member;
    const role = msg.guild.roles.cache.get(roleId);
    if (!role) return;

    const name = resolveName(member);

    // Déjà le rôle
    if (member.roles.cache.has(role.id))
        return msg.reply("Vous avez déjà ce rôle.");

    // Pas l’élément
    if (!name.includes(element))
        return msg.reply(
            `Vous n’avez pas l’élément requis pour obtenir \`${role.name}\`.`
        );

    // Donner le rôle
    try { await member.roles.add(role); }
    catch { return msg.reply("Impossible d’attribuer le rôle."); }

    msg.reply(`Vous avez reçu le rôle \`${role.name}\`.`);

    // Log
    sendLogRoleGiven(msg.guild, member, role, element);
});

// -------------------------------------------------------------
// RETRAIT AUTOMATIQUE DU ROLE
// -------------------------------------------------------------
async function processNameChange(oldName, newName, member) {
    const element = await getSetting("element");
    const roleId = await getSetting("roleId");

    if (!element || !roleId) return;
    const role = member.guild.roles.cache.get(roleId);
    if (!role) return;

    const oldHad = oldName.includes(element);
    const newHas = newName.includes(element);

    // Retrait automatique
    if (oldHad && !newHas && member.roles.cache.has(role.id)) {
        try { await member.roles.remove(role); } catch {}

        // LOG du retrait
        sendLogRoleRemoved(member.guild, member, role, element, oldName, newName);
    }
}

// Pseudo serveur (nickname / displayName local)
client.on("guildMemberUpdate", async (oldMem, newMem) => {
    const oldName = resolveName(oldMem);
    const newName = resolveName(newMem);
    if (oldName !== newName)
        await processNameChange(oldName, newName, newMem);
});

// Pseudo GLOBAL (userUpdate)
client.on("userUpdate", async (oldUser, newUser) => {
    for (const guild of client.guilds.cache.values()) {
        const member = guild.members.cache.get(newUser.id);
        if (!member) continue;

        const oldName = oldUser.globalName || oldUser.username;
        const newName = newUser.globalName || newUser.username;

        if (oldName !== newName)
            await processNameChange(oldName, newName, member);
    }
});

// -------------------------------------------------------------
// SLASH COMMANDS HANDLER
// -------------------------------------------------------------
client.on("interactionCreate", async i => {
    if (!i.isChatInputCommand()) return;

    if (!isOwner(i.user.id))
        return i.reply({ content: "Permission refusée.", ephemeral: true });

    const cmd = i.commandName;

    // /setrole
    if (cmd === "setrole") {
        const role = i.options.getRole("role");
        const element = i.options.getString("element");

        setSetting("roleId", role.id);
        setSetting("element", element);

        return i.reply({
            embeds: [
                createDjibrilEmbed(
                    [
                        "``🍀`` Configuration mise à jour",
                        "",
                        `Rôle : \`${role.name}\``,
                        `Élément détecté : \`${element}\``
                    ].join("\n")
                )
            ],
            ephemeral: true
        });
    }

    // /setlogs
    if (cmd === "setlogs") {
        const channel = i.options.getChannel("salon");
        setSetting("logsChannelId", channel.id);

        return i.reply({
            embeds: [
                createDjibrilEmbed(
                    [
                        "``🦋`` Salon de logs mis à jour",
                        "",
                        `Logs → ${channel}`
                    ].join("\n")
                )
            ],
            ephemeral: true
        });
    }

    // /bot-name
    if (cmd === "bot-name") {
        const name = i.options.getString("name");

        try { await i.guild.members.me.setNickname(name); } catch {}

        return i.reply({
            embeds: [
                createDjibrilEmbed(`\`\`🍦\`\` Nouveau pseudo : \`${name}\``)
            ],
            ephemeral: true
        });
    }

    // /bot-avatar
    if (cmd === "bot-avatar") {
        const img = i.options.getAttachment("image");

        if (!img.contentType?.startsWith("image/"))
            return i.reply({ content: "Fichier invalide.", ephemeral: true });

        try { await client.user.setAvatar(img.url); } catch {}

        return i.reply({
            embeds: [
                createDjibrilEmbed("``🦋`` Avatar mis à jour.")
            ],
            ephemeral: true
        });
    }

    // /bot-status
    if (cmd === "bot-status") {
        const type = i.options.getString("type");

        client.user.setStatus(type);

        return i.reply({
            embeds: [
                createDjibrilEmbed(`\`\`💤\`\` Nouveau status : \`${type}\``)
            ],
            ephemeral: true
        });
    }

    // /bot-activities
    if (cmd === "bot-activities") {
        const type = i.options.getString("type");
        const desc = i.options.getString("description");

        let aType = ActivityType.Playing;
        if (type === "watching") aType = ActivityType.Watching;
        if (type === "streaming") aType = ActivityType.Streaming;
        if (type === "competing") aType = ActivityType.Competing;

        client.user.setActivity(desc, {
            type: aType,
            url: type === "streaming" ? TWITCH_URL : undefined
        });

        return i.reply({
            embeds: [
                createDjibrilEmbed(
                    [
                        "``💊`` Activité mise à jour",
                        "",
                        `Type : \`${type}\``,
                        `Texte : \`${desc}\``
                    ].join("\n")
                )
            ],
            ephemeral: true
        });
    }

    // /analyse
    if (cmd === "analyse") {
        if (!PASTEBIN_API_KEY)
            return i.reply({ content: "PASTEBIN_API_KEY manquant.", ephemeral: true });

        await i.deferReply({ ephemeral: true });

        const dangerous = [
            PermissionFlagsBits.Administrator,
            PermissionFlagsBits.ManageGuild,
            PermissionFlagsBits.ManageRoles,
            PermissionFlagsBits.ManageChannels,
            PermissionFlagsBits.BanMembers,
            PermissionFlagsBits.KickMembers
        ];

        const lines = [];

        lines.push(`# Analyse des rôles dangereux`);
        lines.push(`# Serveur : ${i.guild.name}`);
        lines.push(`# Date : ${new Date().toISOString()}`);
        lines.push("");

        i.guild.roles.cache.forEach(role => {
            const perms = role.permissions;
            if (dangerous.some(p => perms.has(p)))
                lines.push(`${role.name} (${role.id}) → ${perms.toArray().join(", ")}`);
        });

        if (lines.length <= 3)
            return i.editReply("Aucun rôle dangereux.");

        const content = lines.join("\n");

        const body = new URLSearchParams({
            api_dev_key: PASTEBIN_API_KEY,
            api_option: "paste",
            api_paste_code: content,
            api_paste_private: "0",
            api_paste_name: `Analyse des rôles - ${i.guild.name}`
        });

        let url;
        try {
            const res = await fetch("https://pastebin.com/api/api_post.php", {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body
            });
            const text = await res.text();
            if (text.startsWith("http")) url = text;
        } catch {}

        return i.editReply(url || "Erreur Pastebin.");
    }
});

// -------------------------------------------------------------
// LOGIN
// -------------------------------------------------------------
client.login(TOKEN);
