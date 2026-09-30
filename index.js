/*
 * ENDLESS ÖZEL ODA BOTU - TEK DOSYA
 * Gereksinim: Node.js 18+ ve discord.js v14
 * Kurulum: npm install discord.js dotenv
 * Başlatma: node index.js
 * Environment: DISCORD_TOKEN zorunlu, DISCORD_GUILD_ID isteğe bağlı
 */

require('dotenv').config();
const fs = require('node:fs/promises');
const path = require('node:path');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  ModalBuilder,
  PermissionFlagsBits,
  PermissionsBitField,
  REST,
  Routes,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

const token = process.env.DISCORD_TOKEN?.trim();
if (!token) throw new Error('DISCORD_TOKEN environment variable is required.');

const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'rooms.json');
const emptyState = { configs: {}, rooms: {} };

class RoomStore {
  constructor() {
    this.state = structuredClone(emptyState);
  }

  async load() {
    await fs.mkdir(DATA_DIR, { recursive: true });
    try {
      const raw = await fs.readFile(STATE_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      this.state = { configs: parsed.configs || {}, rooms: parsed.rooms || {} };
    } catch {
      await this.persist();
    }
  }

  getConfig(guildId) { return this.state.configs[guildId]; }

  async setConfig(config) {
    this.state.configs[config.guildId] = config;
    await this.persist();
  }

  getRoom(channelId) { return this.state.rooms[channelId]; }

  getRoomsForGuild(guildId) {
    return Object.values(this.state.rooms).filter(room => room.guildId === guildId);
  }

  async setRoom(room) {
    this.state.rooms[room.channelId] = room;
    await this.persist();
  }

  async deleteRoom(channelId) {
    delete this.state.rooms[channelId];
    await this.persist();
  }

  async persist() {
    await fs.writeFile(STATE_FILE, `${JSON.stringify(this.state, null, 2)}\n`);
  }
}

const store = new RoomStore();

const commands = [
  new SlashCommandBuilder()
    .setName('kurulum')
    .setDescription('Özel oda sistemini bu sunucuya kurar.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName('chttemizle')
    .setDescription('Kullanıldığı kanaldaki tüm mesajları temizler.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
  new SlashCommandBuilder()
    .setName('panel')
    .setDescription('Bu kanala özel oda yönetim paneli gönderir.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName('oda')
    .setDescription('Sana ait özel oda hakkında bilgi gösterir.'),
].map(command => command.toJSON());

const panelButtons = {
  first: [
    ['room:limit', 'Kapasite', ButtonStyle.Primary],
    ['room:lock', 'Kilitle / Aç', ButtonStyle.Secondary],
    ['room:invite', 'Davet Et', ButtonStyle.Success],
    ['room:revoke', 'Erişim Kaldır', ButtonStyle.Danger],
  ],
  second: [
    ['room:rename', 'Ad Değiştir', ButtonStyle.Secondary],
    ['room:transfer', 'Odayı Devret', ButtonStyle.Secondary],
    ['room:hide', 'Gizle / Göster', ButtonStyle.Secondary],
    ['room:destroy', 'Odayı Sil', ButtonStyle.Danger],
  ],
};

function buildPanel() {
  const embed = new EmbedBuilder()
    .setColor(0x7567f8)
    .setTitle('ROOM / LOUNGE')
    .setDescription([
      'Ses kanalına gir, kendi alanın otomatik oluşsun.',
      '',
      '**Oda sahibi araçları**',
      'Kapasiteyi belirle, odayı kilitle, arkadaşlarını davet et veya yönetimi devret.',
      '',
      '_Oda boş kaldığında sistem tarafından otomatik olarak kaldırılır._',
    ].join('\n'))
    .addFields(
      { name: '1 · Odanı oluştur', value: 'Tetikleyici ses kanalına gir.', inline: true },
      { name: '2 · Kontrol et', value: 'Aşağıdaki butonlardan birini seç.', inline: true },
      { name: '3 · Alanını paylaş', value: 'Davet ile erişim ver.', inline: true },
    )
    .setFooter({ text: 'Özel Oda Sistemi  •  room/lounge' });

  const rows = [panelButtons.first, panelButtons.second].map(buttons =>
    new ActionRowBuilder().addComponents(
      buttons.map(([customId, label, style]) =>
        new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style),
      ),
    ),
  );
  return { embeds: [embed], components: rows };
}

function normalizeChannelName(value) {
  const normalized = String(value)
    .replace(/[^\p{L}\p{N}\s._-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
  return (normalized || 'ozel-oda').slice(0, 90);
}

function extractUserId(value) {
  const id = String(value || '').trim().replace(/[<@!>]/g, '');
  return /^\d{15,22}$/.test(id) ? id : null;
}

function makeModal(customId, title, inputId, label, placeholder) {
  const input = new TextInputBuilder()
    .setCustomId(inputId)
    .setLabel(label)
    .setPlaceholder(placeholder)
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(100);
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title)
    .addComponents(new ActionRowBuilder().addComponents(input));
}

async function getGuildMember(guild, userId) {
  return guild.members.fetch(userId).catch(() => null);
}

function isOwner(member, room) { return room.ownerId === member.id; }

async function findOwnedRoom(guild, userId) {
  for (const room of store.getRoomsForGuild(guild.id)) {
    if (room.ownerId !== userId) continue;
    const channel = guild.channels.cache.get(room.channelId);
    if (channel?.type === ChannelType.GuildVoice) return { room, channel };
  }
  return null;
}

async function replyNoRoom(interaction) {
  await interaction.reply({ content: 'Önce oluşturma kanalına girerek kendine bir oda açmalısın.', ephemeral: true });
}

async function requireOwner(interaction) {
  if (!interaction.guild) {
    await interaction.reply({ content: 'Bu işlem yalnızca sunucularda kullanılabilir.', ephemeral: true });
    return null;
  }
  const owned = await findOwnedRoom(interaction.guild, interaction.user.id);
  if (!owned) { await replyNoRoom(interaction); return null; }
  const member = await getGuildMember(interaction.guild, interaction.user.id);
  if (!member || !isOwner(member, owned.room)) {
    await interaction.reply({ content: 'Bu odanın sahibi değilsin.', ephemeral: true });
    return null;
  }
  return owned;
}

async function createRoom(guild, member, config) {
  const existing = await findOwnedRoom(guild, member.id);
  if (existing) {
    await member.voice.setChannel(existing.channel);
    return existing.channel;
  }

  const channel = await guild.channels.create({
    name: `${normalizeChannelName(member.displayName)}・oda`,
    type: ChannelType.GuildVoice,
    parent: config.categoryId,
    userLimit: 0,
    reason: 'Özel oda otomatik oluşturuldu',
  });

  await channel.permissionOverwrites.edit(guild.roles.everyone, {
    ViewChannel: true, Connect: true, Speak: true,
  });
  await channel.permissionOverwrites.edit(member.id, {
    ViewChannel: true, Connect: true, Speak: true,
    ManageChannels: true, MoveMembers: true, MuteMembers: true, DeafenMembers: true,
  });

  await store.setRoom({
    channelId: channel.id,
    guildId: guild.id,
    ownerId: member.id,
    locked: false,
    hidden: false,
    userLimit: 0,
  });
  await member.voice.setChannel(channel);
  return channel;
}

async function deleteRoom(guild, channelId) {
  const channel = guild.channels.cache.get(channelId);
  await store.deleteRoom(channelId);
  if (channel?.type === ChannelType.GuildVoice) {
    await channel.delete('Özel oda boş kaldı veya sahibi tarafından silindi').catch(() => undefined);
  }
}

async function clearTextChannel(channel) {
  let deletedCount = 0;
  while (true) {
    const messages = await channel.messages.fetch({ limit: 100 });
    if (!messages.size) break;

    const recent = messages.filter(message => Date.now() - message.createdTimestamp < 14 * 24 * 60 * 60 * 1000);
    const old = messages.filter(message => Date.now() - message.createdTimestamp >= 14 * 24 * 60 * 60 * 1000);

    if (recent.size) {
      const deleted = await channel.bulkDelete(recent, true);
      deletedCount += deleted.size;
    }
    for (const message of old.values()) {
      await message.delete().then(() => { deletedCount += 1; }).catch(() => undefined);
    }
    if (messages.size < 100) break;
  }
  return deletedCount;
}

async function handleSetup(interaction) {
  if (!interaction.guild) return interaction.reply({ content: 'Bu komut yalnızca sunucularda kullanılabilir.', ephemeral: true });
  await interaction.deferReply({ ephemeral: true });
  const guild = interaction.guild;
  const current = store.getConfig(guild.id);
  const existingCategory = current ? guild.channels.cache.get(current.categoryId) : undefined;

  if (existingCategory?.type === ChannelType.GuildCategory) {
    await interaction.editReply(`Kurulum zaten hazır. Panel: <#${current.controlChannelId}> · Oluşturma kanalı: <#${current.triggerChannelId}>`);
    return;
  }

  const category = await guild.channels.create({ name: '✦ ÖZEL ODA LOUNGE', type: ChannelType.GuildCategory, reason: 'Özel oda sistemi kurulumu' });
  const controlChannel = await guild.channels.create({
    name: 'oda-paneli', type: ChannelType.GuildText, parent: category.id,
    topic: 'Özel oda yönetim paneli', reason: 'Özel oda sistemi kurulumu',
  });
  const triggerChannel = await guild.channels.create({
    name: '＋・Oda Oluştur', type: ChannelType.GuildVoice, parent: category.id,
    reason: 'Özel oda sistemi kurulumu',
  });

  await controlChannel.permissionOverwrites.edit(guild.roles.everyone, {
    ViewChannel: true, SendMessages: false, AddReactions: false,
  });
  const panelMessage = await controlChannel.send(buildPanel());
  await store.setConfig({
    guildId: guild.id,
    categoryId: category.id,
    triggerChannelId: triggerChannel.id,
    controlChannelId: controlChannel.id,
    controlMessageId: panelMessage.id,
  });

  await interaction.editReply([
    'Özel oda sistemi hazır.',
    `Panel: <#${controlChannel.id}>`,
    `Oda oluşturma kanalı: <#${triggerChannel.id}>`,
    'Sunucundaki üyeler oluşturma kanalına girerek kendi odasını açabilir.',
  ].join('\n'));
}

async function handlePanel(interaction) {
  if (!interaction.guild) return interaction.reply({ content: 'Bu komut yalnızca sunucularda kullanılabilir.', ephemeral: true });
  if (!interaction.channel || interaction.channel.type !== ChannelType.GuildText) {
    return interaction.reply({ content: 'Paneli bir metin kanalında göndermelisin.', ephemeral: true });
  }
  const message = await interaction.channel.send(buildPanel());
  const config = store.getConfig(interaction.guild.id);
  if (config) await store.setConfig({ ...config, controlChannelId: interaction.channel.id, controlMessageId: message.id });
  await interaction.reply({ content: 'Özel oda paneli gönderildi.', ephemeral: true });
}

async function handleRoomCommand(interaction) {
  if (!interaction.guild) return interaction.reply({ content: 'Bu komut yalnızca sunucularda kullanılabilir.', ephemeral: true });
  const owned = await findOwnedRoom(interaction.guild, interaction.user.id);
  if (!owned) return replyNoRoom(interaction);
  await interaction.reply({
    content: `Odan burada: <#${owned.channel.id}> · ${owned.room.locked ? 'kilitli' : 'açık'} · kapasite: ${owned.room.userLimit || 'sınırsız'}`,
    ephemeral: true,
  });
}

async function handleButton(interaction) {
  if (!interaction.guild) return interaction.reply({ content: 'Bu işlem yalnızca sunucularda kullanılabilir.', ephemeral: true });
  const owned = await requireOwner(interaction);
  if (!owned) return;
  const { room, channel } = owned;

  switch (interaction.customId) {
    case 'room:limit':
      return interaction.showModal(makeModal('room:limit:submit', 'Oda kapasitesi', 'limit', 'Kişi sayısı', '0 sınırsız, 1-99 arası kapasite'));
    case 'room:invite':
      return interaction.showModal(makeModal('room:invite:submit', 'Odaya davet et', 'user', 'Kullanıcı', '@kullanıcı veya kullanıcı ID'));
    case 'room:revoke':
      return interaction.showModal(makeModal('room:revoke:submit', 'Oda erişimini kaldır', 'user', 'Kullanıcı', '@kullanıcı veya kullanıcı ID'));
    case 'room:rename':
      return interaction.showModal(makeModal('room:rename:submit', 'Oda adını değiştir', 'name', 'Yeni oda adı', 'ör. gece sohbeti'));
    case 'room:transfer':
      return interaction.showModal(makeModal('room:transfer:submit', 'Odayı devret', 'user', 'Yeni sahip', '@kullanıcı veya kullanıcı ID'));
    case 'room:lock':
      room.locked = !room.locked;
      await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { Connect: !room.locked });
      await store.setRoom(room);
      return interaction.reply({ content: room.locked ? 'Odan kilitlendi. Yeni girişler kapatıldı.' : 'Odanın kilidi açıldı.', ephemeral: true });
    case 'room:hide':
      room.hidden = !room.hidden;
      await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { ViewChannel: !room.hidden });
      await store.setRoom(room);
      return interaction.reply({ content: room.hidden ? 'Odan gizlendi.' : 'Odan tekrar görünür.', ephemeral: true });
    case 'room:destroy':
      await deleteRoom(interaction.guild, channel.id);
      return interaction.reply({ content: 'Odan silindi.', ephemeral: true });
    default:
      return undefined;
  }
}

async function handleModal(interaction) {
  if (!interaction.guild) return;
  const owned = await findOwnedRoom(interaction.guild, interaction.user.id);
  if (!owned) return interaction.reply({ content: 'Önce oluşturma kanalına girerek kendine bir oda açmalısın.', ephemeral: true });
  const { room, channel } = owned;

  switch (interaction.customId) {
    case 'room:limit:submit': {
      const value = interaction.fields.getTextInputValue('limit').trim();
      const limit = Number(value);
      if (!Number.isInteger(limit) || limit < 0 || limit > 99) return interaction.reply({ content: 'Kapasite 0 ile 99 arasında tam sayı olmalı. 0 sınırsızdır.', ephemeral: true });
      room.userLimit = limit;
      await channel.setUserLimit(limit);
      await store.setRoom(room);
      return interaction.reply({ content: limit ? `Oda kapasitesi ${limit} kişi oldu.` : 'Oda kapasitesi sınırsız oldu.', ephemeral: true });
    }
    case 'room:rename:submit': {
      const value = interaction.fields.getTextInputValue('name').trim();
      await channel.setName(`${normalizeChannelName(value)}・oda`);
      return interaction.reply({ content: 'Oda adı güncellendi.', ephemeral: true });
    }
    case 'room:invite:submit': {
      const userId = extractUserId(interaction.fields.getTextInputValue('user'));
      const member = userId ? await getGuildMember(interaction.guild, userId) : null;
      if (!member) return interaction.reply({ content: 'Geçerli bir sunucu üyesi bulamadım.', ephemeral: true });
      await channel.permissionOverwrites.edit(member.id, { ViewChannel: true, Connect: true, Speak: true });
      return interaction.reply({ content: `${member.displayName} odaya davet edildi.`, ephemeral: true });
    }
    case 'room:revoke:submit': {
      const userId = extractUserId(interaction.fields.getTextInputValue('user'));
      const member = userId ? await getGuildMember(interaction.guild, userId) : null;
      if (!member || member.id === room.ownerId) return interaction.reply({ content: 'Geçerli bir üye yazmalı ve oda sahibinin erişimini kaldıramazsın.', ephemeral: true });
      await channel.permissionOverwrites.edit(member.id, { ViewChannel: false, Connect: false, Speak: false });
      if (member.voice.channelId === channel.id) await member.voice.disconnect('Oda sahibi erişimi kaldırdı').catch(() => undefined);
      return interaction.reply({ content: `${member.displayName} için oda erişimi kaldırıldı.`, ephemeral: true });
    }
    case 'room:transfer:submit': {
      const userId = extractUserId(interaction.fields.getTextInputValue('user'));
      const member = userId ? await getGuildMember(interaction.guild, userId) : null;
      if (!member) return interaction.reply({ content: 'Geçerli bir sunucu üyesi bulamadım.', ephemeral: true });
      const previousOwnerId = room.ownerId;
      room.ownerId = member.id;
      await channel.permissionOverwrites.edit(previousOwnerId, { ManageChannels: false, MoveMembers: false, MuteMembers: false, DeafenMembers: false });
      await channel.permissionOverwrites.edit(member.id, {
        ViewChannel: true, Connect: true, Speak: true,
        ManageChannels: true, MoveMembers: true, MuteMembers: true, DeafenMembers: true,
      });
      await store.setRoom(room);
      return interaction.reply({ content: `Odan ${member.displayName} kullanıcısına devredildi.`, ephemeral: true });
    }
    default:
      return undefined;
  }
}

async function registerCommands(client) {
  const rest = new REST({ version: '10' }).setToken(token);
  const guildId = process.env.DISCORD_GUILD_ID?.trim();
  const route = guildId
    ? Routes.applicationGuildCommands(client.user.id, guildId)
    : Routes.applicationCommands(client.user.id);
  await rest.put(route, { body: commands });
  console.log(`[ENDLESS] ${guildId ? 'Sunucu' : 'Global'} slash komutları güncellendi.`);
}

async function start() {
  await store.load();
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });

  client.once('clientReady', async readyClient => {
    console.log(`[ENDLESS] ${readyClient.user.tag} aktif. Sunucu sayısı: ${readyClient.guilds.cache.size}`);
    try {
      await registerCommands(readyClient);
      const permissions = PermissionsBitField.resolve([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.Speak,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.MoveMembers,
        PermissionFlagsBits.MuteMembers,
        PermissionFlagsBits.DeafenMembers,
      ]);
      console.log(`[ENDLESS] Davet: https://discord.com/oauth2/authorize?client_id=${readyClient.user.id}&permissions=${permissions}&scope=bot%20applications.commands`);
    } catch (error) {
      console.error('[ENDLESS] Slash komutları yüklenemedi:', error.message || error);
      console.error('[ENDLESS] DISCORD_GUILD_ID doğru mu ve bot bu sunucuda mı kontrol et.');
    }
  });

  client.on('voiceStateUpdate', async (oldState, newState) => {
    try {
      const config = store.getConfig(newState.guild.id);
      if (config && newState.channelId === config.triggerChannelId && newState.member) {
        await createRoom(newState.guild, newState.member, config);
      }
      if (oldState.channelId) {
        const oldRoom = store.getRoom(oldState.channelId);
        const oldChannel = oldState.guild.channels.cache.get(oldState.channelId);
        if (oldRoom && oldChannel?.type === ChannelType.GuildVoice && oldChannel.members.size === 0) {
          await deleteRoom(oldState.guild, oldState.channelId);
        }
      }
    } catch (error) {
      console.error('[ENDLESS] Ses kanalı olayı işlenemedi:', error);
    }
  });

  client.on('interactionCreate', async interaction => {
    try {
      if (interaction.isChatInputCommand()) {
        if (interaction.commandName === 'kurulum') await handleSetup(interaction);
        else if (interaction.commandName === 'chttemizle') {
          if (!interaction.channel || !interaction.channel.isTextBased()) {
            await interaction.reply({ content: 'Bu komut sadece metin kanallarında kullanılabilir.', ephemeral: true });
          } else if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) {
            await interaction.reply({ content: 'Bu komut için Mesajları Yönet yetkisi gerekiyor.', ephemeral: true });
            setTimeout(() => interaction.deleteReply().catch(() => undefined), 2000);
          } else {
            await interaction.reply({ content: '🧹 Kanal mesajları temizleniyor...', ephemeral: true });
            try {
              const deletedCount = await clearTextChannel(interaction.channel);
              await interaction.editReply({ content: `✅ Kanal temizlendi. **${deletedCount}** mesaj silindi.` });
            } catch (error) {
              console.error('[ENDLESS] Kanal temizleme hatası:', error);
              await interaction.editReply({ content: '❌ Mesajlar temizlenirken bir hata oluştu. Botun Mesajları Yönet yetkisini kontrol et.' }).catch(() => undefined);
            }
            setTimeout(() => interaction.deleteReply().catch(() => undefined), 2000);
          }
        }
        else if (interaction.commandName === 'panel') await handlePanel(interaction);
        else if (interaction.commandName === 'oda') await handleRoomCommand(interaction);
      } else if (interaction.isButton()) {
        await handleButton(interaction);
      } else if (interaction.isModalSubmit()) {
        await handleModal(interaction);
      }
    } catch (error) {
      console.error('[ENDLESS] Discord etkileşimi işlenemedi:', error);
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'Bu işlem sırasında bir hata oluştu. Bot logunu kontrol et.', ephemeral: true }).catch(() => undefined);
      }
    }
  });

  await client.login(token);
}

start().catch(error => {
  console.error('[ENDLESS] Bot başlatılamadı:', error);
  process.exitCode = 1;
});
