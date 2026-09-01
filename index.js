import { Client, GatewayIntentBits, EmbedBuilder } from 'discord.js';
import { AudioPlayerStatus } from '@discordjs/voice';
import dotenv from 'dotenv';
import play from 'play-dl';
import {
  getQueue,
  createQueue,
  destroyQueue,
  resolveTrack,
  playNext,
} from './queueManager.js';

dotenv.config();

// Se um cookie do YouTube foi configurado no .env, registra ele no play-dl.
// Isso ajuda a evitar o erro "Sign in to confirm you're not a bot" / "Invalid URL"
// que o YouTube passou a exibir com mais frequência para requisições sem login.
if (process.env.YOUTUBE_COOKIE) {
  try {
    await play.setToken({
      youtube: { cookie: process.env.YOUTUBE_COOKIE },
    });
    console.log('🍪 Cookie do YouTube carregado.');
  } catch (err) {
    console.error('⚠️ Não foi possível carregar o cookie do YouTube:', err.message);
  }
} else {
  console.log('ℹ️ Nenhum YOUTUBE_COOKIE definido no .env — o YouTube pode bloquear alguns vídeos sem login.');
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
  ],
});

client.once('ready', () => {
  console.log(`✅ Bot conectado como ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, guild, member, channel } = interaction;

  // Comandos que não exigem estar em um canal de voz.
  if (commandName === 'queue') {
    const queue = getQueue(guild.id);
    if (!queue || queue.songs.length === 0) {
      return interaction.reply('A fila está vazia.');
    }
    const list = queue.songs
      .slice(0, 10)
      .map((s, i) => `${i === 0 ? '▶️' : `${i}.`} ${s.title}`)
      .join('\n');
    const embed = new EmbedBuilder()
      .setTitle('🎵 Fila de reprodução')
      .setDescription(list)
      .setFooter({ text: queue.songs.length > 10 ? `+ ${queue.songs.length - 10} música(s) na fila` : ' ' });
    return interaction.reply({ embeds: [embed] });
  }

  if (commandName === 'nowplaying') {
    const queue = getQueue(guild.id);
    if (!queue || !queue.songs[0]) {
      return interaction.reply('Nada tocando no momento.');
    }
    return interaction.reply(`🎶 Tocando agora: **${queue.songs[0].title}**`);
  }

  // Comandos que exigem o usuário em um canal de voz.
  const voiceChannel = member.voice.channel;
  if (['play', 'pause', 'resume', 'skip', 'stop', 'volume'].includes(commandName) && !voiceChannel) {
    return interaction.reply({ content: '⚠️ Você precisa estar em um canal de voz para usar esse comando.', ephemeral: true });
  }

  if (commandName === 'play') {
    await interaction.deferReply();
    const link = interaction.options.getString('link', true);

    let queue = getQueue(guild.id);
    if (!queue) {
      queue = createQueue(guild, voiceChannel, channel);
    }

    try {
      const result = await resolveTrack(link);
      const tracks = Array.isArray(result) ? result : [result];

      if (tracks.length === 0) {
        return interaction.editReply('Não encontrei nenhuma música válida nesse link.');
      }

      queue.songs.push(...tracks);

      if (!queue.playing) {
        await playNext(guild.id);
        await interaction.editReply(
          tracks.length > 1
            ? `✅ Adicionadas **${tracks.length}** músicas à fila e iniciando reprodução!`
            : `✅ Iniciando reprodução!`
        );
      } else {
        await interaction.editReply(
          tracks.length > 1
            ? `✅ **${tracks.length}** músicas adicionadas à fila!`
            : `✅ **${tracks[0].title}** adicionada à fila!`
        );
      }
    } catch (err) {
      console.error('Erro no comando /play:', err);
      await interaction.editReply(`❌ Erro: ${err.message}`);
    }
    return;
  }

  const queue = getQueue(guild.id);
  if (!queue) {
    return interaction.reply({ content: 'Não estou tocando nada no momento.', ephemeral: true });
  }

  if (commandName === 'pause') {
    queue.player.pause();
    return interaction.reply('⏸️ Pausado.');
  }

  if (commandName === 'resume') {
    queue.player.unpause();
    return interaction.reply('▶️ Retomado.');
  }

  if (commandName === 'skip') {
    if (!queue.songs.length) {
      return interaction.reply('Não há nada para pular.');
    }
    queue.player.stop(); // Dispara o evento Idle, que já toca a próxima da fila.
    return interaction.reply('⏭️ Música pulada.');
  }

  if (commandName === 'stop') {
    destroyQueue(guild.id);
    return interaction.reply('⏹️ Reprodução parada, fila limpa e bot desconectado.');
  }

  if (commandName === 'volume') {
    const percentual = interaction.options.getInteger('percentual', true);
    queue.volume = percentual;
    queue.currentResource?.volume?.setVolume(percentual / 100);
    return interaction.reply(`🔊 Volume ajustado para ${percentual}%.`);
  }
});

client.login(process.env.DISCORD_TOKEN);
