import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import dotenv from 'dotenv';
dotenv.config();

const commands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Toca um link de música/som (YouTube, Spotify, SoundCloud ou link direto de áudio)')
    .addStringOption(opt =>
      opt.setName('link')
        .setDescription('URL da música/som (ou termo de busca)')
        .setRequired(true)),

  new SlashCommandBuilder()
    .setName('pause')
    .setDescription('Pausa a música atual'),

  new SlashCommandBuilder()
    .setName('resume')
    .setDescription('Retoma a música pausada'),

  new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Pula para a próxima música da fila'),

  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Para a reprodução, limpa a fila e desconecta o bot'),

  new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Mostra a fila de reprodução atual'),

  new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Ajusta o volume da música (0 a 150)')
    .addIntegerOption(opt =>
      opt.setName('percentual')
        .setDescription('Volume em porcentagem (padrão 100)')
        .setMinValue(0)
        .setMaxValue(150)
        .setRequired(true)),

  new SlashCommandBuilder()
    .setName('nowplaying')
    .setDescription('Mostra o que está tocando agora'),
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

async function main() {
  try {
    const { CLIENT_ID, GUILD_ID } = process.env;
    if (!CLIENT_ID) throw new Error('CLIENT_ID não definido no .env');

    if (GUILD_ID) {
      // Registro em um único servidor: aparece quase instantaneamente. Ótimo para testes.
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
      console.log(`Comandos registrados no servidor ${GUILD_ID}.`);
    } else {
      // Registro global: pode levar até 1 hora para propagar para todos os servidores.
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log('Comandos registrados globalmente.');
    }
  } catch (err) {
    console.error('Erro ao registrar comandos:', err);
  }
}

main();
