import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  StreamType,
  VoiceConnectionStatus,
  NoSubscriberBehavior,
} from '@discordjs/voice';
import play from 'play-dl';
import { getInfo, getPlaylist, getAudioStream } from './ytdlp.js';

// Guarda uma fila por servidor (guild).
const queues = new Map();

function getQueue(guildId) {
  return queues.get(guildId);
}

function createQueue(guild, voiceChannel, textChannel) {
  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
  });

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
  });

  connection.subscribe(player);

  const queue = {
    connection,
    player,
    songs: [],
    volume: 100,
    textChannel,
    voiceChannel,
    playing: false,
    currentProcess: null,
  };

  player.on(AudioPlayerStatus.Idle, () => {
    console.log('[player] Idle');
    queue.currentProcess?.();
    queue.songs.shift();
    playNext(guild.id);
  });

  player.on(AudioPlayerStatus.Buffering, () => console.log('[player] Buffering'));
  player.on(AudioPlayerStatus.Playing, () => console.log('[player] Playing (áudio realmente sendo enviado)'));
  player.on(AudioPlayerStatus.Paused, () => console.log('[player] Paused'));
  player.on(AudioPlayerStatus.AutoPaused, () => console.log('[player] AutoPaused (sem ninguém "inscrito"/conectado?)'));

  connection.on(VoiceConnectionStatus.Ready, () => console.log('[connection] Ready (conectado de verdade ao canal de voz)'));
  connection.on(VoiceConnectionStatus.Signalling, () => console.log('[connection] Signalling'));
  connection.on(VoiceConnectionStatus.Connecting, () => console.log('[connection] Connecting'));

  player.on('error', (error) => {
    console.error('Erro no player de áudio:', error.message);
    queue.textChannel?.send(`⚠️ Ocorreu um erro ao tocar **${queue.songs[0]?.title ?? 'a faixa'}**, pulando para a próxima.`);
    queue.currentProcess?.();
    queue.songs.shift();
    playNext(guild.id);
  });

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5000),
      ]);
    } catch {
      destroyQueue(guild.id);
    }
  });

  queues.set(guild.id, queue);
  return queue;
}

function destroyQueue(guildId) {
  const queue = getQueue(guildId);
  if (!queue) return;
  try {
    queue.currentProcess?.();
    queue.player.stop(true);
    queue.connection.destroy();
  } catch {
    // Já pode ter sido destruído.
  }
  queues.delete(guildId);
}

/**
 * Identifica a plataforma do link/termo e devolve um ou mais itens com
 * título + URL definitiva, prontos para tocar. Suporta:
 * - YouTube (vídeo e playlist) e SoundCloud (faixa e set), via yt-dlp;
 * - Spotify (faixa, álbum, playlist) — busca metadados no Spotify e toca a
 *   faixa equivalente no YouTube, já que o Spotify não permite streaming
 *   direto de áudio bruto;
 * - Links diretos de arquivo de áudio (.mp3, .wav, .ogg etc);
 * - Termos de busca livres (sem link) — pesquisados no YouTube.
 */
async function resolveTrack(query) {
  const isUrl = /^https?:\/\//i.test(query);

  // Link direto de arquivo de áudio: não precisa do yt-dlp, o ffmpeg cuida do resto.
  if (isUrl && /\.(mp3|wav|ogg|m4a|flac|webm)(\?.*)?$/i.test(query)) {
    return {
      title: query.split('/').pop().split('?')[0],
      url: query,
      source: 'direct',
    };
  }

  // Spotify: pega metadados (nome + artista) e busca a faixa equivalente no YouTube.
  if (isUrl && /open\.spotify\.com/i.test(query)) {
    const spotifyData = await play.spotify(query).catch(() => {
      throw new Error('Não consegui ler esse link do Spotify. Verifique se as credenciais do Spotify foram configuradas (veja o README).');
    });

    if (spotifyData.type === 'track') {
      const searchTerm = `${spotifyData.name} ${spotifyData.artists.map(a => a.name).join(' ')}`;
      const info = await getInfo(`ytsearch1:${searchTerm}`);
      return { ...info, source: 'spotify->youtube' };
    }

    if (spotifyData.type === 'playlist' || spotifyData.type === 'album') {
      const tracks = await spotifyData.all_tracks();
      const resolved = [];
      for (const track of tracks) {
        const searchTerm = `${track.name} ${track.artists.map(a => a.name).join(' ')}`;
        try {
          const info = await getInfo(`ytsearch1:${searchTerm}`);
          resolved.push({ ...info, source: 'spotify->youtube' });
        } catch {
          // Pula faixas que não foram encontradas no YouTube.
        }
      }
      return resolved;
    }
  }

  // Playlist (YouTube "list=" ou SoundCloud "/sets/"): resolve todos os itens.
  if (isUrl && (/[?&]list=/i.test(query) || /soundcloud\.com\/.+\/sets\//i.test(query))) {
    const items = await getPlaylist(query);
    if (!items.length) throw new Error('Não encontrei nenhuma faixa nessa playlist.');
    return items.map((i) => ({ ...i, source: 'ytdlp' }));
  }

  // Link único (YouTube, SoundCloud, etc.) ou termo de busca livre.
  const target = isUrl ? query : `ytsearch1:${query}`;
  const info = await getInfo(target);
  return { ...info, source: 'ytdlp' };
}

async function getStreamForTrack(track) {
  if (track.source === 'direct') {
    return { input: track.url, type: StreamType.Arbitrary, stop: null };
  }
  const { stdout, kill } = getAudioStream(track.url);
  return { input: stdout, type: StreamType.Raw, stop: kill };
}

async function playNext(guildId) {
  const queue = getQueue(guildId);
  if (!queue) return;

  const nextTrack = queue.songs[0];
  if (!nextTrack) {
    queue.playing = false;
    return;
  }

  try {
    const { input, type, stop } = await getStreamForTrack(nextTrack);
    queue.currentProcess = stop;
    const resource = createAudioResource(input, { inputType: type, inlineVolume: true });
    resource.volume?.setVolume(queue.volume / 100);
    queue.currentResource = resource;
    queue.player.play(resource);
    queue.playing = true;
    queue.textChannel?.send(`🎶 Tocando agora: **${nextTrack.title}**`);
  } catch (err) {
    console.error('Erro ao carregar stream:', err);
    queue.textChannel?.send(`⚠️ Não consegui carregar **${nextTrack.title ?? 'a faixa'}**, pulando. (${err.message})`);
    queue.songs.shift();
    playNext(guildId);
  }
}

export {
  getQueue,
  createQueue,
  destroyQueue,
  resolveTrack,
  playNext,
  queues,
};
