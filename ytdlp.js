import { spawn } from 'child_process';
import path from 'path';
import { existsSync } from 'fs';
import ffmpegPath from 'ffmpeg-static';

// Caminho do executável do yt-dlp. Por padrão procura em ./bin/yt-dlp.exe (Windows)
// ou ./bin/yt-dlp (Mac/Linux) dentro do próprio projeto. Pode ser sobrescrito
// definindo YTDLP_PATH no .env (por exemplo, se o yt-dlp já estiver no PATH do sistema).
const DEFAULT_BIN = process.platform === 'win32'
  ? path.join(process.cwd(), 'bin', 'yt-dlp.exe')
  : path.join(process.cwd(), 'bin', 'yt-dlp');

const YTDLP_BIN = process.env.YTDLP_PATH || (existsSync(DEFAULT_BIN) ? DEFAULT_BIN : 'yt-dlp');

function baseArgs() {
  const args = ['--no-warnings', '--quiet', '--no-playlist'];
  if (ffmpegPath) {
    args.push('--ffmpeg-location', ffmpegPath);
  }
  if (process.env.YOUTUBE_COOKIE) {
    // yt-dlp aceita cookies em formato Netscape (arquivo) ou via --cookies-from-browser.
    // Para manter simples, se um arquivo cookies.txt existir na raiz do projeto, ele é usado.
    const cookieFile = path.join(process.cwd(), 'cookies.txt');
    if (existsSync(cookieFile)) {
      args.push('--cookies', cookieFile);
    }
  }
  return args;
}

function runJson(target, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const args = [...baseArgs(), ...extraArgs, '-J', target];
    const child = spawn(YTDLP_BIN, args, { windowsHide: true });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        reject(new Error(
          `Não encontrei o yt-dlp em "${YTDLP_BIN}". Baixe o yt-dlp.exe e coloque na pasta bin/ do projeto, ` +
          `ou instale-o no PATH do sistema.`
        ));
      } else {
        reject(err);
      }
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim().split('\n').pop() || `yt-dlp saiu com código ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (err) {
        reject(new Error('Não consegui interpretar a resposta do yt-dlp.'));
      }
    });
  });
}

/**
 * Resolve uma URL (YouTube, SoundCloud, etc.) ou termo de busca em um único
 * item com título e URL definitiva. Termos de busca devem vir prefixados
 * com "ytsearch1:" pelo chamador quando não forem uma URL.
 */
async function getInfo(target) {
  const info = await runJson(target);
  // Quando é uma busca (ytsearch1:), o yt-dlp devolve um objeto "playlist" com 1 entrada.
  const entry = info.entries ? info.entries[0] : info;
  if (!entry) throw new Error('Nenhum resultado encontrado.');
  return {
    title: entry.title,
    url: entry.webpage_url || entry.url,
    durationRaw: entry.duration ? formatDuration(entry.duration) : null,
    thumbnail: entry.thumbnail,
  };
}

/**
 * Resolve uma playlist (YouTube ou SoundCloud) em uma lista de itens.
 * Usa --flat-playlist para ser rápido (não baixa metadados completos de cada vídeo).
 */
async function getPlaylist(url) {
  const info = await runJson(url, ['--flat-playlist']);
  const entries = info.entries || [];
  return entries.map((e) => ({
    title: e.title,
    url: e.url || (e.id ? `https://www.youtube.com/watch?v=${e.id}` : null),
    durationRaw: e.duration ? formatDuration(e.duration) : null,
    thumbnail: e.thumbnails?.[0]?.url,
  })).filter((t) => t.url);
}

function formatDuration(seconds) {
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  const m = Math.floor(seconds / 60);
  return `${m}:${s}`;
}

/**
 * Abre um processo yt-dlp que baixa o melhor áudio disponível e escreve os
 * bytes brutos na saída padrão (stdout). Em seguida, encaminha esse áudio
 * para um processo ffmpeg próprio, que converte para PCM bruto (formato que
 * o @discordjs/voice consegue tocar diretamente, sem depender da detecção
 * automática de ffmpeg de bibliotecas internas).
 */
function getAudioStream(url) {
  const ytArgs = [...baseArgs(), '-f', 'bestaudio/best', '-o', '-', url];
  const ytProcess = spawn(YTDLP_BIN, ytArgs, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

  let ytStderr = '';
  ytProcess.stderr.on('data', (chunk) => { ytStderr += chunk; });
  ytProcess.on('error', (err) => {
    console.error('Erro ao iniciar o yt-dlp:', err.message);
  });

  const ffmpegArgs = [
    '-loglevel', 'error',
    '-i', 'pipe:0',
    '-analyzeduration', '0',
    '-f', 's16le',
    '-ar', '48000',
    '-ac', '2',
    'pipe:1',
  ];
  const ffmpegProcess = spawn(ffmpegPath, ffmpegArgs, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

  let ffmpegStderr = '';
  ffmpegProcess.stderr.on('data', (chunk) => { ffmpegStderr += chunk; });
  ffmpegProcess.on('error', (err) => {
    console.error('Erro ao iniciar o ffmpeg:', err.message);
  });

  ytProcess.stdout.pipe(ffmpegProcess.stdin);
  // Evita que o processo quebre com EPIPE se o ffmpeg fechar antes do yt-dlp terminar.
  ytProcess.stdout.on('error', () => {});
  ffmpegProcess.stdin.on('error', () => {});

  // Diagnóstico: mostra quantos bytes de áudio realmente passaram por cada etapa.
  let ytBytes = 0;
  let ffmpegBytes = 0;
  ytProcess.stdout.on('data', (chunk) => { ytBytes += chunk.length; });
  ffmpegProcess.stdout.on('data', (chunk) => { ffmpegBytes += chunk.length; });
  const reportInterval = setInterval(() => {
    console.log(`[audio] yt-dlp entregou ${ytBytes} bytes, ffmpeg entregou ${ffmpegBytes} bytes`);
  }, 4000);
  const stopReporting = () => clearInterval(reportInterval);
  ffmpegProcess.on('close', stopReporting);
  ytProcess.on('close', stopReporting);

  // Loga qualquer falha real (código de saída != 0 / != null) depois de encerrar,
  // útil para depuração pelo terminal do bot.
  ytProcess.on('close', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`yt-dlp encerrou com código ${code}:`, ytStderr.trim().split('\n').slice(-5).join('\n'));
    }
  });
  ffmpegProcess.on('close', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`ffmpeg encerrou com código ${code}:`, ffmpegStderr.trim().split('\n').slice(-5).join('\n'));
    }
  });

  function kill() {
    try { ytProcess.kill(); } catch {}
    try { ffmpegProcess.kill(); } catch {}
  }

  return { stdout: ffmpegProcess.stdout, kill };
}

export { getInfo, getPlaylist, getAudioStream, YTDLP_BIN };
