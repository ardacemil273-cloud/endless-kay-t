/*
 * ENDLESS Discord Bot - tek dosyalı sürüm
 * Gereksinim: Node.js 18+ | discord.js v14
 * Kurulum: npm i discord.js dotenv
 * Çalıştırma: DISCORD_TOKEN=token DISCORD_CLIENT_ID=client_id node index.js
 * İsteğe bağlı: DISCORD_GUILD_ID=server_id (slash komutlarını tek sunucuda hızlı yenilemek için)
 */

require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const {
  Client, GatewayIntentBits, Partials, PermissionsBitField, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, SlashCommandBuilder,
  REST, Routes, ChannelType
} = require('discord.js');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID || '';
const PREFIX = process.env.PREFIX || '.';
if (!TOKEN || !CLIENT_ID) throw new Error('DISCORD_TOKEN ve DISCORD_CLIENT_ID .env içinde bulunmalı.');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const MEMBERS_FILE = path.join(DATA_DIR, 'members.json');
const WARN_FILE = path.join(DATA_DIR, 'warnings.json');

const readJson = (file, fallback) => {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback; }
  catch { return fallback; }
};
const writeJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));
let configs = readJson(CONFIG_FILE, {});
let members = readJson(MEMBERS_FILE, {});
let warnings = readJson(WARN_FILE, {});
const saveAll = () => { writeJson(CONFIG_FILE, configs); writeJson(MEMBERS_FILE, members); writeJson(WARN_FILE, warnings); };

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, GatewayIntentBits.GuildModeration
  ],
  partials: [Partials.Channel, Partials.GuildMember, Partials.User]
});

const defaults = () => ({
  welcomeChannelId: null, logChannelId: null, unregisterRoleId: null, registeredRoleId: null,
  registrationRoleId: null, counterChannelId: null, counterName: 'Üye Sayısı: {count}',
  tag: '', welcomeEnabled: true, autoNickname: true, logEnabled: true
});
const cfg = guildId => { if (!configs[guildId]) configs[guildId] = defaults(); return configs[guildId]; };
const footer = { text: 'ENDLESS • Kayıt & Moderasyon Sistemi' };
const ok = (title, description) => new EmbedBuilder().setColor(0x2ecc71).setTitle(`✅ ${title}`).setDescription(description).setFooter(footer).setTimestamp();
const err = description => new EmbedBuilder().setColor(0xe74c3c).setTitle('❌ İşlem başarısız').setDescription(description).setFooter(footer).setTimestamp();
const info = (title, description) => new EmbedBuilder().setColor(0x5865f2).setTitle(`🛡️ ${title}`).setDescription(description).setFooter(footer).setTimestamp();
const mention = id => id ? `<@&${id}>` : '`Ayarlanmadı`';
const channelMention = id => id ? `<#${id}>` : '`Ayarlanmadı`';
const isOwnerOrAdmin = member => member.id === member.guild.ownerId || member.permissions.has(PermissionsBitField.Flags.Administrator);
const canRegister = (member, config) => isOwnerOrAdmin(member) || (config.registrationRoleId && member.roles.cache.has(config.registrationRoleId));
const hasMod = member => isOwnerOrAdmin(member) || member.permissions.has(PermissionsBitField.Flags.ManageMessages) || member.permissions.has(PermissionsBitField.Flags.KickMembers) || member.permissions.has(PermissionsBitField.Flags.BanMembers);
const validTarget = (actor, target) => target && target.id !== actor.id && target.id !== actor.guild.ownerId && actor.roles.highest.position > target.roles.highest.position;
const logAction = async (guild, embed) => { const id = cfg(guild.id).logChannelId; if (!id) return; const ch = guild.channels.cache.get(id); if (ch?.isTextBased()) ch.send({ embeds: [embed] }).catch(() => {}); };
const updateCounter = async guild => {
  const c = cfg(guild.id); if (!c.counterChannelId) return;
  const ch = guild.channels.cache.get(c.counterChannelId); if (!ch) return;
  const name = (c.counterName || 'Üye Sayısı: {count}').replace('{count}', String(guild.memberCount));
  ch.setName(name.slice(0, 100)).catch(() => {});
};
const applyMemberRoles = async (member, registered) => {
  const c = cfg(member.guild.id);
  const add = registered ? c.registeredRoleId : c.unregisterRoleId;
  const remove = registered ? c.unregisterRoleId : c.registeredRoleId;
  if (remove) await member.roles.remove(remove).catch(() => {});
  if (add) await member.roles.add(add).catch(() => {});
};
const setNick = async (member, name, age) => {
  if (!cfg(member.guild.id).autoNickname) return;
  const nick = `${name} | ${age}`.slice(0, 32);
  await member.setNickname(nick).catch(() => {});
};
const registerMember = async (guild, target, name, age, gender, actor) => {
  members[guild.id] ||= {};
  members[guild.id][target.id] = { name, age: String(age), gender, registeredBy: actor.id, registeredAt: new Date().toISOString() };
  await applyMemberRoles(target, true); await setNick(target, name, age); saveAll();
  await logAction(guild, info('Yeni kayıt', `${target} kullanıcısı **${name} | ${age}** olarak kaydedildi.\nCinsiyet: **${gender}**\nYetkili: ${actor}`));
};
const parseUser = async (guild, raw) => {
  const id = String(raw || '').replace(/[<@!>]/g, '');
  if (!/^\d{15,22}$/.test(id)) return null;
  return guild.members.fetch(id).catch(() => null);
};

const registrationPanel = () => {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('📋 ENDLESS Kayıt Merkezi')
    .setDescription(`Aşağıdaki butonlardan uygun kayıt türünü seçin. Açılan formda **kullanıcı ID**, **isim** ve **yaş** bilgilerini eksiksiz doldurun.

> Kayıt işlemi sadece kayıt yetkilisi rolüne sahip ekip üyeleri tarafından yapılabilir.`)
    .addFields(
      { name: 'Erkek kayıt', value: 'Üyeyi erkek olarak kaydeder.', inline: true },
      { name: 'Kız kayıt', value: 'Üyeyi kız olarak kaydeder.', inline: true },
      { name: 'Kayıtsıza al', value: 'Üyeyi kayıt sisteminden çıkarır.', inline: true }
    )
    .setFooter(footer).setTimestamp();
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('endless-register:Erkek').setLabel('Erkek Kayıt').setEmoji('👨').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('endless-register:Kız').setLabel('Kız Kayıt').setEmoji('👩').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('endless-unregister').setLabel('Kayıtsıza Al').setEmoji('🔄').setStyle(ButtonStyle.Secondary)
  );
  return { embeds: [embed], components: [row] };
};

const registrationModal = gender => {
  const modal = new ModalBuilder().setCustomId(`endless-modal:${gender}`).setTitle(`${gender} üye kaydı`);
  const uid = new TextInputBuilder().setCustomId('user_id').setLabel('Kullanıcı ID').setPlaceholder('Örn: 123456789012345678').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(15).setMaxLength(22);
  const name = new TextInputBuilder().setCustomId('member_name').setLabel('İsim').setPlaceholder('Örn: Ahmet veya Ahmet Yılmaz').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(24);
  const age = new TextInputBuilder().setCustomId('member_age').setLabel('Yaş').setPlaceholder('Örn: 21').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(2);
  return modal.addComponents(new ActionRowBuilder().addComponents(uid), new ActionRowBuilder().addComponents(name), new ActionRowBuilder().addComponents(age));
};

const slashCommands = [
  new SlashCommandBuilder().setName('yardim').setDescription('Komut kategorilerini ve kullanımlarını gösterir'),
  new SlashCommandBuilder().setName('kayit-panel').setDescription('Seçilen kanala butonlu kayıt paneli gönderir').addChannelOption(o => o.setName('kanal').setDescription('Panelin gönderileceği metin kanalı').addChannelTypes(ChannelType.GuildText)),
  new SlashCommandBuilder().setName('kayit').setDescription('Bir üyeyi kayıt eder')
    .addUserOption(o => o.setName('uye').setDescription('Kayıt edilecek üye').setRequired(true))
    .addStringOption(o => o.setName('isim').setDescription('Üyenin ismi').setRequired(true))
    .addIntegerOption(o => o.setName('yas').setDescription('Üyenin yaşı').setMinValue(1).setMaxValue(99).setRequired(true))
    .addStringOption(o => o.setName('cinsiyet').setDescription('Kayıt tipi').setRequired(true).addChoices({ name: 'Erkek', value: 'Erkek' }, { name: 'Kız', value: 'Kız' })),
  new SlashCommandBuilder().setName('kayitsiz').setDescription('Üyeyi kayıtsıza alır').addUserOption(o => o.setName('uye').setDescription('Üye').setRequired(true)),
  new SlashCommandBuilder().setName('ayar').setDescription('Kayıt sistemi ayarlarını yönetir')
    .addSubcommand(s => s.setName('goster').setDescription('Mevcut ayarları gösterir'))
    .addSubcommand(s => s.setName('kayit-yetkilisi').setDescription('Kayıt komutunu kullanabilecek rolü ayarlar').addRoleOption(o => o.setName('rol').setDescription('Yetkili rolü').setRequired(true)))
    .addSubcommand(s => s.setName('kayitsiz-rol').setDescription('Yeni üyelere verilecek rolü ayarlar').addRoleOption(o => o.setName('rol').setDescription('Rol').setRequired(true)))
    .addSubcommand(s => s.setName('kayitli-rol').setDescription('Kayıt sonrası verilecek rolü ayarlar').addRoleOption(o => o.setName('rol').setDescription('Rol').setRequired(true)))
    .addSubcommand(s => s.setName('hosgeldin-kanali').setDescription('Karşılama kanalını ayarlar').addChannelOption(o => o.setName('kanal').setDescription('Kanal').addChannelTypes(ChannelType.GuildText).setRequired(true)))
    .addSubcommand(s => s.setName('log-kanali').setDescription('Mod/kayıt log kanalını ayarlar').addChannelOption(o => o.setName('kanal').setDescription('Kanal').addChannelTypes(ChannelType.GuildText).setRequired(true)))
    .addSubcommand(s => s.setName('sayac-kanali').setDescription('Sayaç kanalını ayarlar').addChannelOption(o => o.setName('kanal').setDescription('Ses veya metin kanalı').setRequired(true)))
    .addSubcommand(s => s.setName('etiket').setDescription('Otomatik isim etiketi ayarlar').addStringOption(o => o.setName('metin').setDescription('Örn: [TR]').setRequired(true))),
  new SlashCommandBuilder().setName('ban').setDescription('Üyeyi yasaklar').addUserOption(o => o.setName('uye').setDescription('Üye').setRequired(true)).addStringOption(o => o.setName('sebep').setDescription('Sebep')),
  new SlashCommandBuilder().setName('kick').setDescription('Üyeyi atar').addUserOption(o => o.setName('uye').setDescription('Üye').setRequired(true)).addStringOption(o => o.setName('sebep').setDescription('Sebep')),
  new SlashCommandBuilder().setName('timeout').setDescription('Üyeye süreli susturma verir').addUserOption(o => o.setName('uye').setDescription('Üye').setRequired(true)).addIntegerOption(o => o.setName('dakika').setDescription('Dakika').setMinValue(1).setMaxValue(40320).setRequired(true)).addStringOption(o => o.setName('sebep').setDescription('Sebep')),
  new SlashCommandBuilder().setName('uyar').setDescription('Üyeye uyarı verir').addUserOption(o => o.setName('uye').setDescription('Üye').setRequired(true)).addStringOption(o => o.setName('sebep').setDescription('Sebep').setRequired(true)),
  new SlashCommandBuilder().setName('uyarilar').setDescription('Üyenin uyarılarını gösterir').addUserOption(o => o.setName('uye').setDescription('Üye').setRequired(true)),
  new SlashCommandBuilder().setName('sil').setDescription('Mesaj siler').addIntegerOption(o => o.setName('miktar').setDescription('1-100').setMinValue(1).setMaxValue(100).setRequired(true)),
  new SlashCommandBuilder().setName('kilit').setDescription('Kanalı kilitler'),
  new SlashCommandBuilder().setName('kilit-ac').setDescription('Kanal kilidini açar'),
  new SlashCommandBuilder().setName('yavasmod').setDescription('Kanal yavaş modunu ayarlar').addIntegerOption(o => o.setName('saniye').setDescription('0-21600').setMinValue(0).setMaxValue(21600).setRequired(true))
].map(x => x.toJSON());

async function deployCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  const route = GUILD_ID ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID) : Routes.applicationCommands(CLIENT_ID);
  await rest.put(route, { body: slashCommands });
  console.log(`[ENDLESS] ${slashCommands.length} slash komut yüklendi.`);
}

async function handleModeration(interaction, command) {
  if (!hasMod(interaction.member)) return interaction.reply({ embeds: [err('Bu moderasyon komutu için yetkin yok.')], ephemeral: true });
  const guild = interaction.guild, reason = interaction.options.getString('sebep') || 'Sebep belirtilmedi';
  const targetUser = interaction.options.getUser('uye'); const target = targetUser ? await guild.members.fetch(targetUser.id).catch(() => null) : null;
  if (['ban', 'kick', 'timeout', 'uyar', 'uyarilar'].includes(command) && !target) return interaction.reply({ embeds: [err('Üye bulunamadı.')], ephemeral: true });
  if (['ban', 'kick', 'timeout', 'uyar'].includes(command) && !validTarget(interaction.member, target)) return interaction.reply({ embeds: [err('Bu üyeye işlem uygulayamam; rol hiyerarşisini kontrol et.')], ephemeral: true });
  if (command === 'ban') { await target.ban({ reason }); await logAction(guild, info('Ban', `${target.user.tag} yasaklandı.\nYetkili: ${interaction.user}\nSebep: ${reason}`)); return interaction.reply({ embeds: [ok('Ban uygulandı', `${target} sunucudan yasaklandı.`)] }); }
  if (command === 'kick') { await target.kick(reason); await logAction(guild, info('Kick', `${target.user.tag} atıldı.\nYetkili: ${interaction.user}\nSebep: ${reason}`)); return interaction.reply({ embeds: [ok('Kick uygulandı', `${target} sunucudan atıldı.`)] }); }
  if (command === 'timeout') { const mins = interaction.options.getInteger('dakika'); await target.timeout(mins * 60000, reason); return interaction.reply({ embeds: [ok('Timeout uygulandı', `${target} **${mins} dakika** susturuldu.`)] }); }
  if (command === 'uyar') { warnings[guild.id] ||= {}; warnings[guild.id][target.id] ||= []; warnings[guild.id][target.id].push({ reason, by: interaction.user.id, at: new Date().toISOString() }); saveAll(); await logAction(guild, info('Uyarı', `${target} uyarıldı.\nSebep: ${reason}`)); return interaction.reply({ embeds: [ok('Uyarı verildi', `${target} uyarıldı.\nSebep: **${reason}**`)] }); }
  if (command === 'uyarilar') { const list = warnings[guild.id]?.[target.id] || []; return interaction.reply({ embeds: [info('Uyarı geçmişi', list.length ? list.map((w, i) => `**${i + 1}.** ${w.reason} — <@${w.by}>`).join('\n') : 'Bu üyenin uyarısı yok.')] }); }
  if (command === 'sil') { const n = interaction.options.getInteger('miktar'); const deleted = await interaction.channel.bulkDelete(n, true); return interaction.reply({ embeds: [ok('Mesajlar silindi', `**${deleted.size}** mesaj silindi.`)], ephemeral: true }); }
  if (command === 'kilit' || command === 'kilit-ac') { const locked = command === 'kilit'; await interaction.channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: !locked }); return interaction.reply({ embeds: [ok(locked ? 'Kanal kilitlendi' : 'Kanal açıldı', locked ? 'Üyeler mesaj gönderemez.' : 'Mesaj gönderme açıldı.')] }); }
  if (command === 'yavasmod') { const sec = interaction.options.getInteger('saniye'); await interaction.channel.setRateLimitPerUser(sec); return interaction.reply({ embeds: [ok('Yavaş mod güncellendi', `Yavaş mod: **${sec} saniye**.`)] }); }
}

client.on('guildMemberAdd', async member => {
  const c = cfg(member.guild.id); await applyMemberRoles(member, false); await updateCounter(member.guild);
  if (c.autoNickname) await member.setNickname(`${c.tag ? c.tag + ' ' : ''}İsim | Yaş`.slice(0, 32)).catch(() => {});
  if (c.welcomeEnabled && c.welcomeChannelId) {
    const ch = member.guild.channels.cache.get(c.welcomeChannelId);
    if (ch?.isTextBased()) ch.send({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('🌟 Yeni üye aramıza katıldı!').setDescription(`Hoş geldin ${member}!\n\nSunucumuzda **${member.guild.memberCount}** kişi olduk.\nKayıt olmak için yetkililerin işlem yapmasını bekle.`).addFields({ name: 'Kayıtsız rolü', value: mention(c.unregisterRoleId), inline: true }, { name: 'Kayıt sistemi', value: 'Yetkililer `.e` / `.k` veya `/kayit` kullanabilir.', inline: true }).setThumbnail(member.user.displayAvatarURL({ size: 256 })).setFooter(footer).setTimestamp()] }).catch(() => {});
  }
  await logAction(member.guild, info('Yeni üye', `${member} sunucuya katıldı. Otomatik kayıtsız rolü verildi.`));
});
client.on('guildMemberRemove', member => { updateCounter(member.guild); logAction(member.guild, info('Üye ayrıldı', `${member.user.tag} sunucudan ayrıldı.`)); });

client.on('interactionCreate', async interaction => {
  const guild = interaction.guild; if (!guild) return;
  const c = cfg(guild.id);
  if (interaction.isButton()) {
    if (!canRegister(interaction.member, c)) return interaction.reply({ embeds: [err(`Bu paneli sadece ${mention(c.registrationRoleId)} rolü veya yöneticiler kullanabilir.`)], ephemeral: true });
    if (interaction.customId === 'endless-unregister') {
      const modal = new ModalBuilder().setCustomId('endless-modal:Kayıtsız').setTitle('Üyeyi kayıtsıza al');
      const uid = new TextInputBuilder().setCustomId('user_id').setLabel('Kullanıcı ID').setPlaceholder('Örn: 123456789012345678').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(15).setMaxLength(22);
      return interaction.showModal(modal.addComponents(new ActionRowBuilder().addComponents(uid)));
    }
    if (interaction.customId.startsWith('endless-register:')) return interaction.showModal(registrationModal(interaction.customId.split(':')[1]));
  }
  if (interaction.isModalSubmit()) {
    if (!canRegister(interaction.member, c)) return interaction.reply({ embeds: [err(`Bu işlemi sadece ${mention(c.registrationRoleId)} rolü veya yöneticiler kullanabilir.`)], ephemeral: true });
    const mode = interaction.customId.split(':')[1];
    const target = await parseUser(guild, interaction.fields.getTextInputValue('user_id'));
    if (!target) return interaction.reply({ embeds: [err('Bu ID ile sunucuda bir üye bulunamadı. ID’yi ve botun üye görme yetkisini kontrol et.')], ephemeral: true });
    if (mode === 'Kayıtsız') {
      await applyMemberRoles(target, false); delete (members[guild.id] || {})[target.id];
      if (c.autoNickname) await target.setNickname(`${c.tag ? c.tag + ' ' : ''}İsim | Yaş`.slice(0, 32)).catch(() => {});
      saveAll(); await logAction(guild, info('Panel kayıtsız işlemi', `${target} kayıtsıza alındı. Yetkili: ${interaction.user}`));
      return interaction.reply({ embeds: [ok('Üye kayıtsıza alındı', `${target} tekrar **İsim | Yaş** formatına getirildi.`)], ephemeral: true });
    }
    const name = interaction.fields.getTextInputValue('member_name').trim();
    const age = Number(interaction.fields.getTextInputValue('member_age').trim());
    if (!name || !Number.isInteger(age) || age < 1 || age > 99) return interaction.reply({ embeds: [err('İsim ve yaş bilgisi geçersiz. Yaş 1-99 arasında olmalı.')], ephemeral: true });
    await registerMember(guild, target, name, age, mode, interaction.user);
    return interaction.reply({ embeds: [ok('Panel kaydı tamamlandı', `${target} nickname’i **${name} | ${age}** olarak değiştirildi.\nKayıt tipi: **${mode}**`)], ephemeral: true });
  }
  if (!interaction.isChatInputCommand()) return;
  const command = interaction.commandName;
  if (['ban', 'kick', 'timeout', 'uyar', 'uyarilar', 'sil', 'kilit', 'kilit-ac', 'yavasmod'].includes(command)) return handleModeration(interaction, command);
  if (command === 'yardim') return interaction.reply({ embeds: [info('ENDLESS Komut Merkezi', '**Kayıt**\n`/kayit`, `/kayitsiz`, `/kayit-panel`\n\n**Ayar**\n`/ayar goster` ve diğer ayar alt komutları\n\n**Moderasyon**\n`/ban`, `/kick`, `/timeout`, `/uyar`, `/uyarilar`, `/sil`, `/kilit`, `/kilit-ac`, `/yavasmod`\n\n**Prefix kayıt**\n`.e ID İsim Yaş` = erkek\n`.k ID İsim Yaş` = kız\n`.isim ID Yeni İsim` = isim değiştir\n`.yaş ID 21` = yaş değiştir\n`.cinsiyet ID erkek/kız` = cinsiyet değiştir\n`.kayıtsız ID` = tekrar kayıtsız yap')] });
  if (command === 'kayit-panel') {
    if (!isOwnerOrAdmin(interaction.member)) return interaction.reply({ embeds: [err('Kayıt panelini sadece sunucu sahibi veya yöneticiler gönderebilir.')], ephemeral: true });
    const requested = interaction.options.getChannel('kanal');
    const channel = requested || (c.welcomeChannelId ? guild.channels.cache.get(c.welcomeChannelId) : null);
    if (!channel?.isTextBased()) return interaction.reply({ embeds: [err('Önce bir metin kanalı etiketle veya `/ayar hosgeldin-kanali` ile varsayılan kanal ayarla.')], ephemeral: true });
    await channel.send(registrationPanel());
    return interaction.reply({ embeds: [ok('Kayıt paneli gönderildi', `Panel ${channel} kanalına gönderildi. Yetkililer butonlardan ID, isim ve yaş girerek kayıt yapabilir.`)], ephemeral: true });
  }
  if (command === 'kayit' || command === 'kayitsiz') {
    if (!canRegister(interaction.member, c)) return interaction.reply({ embeds: [err(`Bu işlemi sadece ${mention(c.registrationRoleId)} rolü veya yöneticiler kullanabilir.`)], ephemeral: true });
    const target = await guild.members.fetch(interaction.options.getUser('uye').id).catch(() => null); if (!target) return interaction.reply({ embeds: [err('Üye bulunamadı.')], ephemeral: true });
    if (command === 'kayitsiz') { await applyMemberRoles(target, false); delete (members[guild.id] || {})[target.id]; await target.setNickname(`${c.tag ? c.tag + ' ' : ''}İsim | Yaş`.slice(0, 32)).catch(() => {}); saveAll(); return interaction.reply({ embeds: [ok('Üye kayıtsıza alındı', `${target} tekrar kayıtsız rolüne alındı.`)] }); }
    const name = interaction.options.getString('isim').trim(), age = interaction.options.getInteger('yas'), gender = interaction.options.getString('cinsiyet');
    await registerMember(guild, target, name, age, gender, interaction.user); return interaction.reply({ embeds: [ok('Kayıt tamamlandı', `${target} **${name} | ${age}** olarak kaydedildi.\nKayıt tipi: **${gender}**`)] });
  }
  if (command === 'ayar') {
    if (!isOwnerOrAdmin(interaction.member)) return interaction.reply({ embeds: [err('Ayarları sadece sunucu sahibi veya yöneticiler değiştirebilir.')], ephemeral: true });
    const sub = interaction.options.getSubcommand(); const role = interaction.options.getRole('rol'); const channel = interaction.options.getChannel('kanal');
    if (sub === 'goster') return interaction.reply({ embeds: [info('Kayıt sistemi ayarları', `Kayıt yetkilisi: ${mention(c.registrationRoleId)}\nKayıtsız rolü: ${mention(c.unregisterRoleId)}\nKayıtlı rolü: ${mention(c.registeredRoleId)}\nHoş geldin kanalı: ${channelMention(c.welcomeChannelId)}\nLog kanalı: ${channelMention(c.logChannelId)}\nSayaç kanalı: ${channelMention(c.counterChannelId)}\nEtiket: **${c.tag || 'Yok'}**`)] });
    if (sub === 'kayit-yetkilisi') c.registrationRoleId = role.id;
    if (sub === 'kayitsiz-rol') c.unregisterRoleId = role.id;
    if (sub === 'kayitli-rol') c.registeredRoleId = role.id;
    if (sub === 'hosgeldin-kanali') c.welcomeChannelId = channel.id;
    if (sub === 'log-kanali') c.logChannelId = channel.id;
    if (sub === 'sayac-kanali') c.counterChannelId = channel.id;
    if (sub === 'etiket') c.tag = interaction.options.getString('metin');
    saveAll(); if (sub === 'sayac-kanali') await updateCounter(guild); return interaction.reply({ embeds: [ok('Ayar kaydedildi', `**${sub}** ayarı başarıyla güncellendi.`)] });
  }
});

client.on('messageCreate', async message => {
  if (message.author.bot || !message.guild || !message.content.startsWith(PREFIX)) return;
  const args = message.content.slice(PREFIX.length).trim().split(/\s+/); const command = args.shift()?.toLowerCase(); const c = cfg(message.guild.id);
  if (['isim', 'cinsiyet', 'yaş', 'yas', 'kayıtsız', 'kayitsiz'].includes(command)) {
    if (!canRegister(message.member, c)) return message.reply({ embeds: [err(`Bu işlemi sadece ${mention(c.registrationRoleId)} rolü veya yöneticiler kullanabilir.`)] });
    const target = await parseUser(message.guild, args.shift());
    if (!target) return message.reply({ embeds: [err(`Kullanım: \`${PREFIX}${command} KULLANICI_ID ...\``)] });
    members[message.guild.id] ||= {};
    const record = members[message.guild.id][target.id];
    if (command === 'kayıtsız' || command === 'kayitsiz') {
      await applyMemberRoles(target, false); delete members[message.guild.id][target.id];
      if (c.autoNickname) await target.setNickname(`${c.tag ? c.tag + ' ' : ''}İsim | Yaş`.slice(0, 32)).catch(() => {});
      saveAll(); await logAction(message.guild, info('Üye kayıtsıza alındı', `${target} tekrar kayıtsıza alındı. Yetkili: ${message.author}`));
      return message.reply({ embeds: [ok('Kayıtsıza alındı', `${target} tekrar **İsim | Yaş** formatına getirildi.`)] });
    }
    if (!record) return message.reply({ embeds: [err('Bu üye kayıtlı görünmüyor. Önce `.e` veya `.k` ile kayıt yapmalısın.')] });
    if (command === 'isim') {
      const newName = args.join(' ').trim();
      if (!newName) return message.reply({ embeds: [err(`Kullanım: \`${PREFIX}isim KULLANICI_ID Yeni İsim\``)] });
      record.name = newName; await setNick(target, record.name, record.age); saveAll();
      return message.reply({ embeds: [ok('İsim güncellendi', `${target} yeni nickname’i **${record.name} | ${record.age}** oldu.`)] });
    }
    if (command === 'yaş' || command === 'yas') {
      const newAge = Number(args.shift());
      if (!Number.isInteger(newAge) || newAge < 1 || newAge > 99) return message.reply({ embeds: [err(`Kullanım: \`${PREFIX}yaş KULLANICI_ID 21\``)] });
      record.age = String(newAge); await setNick(target, record.name, record.age); saveAll();
      return message.reply({ embeds: [ok('Yaş güncellendi', `${target} yeni nickname’i **${record.name} | ${record.age}** oldu.`)] });
    }
    if (command === 'cinsiyet') {
      const value = args.join(' ').toLowerCase();
      if (!['erkek', 'kız', 'kiz'].includes(value)) return message.reply({ embeds: [err(`Kullanım: \`${PREFIX}cinsiyet KULLANICI_ID erkek/kız\``)] });
      record.gender = value === 'erkek' ? 'Erkek' : 'Kız'; saveAll();
      return message.reply({ embeds: [ok('Cinsiyet güncellendi', `${target} kayıt tipi **${record.gender}** olarak güncellendi.`)] });
    }
  }

  if (command === 'e' || command === 'k') {
    if (!canRegister(message.member, c)) return message.reply({ embeds: [err(`Bu işlemi sadece ${mention(c.registrationRoleId)} rolü veya yöneticiler kullanabilir.`)] });
    const target = await parseUser(message.guild, args.shift()); const age = Number(args.pop()); const name = args.join(' ').trim();
    if (!target || !name || !Number.isInteger(age) || age < 1 || age > 99) return message.reply({ embeds: [err(`Kullanım: [0;32m${PREFIX}${command} @üye İsim 20[0m`)] });
    await registerMember(message.guild, target, name, age, command === 'e' ? 'Erkek' : 'Kız', message.author);
    return message.reply({ embeds: [ok('Kayıt tamamlandı', `${target} **${name} | ${age}** olarak kaydedildi.`)] });
  }
  if (command === 'yardım' || command === 'help') return message.reply({ embeds: [info('ENDLESS', 'Slash komutları için `/yardim` yaz. Kayıt: `.e @üye İsim Yaş` veya `.k @üye İsim Yaş`')] });
});

client.once('ready', async () => { console.log(`[ENDLESS] ${client.user.tag} aktif.`); client.user.setActivity('Kayıt & Moderasyon | /yardim'); await deployCommands(); for (const guild of client.guilds.cache.values()) updateCounter(guild); });
process.on('unhandledRejection', error => console.error('[ENDLESS] Hata:', error));
process.on('SIGINT', () => { saveAll(); client.destroy(); process.exit(0); });
client.login(TOKEN);
