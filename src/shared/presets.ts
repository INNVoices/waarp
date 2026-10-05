export interface Preset {
  id: string
  name: string
  hint: string
  color: string
  brand?: string
  domains: string[]
  cidrs?: string[]
}

export const PRESETS: Preset[] = [
  { id: 'youtube', brand: 'youtube', name: 'YouTube', hint: 'видео без замедления', color: '#d6646f',
    domains: ['youtube.com', 'youtu.be', 'googlevideo.com', 'ytimg.com', 'ggpht.com', 'youtube-nocookie.com', 'youtubei.googleapis.com', 'yt3.ggpht.com'] },
  { id: 'discord', brand: 'discord', name: 'Discord', hint: 'сайт, CDN и голос', color: '#8b93e6',
    domains: ['discord.com', 'discord.gg', 'discordapp.com', 'discordapp.net', 'discord.media', 'discordcdn.com', 'discord.dev', 'discordstatus.com'] },
  { id: 'telegram', brand: 'telegram', name: 'Telegram', hint: 'веб и серверы MTProto', color: '#5aa2ec',
    domains: ['telegram.org', 't.me', 'telegra.ph', 'telesco.pe', 'tdesktop.com', 'telegram.me'],
    cidrs: ['91.108.4.0/22', '91.108.8.0/22', '91.108.12.0/22', '91.108.16.0/22', '91.108.56.0/22', '149.154.160.0/20', '95.161.64.0/20'] },
  { id: 'chatgpt', name: 'ChatGPT', hint: 'OpenAI, Codex, Sora', color: '#9bb06e',
    domains: ['openai.com', 'chatgpt.com', 'oaistatic.com', 'oaiusercontent.com', 'sora.com', 'auth0.com'] },
  { id: 'claude', brand: 'claude', name: 'Claude', hint: 'claude.ai и API', color: '#d97757',
    domains: ['anthropic.com', 'claude.ai', 'claude.com', 'claudeusercontent.com', 'clau.de'] },
  { id: 'gemini', brand: 'googlegemini', name: 'Gemini', hint: 'Gemini, AI Studio', color: '#8ab4f8',
    domains: ['gemini.google.com', 'aistudio.google.com', 'generativelanguage.googleapis.com', 'bard.google.com', 'notebooklm.google.com', 'alkalimakersuite-pa.clients6.google.com'] },
  { id: 'meta', brand: 'instagram', name: 'Instagram', hint: 'Instagram, Facebook, Threads', color: '#c985b2',
    domains: ['instagram.com', 'cdninstagram.com', 'facebook.com', 'fbcdn.net', 'fb.com', 'threads.net', 'threads.com', 'messenger.com'] },
  { id: 'x', brand: 'x', name: 'X', hint: 'бывший Twitter', color: '#c6c1bb',
    domains: ['x.com', 'twitter.com', 'twimg.com', 't.co', 'x.ai', 'grok.com'] },
  { id: 'spotify', brand: 'spotify', name: 'Spotify', hint: 'музыка и подкасты', color: '#7cc0aa',
    domains: ['spotify.com', 'scdn.co', 'spotifycdn.com', 'spotify.design', 'pscdn.co'] },
  { id: 'dev', brand: 'github', name: 'Dev', hint: 'GitHub, Docker, npm', color: '#9486d6',
    domains: ['github.com', 'githubusercontent.com', 'githubcopilot.com', 'docker.io', 'docker.com', 'npmjs.org', 'jetbrains.com', 'cursor.sh', 'cursor.com'] }
]
